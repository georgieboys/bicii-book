-- 2026-11-22 audit, A-21: a purchase order that customer jobs are waiting
-- on can no longer be cancelled or cut below what those jobs ordered.
--
--   * cancel_purchase_order refuses with purchase_order_has_indent_requests
--     while an ordered indent part on one of its lines has not arrived
--     (part_request_arrival_rows' rule: the line's receipts cover the
--     ordered and fitted requests first ordered first). Before, the cancel
--     left those requests "ordered" against lines that can never be
--     received, so they never arrived and their jobs could not complete.
--     The jobs are locked first, in id order, then the purchase order: the
--     order order_part_requests takes them in.
--   * set_purchase_order_line refuses the same way when an existing line's
--     quantity is lowered below what its not-yet-arrived ordered requests
--     need (the cumulative quantity of the last of them). Raising a line,
--     as order_part_requests does, is never refused here.
--
-- A refusal changes no data. Staff settle the job's request first (Fit from
-- other stock, or an admin or manager cancels it), then cancel or cut the
-- order. Un-ordering a request is not built (R-084).

-- ---------------------------------------------------------------------------
-- The not-yet-arrived ordered requests on one purchase order (or one line)
-- ---------------------------------------------------------------------------

-- Per ordered request on the PO's lines that its line's receipts do not yet
-- cover: its job and the cumulative quantity the line must bring for it.
-- Scoped part_request_arrival_rows (20261014000200): the same queue order.
create function private.purchase_order_waiting_indent(purchase_order_id uuid, line_id uuid default null)
returns table (request_id uuid, work_order_id uuid, purchase_order_line_id uuid, cumulative integer)
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select l.id
    from public.purchase_order_lines l
    where l.purchase_order_id = purchase_order_waiting_indent.purchase_order_id
      and (purchase_order_waiting_indent.line_id is null or l.id = purchase_order_waiting_indent.line_id)
  ),
  received as (
    select rl.purchase_order_line_id, sum(rl.quantity_received)::integer as received
    from public.purchase_receipt_lines rl
    where rl.purchase_order_line_id in (select id from lines)
    group by rl.purchase_order_line_id
  ),
  queued as (
    select q.id, q.work_order_id, q.status, q.purchase_order_line_id,
           sum(q.quantity::integer) over (
             partition by q.purchase_order_line_id order by q.ordered_at, q.created_at, q.id
           )::integer as cumulative
    from public.job_part_requests q
    where q.status in ('ordered', 'fitted') and q.purchase_order_line_id in (select id from lines)
  )
  select q.id, q.work_order_id, q.purchase_order_line_id, q.cumulative
  from queued q
  left join received rc on rc.purchase_order_line_id = q.purchase_order_line_id
  where q.status = 'ordered' and coalesce(rc.received, 0) < q.cumulative;
$$;

revoke all on function private.purchase_order_waiting_indent(uuid, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cancel_purchase_order: 20261005000200 with the A-21 refusal
-- ---------------------------------------------------------------------------

-- D61 D-PO-CANCEL: from draft, submitted or partially_received with a
-- reason. Receipts, movements and stock stay. A replay returns the PO.
-- A-21: refused while a customer job waits on a part ordered on it.
create or replace function public.cancel_purchase_order(purchase_order_id uuid, reason text)
returns public.purchase_orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  staff uuid := private.require_permission('manage_purchasing');
  cleaned text := nullif(pg_catalog.btrim(coalesce(cancel_purchase_order.reason, '')), '');
  po public.purchase_orders;
  result public.purchase_orders;
  job record;
  waiting_jobs text;
begin
  if cancel_purchase_order.purchase_order_id is null then
    raise exception 'purchase_order_id is required' using errcode = '22004';
  end if;
  if cleaned is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why the order is being cancelled.';
  end if;
  if pg_catalog.char_length(cleaned) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;

  -- The jobs with parts ordered on this PO first, in id order, then the PO
  -- (order_part_requests' lock order). A part ordered by another job while
  -- we wait for the PO lock is seen by the check below, under the PO lock.
  for job in
    select distinct r.work_order_id as id
    from public.job_part_requests r
    join public.purchase_order_lines l on l.id = r.purchase_order_line_id
    where l.purchase_order_id = cancel_purchase_order.purchase_order_id and r.status = 'ordered'
    order by r.work_order_id
  loop
    perform private.lock_work_order(job.id);
  end loop;

  po := private.lock_purchase_order(cancel_purchase_order.purchase_order_id);
  if po.status = 'cancelled' then
    return po;
  end if;
  if po.status = 'received' then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_order_closed',
      detail = 'A fully received order cannot be cancelled.';
  end if;

  select pg_catalog.string_agg(distinct w.job_number, ', ' order by w.job_number) into waiting_jobs
  from private.purchase_order_waiting_indent(po.id) x
  join public.work_orders w on w.id = x.work_order_id;
  if waiting_jobs is not null then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_order_has_indent_requests',
      detail = pg_catalog.format(
        'Customer jobs are waiting for parts on this order (%s). Fit or cancel those parts on the jobs first.',
        waiting_jobs
      );
  end if;

  update public.purchase_orders o
  set status = 'cancelled', cancelled_at = now(), cancelled_by = staff, cancellation_reason = cleaned
  where o.id = po.id
  returning o.* into result;
  return result;
end;
$$;

comment on function public.cancel_purchase_order(uuid, text) is
  'manage_purchasing: cancel a draft, submitted or partially received PO with a reason (D61); receipts and stock stay; purchase_order_has_indent_requests while a customer job waits on a part ordered on it (A-21).';

-- ---------------------------------------------------------------------------
-- set_purchase_order_line: 20261005000300 with the A-21 refusal
-- ---------------------------------------------------------------------------

-- Adds or changes a PO line, upsert by id. Lock the PO first; closed POs
-- refuse (raising a quantity on a received PO is refused, D65). A new line
-- orders a quantity-tracked, shop-owned, active product in the PO's
-- currency, once per PO (D62). unit_cost 0 is accepted (D24 as amended).
-- Products are read without locks. A-21: a lowered quantity must still
-- bring every customer job's ordered part that has not arrived.
create or replace function public.set_purchase_order_line(
  id uuid,
  purchase_order_id uuid,
  product_id uuid,
  quantity_ordered integer,
  unit_cost public.money_amount,
  expected_at date default null,
  notes text default null,
  reason text default null
)
returns public.purchase_order_lines
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  staff uuid := private.require_permission('manage_purchasing');
  cleaned_notes text := nullif(pg_catalog.btrim(set_purchase_order_line.notes), '');
  cleaned_reason text := nullif(pg_catalog.btrim(set_purchase_order_line.reason), '');
  po public.purchase_orders;
  existing public.purchase_order_lines;
  prod public.products;
  received integer;
  indent_needed integer;
  result public.purchase_order_lines;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  if set_purchase_order_line.id is null or set_purchase_order_line.purchase_order_id is null
     or set_purchase_order_line.product_id is null or set_purchase_order_line.quantity_ordered is null
     or set_purchase_order_line.unit_cost is null then
    raise exception 'id, purchase_order_id, product_id, quantity_ordered and unit_cost are required'
      using errcode = '22004';
  end if;
  if cleaned_reason is not null and pg_catalog.char_length(cleaned_reason) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;

  po := private.lock_purchase_order(set_purchase_order_line.purchase_order_id);
  if po.status in ('received', 'cancelled') then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_order_closed',
      detail = 'This order is closed: it has been fully received or cancelled. Extra units go on a new order.';
  end if;

  select l.* into existing from public.purchase_order_lines l where l.id = set_purchase_order_line.id;
  if found then
    if existing.purchase_order_id <> po.id or existing.product_id <> set_purchase_order_line.product_id then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_conflict',
        detail = 'That line id is already used for another line.';
    end if;
    select coalesce(sum(rl.quantity_received), 0)::integer into received
    from public.purchase_receipt_lines rl
    where rl.purchase_order_line_id = existing.id;
    if set_purchase_order_line.quantity_ordered < received then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_below_received',
        detail = pg_catalog.format('%s already received; the order cannot be for fewer.', received);
    end if;
    -- A-21: under the PO lock no request is newly ordered on this line
    -- (order_part_requests links them after taking it).
    if set_purchase_order_line.quantity_ordered < existing.quantity_ordered then
      select pg_catalog.max(x.cumulative) into indent_needed
      from private.purchase_order_waiting_indent(po.id, existing.id) x;
      if set_purchase_order_line.quantity_ordered < indent_needed then
        raise exception using
          errcode = 'P0001',
          message = 'purchase_order_has_indent_requests',
          detail = pg_catalog.format(
            'Customer jobs are waiting for %s of these; fit or cancel those parts on the jobs first.',
            indent_needed
          );
      end if;
    end if;
    if existing.quantity_ordered = set_purchase_order_line.quantity_ordered
       and existing.unit_cost = set_purchase_order_line.unit_cost
       and existing.expected_at is not distinct from set_purchase_order_line.expected_at
       and existing.notes is not distinct from cleaned_notes then
      return existing;
    end if;

    perform private.set_change_reason(cleaned_reason);
    begin
      update public.purchase_order_lines l
      set quantity_ordered = set_purchase_order_line.quantity_ordered,
          unit_cost = set_purchase_order_line.unit_cost,
          expected_at = set_purchase_order_line.expected_at,
          notes = cleaned_notes
      where l.id = existing.id
      returning l.* into result;
    exception
      when check_violation or not_null_violation then
        get stacked diagnostics
          err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
          err_schema = schema_name, err_column = column_name, err_message = message_text;
        perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
    end;
    perform private.set_change_reason(null);
  else
    select p.* into prod from public.products p where p.id = set_purchase_order_line.product_id;
    if not found then
      raise exception 'product % not found', set_purchase_order_line.product_id using errcode = 'P0002';
    end if;
    if prod.tracking_type <> 'quantity' then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_unique_product',
        detail = 'Unique items are registered one by one in Stock, not ordered on a purchase order.';
    end if;
    if prod.ownership_type <> 'shop_owned' then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_not_shop_owned',
        detail = 'Only shop-owned products are bought from suppliers.';
    end if;
    if not prod.active or prod.archived_at is not null then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_product_inactive',
        detail = 'That product is inactive or archived.';
    end if;
    if prod.currency <> po.currency then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_currency_mismatch',
        detail = pg_catalog.format('The product is priced in %s but the order is in %s.', prod.currency, po.currency);
    end if;
    if exists (
      select 1 from public.purchase_order_lines l
      where l.purchase_order_id = po.id and l.product_id = prod.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_line_duplicate_product',
        detail = 'That product is already on this order; change its line instead.';
    end if;

    perform private.set_change_reason(cleaned_reason);
    begin
      insert into public.purchase_order_lines as l (
        id, purchase_order_id, product_id, quantity_ordered, unit_cost, currency, expected_at, notes, created_by
      )
      values (
        set_purchase_order_line.id, po.id, prod.id, set_purchase_order_line.quantity_ordered,
        set_purchase_order_line.unit_cost, po.currency, set_purchase_order_line.expected_at, cleaned_notes, staff
      )
      returning l.* into result;
    exception
      when check_violation or not_null_violation then
        get stacked diagnostics
          err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
          err_schema = schema_name, err_column = column_name, err_message = message_text;
        perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
    end;
    perform private.set_change_reason(null);
  end if;

  -- A reduction to the received total can complete a partially received PO.
  perform private.refresh_purchase_order_status(po.id, now());
  return result;
end;
$$;

comment on function public.set_purchase_order_line(uuid, uuid, uuid, integer, public.money_amount, date, text, text) is
  'manage_purchasing: add or change a PO line (upsert by id) on an open PO (D62, D65); 0 is a valid cost; a lowered quantity below what customer jobs still wait for on the line is purchase_order_has_indent_requests (A-21).';

-- create or replace keeps the grants of 20261005000200 and 20261005000300.
