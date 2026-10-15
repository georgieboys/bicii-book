-- Voiding a fitted indent line undoes the fit (PLAN D160, owner decision
-- 2026-10-15 SGT, chosen from the three options of RISKS R-083; ADR-024
-- amendment "D160"; DATA-MODEL §5 "Voiding a fitted indent line", §16).
--
-- Before this file a request stayed `fitted`, pointing at its voided line:
-- Fit and Cancel both refused it, D149b's settle guard did not see it, the
-- memo, the quote page and paid_parts_not_fitted counted it as on the bill
-- (R-083). The owner's rule: when a job line that a fitted request points
-- at is voided, the request goes back to where it was before Fit (ordered
-- when it is on a purchase order line, else approved), unlinked, with a
-- timeline entry, so it can be fitted again or cancelled.
--
--   private.unfit_part_request(line_id)  the one place that does it: when
--                         `line_id` is voided and a fitted request points at
--                         it, the request goes to `ordered` (its
--                         purchase_order_line_id is set: a fit from ordered)
--                         or `approved` (anything else, including a part
--                         bought outside BICII, D149a, which is never on a
--                         purchase order); work_order_line_item_id,
--                         fitted_at, fitted_by and outside_purchase_movement_id
--                         are cleared, and part_request_unfitted {request_id,
--                         line_id, description, quantity, status,
--                         bought_outside} is recorded on the request's job
--                         with the caller as actor (never a price or cost).
--                         Returns the request id, or null when there is
--                         nothing to undo (a live line, a line no request
--                         points at, a request already back).
--   work_order_line_items_unfit_part_request  AFTER UPDATE on
--                         work_order_line_items, for every row whose
--                         voided_at goes from null to a value: every writer
--                         of a void (public.void_line, the only RPC; the
--                         owner; the tests), in the void's own transaction.
--                         It sorts after work_order_line_items_record_history,
--                         so the timeline reads line_voided,
--                         part_request_unfitted, then void_line's
--                         stock_reversed.
--   job_part_requests_require_live_line  BEFORE INSERT OR UPDATE on
--                         job_part_requests: a request is never linked to a
--                         voided line (part_request_line_voided). Without
--                         it, a stale Fit replayed with the voided line's id
--                         would re-link the request through
--                         add_inventory_line's and add_service_line's replay
--                         (which answer a voided line as a replay) and bring
--                         R-083 back.
--   one-off               fitted requests whose line was already voided are
--                         un-fitted once, each job locked first; a NOTICE
--                         says how many, how many are on jobs that are not
--                         open (settled by D149b at their next move, or on a
--                         collected or cancelled job by D149's admin or
--                         manager cancel) and how many are on a job with a
--                         live line of the same item added after the void
--                         that no request is linked to (staff who followed
--                         R-083's workaround may have added it by hand:
--                         check, then cancel the request if so). Running it
--                         again changes nothing.
--
-- Why a trigger and not a new void_line: a void is a single UPDATE of
-- voided_at (work_order_line_items_enforce_rules allows nothing else), so an
-- AFTER trigger on that change covers every writer, including direct owner
-- writes, with no copy of void_line's 150-line body to keep in step, and
-- void_line (a hosted function) is not replaced: its signature, checks,
-- error order, return value, replay, stock reversal, unit status and
-- publication refresh are exactly as before. The trigger is in the void's
-- transaction, so a refused void un-fits nothing.
--
-- Unchanged: stock arithmetic (the void's linked reversal puts the part
-- back where it was taken, at its cost; a part bought outside BICII keeps
-- its outside_purchase receipt, so after the void it is in stock and a
-- re-fit takes it from there), line totals, yield, Cult Commons, money,
-- snapshots, quotes and deposits (quote_deposits, payment_issues,
-- work_order_unfitted_requests and the quote page read the request's
-- status, so they see the item again as approved or ordered). Who may void
-- is who may void (active staff, D15); the trigger is security definer and
-- owner-only, so the un-fit needs no permission of its own.
--
-- Lock order (DATA-MODEL §5, §7): void_line takes the job
-- (private.lock_work_order, step 1), then the line FOR UPDATE; the trigger
-- then locks the line's request, all before void_line's stock, bike and
-- unit locks (steps 3 to 5). fit_part_request and fit_part_bought_outside
-- take the job before the request and the line, cancel_part_request the job
-- before the request: every writer of a request holds its job's lock first,
-- so no two of them interleave on one job. A direct writer of a void holds
-- the job FOR SHARE (work_order_line_items_enforce_rules), which still
-- blocks every request writer and every status change of the job, so D149b's
-- guard never reads a request mid-change.

-- ---------------------------------------------------------------------------
-- The un-fit (D160)
-- ---------------------------------------------------------------------------

-- Callers hold the request's job lock (void_line), at least FOR SHARE (a
-- direct void), or lock the job first (the one-off below).
create function private.unfit_part_request(line_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  req public.job_part_requests;
  back public.part_request_status;
begin
  -- Only a voided line: a live line keeps its request fitted.
  if not exists (
    select 1 from public.work_order_line_items li
    where li.id = unfit_part_request.line_id and li.voided_at is not null
  ) then
    return null;
  end if;
  select r.* into req
  from public.job_part_requests r
  where r.work_order_line_item_id = unfit_part_request.line_id
  for update;
  if not found or req.status <> 'fitted' then
    return null;
  end if;

  -- Where it was before Fit: fit_part_request fits approved requests and
  -- ordered parts; only order_part_requests sets purchase_order_line_id,
  -- and it sets ordered with it.
  back := case when req.purchase_order_line_id is not null then 'ordered' else 'approved' end;
  update public.job_part_requests r
  set status = back, work_order_line_item_id = null, fitted_at = null, fitted_by = null,
      outside_purchase_movement_id = null
  where r.id = req.id;

  perform private.record_work_order_event(
    req.work_order_id,
    'part_request_unfitted',
    pg_catalog.jsonb_build_object(
      'request_id', req.id,
      'line_id', unfit_part_request.line_id,
      'description', req.description,
      'quantity', req.quantity,
      'status', back::text,
      'bought_outside', req.outside_purchase_movement_id is not null
    )
  );
  return req.id;
end;
$$;

comment on function private.unfit_part_request(uuid) is
  'D160: when line_id is voided and a fitted request points at it, the request goes back to ordered (on a purchase order line) or approved, unlinked (work_order_line_item_id, fitted_at, fitted_by, outside_purchase_movement_id cleared), and part_request_unfitted {request_id, line_id, description, quantity, status, bought_outside} is recorded; returns the request id, or null when there is nothing to undo. Callers hold the job lock.';

-- AFTER UPDATE, every writer of a void (no column list: whatever sets
-- voided_at, the row is what counts).
create function private.work_order_line_items_unfit_part_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.unfit_part_request(new.id);
  return null;
end;
$$;

comment on function private.work_order_line_items_unfit_part_request() is
  'D160: a voided line''s fitted indent request goes back to approved or ordered (private.unfit_part_request), in the void''s transaction, for every writer.';

create trigger work_order_line_items_unfit_part_request
  after update on public.work_order_line_items
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function private.work_order_line_items_unfit_part_request();

-- ---------------------------------------------------------------------------
-- A request is never linked to a voided line (D160)
-- ---------------------------------------------------------------------------

-- BEFORE INSERT OR UPDATE, every writer. Only a new or changed link is
-- checked, so un-fitting (link cleared) and the other request changes never
-- read a line.
create function private.job_part_requests_require_live_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.work_order_line_item_id is not null
     and (tg_op = 'INSERT' or new.work_order_line_item_id is distinct from old.work_order_line_item_id)
     and exists (
       select 1 from public.work_order_line_items li
       where li.id = new.work_order_line_item_id and li.voided_at is not null
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_line_voided',
      detail = 'That line was voided. Reload the job and fit the item again.';
  end if;
  return new;
end;
$$;

comment on function private.job_part_requests_require_live_line() is
  'D160: a job_part_requests row is never linked to a voided line (part_request_line_voided), so a stale Fit replay cannot re-link a request whose line was voided.';

create trigger job_part_requests_require_live_line
  before insert or update on public.job_part_requests
  for each row
  execute function private.job_part_requests_require_live_line();

-- ---------------------------------------------------------------------------
-- One-off (D160): requests left fitted on a voided line before this file
-- ---------------------------------------------------------------------------

-- Each job is locked (in id order) before its requests; the actor is null
-- (the migration). Requests on jobs that are no longer open are un-fitted
-- too: D149b then holds their next move (completed, ready) until they are
-- fitted after a reopen or cancelled, D149's admin or manager cancel closes
-- them on a collected or cancelled job, and paid_parts_not_fitted flags a
-- deposit held for them. Production held none as far as known (R-083).
do $$
declare
  stuck record;
  current_status public.work_order_status;
  fixed integer := 0;
  not_open integer := 0;
  hand_added integer := 0;
begin
  for stuck in
    select r.work_order_id, r.work_order_line_item_id as line_id, r.product_id, r.service_id
    from public.job_part_requests r
    join public.work_order_line_items li on li.id = r.work_order_line_item_id
    where r.status = 'fitted' and li.voided_at is not null
    order by r.work_order_id, r.id
  loop
    current_status := (private.lock_work_order(stuck.work_order_id)).status;
    if private.unfit_part_request(stuck.line_id) is not null then
      fixed := fixed + 1;
      if not private.work_order_status_is_open(current_status) then
        not_open := not_open + 1;
      end if;
      -- A possible hand re-add (R-083's workaround): a live line of the same
      -- product or service, added after the void, that no request is
      -- linked to (a second request's own fit is not one, nor is a line
      -- that was on the job before the void).
      if exists (
        select 1 from public.work_order_line_items li
        where li.work_order_id = stuck.work_order_id and li.voided_at is null
          and (li.source_product_id = stuck.product_id or li.source_service_id = stuck.service_id)
          and li.created_at > (
            select v.voided_at from public.work_order_line_items v where v.id = stuck.line_id
          )
          and not exists (
            select 1 from public.job_part_requests o where o.work_order_line_item_id = li.id
          )
      ) then
        hand_added := hand_added + 1;
      end if;
    end if;
  end loop;
  raise notice 'D160 one-off: % fitted indent request(s) whose line was voided went back to approved or ordered; % of them on jobs that are not open, % on a job with a live line of the same item added after the void (check whether it was added by hand).',
    fixed, not_open, hand_added;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (DATA-MODEL §15): private helpers and trigger functions only.
-- ---------------------------------------------------------------------------
revoke all on function
  private.unfit_part_request(uuid),
  private.work_order_line_items_unfit_part_request(),
  private.job_part_requests_require_live_line()
from public, anon, authenticated, service_role;
