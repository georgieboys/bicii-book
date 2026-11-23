set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D269 ADD-AFTER-COMPLETE (the owner, 2026-11-23: operators, mechanics and
-- managers finish what they are doing in place; the software does the
-- missing step). A part, service or manual line added to a job that is
-- completed or ready for collection no longer needs a reopen first:
--
--   * completed on today's shop day (D35, private.shop_day): the job is
--     reopened with the reason "Added after completion: <description>",
--     the line is added and the job is completed again, back to the status
--     it was in (ready_for_collection goes completed -> ready again). Its
--     completion stamps are today's, so D3 recognises it on the same day;
--     the timeline reads reopened, line_added, completed (ready).
--   * completed on an earlier shop day (or a same-day reopen the job's own
--     rules refuse, e.g. a sold bike already with its buyer): the original
--     job is untouched and the line goes on a follow-up job for the same
--     customer and bike, made through private.create_work_order. The
--     follow-up's id is md5('follow_up:<job id>:<shop day>:<n>'), so lines
--     added the same day share one follow-up (n moves on only past a
--     collected or cancelled one); it starts received, with the original's
--     lead when they are still active, for staff to complete and bill.
--     A follow-up completed earlier today is reopened and completed again
--     the same way.
--   * collected or cancelled: work_order_closed, as before.
--   * still open: the line is added as before.
--
--   public.add_part_after_complete     a part (counted: add_part_lines, so
--                                      D267 receive-on-use applies; a unit:
--                                      add_inventory_line).
--   public.add_service_after_complete  add_service_line.
--   public.add_manual_after_complete   add_manual_line.
--
-- Each returns public.add_after_complete_result. Replay-safe by line id: a
-- line that exists already returns where it went (the job or a follow-up
-- for the same bike) without reopening anything.

create type public.add_after_complete_result as (
  line_id uuid,
  work_order_id uuid,
  job_number text,
  follow_up boolean,
  recompleted boolean,
  received_quantity integer,
  location_id uuid,
  replayed boolean
);

comment on type public.add_after_complete_result is
  'D269: where a line added after completion went (the job itself, completed again, or a follow-up job), D267''s received quantity and location for a part, and whether the call was a replay.';

-- ---------------------------------------------------------------------------
-- Where the line goes
-- ---------------------------------------------------------------------------

-- A replay: the line exists already. Returns its job when that is `wo` or a
-- job for the same bike (a follow-up); line_conflict otherwise; null when
-- the line is new.
create function private.late_line_replay(wo public.work_orders, line_id uuid)
returns public.add_after_complete_result
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.work_orders;
  result public.add_after_complete_result;
begin
  select w.* into target
  from public.work_order_line_items li
  join public.work_orders w on w.id = li.work_order_id
  where li.id = late_line_replay.line_id;
  if not found then
    return null;
  end if;
  if target.id <> wo.id and (target.bike_id <> wo.bike_id or target.customer_id <> wo.customer_id) then
    raise exception using
      errcode = 'P0001',
      message = 'line_conflict',
      detail = 'That line id is already used for another line.';
  end if;
  select late_line_replay.line_id, target.id, target.job_number, target.id <> wo.id, false, 0, null::uuid, true
    into result;
  return result;
end;
$$;

comment on function private.late_line_replay(public.work_orders, uuid) is
  'D269: a replayed late line returns the job it went on (the job itself or a follow-up for the same bike); line_conflict for a line on an unrelated job; null for a new line.';

revoke all on function private.late_line_replay(public.work_orders, uuid)
  from public, anon, authenticated, service_role;

-- Reopens a completed or ready job (locked by the caller) with the D269
-- reason. False when the job's own reopen rules refuse (bike_with_customer,
-- consignor_archived and the like): the caller then uses a follow-up.
create function private.reopen_for_late_line(wo public.work_orders, what text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  begin
    perform public.set_work_order_status(
      wo.id, 'in_progress',
      pg_catalog.left('Added after completion: ' || coalesce(nullif(pg_catalog.btrim(what), ''), 'a line'), 500)
    );
  exception
    when raise_exception then
      return false;
  end;
  return true;
end;
$$;

comment on function private.reopen_for_late_line(public.work_orders, text) is
  'D269: reopen a completed or ready job with the reason "Added after completion: <description>"; false (nothing changed) when the reopen is refused.';

revoke all on function private.reopen_for_late_line(public.work_orders, text)
  from public, anon, authenticated, service_role;

-- The job a late line goes on, open and locked, and the status to restore
-- afterwards (null: leave it open). `wo` is locked by the caller.
create function private.late_line_target(
  actor uuid,
  wo public.work_orders,
  what text,
  out target_id uuid,
  out restore public.work_order_status
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  today date := private.shop_today();
  n integer := 0;
  follow_up_id uuid;
  job public.work_orders;
  lead_id uuid;
begin
  perform private.require_unclosed_work_order(wo);
  if private.work_order_status_is_open(wo.status) then
    target_id := wo.id;
    return;
  end if;
  -- Completed today: reopen, add, complete again.
  if private.shop_day(wo.completed_at) = today then
    if private.reopen_for_late_line(wo, what) then
      target_id := wo.id;
      restore := wo.status;
      return;
    end if;
  end if;

  -- An earlier day: today's follow-up for this job, skipping closed ones.
  loop
    n := n + 1;
    follow_up_id := pg_catalog.md5('follow_up:' || wo.id::text || ':' || today::text || ':' || n::text)::uuid;
    select w.* into job from public.work_orders w where w.id = follow_up_id for update;
    exit when not found or not private.work_order_status_is_closed(job.status);
  end loop;
  target_id := follow_up_id;

  if job.id is null then
    select s.id into lead_id from public.staff s where s.id = wo.lead_mechanic_id and s.active;
    perform private.create_work_order(
      actor, follow_up_id, wo.customer_id, wo.bike_id,
      pg_catalog.left(
        'Follow-up to ' || wo.job_number || ': '
          || coalesce(nullif(pg_catalog.btrim(what), ''), 'a line added after completion'),
        2000
      ),
      null, lead_id, '{}'::uuid[], null, null
    );
    return;
  end if;
  if private.work_order_status_is_open(job.status) then
    return;
  end if;
  -- The follow-up was completed earlier today: the same-day rule.
  if private.reopen_for_late_line(job, what) then
    restore := job.status;
    return;
  end if;
  perform private.require_open_work_order(job.id);
end;
$$;

comment on function private.late_line_target(uuid, public.work_orders, text) is
  'D269: the open job a late line goes on: the job itself when open; reopened when it was completed on today''s shop day (restore = its status); else today''s follow-up job for the same customer and bike (md5 id, created through private.create_work_order). work_order_closed for a collected or cancelled job.';

revoke all on function private.late_line_target(uuid, public.work_orders, text)
  from public, anon, authenticated, service_role;

-- Back to the status the job was in before the late line (none: no change).
create function private.restore_after_late_line(work_order_id uuid, restore public.work_order_status)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if restore is null then
    return;
  end if;
  perform public.set_work_order_status(restore_after_late_line.work_order_id, 'completed', null);
  if restore = 'ready_for_collection' then
    perform public.set_work_order_status(restore_after_late_line.work_order_id, 'ready_for_collection', null);
  end if;
end;
$$;

comment on function private.restore_after_late_line(uuid, public.work_order_status) is
  'D269: complete a job reopened for a late line again, and make it ready for collection again when it was.';

revoke all on function private.restore_after_late_line(uuid, public.work_order_status)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The three entry points
-- ---------------------------------------------------------------------------
create function public.add_part_after_complete(
  line_id uuid,
  work_order_id uuid,
  product_id uuid,
  quantity integer default 1,
  location_id uuid default null,
  inventory_unit_id uuid default null,
  unit_sale_price public.money_amount default null
)
returns public.add_after_complete_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  what text;
  target_id_of uuid;
  target public.work_orders;
  restore public.work_order_status;
  part public.add_part_result;
  unit_line public.inventory_line_result;
  result public.add_after_complete_result;
begin
  if add_part_after_complete.line_id is null or add_part_after_complete.work_order_id is null
     or add_part_after_complete.product_id is null then
    raise exception 'line_id, work_order_id and product_id are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(add_part_after_complete.work_order_id);
  result := private.late_line_replay(wo, add_part_after_complete.line_id);
  if result.line_id is not null then
    return result;
  end if;

  select p.name into what from public.products p where p.id = add_part_after_complete.product_id;
  if not found then
    raise exception 'product % not found', add_part_after_complete.product_id using errcode = 'P0002';
  end if;
  select l.target_id, l.restore into target_id_of, restore
    from private.late_line_target(actor, wo, what) l;
  target := private.lock_work_order(target_id_of);

  if add_part_after_complete.inventory_unit_id is not null then
    unit_line := public.add_inventory_line(
      add_part_after_complete.line_id, target.id, add_part_after_complete.product_id,
      add_part_after_complete.quantity, add_part_after_complete.location_id,
      add_part_after_complete.inventory_unit_id, add_part_after_complete.unit_sale_price
    );
    select add_part_after_complete.line_id, 1, 0, unit_line.location_id, false into part;
  else
    part := private.add_part_lines(
      target, add_part_after_complete.line_id, add_part_after_complete.product_id,
      add_part_after_complete.quantity, add_part_after_complete.location_id,
      add_part_after_complete.unit_sale_price
    );
  end if;
  perform private.restore_after_late_line(target.id, restore);

  select add_part_after_complete.line_id, target.id, target.job_number,
         target.id <> wo.id, restore is not null, part.received_quantity, part.location_id, false
    into result;
  return result;
end;
$$;

comment on function public.add_part_after_complete(uuid, uuid, uuid, integer, uuid, uuid, public.money_amount) is
  'D269: active staff put a part on a job in any status but collected or cancelled: an open job as Add part; completed today, reopened ("Added after completion: <part>"), added and completed again; completed on an earlier day, on today''s follow-up job for the same bike. Counted parts go through add_part_lines (D267), units through add_inventory_line. Replay-safe by line id.';

revoke all on function public.add_part_after_complete(uuid, uuid, uuid, integer, uuid, uuid, public.money_amount)
  from public, anon, authenticated, service_role;
grant execute on function public.add_part_after_complete(uuid, uuid, uuid, integer, uuid, uuid, public.money_amount)
  to authenticated;

create function public.add_service_after_complete(
  line_id uuid,
  work_order_id uuid,
  service_id uuid,
  quantity public.line_quantity default 1,
  unit_sale_price public.money_amount default null,
  unit_direct_cost public.money_amount default null,
  description text default null
)
returns public.add_after_complete_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  what text;
  target_id_of uuid;
  target public.work_orders;
  restore public.work_order_status;
  result public.add_after_complete_result;
begin
  if add_service_after_complete.unit_direct_cost is not null and not private.has_permission('view_costs') then
    raise exception 'permission view_costs required to set a cost' using errcode = '42501';
  end if;
  if add_service_after_complete.line_id is null or add_service_after_complete.work_order_id is null
     or add_service_after_complete.service_id is null or add_service_after_complete.quantity is null then
    raise exception 'line_id, work_order_id, service_id and quantity are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(add_service_after_complete.work_order_id);
  result := private.late_line_replay(wo, add_service_after_complete.line_id);
  if result.line_id is not null then
    return result;
  end if;

  select coalesce(nullif(pg_catalog.btrim(add_service_after_complete.description), ''), s.name) into what
  from public.services s where s.id = add_service_after_complete.service_id;
  if not found then
    raise exception 'service % not found', add_service_after_complete.service_id using errcode = 'P0002';
  end if;
  select l.target_id, l.restore into target_id_of, restore
    from private.late_line_target(actor, wo, what) l;
  target := private.lock_work_order(target_id_of);
  perform public.add_service_line(
    add_service_after_complete.line_id, target.id, add_service_after_complete.service_id,
    add_service_after_complete.quantity, add_service_after_complete.unit_sale_price,
    add_service_after_complete.unit_direct_cost, add_service_after_complete.description
  );
  perform private.restore_after_late_line(target.id, restore);

  select add_service_after_complete.line_id, target.id, target.job_number,
         target.id <> wo.id, restore is not null, 0, null::uuid, false
    into result;
  return result;
end;
$$;

comment on function public.add_service_after_complete(
  uuid, uuid, uuid, public.line_quantity, public.money_amount, public.money_amount, text
) is 'D269: active staff add a service to a job in any status but collected or cancelled, as add_part_after_complete (same day: reopened, added, completed again; earlier day: a follow-up job). A cost override needs view_costs. Replay-safe by line id.';

revoke all on function public.add_service_after_complete(
  uuid, uuid, uuid, public.line_quantity, public.money_amount, public.money_amount, text
) from public, anon, authenticated, service_role;
grant execute on function public.add_service_after_complete(
  uuid, uuid, uuid, public.line_quantity, public.money_amount, public.money_amount, text
) to authenticated;

create function public.add_manual_after_complete(
  line_id uuid,
  work_order_id uuid,
  description text,
  unit_sale_price public.money_amount,
  quantity public.line_quantity default 1,
  unit_direct_cost public.money_amount default null
)
returns public.add_after_complete_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  target_id_of uuid;
  target public.work_orders;
  restore public.work_order_status;
  result public.add_after_complete_result;
begin
  if add_manual_after_complete.unit_direct_cost is not null and not private.has_permission('view_costs') then
    raise exception 'permission view_costs required to set a cost' using errcode = '42501';
  end if;
  if add_manual_after_complete.line_id is null or add_manual_after_complete.work_order_id is null
     or add_manual_after_complete.description is null or add_manual_after_complete.unit_sale_price is null
     or add_manual_after_complete.quantity is null then
    raise exception 'line_id, work_order_id, description, unit_sale_price and quantity are required'
      using errcode = '22004';
  end if;
  wo := private.lock_work_order(add_manual_after_complete.work_order_id);
  result := private.late_line_replay(wo, add_manual_after_complete.line_id);
  if result.line_id is not null then
    return result;
  end if;

  select l.target_id, l.restore into target_id_of, restore
    from private.late_line_target(actor, wo, add_manual_after_complete.description) l;
  target := private.lock_work_order(target_id_of);
  perform public.add_manual_line(
    add_manual_after_complete.line_id, target.id, add_manual_after_complete.description,
    add_manual_after_complete.unit_sale_price, add_manual_after_complete.quantity,
    add_manual_after_complete.unit_direct_cost
  );
  perform private.restore_after_late_line(target.id, restore);

  select add_manual_after_complete.line_id, target.id, target.job_number,
         target.id <> wo.id, restore is not null, 0, null::uuid, false
    into result;
  return result;
end;
$$;

comment on function public.add_manual_after_complete(
  uuid, uuid, text, public.money_amount, public.line_quantity, public.money_amount
) is 'D269: active staff add a free-text line to a job in any status but collected or cancelled, as add_part_after_complete (same day: reopened, added, completed again; earlier day: a follow-up job). A cost needs view_costs. Replay-safe by line id.';

revoke all on function public.add_manual_after_complete(
  uuid, uuid, text, public.money_amount, public.line_quantity, public.money_amount
) from public, anon, authenticated, service_role;
grant execute on function public.add_manual_after_complete(
  uuid, uuid, text, public.money_amount, public.line_quantity, public.money_amount
) to authenticated;
