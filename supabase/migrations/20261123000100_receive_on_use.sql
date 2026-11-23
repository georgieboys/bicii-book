set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D267 RECEIVE-ON-USE (the owner, 2026-11-23: "if I add a product while
-- doing a job and I see a product that is in the shop ... we need systems
-- intuitive enough so it does not become an administrative headache later
-- on"; amends D44/D50 for jobs). A consigned part in the mechanic's hand
-- is put on the job even when BICII holds less of it than that: the
-- missing quantity is received from the consignor at that moment, then
-- used, in one transaction. Consigned stock still never goes below zero
-- (it is received first). D268: what the consignor is owed for each, when
-- nobody says, is the product's last agreed amount, else half its price.
--
--   private.receive_for_use      the intake (no manage_consignments: any
--                                active staff on a job), flagged
--                                received_on_use for a manager to check.
--   private.add_part_lines       the part on the job: from the oldest
--                                consignments at that location first
--                                (one line each), then what was received.
--   public.add_part_to_job       Add part's entry point (any staff).
--   public.fit_part_request      re-created: Fit receives the same way.
--   public.check_received_on_use manage_consignments: the review list's
--                                "Looks right".
--
-- Shop-owned and unique parts go straight to add_inventory_line as before
-- (D23 allows shop stock below zero).

alter table public.consignment_items
  add column received_on_use boolean not null default false,
  add column use_checked_at timestamptz,
  add column use_checked_by uuid references public.staff (id) on delete restrict;

comment on column public.consignment_items.received_on_use is
  'D267: taken in on a job when the part was used and BICII held too little of it; listed for a manager to check (use_checked_at).';
comment on column public.consignment_items.use_checked_at is
  'D267: when a manager confirmed a received-on-use item (consignor and amount owed).';

-- Readable like the item's other columns (the agreed amount stays gated).
grant select (received_on_use, use_checked_at, use_checked_by)
  on table public.consignment_items to authenticated;

create index consignment_items_received_on_use_idx
  on public.consignment_items (received_at)
  where received_on_use and use_checked_at is null;

-- ---------------------------------------------------------------------------
-- The intake at the moment of use
-- ---------------------------------------------------------------------------
create function private.receive_for_use(
  prod public.products,
  location_id uuid,
  quantity integer,
  unit_sale_price public.money_amount,
  job_number text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  last_item public.consignment_items;
  chosen_consignor uuid;
  consignor_archived timestamptz;
  agreed public.money_amount;
  asking public.money_amount;
  new_item uuid := gen_random_uuid();
begin
  -- The product's latest consignment gives its consignor and terms.
  select i.* into last_item
  from public.consignment_items i
  join public.consignors c on c.id = i.consignor_id
  where i.product_id = prod.id and c.archived_at is null
  order by i.received_at desc, i.short_id desc
  limit 1;
  chosen_consignor := last_item.consignor_id;
  if chosen_consignor is null then
    -- Never consigned before: the consignor with the most items (the owner).
    select c.id into chosen_consignor
    from public.consignors c
    left join public.consignment_items i on i.consignor_id = c.id
    where c.archived_at is null
    group by c.id
    order by count(i.id) desc, c.created_at
    limit 1;
  end if;
  if chosen_consignor is null then
    raise exception using errcode = 'P0001', message = 'consignor_required',
      detail = 'No consignor is set up yet; add one under Consignment.';
  end if;
  -- Lock order 0b (as create_consignment_item): archiving waits.
  select c.archived_at into consignor_archived
  from public.consignors c where c.id = chosen_consignor for share;

  asking := coalesce(receive_for_use.unit_sale_price, last_item.asking_price, prod.default_sale_price);
  -- D268: the last agreed amount, else half the price, else nothing.
  agreed := coalesce(
    last_item.agreed_amount_owed,
    pg_catalog.round(coalesce(asking, 0) * 0.5, 2)
  );

  insert into public.consignment_items (
    id, consignor_id, product_id, quantity, received_at, agreed_amount_owed, asking_price, currency,
    internal_notes, request_fingerprint, received_on_use
  )
  values (
    new_item, chosen_consignor, prod.id, receive_for_use.quantity, pg_catalog.now(), agreed, asking,
    prod.currency, 'Received on use for ' || coalesce(receive_for_use.job_number, 'a job'),
    pg_catalog.md5('receive_for_use:' || new_item::text), true
  );
  perform private.record_linked_movement(
    prod.id, null, receive_for_use.location_id, receive_for_use.quantity, 'consignment_received', null,
    agreed, new_item, null, null, null, null, new_item
  );
  return new_item;
end;
$$;

comment on function private.receive_for_use(public.products, uuid, integer, public.money_amount, text) is
  'D267/D268: take in a consigned quantity at the moment of use, from the product''s latest consignor (else the consignor with the most items) at its last agreed amount (else half the price), flagged received_on_use. The caller holds the work order and stock locks.';

revoke all on function private.receive_for_use(public.products, uuid, integer, public.money_amount, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A part on a job, receiving what is missing
-- ---------------------------------------------------------------------------
create type public.add_part_result as (
  line_id uuid,
  line_count integer,
  received_quantity integer,
  location_id uuid,
  replayed boolean
);

comment on type public.add_part_result is
  'D267: the first job line a part became, how many lines it took (one per consignment), how many were received on use, from where, and whether the call was a replay.';

create function private.add_part_lines(
  wo public.work_orders,
  line_id uuid,
  product_id uuid,
  quantity integer,
  location_id uuid,
  unit_sale_price public.money_amount
)
returns public.add_part_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  prod public.products;
  loc uuid := add_part_lines.location_id;
  loc_active boolean;
  remaining integer := add_part_lines.quantity;
  piece record;
  take integer;
  n integer := 0;
  this_line uuid;
  received integer := 0;
  result public.add_part_result;
begin
  if add_part_lines.quantity is null or add_part_lines.quantity < 1 or add_part_lines.quantity > 999 then
    raise exception using errcode = 'P0001', message = 'quantity_invalid', detail = 'Add between 1 and 999.';
  end if;
  -- A replay: the first line exists already (the others were written in
  -- the same transaction). Anything else reusing the id is a clash.
  if exists (select 1 from public.work_order_line_items li where li.id = add_part_lines.line_id) then
    if not exists (
      select 1 from public.work_order_line_items li
      where li.id = add_part_lines.line_id and li.work_order_id = wo.id and li.line_type = 'inventory'
        and li.source_product_id = add_part_lines.product_id
    ) then
      raise exception using errcode = 'P0001', message = 'line_conflict',
        detail = 'That line id is already used for another line.';
    end if;
    select add_part_lines.line_id, 1, 0, null::uuid, true into result;
    return result;
  end if;

  select p.* into prod from public.products p where p.id = add_part_lines.product_id;
  if not found then
    raise exception 'product % not found', add_part_lines.product_id using errcode = 'P0002';
  end if;
  if prod.ownership_type <> 'consignment' or prod.tracking_type <> 'quantity'
     or not prod.active or prod.archived_at is not null then
    -- Shop stock, units and refusals: add_inventory_line's own rules.
    perform public.add_inventory_line(
      add_part_lines.line_id, wo.id, prod.id, add_part_lines.quantity, add_part_lines.location_id, null,
      add_part_lines.unit_sale_price
    );
    select add_part_lines.line_id, 1, 0, add_part_lines.location_id, false into result;
    return result;
  end if;

  if loc is null then
    select l.id into loc from public.locations l where l.active order by l.sort_order, l.name limit 1;
    if loc is null then
      raise exception using errcode = 'P0001', message = 'location_required',
        detail = 'There is no active stock location; add one first.';
    end if;
  else
    select l.active into loc_active from public.locations l where l.id = loc;
    if not found then
      raise exception 'location % not found', loc using errcode = 'P0002';
    end if;
    if not loc_active then
      raise exception using errcode = 'P0001', message = 'location_inactive',
        detail = 'That location is inactive; choose another or reactivate it.';
    end if;
  end if;

  perform private.lock_stock(prod.id);
  -- What each consignment holds here, oldest first (D44/D54: one
  -- consignment per line).
  for piece in
    select i.id as item_id,
           least(pos.remaining_qty, private.consignment_item_on_hand(i.id, loc)) as available
    from public.consignment_items i
    join reporting.consignment_item_position pos on pos.consignment_item_id = i.id
    where i.product_id = prod.id and i.status = 'active'
    order by i.received_at, i.short_id
  loop
    exit when remaining = 0;
    continue when piece.available is null or piece.available < 1;
    take := least(piece.available, remaining);
    n := n + 1;
    this_line := case when n = 1 then add_part_lines.line_id
      else pg_catalog.md5(add_part_lines.line_id::text || ':' || n::text)::uuid end;
    -- add_inventory_line takes the oldest consignment covering `take`
    -- here, which is this one: the older ones are used up above.
    perform public.add_inventory_line(this_line, wo.id, prod.id, take, loc, null, add_part_lines.unit_sale_price);
    remaining := remaining - take;
  end loop;

  if remaining > 0 then
    perform private.receive_for_use(prod, loc, remaining, add_part_lines.unit_sale_price, wo.job_number);
    received := remaining;
    n := n + 1;
    this_line := case when n = 1 then add_part_lines.line_id
      else pg_catalog.md5(add_part_lines.line_id::text || ':' || n::text)::uuid end;
    perform public.add_inventory_line(this_line, wo.id, prod.id, remaining, loc, null, add_part_lines.unit_sale_price);
  end if;

  select add_part_lines.line_id, n, received, loc, false into result;
  return result;
end;
$$;

comment on function private.add_part_lines(public.work_orders, uuid, uuid, integer, uuid, public.money_amount) is
  'D267: put a part on a job. Consigned stock counted by quantity comes from the oldest consignments at the location first, one line each (the first line keeps line_id, the others md5(line_id:n)), and what is still missing is received on use. Everything else is add_inventory_line as before.';

revoke all on function private.add_part_lines(public.work_orders, uuid, uuid, integer, uuid, public.money_amount)
  from public, anon, authenticated, service_role;

create function public.add_part_to_job(
  line_id uuid,
  work_order_id uuid,
  product_id uuid,
  quantity integer default 1,
  location_id uuid default null,
  unit_sale_price public.money_amount default null
)
returns public.add_part_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
begin
  if add_part_to_job.line_id is null or add_part_to_job.work_order_id is null
     or add_part_to_job.product_id is null then
    raise exception 'line_id, work_order_id and product_id are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(add_part_to_job.work_order_id);
  return private.add_part_lines(
    wo, add_part_to_job.line_id, add_part_to_job.product_id, add_part_to_job.quantity,
    add_part_to_job.location_id, add_part_to_job.unit_sale_price
  );
end;
$$;

comment on function public.add_part_to_job(uuid, uuid, uuid, integer, uuid, public.money_amount) is
  'D267: active staff put a stocked part on an open job; consigned stock BICII holds too little of is received from its consignor at that moment (received_on_use) and used. Replay-safe by line id.';

revoke all on function public.add_part_to_job(uuid, uuid, uuid, integer, uuid, public.money_amount)
  from public, anon, authenticated, service_role;
grant execute on function public.add_part_to_job(uuid, uuid, uuid, integer, uuid, public.money_amount)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Fit receives the same way
-- ---------------------------------------------------------------------------
create or replace function public.fit_part_request(request_id uuid, line_id uuid, location_id uuid default null)
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
    -- D267: consigned stock BICII holds too little of is received on use.
    perform private.add_part_lines(
      wo, fit_part_request.line_id, req.product_id, req.quantity::integer, from_location, req.unit_sale_price
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
  'D140/D146/D267: active staff put an approved or ordered request on its open job as ordinary lines (a part through add_part_lines, so consigned stock BICII holds too little of is received on use; a service through add_service_line); replay-safe.';

-- ---------------------------------------------------------------------------
-- The manager's check
-- ---------------------------------------------------------------------------
create function public.check_received_on_use(item_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_consignments');
begin
  if check_received_on_use.item_id is null then
    raise exception 'item_id is required' using errcode = '22004';
  end if;
  update public.consignment_items i
  set use_checked_at = coalesce(i.use_checked_at, pg_catalog.now()),
      use_checked_by = coalesce(i.use_checked_by, actor)
  where i.id = check_received_on_use.item_id and i.received_on_use;
  if not found then
    raise exception 'consignment item % not received on use', check_received_on_use.item_id using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.check_received_on_use(uuid) is
  'D267: manage_consignments confirms an item received on use (its consignor and amount owed look right), taking it off the review list. Idempotent.';

revoke all on function public.check_received_on_use(uuid) from public, anon, authenticated, service_role;
grant execute on function public.check_received_on_use(uuid) to authenticated;
