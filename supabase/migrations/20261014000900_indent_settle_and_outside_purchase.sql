-- Settling indent items before a job closes, and fitting a part bought
-- outside BICII (PLAN D149a INDENT-FIT-OUTSIDE and D149b
-- INDENT-SETTLE-BEFORE-COMPLETE, owner decisions 2026-10-15 SGT; D149c build
-- defaults, owner to confirm (PRODUCT question 34); ADR-024 amendment
-- 2026-10-15; DATA-MODEL §4, §5, §6, §7, §14, §15, §16; RISKS R-082, R-084).
--
-- The owner's answer to PRODUCT question 33 (block or warn at Complete):
-- block. Not all orders happen through BICII, so a part the shop bought
-- elsewhere gets its own way onto the job.
--
--   fit_part_bought_outside  D149a: an approved indent part never ordered in
--                         BICII is recorded as bought outside BICII at the
--                         unit cost staff enter (one outside_purchase
--                         movement, +quantity at that cost, linked to the
--                         job) and fitted in the same transaction through
--                         add_inventory_line at the same location
--                         (-quantity, job_consumption). On-hand there does
--                         not change, so it never goes below zero; the
--                         product's cost becomes the entered cost, as a
--                         purchase receipt's does (D5, D63; D149c(4)), so
--                         the line's cost snapshot and the job's yield use
--                         it (D24 unchanged: the line takes the product's
--                         cost). View costs or Manage purchasing
--                         (D149c(3)). A part on a purchase order is refused
--                         (part_request_ordered): it is received in
--                         Purchasing, then fitted.
--   work_orders_require_settled_requests  D149b, D149c(1): BEFORE UPDATE OF
--                         status, for every writer. A job cannot move into a
--                         status that is not open (completed, ready for
--                         collection, collected, cancelled) while any of its
--                         requests is approved or ordered
--                         (work_order_has_unfitted_requests). It fires after
--                         work_orders_cancel_requires_no_lines and
--                         work_orders_enforce_rules (trigger names sort that
--                         way), so an invalid move, a missing reason and a
--                         cancel with live lines still report first;
--                         set_work_order_status reports those three before
--                         its UPDATE and is not replaced. Status changes on
--                         job_part_requests never move a job, so D149's
--                         admin or manager cancel on a collected or
--                         cancelled job (J-000002) is untouched.
--   work_orders_withdraw_open_quote  D149c(2): AFTER UPDATE OF status: when
--                         a job leaves the open statuses its open quote is
--                         withdrawn (private.withdraw_open_quote: its quoted
--                         items back to proposed, quote_withdrawn on the
--                         timeline after the status entry), so the
--                         customer's link says withdrawn instead of open.
--                         Answered quotes and deposits are not touched.
--   one-off               D149c(6): open quotes on jobs that are already
--                         not open are withdrawn the same way.
--
-- Money, totals, yield and Cult Commons formulas are unchanged; no snapshot
-- is touched; inventory ownership and consignment liability are unchanged
-- (shop-owned products only; D50 refuses the new type on consigned stock).
--
-- Merged migrations are never edited: 20261014000200 (fit_part_request,
-- withdraw_open_quote) and 20261014000700 (cancel_part_request, D149) stay
-- as they are; nothing here replaces a hosted function.
--
-- Lock order (DATA-MODEL §7, binding): fit_part_bought_outside takes the job
-- (private.lock_work_order, step 1), the request FOR UPDATE,
-- private.lock_stock(the product) (step 3) and last the products row FOR NO
-- KEY UPDATE (step 7), always, before it reads the cost: a direct cost edit
-- (the product page) waits, so the receipt, the line and its job_consumption
-- carry one cost even when the entered cost equals the stored one.
-- add_inventory_line then takes the job and the stock again, which this
-- transaction already holds. Purchasing RPCs never lock a job, so there is
-- no inversion with receive_purchase (PO, then stock, then products). The
-- guard reads the job's requests under the job row lock its UPDATE holds;
-- every writer of job_part_requests.status takes that lock first, so the
-- read cannot race.

-- ---------------------------------------------------------------------------
-- The ledger row and its link on the request (D149a)
-- ---------------------------------------------------------------------------

-- A bought-outside receipt is one positive, costed, job-linked row; never a
-- unit, a line, a sale, a receipt line or a consignment row. request_id is
-- the fitted line's id (the idempotency key). No existing row has the type.
alter table public.inventory_movements
  add constraint inventory_movements_outside_purchase_shape check (
    movement_type <> 'outside_purchase'
    or (quantity_delta > 0 and work_order_id is not null and request_id is not null
        and unit_cost_snapshot is not null and inventory_unit_id is null
        and work_order_line_item_id is null and sale_line_id is null
        and purchase_receipt_line_id is null and consignment_item_id is null)
  );

alter table public.job_part_requests
  add column outside_purchase_movement_id bigint null
    references public.inventory_movements (id) on delete restrict,
  add constraint job_part_requests_outside_purchase_shape check (
    outside_purchase_movement_id is null or (kind = 'part' and status = 'fitted')
  );

create unique index job_part_requests_outside_purchase_key
  on public.job_part_requests (outside_purchase_movement_id)
  where outside_purchase_movement_id is not null;

comment on column public.job_part_requests.outside_purchase_movement_id is
  'D149a: the outside_purchase movement recorded when this part was fitted as bought outside BICII (its cost is on the movement, read through inventory_movement_costs; none here).';

-- Not a cost: staff read it like the request's other links (DATA-MODEL §15).
grant select (outside_purchase_movement_id) on table public.job_part_requests to authenticated;

-- ---------------------------------------------------------------------------
-- fit_part_bought_outside (D149a)
-- ---------------------------------------------------------------------------

-- View costs or Manage purchasing (private.can_view_purchase_costs(), D60,
-- D147, D149c(3)). An approved indent part never ordered in BICII, on an
-- open job: records it as bought outside BICII at unit_cost (what the shop
-- paid for one, 0 to 99,999.99) and puts it on the job as an ordinary line
-- with line_id as the line's id, at location_id or add_inventory_line's
-- default location, both rows at the same place. reference is optional
-- free text (where it was bought, a receipt number; at most 100
-- characters), kept on the movement's reason, the cost change's reason and
-- the timeline. Replay: a request fitted as bought outside with this line
-- returns the line and writes nothing.
create function public.fit_part_bought_outside(
  request_id uuid,
  line_id uuid,
  unit_cost public.money_amount,
  location_id uuid default null,
  reference text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  cleaned_reference text := nullif(pg_catalog.btrim(fit_part_bought_outside.reference), '');
  req public.job_part_requests;
  wo public.work_orders;
  prod public.products;
  chosen_location uuid;
  loc_active boolean;
  why text;
  movement bigint;
begin
  -- (1) Arguments and permission, before any read: a caller without the
  -- permission learns nothing about the request.
  if fit_part_bought_outside.request_id is null or fit_part_bought_outside.line_id is null
     or fit_part_bought_outside.unit_cost is null then
    raise exception 'request_id, line_id and unit_cost are required' using errcode = '22004';
  end if;
  if not private.can_view_purchase_costs() then
    raise exception 'permission view_costs or manage_purchasing required to record a part bought outside BICII'
      using errcode = '42501';
  end if;

  -- (2) The job, then the request (lock order 1).
  select r.* into req from public.job_part_requests r where r.id = fit_part_bought_outside.request_id;
  if not found then
    raise exception 'part request % not found', fit_part_bought_outside.request_id using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(req.work_order_id);
  select r.* into req from public.job_part_requests r where r.id = fit_part_bought_outside.request_id for update;

  -- (3) Replay: the same line, recorded as bought outside.
  if req.status = 'fitted' then
    if req.work_order_line_item_id = fit_part_bought_outside.line_id
       and req.outside_purchase_movement_id is not null then
      return req.work_order_line_item_id;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'part_request_fitted',
      detail = 'It is already on the job.';
  end if;

  -- (4) What can be bought outside: an approved part, never ordered, on an
  -- open job. An ordered part is received through Purchasing, so a later
  -- receipt never counts it twice.
  if req.kind <> 'part' then
    raise exception using
      errcode = 'P0001',
      message = 'outside_purchase_part_only',
      detail = 'Only a part can be bought outside BICII; add a service with Add to job.';
  end if;
  if req.status = 'ordered' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_ordered',
      detail = 'It is on a purchase order: receive it in Purchasing, then fit it.';
  end if;
  if req.status <> 'approved' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_approved',
      detail = 'Only an approved part can be bought outside BICII.';
  end if;
  perform private.require_open_work_order(wo.id);  -- work_order_locked

  -- (5) The values (money_amount alone allows negatives).
  if fit_part_bought_outside.unit_cost < 0 or fit_part_bought_outside.unit_cost > 99999.99 then
    raise exception using
      errcode = 'P0001',
      message = 'outside_purchase_cost_invalid',
      detail = 'Enter a unit cost between 0 and 99,999.99.';
  end if;
  if pg_catalog.char_length(cleaned_reference) > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'outside_purchase_reference_too_long',
      detail = 'Keep where it was bought under 100 characters.';
  end if;
  -- A line with this id already exists (a reused form id): nothing is
  -- recorded, so the ledger never gets the receipt without the fit.
  if exists (select 1 from public.work_order_line_items li where li.id = fit_part_bought_outside.line_id) then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_conflict',
      detail = 'That line already exists. Reload and try again.';
  end if;

  -- (6) The stock lock (lock order 3), then the products row (lock order 7),
  -- locked always, not only when step (9) writes it: from here to
  -- add_inventory_line's own read of the cost, nobody else can change it,
  -- so the receipt, the line and its job_consumption carry the same cost.
  perform private.lock_stock(req.product_id);
  select p.* into prod from public.products p where p.id = req.product_id for no key update;
  if not found then
    raise exception 'product % not found', req.product_id using errcode = 'P0002';
  end if;
  if prod.archived_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'product_archived',
      detail = 'That product is archived.';
  end if;
  if not prod.active then
    raise exception using
      errcode = 'P0001',
      message = 'product_inactive',
      detail = 'That product is inactive.';
  end if;
  -- D62: shop-owned, counted by quantity (also keeps D50's consigned-stock
  -- rule from ever being reached).
  if prod.tracking_type <> 'quantity' or prod.ownership_type <> 'shop_owned' then
    raise exception using
      errcode = 'P0001',
      message = 'indent_product_invalid',
      detail = 'Only shop-owned products counted by quantity can be bought for a job.';
  end if;
  if prod.currency <> wo.currency then
    raise exception using
      errcode = 'P0001',
      message = 'currency_mismatch',
      detail = 'That product is priced in another currency than the job.';
  end if;

  -- (7) The location: add_inventory_line's rule, resolved here so the
  -- receipt and the fit are at the same place.
  if fit_part_bought_outside.location_id is null then
    select l.id into chosen_location from public.locations l
    where l.active
    order by l.sort_order, l.name
    limit 1;
    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'location_required',
        detail = 'There is no active stock location; add one first.';
    end if;
  else
    select l.active into loc_active from public.locations l where l.id = fit_part_bought_outside.location_id;
    if not found then
      raise exception 'location % not found', fit_part_bought_outside.location_id using errcode = 'P0002';
    end if;
    if not loc_active then
      raise exception using
        errcode = 'P0001',
        message = 'location_inactive',
        detail = 'That location is inactive; choose another or reactivate it.';
    end if;
    chosen_location := fit_part_bought_outside.location_id;
  end if;

  -- (8) The receipt row (as receive_purchase's step 10): +quantity at the
  -- entered cost, linked to the job, keyed by the line id.
  why := 'Bought outside BICII for ' || wo.job_number || coalesce(' (' || cleaned_reference || ')', '');
  movement := private.record_movement(
    prod.id, null, chosen_location, req.quantity::integer, 'outside_purchase', why,
    fit_part_bought_outside.unit_cost, fit_part_bought_outside.line_id, wo.id, null, null
  );

  -- (9) The last cost (D5, D63 extended, D149c(4)): the purchase is now, so
  -- it always sets the product's cost; nothing is written when it is
  -- unchanged (the row is already locked, step 6). products_record_history
  -- writes cost_changed with an empty payload and this reason.
  if prod.default_direct_cost is distinct from fit_part_bought_outside.unit_cost then
    perform private.set_change_reason(why);
    update public.products p
    set default_direct_cost = fit_part_bought_outside.unit_cost
    where p.id = prod.id;
    perform private.set_change_reason(null);
  end if;

  -- (10) The ordinary fit: the line snapshots the cost just set (D24) and
  -- the quoted price; its job_consumption takes the same quantity back out.
  -- Any refusal here rolls the receipt and the cost back with it.
  perform public.add_inventory_line(
    fit_part_bought_outside.line_id, wo.id, prod.id, req.quantity::integer, chosen_location, null,
    req.unit_sale_price
  );

  -- (11) The request and the timeline (never a cost).
  update public.job_part_requests r
  set status = 'fitted', work_order_line_item_id = fit_part_bought_outside.line_id,
      fitted_at = pg_catalog.clock_timestamp(), fitted_by = actor,
      outside_purchase_movement_id = movement
  where r.id = req.id;
  perform private.record_work_order_event(
    wo.id,
    'part_fitted',
    pg_catalog.jsonb_build_object(
      'request_id', req.id, 'line_id', fit_part_bought_outside.line_id, 'description', req.description,
      'quantity', req.quantity, 'bought_outside', true, 'reference', cleaned_reference
    )
  );
  return fit_part_bought_outside.line_id;
end;
$$;

comment on function public.fit_part_bought_outside(uuid, uuid, public.money_amount, uuid, text) is
  'D149a: view_costs or manage_purchasing (42501 otherwise) record an approved indent part never ordered in BICII as bought outside at unit_cost (0..99999.99): one outside_purchase movement (+quantity, costed, linked to the job, request_id = line_id), the product''s cost set to unit_cost (D5, D63 extended; cost_changed with the reason, no cost in any payload) and the ordinary fit through add_inventory_line at the same location, so on-hand there does not change. Ordered parts: part_request_ordered; services: outside_purchase_part_only. Replay-safe on line_id.';

-- ---------------------------------------------------------------------------
-- Settle before closing (D149b, D149c(1))
-- ---------------------------------------------------------------------------

-- BEFORE UPDATE OF status, every writer (the RPC, owner writes, the seed,
-- the tests). Fires after work_orders_cancel_requires_no_lines and
-- work_orders_enforce_rules (name order), so an invalid pair still reports
-- work_order_transition_invalid, a missing reason reason_required and a
-- cancel with live lines work_order_has_lines first. Approved and ordered
-- requests block (an arrived, unfitted part is ordered); proposed, quoted,
-- declined, fitted and cancelled ones never do.
create function private.work_orders_require_settled_requests()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.work_order_status_is_open(new.status)
     and exists (
       select 1 from public.job_part_requests r
       where r.work_order_id = new.id and r.status in ('approved', 'ordered')
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'work_order_has_unfitted_requests',
      detail = case when new.status = 'cancelled'
        then 'Cancel the job''s approved and ordered items before cancelling it.'
        else 'Fit or cancel each approved or ordered item first.' end;
  end if;
  return new;
end;
$$;

comment on function private.work_orders_require_settled_requests() is
  'D149b, D149c(1): a job moves into completed, ready_for_collection, collected or cancelled only while none of its job_part_requests is approved or ordered (work_order_has_unfitted_requests). Reports after the transition, reason and live-line checks.';

create trigger work_orders_require_settled_requests
  before update of status on public.work_orders
  for each row
  when (old.status is distinct from new.status)
  execute function private.work_orders_require_settled_requests();

-- ---------------------------------------------------------------------------
-- An open quote when the job closes (D149c(2))
-- ---------------------------------------------------------------------------

-- AFTER UPDATE OF status; sorts after work_orders_record_history, so the
-- timeline reads "Completed" (or "Cancelled") then "Quote withdrawn". The
-- actor is the staff member who moved the job (null for an owner write).
-- private.withdraw_open_quote checks no job status, so 20261014000700's
-- refusal in public.withdraw_quote does not apply.
create function private.work_orders_withdraw_open_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.work_order_status_is_open(new.status) then
    perform private.withdraw_open_quote(new.id, private.current_staff_id());
  end if;
  return null;
end;
$$;

comment on function private.work_orders_withdraw_open_quote() is
  'D149c(2): when a job leaves the open statuses its open quote, if any, is withdrawn (quoted items back to proposed, quote_withdrawn on the timeline); answered quotes and deposits are untouched.';

create trigger work_orders_withdraw_open_quote
  after update of status on public.work_orders
  for each row
  when (old.status is distinct from new.status)
  execute function private.work_orders_withdraw_open_quote();

-- ---------------------------------------------------------------------------
-- One-off (D149c(6)): open quotes on jobs that are already not open
-- ---------------------------------------------------------------------------

-- Nobody can answer them (answer_quote needs an open job) and, on a
-- completed or ready job, a reopen would make one answerable again. Each job
-- is locked and checked again before its quote is withdrawn (actor null:
-- the migration). Answered quotes, their deposits and every request that is
-- not quoted are untouched.
do $$
declare
  job record;
  current_status public.work_order_status;
begin
  for job in
    select distinct q.work_order_id as id
    from public.quotes q
    join public.work_orders w on w.id = q.work_order_id
    where q.status = 'open' and not private.work_order_status_is_open(w.status)
    order by q.work_order_id
  loop
    current_status := (private.lock_work_order(job.id)).status;
    if not private.work_order_status_is_open(current_status) then
      perform private.withdraw_open_quote(job.id, null);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  public.fit_part_bought_outside(uuid, uuid, public.money_amount, uuid, text),
  private.work_orders_require_settled_requests(),
  private.work_orders_withdraw_open_quote()
from public, anon, authenticated, service_role;

grant execute on function
  public.fit_part_bought_outside(uuid, uuid, public.money_amount, uuid, text)
to authenticated;
