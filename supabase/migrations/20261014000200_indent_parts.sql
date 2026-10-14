-- Phase 13 step 1: indent parts and customer quotes (PLAN Phase 13,
-- D140-D148, ADR-024; DATA-MODEL §5, §15, §16).
--
--   job_part_requests  an item proposed on an open job: an indent part (a
--                      shop-owned, quantity-tracked product) or a catalogue
--                      service for fitting it. No stock movement and no job
--                      line until it is fitted (D140): fitting adds an
--                      ordinary line through add_inventory_line or
--                      add_service_line, so D15, D23 and D24 and every
--                      total, yield and Cult Commons figure are unchanged.
--   quotes, quote_items a snapshot of chosen proposed items sent to the
--                      customer (D141): one open quote per job, valid 1-30
--                      days (7 by default), reached by a link holding a
--                      32-byte random token of which only the SHA-256 is
--                      stored.
--   RPCs               propose_part, propose_service, cancel_part_request,
--                      send_quote (returns the token once), withdraw_quote,
--                      order_part_requests (D145, manage_purchasing),
--                      part_request_arrivals and indent_reservations (D146),
--                      fit_part_request; and, for anyone holding the link,
--                      quote_by_token and answer_quote (D142, D143).
--
-- Access (D147): staff read requests, quotes and items (never the token
-- hash); the expected cost and supplier only through
-- job_part_requests_staff (D60's can_view_purchase_costs). Writes only
-- through the RPCs. anon reaches nothing but the two token RPCs; customers'
-- my_* RPCs show nothing of quotes, and their timeline lists its own event
-- types (D8), so the new ones never reach it.
--
-- Lock order: the work order (private.lock_work_order) before its requests
-- and quotes; then, when ordering, purchase orders through the purchasing
-- RPCs (which never lock work orders, DATA-MODEL §10); fitting calls
-- add_inventory_line / add_service_line, which take the same job lock
-- first.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.part_request_kind as enum ('part', 'service');

create type public.part_request_status as enum (
  'proposed',   -- on the job, not on an open quote
  'quoted',     -- on the job's open quote, waiting for the customer
  'approved',   -- the customer approved it (or staff fit it straight away)
  'declined',   -- the customer declined it
  'ordered',    -- on a purchase order line (parts only, D145)
  'fitted',     -- became a job line (D140, D146)
  'cancelled'   -- withdrawn by staff, with a reason
);

create type public.quote_status as enum ('open', 'answered', 'withdrawn');

create type public.quote_channel as enum ('whatsapp', 'email', 'link');

-- ---------------------------------------------------------------------------
-- job_part_requests
-- ---------------------------------------------------------------------------
create table public.job_part_requests (
  -- Client-supplied by the app's form id (propose's idempotency key).
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  kind public.part_request_kind not null,
  product_id uuid null references public.products (id) on delete restrict,
  service_id uuid null references public.services (id) on delete restrict,
  -- What the customer is shown: the product's or service's name when
  -- proposed.
  description text not null,
  quantity public.line_quantity not null,
  unit_sale_price public.money_amount not null,
  currency char(3) not null,
  line_total public.money_amount generated always as (round(quantity * unit_sale_price, 2)) stored,
  -- Purchase data (D60, D147): no column grant to authenticated; read
  -- through job_part_requests_staff.
  expected_unit_cost public.money_amount null,
  supplier_id uuid null references public.suppliers (id) on delete restrict,
  status public.part_request_status not null default 'proposed',
  purchase_order_line_id uuid null references public.purchase_order_lines (id) on delete restrict,
  work_order_line_item_id uuid null references public.work_order_line_items (id) on delete restrict,
  cancel_reason text null,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz null,
  ordered_at timestamptz null,
  ordered_by uuid null references public.staff (id) on delete restrict,
  fitted_at timestamptz null,
  fitted_by uuid null references public.staff (id) on delete restrict,
  cancelled_at timestamptz null,
  cancelled_by uuid null references public.staff (id) on delete restrict,
  constraint job_part_requests_kind_source check (
    (kind = 'part' and product_id is not null and service_id is null)
    or (kind = 'service' and service_id is not null and product_id is null)
  ),
  constraint job_part_requests_description_check check (
    pg_catalog.btrim(description) <> '' and pg_catalog.char_length(description) <= 200
  ),
  constraint job_part_requests_quantity_check check (
    quantity > 0 and quantity <= 999 and (kind = 'service' or quantity = pg_catalog.trunc(quantity))
  ),
  constraint job_part_requests_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint job_part_requests_service_no_purchase check (
    kind = 'part' or (expected_unit_cost is null and supplier_id is null and purchase_order_line_id is null)
  ),
  constraint job_part_requests_ordered_has_line check (
    status <> 'ordered' or purchase_order_line_id is not null
  ),
  constraint job_part_requests_fitted_has_line check (
    (status = 'fitted') = (work_order_line_item_id is not null)
  ),
  constraint job_part_requests_cancelled_has_reason check (
    (status = 'cancelled') = (cancel_reason is not null)
  ),
  constraint job_part_requests_cancel_reason_check check (pg_catalog.char_length(cancel_reason) <= 500)
);

create index job_part_requests_work_order_idx on public.job_part_requests (work_order_id, created_at);
create index job_part_requests_product_idx on public.job_part_requests (product_id) where product_id is not null;
create index job_part_requests_service_idx on public.job_part_requests (service_id) where service_id is not null;
create index job_part_requests_po_line_idx
  on public.job_part_requests (purchase_order_line_id) where purchase_order_line_id is not null;
create index job_part_requests_supplier_idx on public.job_part_requests (supplier_id) where supplier_id is not null;
create unique index job_part_requests_line_key
  on public.job_part_requests (work_order_line_item_id) where work_order_line_item_id is not null;
create index job_part_requests_created_by_idx on public.job_part_requests (created_by);
create index job_part_requests_ordered_by_idx on public.job_part_requests (ordered_by);
create index job_part_requests_fitted_by_idx on public.job_part_requests (fitted_by);
create index job_part_requests_cancelled_by_idx on public.job_part_requests (cancelled_by);

comment on table public.job_part_requests is
  'D140: an indent part or a fitting service proposed on a job. No movement and no job line until fitted. Written only by the Phase 13 RPCs.';
comment on column public.job_part_requests.expected_unit_cost is
  'D60/D147: purchase cost; not granted to authenticated; read through job_part_requests_staff.';
comment on column public.job_part_requests.supplier_id is
  'D60/D147: who it is expected from; not granted to authenticated; read through job_part_requests_staff.';

create trigger job_part_requests_set_updated_at
  before update on public.job_part_requests
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- quotes and quote_items
-- ---------------------------------------------------------------------------
create table public.quotes (
  -- Client-supplied (send_quote's form id).
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  -- SHA-256 of the link's token text (D141). Never granted to anyone but
  -- the definer RPCs: a database read cannot answer a quote.
  token_hash bytea not null,
  status public.quote_status not null default 'open',
  channel public.quote_channel not null,
  currency char(3) not null,
  total public.money_amount not null,
  expires_at timestamptz not null,
  sent_by uuid not null references public.staff (id) on delete restrict,
  sent_at timestamptz not null default clock_timestamp(),
  answered_at timestamptz null,
  -- What the person answering typed (D142); not proof of identity (R-078).
  answered_name text null,
  withdrawn_at timestamptz null,
  withdrawn_by uuid null references public.staff (id) on delete restrict,
  constraint quotes_token_hash_key unique (token_hash),
  constraint quotes_token_hash_length check (pg_catalog.octet_length(token_hash) = 32),
  constraint quotes_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint quotes_answered_fields check (
    (status = 'answered') = (answered_at is not null and answered_name is not null)
  ),
  constraint quotes_withdrawn_fields check ((status = 'withdrawn') = (withdrawn_at is not null)),
  constraint quotes_answered_name_check check (
    pg_catalog.char_length(answered_name) between 1 and 100
  )
);

-- D141: one open quote per job.
create unique index quotes_one_open_per_job on public.quotes (work_order_id) where status = 'open';
create index quotes_work_order_idx on public.quotes (work_order_id, sent_at);
create index quotes_sent_by_idx on public.quotes (sent_by);
create index quotes_withdrawn_by_idx on public.quotes (withdrawn_by);

comment on table public.quotes is
  'D141: the items sent to the customer for one job, answered once by link (D142). token_hash is never readable through the API.';

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete restrict,
  part_request_id uuid not null references public.job_part_requests (id) on delete restrict,
  position smallint not null,
  -- Snapshot of the request when the quote was sent.
  kind public.part_request_kind not null,
  description text not null,
  quantity public.line_quantity not null,
  unit_sale_price public.money_amount not null,
  line_total public.money_amount not null,
  -- The customer's answer (D142); null until answered.
  decision text null,
  constraint quote_items_request_once unique (quote_id, part_request_id),
  constraint quote_items_position_once unique (quote_id, position),
  constraint quote_items_decision_check check (decision in ('approved', 'declined'))
);

create index quote_items_part_request_idx on public.quote_items (part_request_id);

comment on table public.quote_items is
  'D141/D142: one quoted item and the customer''s answer to it.';

-- ---------------------------------------------------------------------------
-- The staff view with purchase data (D60, D147)
-- ---------------------------------------------------------------------------
create view public.job_part_requests_staff
with (security_barrier)
as
  select r.id, r.work_order_id, r.kind, r.expected_unit_cost, r.supplier_id, s.name as supplier_name
  from public.job_part_requests r
  left join public.suppliers s on s.id = r.supplier_id
  where (select private.can_view_purchase_costs());

comment on view public.job_part_requests_staff is
  'D60/D147: each request''s expected cost and supplier, for view_costs or manage_purchasing holders only.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The SHA-256 of a link token, or null when the text cannot be one of ours
-- (43 base64url characters). Anything else never reaches a lookup.
create function private.quote_token_hash(token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select case
    when quote_token_hash.token ~ '^[A-Za-z0-9_-]{43}$'
      then pg_catalog.sha256(pg_catalog.convert_to(quote_token_hash.token, 'UTF8'))
  end;
$$;

-- The job's open quote, if any, withdrawn: its quoted requests go back to
-- proposed. Callers hold the job lock.
create function private.withdraw_open_quote(work_order_id uuid, actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  open_quote public.quotes;
begin
  select q.* into open_quote
  from public.quotes q
  where q.work_order_id = withdraw_open_quote.work_order_id and q.status = 'open'
  for update;
  if not found then
    return null;
  end if;
  update public.quotes q
  set status = 'withdrawn', withdrawn_at = pg_catalog.clock_timestamp(), withdrawn_by = withdraw_open_quote.actor
  where q.id = open_quote.id;
  update public.job_part_requests r
  set status = 'proposed'
  where r.status = 'quoted'
    and r.id in (select i.part_request_id from public.quote_items i where i.quote_id = open_quote.id);
  perform private.record_work_order_event(
    open_quote.work_order_id, 'quote_withdrawn', pg_catalog.jsonb_build_object('quote_id', open_quote.id)
  );
  return open_quote.id;
end;
$$;

-- What the quote page may show for one quote (D143): never costs, notes,
-- staff, contact details or other jobs. A withdrawn or expired quote shows
-- its state and job number only.
create function private.quote_view(quote public.quotes)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  wo public.work_orders;
  bike public.bikes;
  first_name text;
  state text;
begin
  select w.* into wo from public.work_orders w where w.id = quote.work_order_id;
  state := case
    when quote.status = 'open' and quote.expires_at <= pg_catalog.clock_timestamp() then 'expired'
    else quote.status::text
  end;
  if state in ('withdrawn', 'expired') then
    return pg_catalog.jsonb_build_object('status', state, 'job_number', wo.job_number);
  end if;
  select b.* into bike from public.bikes b where b.id = wo.bike_id;
  select c.first_name into first_name from public.customers c where c.id = wo.customer_id;
  return pg_catalog.jsonb_build_object(
    'status', state,
    'job_number', wo.job_number,
    'bike', pg_catalog.concat_ws(' ', bike.brand, bike.model, bike.variant),
    'first_name', first_name,
    'currency', quote.currency,
    'total', quote.total,
    'sent_at', quote.sent_at,
    'expires_at', quote.expires_at,
    'answered_at', quote.answered_at,
    'answered_name', quote.answered_name,
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', i.id,
          'kind', i.kind,
          'description', i.description,
          'quantity', i.quantity,
          'unit_sale_price', i.unit_sale_price,
          'line_total', i.line_total,
          'decision', i.decision
        )
        order by i.position
      )
      from public.quote_items i
      where i.quote_id = quote.id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- propose_part / propose_service (D140, D147)
-- ---------------------------------------------------------------------------

-- Active staff (any). Proposes an indent part on an open job: a shop-owned,
-- quantity-tracked, active product in the job's currency, at its selling
-- price unless one is given. Expected cost and supplier need
-- can_view_purchase_costs. Replay-safe on request_id.
create function public.propose_part(
  request_id uuid,
  work_order_id uuid,
  product_id uuid,
  quantity integer default 1,
  unit_sale_price public.money_amount default null,
  expected_unit_cost public.money_amount default null,
  supplier_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  existing public.job_part_requests;
  prod public.products;
  price public.money_amount;
begin
  if propose_part.request_id is null or propose_part.work_order_id is null
     or propose_part.product_id is null or propose_part.quantity is null then
    raise exception 'request_id, work_order_id, product_id and quantity are required' using errcode = '22004';
  end if;

  wo := private.lock_work_order(propose_part.work_order_id);
  select r.* into existing from public.job_part_requests r where r.id = propose_part.request_id;
  if found then
    if existing.work_order_id <> wo.id or existing.kind <> 'part'
       or existing.product_id is distinct from propose_part.product_id then
      raise exception using
        errcode = 'P0001',
        message = 'part_request_conflict',
        detail = 'That request id is already used for another item.';
    end if;
    return existing.id;
  end if;
  perform private.require_open_work_order(wo.id);

  if propose_part.quantity < 1 or propose_part.quantity > 999 then
    raise exception using
      errcode = 'P0001',
      message = 'quantity_invalid',
      detail = 'Add between 1 and 999.';
  end if;
  select p.* into prod from public.products p where p.id = propose_part.product_id;
  if not found then
    raise exception 'product % not found', propose_part.product_id using errcode = 'P0002';
  end if;
  if prod.archived_at is not null then
    raise exception using errcode = 'P0001', message = 'product_archived', detail = 'That product is archived.';
  end if;
  if not prod.active then
    raise exception using errcode = 'P0001', message = 'product_inactive', detail = 'That product is inactive.';
  end if;
  -- D62: only what a purchase order can order.
  if prod.tracking_type <> 'quantity' or prod.ownership_type <> 'shop_owned' then
    raise exception using
      errcode = 'P0001',
      message = 'indent_product_invalid',
      detail = 'Only shop-owned products counted by quantity can be ordered for a job.';
  end if;
  if prod.currency <> wo.currency then
    raise exception using
      errcode = 'P0001',
      message = 'currency_mismatch',
      detail = 'That product is priced in another currency than the job.';
  end if;

  price := coalesce(propose_part.unit_sale_price, private.selling_price(prod.id, null));
  if price is null then
    raise exception using
      errcode = 'P0001',
      message = 'part_price_missing',
      detail = 'Set a price for this part before proposing it.';
  end if;
  if price < 0 then
    raise exception using errcode = 'P0001', message = 'price_invalid', detail = 'A price cannot be negative.';
  end if;

  if (propose_part.expected_unit_cost is not null or propose_part.supplier_id is not null)
     and not private.can_view_purchase_costs() then
    raise exception 'permission view_costs or manage_purchasing required to set a cost or supplier'
      using errcode = '42501';
  end if;
  if propose_part.expected_unit_cost is not null and propose_part.expected_unit_cost < 0 then
    raise exception using errcode = 'P0001', message = 'cost_invalid', detail = 'A cost cannot be negative.';
  end if;
  if propose_part.supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = propose_part.supplier_id and s.archived_at is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'supplier_unavailable',
      detail = 'That supplier does not exist or is archived.';
  end if;

  insert into public.job_part_requests (
    id, work_order_id, kind, product_id, description, quantity, unit_sale_price, currency,
    expected_unit_cost, supplier_id, created_by
  ) values (
    propose_part.request_id, wo.id, 'part', prod.id, prod.name, propose_part.quantity, price, wo.currency,
    propose_part.expected_unit_cost, propose_part.supplier_id, actor
  );
  perform private.record_work_order_event(
    wo.id,
    'part_requested',
    pg_catalog.jsonb_build_object(
      'request_id', propose_part.request_id, 'kind', 'part', 'description', prod.name,
      'quantity', propose_part.quantity
    )
  );
  return propose_part.request_id;
end;
$$;

comment on function public.propose_part(uuid, uuid, uuid, integer, public.money_amount, public.money_amount, uuid) is
  'D140: active staff propose an indent part on an open job (no movement, no line); cost and supplier need view_costs or manage_purchasing; replay-safe.';

-- Active staff (any). Proposes a catalogue service (fitting labour) on an
-- open job, at the service's price unless one is given. Replay-safe.
create function public.propose_service(
  request_id uuid,
  work_order_id uuid,
  service_id uuid,
  quantity public.line_quantity default 1,
  unit_sale_price public.money_amount default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  existing public.job_part_requests;
  svc public.services;
  price public.money_amount;
begin
  if propose_service.request_id is null or propose_service.work_order_id is null
     or propose_service.service_id is null or propose_service.quantity is null then
    raise exception 'request_id, work_order_id, service_id and quantity are required' using errcode = '22004';
  end if;

  wo := private.lock_work_order(propose_service.work_order_id);
  select r.* into existing from public.job_part_requests r where r.id = propose_service.request_id;
  if found then
    if existing.work_order_id <> wo.id or existing.kind <> 'service'
       or existing.service_id is distinct from propose_service.service_id then
      raise exception using
        errcode = 'P0001',
        message = 'part_request_conflict',
        detail = 'That request id is already used for another item.';
    end if;
    return existing.id;
  end if;
  perform private.require_open_work_order(wo.id);

  if propose_service.quantity <= 0 or propose_service.quantity > 999 then
    raise exception using
      errcode = 'P0001',
      message = 'quantity_invalid',
      detail = 'Add between 0.01 and 999.';
  end if;
  select s.* into svc from public.services s where s.id = propose_service.service_id;
  if not found then
    raise exception 'service % not found', propose_service.service_id using errcode = 'P0002';
  end if;
  if svc.archived_at is not null or not svc.active then
    raise exception using
      errcode = 'P0001',
      message = 'service_unavailable',
      detail = 'That service is archived or inactive.';
  end if;
  if svc.currency <> wo.currency then
    raise exception using
      errcode = 'P0001',
      message = 'currency_mismatch',
      detail = 'That service is priced in another currency than the job.';
  end if;
  price := coalesce(propose_service.unit_sale_price, svc.default_sale_price);
  if price < 0 then
    raise exception using errcode = 'P0001', message = 'price_invalid', detail = 'A price cannot be negative.';
  end if;

  insert into public.job_part_requests (
    id, work_order_id, kind, service_id, description, quantity, unit_sale_price, currency, created_by
  ) values (
    propose_service.request_id, wo.id, 'service', svc.id, svc.name, propose_service.quantity, price,
    wo.currency, actor
  );
  perform private.record_work_order_event(
    wo.id,
    'part_requested',
    pg_catalog.jsonb_build_object(
      'request_id', propose_service.request_id, 'kind', 'service', 'description', svc.name,
      'quantity', propose_service.quantity
    )
  );
  return propose_service.request_id;
end;
$$;

comment on function public.propose_service(uuid, uuid, uuid, public.line_quantity, public.money_amount) is
  'D140: active staff propose a catalogue service (fitting) on an open job; replay-safe.';

-- ---------------------------------------------------------------------------
-- cancel_part_request
-- ---------------------------------------------------------------------------

-- Active staff (any). Cancels a request that is not on an open quote and
-- not fitted, with a reason. An ordered part stays on its purchase order
-- (staff change the order themselves). Replay: a cancelled request is
-- returned as is.
create function public.cancel_part_request(request_id uuid, reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  cleaned text := nullif(pg_catalog.btrim(cancel_part_request.reason), '');
  req public.job_part_requests;
  wo public.work_orders;
begin
  if cancel_part_request.request_id is null then
    raise exception 'request_id is required' using errcode = '22004';
  end if;
  select r.* into req from public.job_part_requests r where r.id = cancel_part_request.request_id;
  if not found then
    raise exception 'part request % not found', cancel_part_request.request_id using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(req.work_order_id);
  select r.* into req from public.job_part_requests r where r.id = cancel_part_request.request_id for update;
  if req.status = 'cancelled' then
    return req.id;
  end if;
  perform private.require_unclosed_work_order(wo);
  if req.status = 'quoted' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_quoted',
      detail = 'It is on the quote the customer has. Withdraw the quote first.';
  end if;
  if req.status = 'fitted' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_fitted',
      detail = 'It is already on the job. Void the line instead.';
  end if;
  if cleaned is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why it is cancelled.';
  end if;
  if pg_catalog.char_length(cleaned) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;
  update public.job_part_requests r
  set status = 'cancelled', cancel_reason = cleaned, cancelled_at = pg_catalog.clock_timestamp(),
      cancelled_by = actor
  where r.id = req.id;
  perform private.record_work_order_event(
    wo.id,
    'part_request_cancelled',
    pg_catalog.jsonb_build_object(
      'request_id', req.id, 'description', req.description, 'reason', cleaned,
      'was', req.status::text
    )
  );
  return req.id;
end;
$$;

comment on function public.cancel_part_request(uuid, text) is
  'D140: active staff cancel a request not on an open quote and not fitted, with a reason; replay-safe.';

-- ---------------------------------------------------------------------------
-- send_quote / withdraw_quote (D141, D144)
-- ---------------------------------------------------------------------------

-- Active staff (any). Sends the given proposed items of an open job as a
-- quote valid valid_days (1-30) and returns the link token, once: only its
-- SHA-256 is kept. The job's previous open quote, if any, is withdrawn first
-- (its items go back to proposed and may be sent again). A second call with
-- the same quote_id is refused: the token cannot be shown again, so the app
-- sends a new quote instead.
create function public.send_quote(
  quote_id uuid,
  work_order_id uuid,
  request_ids uuid[],
  channel public.quote_channel,
  valid_days integer default 7
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  wanted integer;
  found_count integer;
  token text;
  quote_total public.money_amount;
begin
  if send_quote.quote_id is null or send_quote.work_order_id is null
     or send_quote.request_ids is null or send_quote.channel is null or send_quote.valid_days is null then
    raise exception 'quote_id, work_order_id, request_ids, channel and valid_days are required'
      using errcode = '22004';
  end if;

  wo := private.lock_work_order(send_quote.work_order_id);
  if exists (select 1 from public.quotes q where q.id = send_quote.quote_id) then
    raise exception using
      errcode = 'P0001',
      message = 'quote_already_sent',
      detail = 'This quote was already sent. Send a new one to get a new link.';
  end if;
  perform private.require_open_work_order(wo.id);

  if send_quote.valid_days < 1 or send_quote.valid_days > 30 then
    raise exception using
      errcode = 'P0001',
      message = 'quote_validity_invalid',
      detail = 'A quote is valid for 1 to 30 days.';
  end if;
  wanted := pg_catalog.cardinality(send_quote.request_ids);
  if wanted is null or wanted < 1 or wanted > 50
     or wanted <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(send_quote.request_ids) as x) then
    raise exception using
      errcode = 'P0001',
      message = 'quote_items_invalid',
      detail = 'Choose 1 to 50 different items.';
  end if;

  -- The previous open quote goes first, so its items can be sent again.
  perform private.withdraw_open_quote(wo.id, actor);

  perform 1 from public.job_part_requests r
  where r.id = any (send_quote.request_ids)
  for update;
  select pg_catalog.count(*) into found_count
  from public.job_part_requests r
  where r.id = any (send_quote.request_ids) and r.work_order_id = wo.id and r.status = 'proposed';
  if found_count <> wanted then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_proposed',
      detail = 'Only items proposed on this job and not on another quote can be sent.';
  end if;

  -- 32 random bytes as base64url without padding: 43 characters.
  token := pg_catalog.rtrim(
    pg_catalog.translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
    '='
  );
  select coalesce(sum(r.line_total), 0) into quote_total
  from public.job_part_requests r where r.id = any (send_quote.request_ids);

  insert into public.quotes (id, work_order_id, token_hash, channel, currency, total, expires_at, sent_by)
  values (
    send_quote.quote_id, wo.id, private.quote_token_hash(token), send_quote.channel, wo.currency,
    quote_total, pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => send_quote.valid_days), actor
  );
  insert into public.quote_items (
    quote_id, part_request_id, position, kind, description, quantity, unit_sale_price, line_total
  )
  select send_quote.quote_id, r.id, x.ord::smallint, r.kind, r.description, r.quantity, r.unit_sale_price,
         r.line_total
  from pg_catalog.unnest(send_quote.request_ids) with ordinality as x (id, ord)
  join public.job_part_requests r on r.id = x.id;
  update public.job_part_requests r set status = 'quoted' where r.id = any (send_quote.request_ids);

  perform private.record_work_order_event(
    wo.id,
    'quote_sent',
    pg_catalog.jsonb_build_object(
      'quote_id', send_quote.quote_id, 'channel', send_quote.channel::text, 'items', wanted,
      'valid_days', send_quote.valid_days
    )
  );
  return token;
end;
$$;

comment on function public.send_quote(uuid, uuid, uuid[], public.quote_channel, integer) is
  'D141/D144: active staff send proposed items as a quote; returns the link token once (only its hash is stored); withdraws the job''s previous open quote.';

-- Active staff (any). Withdraws an open quote: its link stops working and
-- its items go back to proposed. Replay: a withdrawn quote is returned.
create function public.withdraw_quote(quote_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  q public.quotes;
begin
  if withdraw_quote.quote_id is null then
    raise exception 'quote_id is required' using errcode = '22004';
  end if;
  select x.* into q from public.quotes x where x.id = withdraw_quote.quote_id;
  if not found then
    raise exception 'quote % not found', withdraw_quote.quote_id using errcode = 'P0002';
  end if;
  perform private.lock_work_order(q.work_order_id);
  select x.* into q from public.quotes x where x.id = withdraw_quote.quote_id for update;
  if q.status = 'withdrawn' then
    return q.id;
  end if;
  if q.status = 'answered' then
    raise exception using
      errcode = 'P0001',
      message = 'quote_answered',
      detail = 'The customer has already answered this quote.';
  end if;
  perform private.withdraw_open_quote(q.work_order_id, actor);
  return q.id;
end;
$$;

comment on function public.withdraw_quote(uuid) is
  'D141: active staff withdraw an open quote; its items go back to proposed; replay-safe.';

-- ---------------------------------------------------------------------------
-- quote_by_token / answer_quote (D142, D143): anyone holding the link
-- ---------------------------------------------------------------------------

-- The quote page's data for a link token, or null when no quote has it.
create function public.quote_by_token(token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hashed bytea := private.quote_token_hash(quote_by_token.token);
  q public.quotes;
begin
  if hashed is null then
    return null;
  end if;
  select x.* into q from public.quotes x where x.token_hash = hashed;
  if not found then
    return null;
  end if;
  return private.quote_view(q);
end;
$$;

comment on function public.quote_by_token(text) is
  'D143: what the quote page shows for a link token (no costs, notes, staff or contact details); null for an unknown token.';

-- Anyone holding the link answers every item once (D142): decisions is a
-- JSON array of {"item_id": uuid, "approve": boolean}, one per quote item;
-- name is what they type (1-100 characters). Approved part requests become
-- approved, declined ones declined; the job's approval flag is set when
-- anything is approved, and its note says what was answered online, by whom
-- and when. Returns the page's data afterwards. Only an open, unexpired
-- quote of an open job can be answered.
create function public.answer_quote(token text, decisions jsonb, name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  hashed bytea := private.quote_token_hash(answer_quote.token);
  cleaned_name text := nullif(pg_catalog.btrim(answer_quote.name), '');
  q public.quotes;
  wo public.work_orders;
  item_count integer;
  answered_count integer;
  approved_count integer;
  answer_note text;
begin
  if hashed is null then
    raise exception using errcode = 'P0002', message = 'quote_not_found', detail = 'This link is not valid.';
  end if;
  select x.* into q from public.quotes x where x.token_hash = hashed;
  if not found then
    raise exception using errcode = 'P0002', message = 'quote_not_found', detail = 'This link is not valid.';
  end if;
  wo := private.lock_work_order(q.work_order_id);
  select x.* into q from public.quotes x where x.id = q.id for update;

  if q.status <> 'open' then
    raise exception using
      errcode = 'P0001',
      message = 'quote_not_open',
      detail = 'This quote has already been answered or replaced.';
  end if;
  if q.expires_at <= pg_catalog.clock_timestamp() then
    raise exception using
      errcode = 'P0001',
      message = 'quote_expired',
      detail = 'This quote has expired. Ask the shop for a new one.';
  end if;
  if not private.work_order_status_is_open(wo.status) then
    raise exception using
      errcode = 'P0001',
      message = 'quote_not_open',
      detail = 'This job is closed. Ask the shop.';
  end if;
  if cleaned_name is null or pg_catalog.char_length(cleaned_name) > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'quote_name_required',
      detail = 'Type your name (up to 100 characters).';
  end if;

  if answer_quote.decisions is null or pg_catalog.jsonb_typeof(answer_quote.decisions) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = 'quote_answer_incomplete',
      detail = 'Answer every item.';
  end if;
  select pg_catalog.count(*) into item_count from public.quote_items i where i.quote_id = q.id;
  -- Exactly one well-formed answer per item of this quote.
  select pg_catalog.count(distinct i.id) into answered_count
  from pg_catalog.jsonb_array_elements(answer_quote.decisions) as d (value)
  join public.quote_items i
    on i.quote_id = q.id
   and i.id = case
     when pg_catalog.jsonb_typeof(d.value -> 'item_id') = 'string'
      and (d.value ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       then (d.value ->> 'item_id')::uuid
   end
  where pg_catalog.jsonb_typeof(d.value) = 'object'
    and pg_catalog.jsonb_typeof(d.value -> 'approve') = 'boolean';
  if answered_count <> item_count or pg_catalog.jsonb_array_length(answer_quote.decisions) <> item_count then
    raise exception using
      errcode = 'P0001',
      message = 'quote_answer_incomplete',
      detail = 'Answer every item once.';
  end if;

  update public.quote_items i
  set decision = case when (d.value ->> 'approve')::boolean then 'approved' else 'declined' end
  from pg_catalog.jsonb_array_elements(answer_quote.decisions) as d (value)
  where i.quote_id = q.id and i.id = (d.value ->> 'item_id')::uuid;

  update public.job_part_requests r
  set status = case when i.decision = 'approved' then 'approved'::public.part_request_status
                    else 'declined'::public.part_request_status end,
      decided_at = pg_catalog.clock_timestamp()
  from public.quote_items i
  where i.quote_id = q.id and r.id = i.part_request_id and r.status = 'quoted';

  update public.quotes x
  set status = 'answered', answered_at = pg_catalog.clock_timestamp(), answered_name = cleaned_name
  where x.id = q.id
  returning x.* into q;

  select pg_catalog.count(*) into approved_count
  from public.quote_items i where i.quote_id = q.id and i.decision = 'approved';
  answer_note := pg_catalog.left(
    pg_catalog.format(
      'Quote answered online by %s on %s: %s of %s items approved.',
      cleaned_name,
      pg_catalog.to_char(q.answered_at at time zone 'Asia/Singapore', 'DD Mon YYYY HH24:MI'),
      approved_count,
      item_count
    ),
    500
  );
  update public.work_orders w
  set approval_flag = (w.approval_flag or approved_count > 0), approval_note = answer_note
  where w.id = wo.id;

  perform private.record_work_order_event(
    wo.id,
    'quote_answered',
    pg_catalog.jsonb_build_object(
      'quote_id', q.id, 'name', cleaned_name, 'approved', approved_count,
      'declined', item_count - approved_count
    )
  );
  return private.quote_view(q);
end;
$$;

comment on function public.answer_quote(text, jsonb, text) is
  'D142: whoever holds the link answers every item of an open, unexpired quote once; sets the job''s approval flag and note.';

-- ---------------------------------------------------------------------------
-- order_part_requests (D145)
-- ---------------------------------------------------------------------------

-- manage_purchasing. Orders approved indent parts from one supplier: they
-- go on the supplier's newest draft purchase order, or on a new draft with
-- purchase_order_id when the supplier has none; each product's line rises
-- by the requests' quantities (cost: the line's, else the requests'
-- expected cost, else purchase_cost_defaults), and each request is linked
-- to its line. move_to_waiting moves each open job not already waiting on
-- parts to Waiting on parts when its status allows it. Replay: when every
-- request is already ordered, their purchase order is returned. Returns the
-- purchase order id.
create function public.order_part_requests(
  request_ids uuid[],
  supplier_id uuid,
  purchase_order_id uuid,
  move_to_waiting boolean default true
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_purchasing');
  wanted integer;
  job record;
  po_id uuid;
  po public.purchase_orders;
  prod record;
  line public.purchase_order_lines;
  line_id uuid;
  cost public.money_amount;
  ordered_po uuid;
  ordered_count integer;
begin
  if order_part_requests.request_ids is null or order_part_requests.supplier_id is null
     or order_part_requests.purchase_order_id is null or order_part_requests.move_to_waiting is null then
    raise exception 'request_ids, supplier_id, purchase_order_id and move_to_waiting are required'
      using errcode = '22004';
  end if;
  wanted := pg_catalog.cardinality(order_part_requests.request_ids);
  if wanted is null or wanted < 1 or wanted > 50
     or wanted <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(order_part_requests.request_ids) as x) then
    raise exception using
      errcode = 'P0001',
      message = 'order_items_invalid',
      detail = 'Choose 1 to 50 different parts.';
  end if;

  -- The jobs first, in id order (lock order), then the requests.
  for job in
    select distinct r.work_order_id as id
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    order by r.work_order_id
  loop
    perform private.lock_work_order(job.id);
  end loop;
  perform 1 from public.job_part_requests r where r.id = any (order_part_requests.request_ids) for update;

  -- Replay: everything already ordered, on one purchase order.
  select pg_catalog.count(*), pg_catalog.min(l.purchase_order_id::text)::uuid
  into ordered_count, ordered_po
  from public.job_part_requests r
  join public.purchase_order_lines l on l.id = r.purchase_order_line_id
  where r.id = any (order_part_requests.request_ids) and r.status = 'ordered';
  if ordered_count = wanted then
    return ordered_po;
  end if;

  if (select pg_catalog.count(*) from public.job_part_requests r
      where r.id = any (order_part_requests.request_ids) and r.kind = 'part' and r.status = 'approved') <> wanted then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_approved',
      detail = 'Only approved parts that are not ordered yet can be ordered.';
  end if;
  if not exists (
    select 1 from public.suppliers s where s.id = order_part_requests.supplier_id and s.archived_at is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'supplier_unavailable',
      detail = 'That supplier does not exist or is archived.';
  end if;

  select o.id into po_id
  from public.purchase_orders o
  where o.supplier_id = order_part_requests.supplier_id and o.status = 'draft'
  order by o.created_at desc, o.id
  limit 1;
  if po_id is null then
    po := public.create_purchase_order(order_part_requests.purchase_order_id, order_part_requests.supplier_id);
    po_id := po.id;
  end if;

  for prod in
    select r.product_id, sum(r.quantity)::integer as quantity,
           (pg_catalog.array_agg(r.expected_unit_cost order by r.created_at)
              filter (where r.expected_unit_cost is not null))[1] as expected_cost,
           pg_catalog.string_agg(distinct w.job_number, ', ') as jobs
    from public.job_part_requests r
    join public.work_orders w on w.id = r.work_order_id
    where r.id = any (order_part_requests.request_ids)
    group by r.product_id
    order by r.product_id
  loop
    select l.* into line
    from public.purchase_order_lines l
    where l.purchase_order_id = po_id and l.product_id = prod.product_id;
    if found then
      line_id := line.id;
      cost := line.unit_cost;
      perform public.set_purchase_order_line(
        line.id, po_id, prod.product_id, line.quantity_ordered + prod.quantity, cost,
        line.expected_at, line.notes, null
      );
    else
      line_id := gen_random_uuid();
      cost := coalesce(
        prod.expected_cost,
        (select d.unit_cost
         from public.purchase_cost_defaults(order_part_requests.supplier_id, array[prod.product_id]) d
         where d.product_id = prod.product_id),
        0
      );
      perform public.set_purchase_order_line(
        line_id, po_id, prod.product_id, prod.quantity, cost, null,
        pg_catalog.left('For ' || prod.jobs, 500), null
      );
    end if;
    update public.job_part_requests r
    set status = 'ordered', purchase_order_line_id = line_id, ordered_at = pg_catalog.clock_timestamp(),
        ordered_by = actor
    where r.id = any (order_part_requests.request_ids) and r.product_id = prod.product_id;
  end loop;

  select o.* into po from public.purchase_orders o where o.id = po_id;
  for job in
    select r.work_order_id as id, pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('request_id', r.id, 'description', r.description, 'quantity', r.quantity)
             order by r.created_at
           ) as items
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    group by r.work_order_id
    order by r.work_order_id
  loop
    perform private.record_work_order_event(
      job.id,
      'part_ordered',
      pg_catalog.jsonb_build_object('purchase_order', po.po_number, 'items', job.items)
    );
    if order_part_requests.move_to_waiting then
      perform public.set_work_order_status(job.id, 'awaiting_parts', 'Indent parts ordered: ' || po.po_number)
      from public.work_orders w
      where w.id = job.id
        and w.status <> 'awaiting_parts'
        and private.work_order_status_is_open(w.status)
        and private.work_order_transition_rule(w.status, 'awaiting_parts') = 'allowed';
    end if;
  end loop;
  return po_id;
end;
$$;

comment on function public.order_part_requests(uuid[], uuid, uuid, boolean) is
  'D145: manage_purchasing orders approved indent parts on the supplier''s draft purchase order (or a new one), linking each request to its line; replay-safe.';

-- ---------------------------------------------------------------------------
-- Arrival and reservation (D146)
-- ---------------------------------------------------------------------------

-- Every ordered request with how much of it has arrived: receipts on its
-- purchase order line cover the line's requests first requested first
-- covered (requests before any extra stock on the same line), and the
-- receiving location is the line's latest receipt's.
create function private.part_request_arrival_rows()
returns table (
  request_id uuid,
  work_order_id uuid,
  product_id uuid,
  quantity integer,
  arrived boolean,
  location_id uuid,
  purchase_order_id uuid,
  po_number text
)
language sql
stable
security definer
set search_path = ''
as $$
  with received as (
    select rl.purchase_order_line_id, sum(rl.quantity_received)::integer as received,
           (pg_catalog.array_agg(rl.location_id order by r.received_at desc, rl.created_at desc))[1] as location_id
    from public.purchase_receipt_lines rl
    join public.purchase_receipts r on r.id = rl.purchase_receipt_id
    group by rl.purchase_order_line_id
  ),
  queued as (
    select q.id, q.work_order_id, q.product_id, q.quantity::integer as quantity, q.purchase_order_line_id,
           sum(q.quantity::integer) over (
             partition by q.purchase_order_line_id order by q.ordered_at, q.created_at, q.id
           ) as cumulative
    from public.job_part_requests q
    where q.status in ('ordered', 'fitted') and q.purchase_order_line_id is not null
  )
  select q.id, q.work_order_id, q.product_id, q.quantity,
         coalesce(rc.received, 0) >= q.cumulative,
         rc.location_id, l.purchase_order_id, o.po_number
  from queued q
  join public.purchase_order_lines l on l.id = q.purchase_order_line_id
  join public.purchase_orders o on o.id = l.purchase_order_id
  left join received rc on rc.purchase_order_line_id = q.purchase_order_line_id;
$$;

-- Active staff. The ordered and fitted requests of one job with their
-- purchase order and whether they have arrived (D146).
create function public.part_request_arrivals(work_order_id uuid)
returns table (
  request_id uuid,
  arrived boolean,
  location_id uuid,
  purchase_order_id uuid,
  po_number text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_staff();
  return query
    select a.request_id, a.arrived, a.location_id, a.purchase_order_id, a.po_number
    from private.part_request_arrival_rows() a
    where a.work_order_id = part_request_arrivals.work_order_id;
end;
$$;

comment on function public.part_request_arrivals(uuid) is
  'D146: active staff read which ordered indent parts of a job have arrived, where, and on which purchase order.';

-- Active staff. Quantities of a product that have arrived for jobs and are
-- not fitted yet: shown as reserved, never held (D146, R-080).
create function public.indent_reservations(product_id uuid)
returns table (work_order_id uuid, job_number text, quantity integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_staff();
  return query
    select a.work_order_id, w.job_number, sum(a.quantity)::integer
    from private.part_request_arrival_rows() a
    join public.job_part_requests r on r.id = a.request_id
    join public.work_orders w on w.id = a.work_order_id
    where a.product_id = indent_reservations.product_id and a.arrived and r.status = 'ordered'
    group by a.work_order_id, w.job_number
    order by w.job_number;
end;
$$;

comment on function public.indent_reservations(uuid) is
  'D146: active staff read arrived, unfitted indent quantities of a product by job (shown as reserved, not held).';

-- ---------------------------------------------------------------------------
-- fit_part_request (D140, D146)
-- ---------------------------------------------------------------------------

-- Active staff (any). Puts an approved or ordered request on its open job:
-- a part through add_inventory_line (from location_id, else where it was
-- received, else add_inventory_line's default; D23 and D24 apply), a
-- service through add_service_line, both at the quoted price, with line_id
-- as the new line's id. Replay: a request fitted with that line returns it.
create function public.fit_part_request(request_id uuid, line_id uuid, location_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  req public.job_part_requests;
  wo public.work_orders;
  from_location uuid;
begin
  if fit_part_request.request_id is null or fit_part_request.line_id is null then
    raise exception 'request_id and line_id are required' using errcode = '22004';
  end if;
  select r.* into req from public.job_part_requests r where r.id = fit_part_request.request_id;
  if not found then
    raise exception 'part request % not found', fit_part_request.request_id using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(req.work_order_id);
  select r.* into req from public.job_part_requests r where r.id = fit_part_request.request_id for update;

  if req.status = 'fitted' then
    if req.work_order_line_item_id = fit_part_request.line_id then
      return req.work_order_line_item_id;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'part_request_fitted',
      detail = 'It is already on the job.';
  end if;
  if not (req.status = 'approved' or (req.kind = 'part' and req.status = 'ordered')) then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_approved',
      detail = 'Only an approved or ordered item can be put on the job.';
  end if;
  perform private.require_open_work_order(wo.id);

  if req.kind = 'part' then
    from_location := coalesce(
      fit_part_request.location_id,
      (select a.location_id from private.part_request_arrival_rows() a where a.request_id = req.id and a.arrived)
    );
    perform public.add_inventory_line(
      fit_part_request.line_id, wo.id, req.product_id, req.quantity::integer, from_location, null,
      req.unit_sale_price
    );
  else
    perform public.add_service_line(
      fit_part_request.line_id, wo.id, req.service_id, req.quantity, req.unit_sale_price, null, req.description
    );
  end if;

  update public.job_part_requests r
  set status = 'fitted', work_order_line_item_id = fit_part_request.line_id,
      fitted_at = pg_catalog.clock_timestamp(), fitted_by = actor
  where r.id = req.id;
  perform private.record_work_order_event(
    wo.id,
    'part_fitted',
    pg_catalog.jsonb_build_object(
      'request_id', req.id, 'line_id', fit_part_request.line_id, 'description', req.description,
      'quantity', req.quantity
    )
  );
  return fit_part_request.line_id;
end;
$$;

comment on function public.fit_part_request(uuid, uuid, uuid) is
  'D140/D146: active staff put an approved or ordered request on its open job as an ordinary line (add_inventory_line or add_service_line); replay-safe.';

-- ---------------------------------------------------------------------------
-- Privileges and row-level security (D147)
-- ---------------------------------------------------------------------------
revoke all on function
  private.quote_token_hash(text),
  private.withdraw_open_quote(uuid, uuid),
  private.quote_view(public.quotes),
  private.part_request_arrival_rows(),
  public.propose_part(uuid, uuid, uuid, integer, public.money_amount, public.money_amount, uuid),
  public.propose_service(uuid, uuid, uuid, public.line_quantity, public.money_amount),
  public.cancel_part_request(uuid, text),
  public.send_quote(uuid, uuid, uuid[], public.quote_channel, integer),
  public.withdraw_quote(uuid),
  public.quote_by_token(text),
  public.answer_quote(text, jsonb, text),
  public.order_part_requests(uuid[], uuid, uuid, boolean),
  public.part_request_arrivals(uuid),
  public.indent_reservations(uuid),
  public.fit_part_request(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.propose_part(uuid, uuid, uuid, integer, public.money_amount, public.money_amount, uuid),
  public.propose_service(uuid, uuid, uuid, public.line_quantity, public.money_amount),
  public.cancel_part_request(uuid, text),
  public.send_quote(uuid, uuid, uuid[], public.quote_channel, integer),
  public.withdraw_quote(uuid),
  public.order_part_requests(uuid[], uuid, uuid, boolean),
  public.part_request_arrivals(uuid),
  public.indent_reservations(uuid),
  public.fit_part_request(uuid, uuid, uuid)
to authenticated;

-- D143: the quote page, for anyone holding a link.
grant execute on function
  public.quote_by_token(text),
  public.answer_quote(text, jsonb, text)
to anon, authenticated;

alter table public.job_part_requests enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;

revoke all on table public.job_part_requests from public, anon, authenticated, service_role;
revoke all on table public.quotes from public, anon, authenticated, service_role;
revoke all on table public.quote_items from public, anon, authenticated, service_role;
revoke all on table public.job_part_requests_staff from public, anon, authenticated, service_role;

-- Every column except the purchase data (D60, D147).
grant select (
  id, work_order_id, kind, product_id, service_id, description, quantity, unit_sale_price, currency,
  line_total, status, purchase_order_line_id, work_order_line_item_id, cancel_reason, created_by,
  created_at, updated_at, decided_at, ordered_at, ordered_by, fitted_at, fitted_by, cancelled_at,
  cancelled_by
) on table public.job_part_requests to authenticated;
-- Every column except the token hash.
grant select (
  id, work_order_id, status, channel, currency, total, expires_at, sent_by, sent_at, answered_at,
  answered_name, withdrawn_at, withdrawn_by
) on table public.quotes to authenticated;
grant select on table public.quote_items to authenticated;
grant select on table public.job_part_requests_staff to authenticated;

create policy job_part_requests_select_staff on public.job_part_requests
  for select to authenticated
  using ((select private.is_staff()));

create policy quotes_select_staff on public.quotes
  for select to authenticated
  using ((select private.is_staff()));

create policy quote_items_select_staff on public.quote_items
  for select to authenticated
  using ((select private.is_staff()));
