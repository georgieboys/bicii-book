-- D261: build extras. The owner's request 2026-11-22: one-off items (a
-- consigned saddle, a used part from the shop) added to a build on the fly
-- and charged on top of the package price, not priced into it.
--
--   - work_order_build_extras: the live parts (inventory lines) of a job with
--     a package that are extras. Written only by set_build_line_extra, and
--     gone with the package (clear_work_order_build deletes the build row,
--     which cascades).
--   - An extra is left out of the parts: fit_build_to_budget never prices it
--     and work_order_build_summary counts it apart (extras_count,
--     extras_total), so the package adds up to its price without it and the
--     extra is billed on top at its own price.
--   - Marking a part extra puts a fitted (repriced) part back to its shelf
--     price; staff may still reprice it with reprice_build_line, and taking
--     the package off keeps that price. Back in the package, the part keeps
--     its price until the next fit.
--   - Nothing else changes: an extra is still an inventory line, so it takes
--     stock, holds a unique unit, owes a consignor their agreed amount on
--     completion (D44) and counts as product revenue (D250). Manual lines and
--     other services were already outside the package (D249).

-- ---------------------------------------------------------------------------
-- work_order_build_extras
-- ---------------------------------------------------------------------------
create table public.work_order_build_extras (
  line_id uuid primary key references public.work_order_line_items (id),
  work_order_id uuid not null references public.work_order_builds (work_order_id) on delete cascade,
  marked_by uuid null references public.staff (id),
  marked_at timestamptz not null default pg_catalog.now()
);

create index work_order_build_extras_work_order_id_idx
  on public.work_order_build_extras (work_order_id);

comment on table public.work_order_build_extras is
  'D261: the parts of a job with a build package that are extras, charged on top of the package at their own price and never fitted to its budget. Written only by set_build_line_extra; deleted with the package.';

alter table public.work_order_build_extras enable row level security;
revoke all on table public.work_order_build_extras from public, anon, authenticated;
grant select on table public.work_order_build_extras to authenticated;
grant select on table public.work_order_build_extras to service_role;

create policy work_order_build_extras_select_staff on public.work_order_build_extras
  for select to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- set_build_line_extra
-- ---------------------------------------------------------------------------
create function public.set_build_line_extra(line_id uuid, extra boolean)
returns public.work_order_line_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  target public.work_order_line_items;
  wo public.work_orders;
  build public.work_order_builds;
  is_extra boolean;
  result public.work_order_line_items;
begin
  if set_build_line_extra.line_id is null or set_build_line_extra.extra is null then
    raise exception 'line_id and extra are required' using errcode = '22004';
  end if;
  select li.* into target from public.work_order_line_items li where li.id = set_build_line_extra.line_id;
  if not found then
    raise exception 'line % not found', set_build_line_extra.line_id using errcode = 'P0002';
  end if;
  wo := private.require_open_work_order(target.work_order_id);
  select b.* into build from public.work_order_builds b where b.work_order_id = wo.id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'build_missing',
      detail = 'Give the job a build package first.';
  end if;
  select li.* into target from public.work_order_line_items li where li.id = set_build_line_extra.line_id for update;
  if target.voided_at is not null then
    raise exception using errcode = 'P0001', message = 'build_line_voided',
      detail = 'That line is voided.';
  end if;
  if target.line_type <> 'inventory' then
    raise exception using errcode = 'P0001', message = 'build_line_not_part',
      detail = 'Only a part from stock can be an extra; services and manual lines are already charged on top.';
  end if;

  is_extra := exists (select 1 from public.work_order_build_extras e where e.line_id = target.id);
  if is_extra = set_build_line_extra.extra then
    return target;
  end if;

  if set_build_line_extra.extra then
    insert into public.work_order_build_extras (line_id, work_order_id, marked_by)
    values (target.id, wo.id, actor);
    -- A fitted part goes back to its shelf price: it is charged on its own now.
    if target.unit_list_price_snapshot is not null
       and target.unit_list_price_snapshot <> target.unit_sale_price_snapshot then
      result := private.reprice_line(target.id, target.unit_list_price_snapshot);
    else
      result := target;
    end if;
  else
    delete from public.work_order_build_extras e where e.line_id = target.id;
    result := target;
  end if;

  perform private.record_work_order_event(
    wo.id,
    case when set_build_line_extra.extra then 'build_extra_marked' else 'build_extra_unmarked' end
      ::public.work_order_event_type,
    pg_catalog.jsonb_build_object(
      'line_id', target.id,
      'description', target.description_snapshot,
      'quantity', target.quantity,
      'from_price', target.unit_sale_price_snapshot,
      'to_price', result.unit_sale_price_snapshot,
      'sale_total', result.sale_total,
      'currency', result.currency
    )
  );
  return result;
end;
$$;

comment on function public.set_build_line_extra(uuid, boolean) is
  'D261: active staff: on an open job with a build package, make one live part (inventory line) an extra, charged on top of the package at its own price (a fitted part goes back to its shelf price), or put it back in the package; build_extra_marked or build_extra_unmarked event. No change: no event.';

revoke all on function public.set_build_line_extra(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_build_line_extra(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Clearing keeps an extra's own price (D251 otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.clear_work_order_build(work_order_id uuid, reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  cleaned text := private.require_reason(clear_work_order_build.reason);
  wo public.work_orders;
  existing public.work_order_builds;
  li record;
begin
  if clear_work_order_build.work_order_id is null then
    raise exception 'work_order_id is required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(clear_work_order_build.work_order_id);
  select b.* into existing from public.work_order_builds b where b.work_order_id = wo.id for update;
  if not found then
    return wo.id;
  end if;
  perform private.require_open_work_order(wo.id);
  for li in
    select l.id, l.unit_list_price_snapshot
    from public.work_order_line_items l
    where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory'
      and l.unit_list_price_snapshot is not null
      and l.unit_list_price_snapshot <> l.unit_sale_price_snapshot
      and not exists (select 1 from public.work_order_build_extras e where e.line_id = l.id)
    order by l.id
    for update
  loop
    perform private.reprice_line(li.id, li.unit_list_price_snapshot);
  end loop;
  update public.work_order_line_items l
  set voided_at = pg_catalog.clock_timestamp(), voided_by = actor, void_reason = cleaned
  where l.id = existing.labour_line_id and l.voided_at is null;
  delete from public.work_order_builds b where b.work_order_id = wo.id;
  perform private.record_work_order_event(
    wo.id, 'build_cleared',
    pg_catalog.jsonb_build_object(
      'build_package_id', existing.build_package_id,
      'price', existing.price,
      'labour_line_id', existing.labour_line_id,
      'reason', cleaned
    )
  );
  return wo.id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Fitting leaves the extras out (D249 otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.fit_build_to_budget(work_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  build public.work_order_builds;
  labour public.work_order_line_items;
  budget numeric;
  list_total numeric := 0;
  parts_total numeric := 0;
  factor numeric := 1;
  new_price numeric;
  new_labour numeric;
  li record;
  changed jsonb := '[]'::jsonb;
  summary jsonb;
begin
  if fit_build_to_budget.work_order_id is null then
    raise exception 'work_order_id is required' using errcode = '22004';
  end if;
  wo := private.require_open_work_order(fit_build_to_budget.work_order_id);
  select b.* into build from public.work_order_builds b where b.work_order_id = wo.id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'build_missing',
      detail = 'Give the job a build package first.';
  end if;
  select l.* into labour from public.work_order_line_items l where l.id = build.labour_line_id for update;
  if labour.voided_at is not null then
    raise exception using errcode = 'P0001', message = 'build_labour_line_voided',
      detail = 'The build''s labour line was voided; set the package again first.';
  end if;

  -- The parts at their list prices, locked in id order.
  perform 1 from public.work_order_line_items l
  where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory'
    and not exists (select 1 from public.work_order_build_extras e where e.line_id = l.id)
  order by l.id
  for update;
  select coalesce(sum(round(l.quantity * coalesce(l.unit_list_price_snapshot, l.unit_sale_price_snapshot), 2)), 0)
  into list_total
  from public.work_order_line_items l
  where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory'
    and not exists (select 1 from public.work_order_build_extras e where e.line_id = l.id);

  budget := build.price - build.labour_amount;
  if list_total > budget and list_total > 0 then
    factor := budget / list_total;
  end if;

  for li in
    select l.id, l.quantity, l.description_snapshot, l.unit_sale_price_snapshot,
           coalesce(l.unit_list_price_snapshot, l.unit_sale_price_snapshot) as list_price
    from public.work_order_line_items l
    where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory'
    and not exists (select 1 from public.work_order_build_extras e where e.line_id = l.id)
    order by l.created_at, l.id
  loop
    new_price := case when factor = 1 then li.list_price else round(li.list_price * factor, 2) end;
    parts_total := parts_total + round(li.quantity * new_price, 2);
    if new_price <> li.unit_sale_price_snapshot then
      perform private.reprice_line(li.id, new_price::public.money_amount);
      changed := changed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'line_id', li.id, 'description', li.description_snapshot, 'quantity', li.quantity,
        'from_price', li.unit_sale_price_snapshot, 'to_price', new_price, 'list_price', li.list_price
      ));
    end if;
  end loop;

  -- The labour line takes the rest, so the package adds up to its price.
  new_labour := build.price - parts_total;
  if new_labour < 0 then
    raise exception using errcode = 'P0001', message = 'build_over_budget',
      detail = 'The parts cost more than the whole package even after fitting; check the package price.';
  end if;
  if new_labour <> labour.unit_sale_price_snapshot then
    perform private.reprice_line(labour.id, new_labour::public.money_amount);
    changed := changed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'line_id', labour.id, 'description', labour.description_snapshot, 'quantity', labour.quantity,
      'from_price', labour.unit_sale_price_snapshot, 'to_price', new_labour,
      'list_price', coalesce(labour.unit_list_price_snapshot, labour.unit_sale_price_snapshot)
    ));
  end if;

  summary := pg_catalog.jsonb_build_object(
    'price', build.price,
    'labour_amount', build.labour_amount,
    'parts_budget', budget,
    'parts_list_total', list_total,
    'parts_total', parts_total,
    'labour_total', new_labour,
    'factor', round(factor, 6),
    'changed', changed
  );
  if pg_catalog.jsonb_array_length(changed) > 0 then
    perform private.record_work_order_event(wo.id, 'build_fitted', summary);
  end if;
  return summary;
end;
$$;


comment on function public.fit_build_to_budget(uuid) is
  'D249, D261: active staff: on an open job with a build package, price the live parts (inventory lines that are not extras) so they add up to the parts budget (list price × budget / list total, to the cent, when the list total is above the budget; list price otherwise) and give the labour line the rest of the package price; build_fitted event when anything changed. Extras keep their own price. Returns the summary.';

-- ---------------------------------------------------------------------------
-- The job's build at a glance, extras apart (D249, D261)
-- ---------------------------------------------------------------------------
create or replace view public.work_order_build_summary
with (security_invoker = on)
as
select b.work_order_id,
       b.build_package_id,
       p.name,
       p.kind,
       b.price,
       b.labour_amount,
       (b.price - b.labour_amount)::public.money_amount as parts_budget,
       b.labour_line_id,
       x.parts_count,
       x.parts_list_total::public.money_amount as parts_list_total,
       x.parts_total::public.money_amount as parts_total,
       l.labour_total::public.money_amount as labour_total,
       (x.parts_total + coalesce(l.labour_total, 0))::public.money_amount as package_total,
       (b.price - x.parts_total - coalesce(l.labour_total, 0)) as difference,
       b.currency,
       y.extras_count,
       y.extras_total::public.money_amount as extras_total
from public.work_order_builds b
join public.build_packages p on p.id = b.build_package_id
cross join lateral (
  select count(*)::integer as parts_count,
         coalesce(sum(round(li.quantity * coalesce(li.unit_list_price_snapshot, li.unit_sale_price_snapshot), 2)), 0)
           as parts_list_total,
         coalesce(sum(li.sale_total), 0) as parts_total
  from public.work_order_line_items li
  where li.work_order_id = b.work_order_id and li.voided_at is null and li.line_type = 'inventory'
    and not exists (select 1 from public.work_order_build_extras e where e.line_id = li.id)
) x
left join lateral (
  select li.sale_total as labour_total
  from public.work_order_line_items li
  where li.id = b.labour_line_id and li.voided_at is null
) l on true
cross join lateral (
  select count(*)::integer as extras_count,
         coalesce(sum(li.sale_total), 0) as extras_total
  from public.work_order_build_extras e
  join public.work_order_line_items li on li.id = e.line_id
  where e.work_order_id = b.work_order_id and li.voided_at is null
) y;


comment on view public.work_order_build_summary is
  'D249, D261: per job with a package: price, labour amount, parts budget, the live parts (not extras) at list and at their prices, the live labour line, the package total and the difference from the price (0 when fitted), and the live extras charged on top (extras_count, extras_total). Security invoker: staff through RLS.';
