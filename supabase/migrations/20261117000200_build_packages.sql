-- D246-D251: build packages. The owner's request 2026-11-17: a full build
-- (Classic, Classic+, Restomod, Restomod+) is sold at one price; the frame
-- is a separate sale at its full price; of the package, a fixed labour
-- amount (S$180) is service revenue and the balance is the parts budget,
-- recognised as product revenue through the parts actually fitted, priced
-- down where needed so they add up to the budget. Build-only packages
-- (Full Send, Clean Slate, Strip and rebuild) are labour on the customer's
-- own bike.
--
--   D246 build_packages: kind (full_build | build_only), name, price (or a
--        "from" price), labour amount, the service the labour line uses,
--        public, sort order. Admins write them; staff read; anyone reads
--        the public, live ones through public_build_packages().
--   D247 work_order_builds: at most one package per job, with its price and
--        labour amount snapshotted and the job's labour line (a service
--        line at the labour amount). Set, changed and cleared only through
--        set_work_order_build and clear_work_order_build on an open job.
--   D248 repricing: a live line of a job with a package may have its sale
--        price changed (never anything else), only by reprice_build_line
--        and fit_build_to_budget, only while the job is open, with a
--        line_repriced or build_fitted event. The first change keeps the
--        line's original price in unit_list_price_snapshot. Every other
--        line stays immutable except voiding (D15 unchanged).
--   D249 fit to budget: the parts are the job's live inventory lines. At
--        list prices above the budget, each part's price is its list price
--        times budget / list total, rounded to the cent; at or under the
--        budget they stay at list. The labour line then takes the rest of
--        the package price, so the package always adds up to its price:
--        S$180 give or take the rounding cents when parts are scaled, more
--        when they come in under budget (the owner, 2026-11-17: parts are
--        never charged above their shelf price; the difference is service
--        revenue). Lines outside the package (other services, manual
--        lines) are not touched and are billed on top.
--   D250 revenue: unchanged rules. The labour line is a service line and
--        the parts inventory lines, so the job's completion recognises the
--        labour as service revenue and the parts as product revenue
--        (financial_lines, D32). A price below cost is allowed and reports
--        as a loss line (D1).
--   D251 clearing a package voids its labour line and returns repriced
--        parts to their list prices.

-- ---------------------------------------------------------------------------
-- build_packages (D246)
-- ---------------------------------------------------------------------------
create type public.build_package_kind as enum ('full_build', 'build_only');

create table public.build_packages (
  id uuid primary key default gen_random_uuid(),
  kind public.build_package_kind not null,
  name text not null,
  description text null,
  price public.money_amount not null,
  price_is_from boolean not null default false,
  labour_amount public.money_amount not null,
  labour_service_id uuid not null references public.services (id),
  currency char(3) not null default 'SGD',
  public boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid null references public.staff (id),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz null,
  constraint build_packages_name_length check (pg_catalog.char_length(name) between 1 and 80),
  constraint build_packages_description_length check (
    description is null or pg_catalog.char_length(description) <= 4000
  ),
  constraint build_packages_price_positive check (price > 0),
  constraint build_packages_labour_within_price check (labour_amount <= price),
  constraint build_packages_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint build_packages_sort_order_range check (sort_order between 0 and 10000)
);

create unique index build_packages_name_key
  on public.build_packages (pg_catalog.lower(name))
  where archived_at is null;

comment on table public.build_packages is
  'D246: a build sold at one price. full_build: parts and labour (the labour amount is service revenue, the rest the parts budget, D249); build_only: labour on the customer''s own bike. Admins write; staff read; public_build_packages() for the site.';

create trigger build_packages_set_updated_at
  before update on public.build_packages
  for each row execute function private.set_updated_at();

create function private.build_packages_enforce_rules()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  svc_archived timestamptz;
begin
  new.name := pg_catalog.btrim(coalesce(new.name, ''));
  new.description := nullif(pg_catalog.btrim(coalesce(new.description, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := private.current_staff_id();
  end if;
  if tg_op = 'INSERT' or new.labour_service_id is distinct from old.labour_service_id then
    select s.archived_at into svc_archived from public.services s where s.id = new.labour_service_id;
    if not found or svc_archived is not null then
      raise exception using errcode = 'P0001', message = 'build_labour_service_invalid',
        detail = 'Choose a live service for the build''s labour line.';
    end if;
  end if;
  return new;
end;
$$;

create trigger build_packages_enforce_rules
  before insert or update on public.build_packages
  for each row execute function private.build_packages_enforce_rules();

alter table public.build_packages enable row level security;

-- Hosted Supabase grants ALL on new public tables: start from nothing.
revoke all on table public.build_packages from public, anon, authenticated;

grant select on table public.build_packages to authenticated;
grant insert (
  id, kind, name, description, price, price_is_from, labour_amount, labour_service_id, currency, public, sort_order
) on table public.build_packages to authenticated;
grant update (
  kind, name, description, price, price_is_from, labour_amount, labour_service_id, public, sort_order, archived_at
) on table public.build_packages to authenticated;
grant select on table public.build_packages to service_role;

create policy build_packages_select_staff on public.build_packages
  for select to authenticated
  using ((select private.is_staff()));

create policy build_packages_insert_admin on public.build_packages
  for insert to authenticated
  with check ((select private.is_admin()));

create policy build_packages_update_admin on public.build_packages
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- The public site's list: live, public packages, in order.
create function public.public_build_packages()
returns table (
  id uuid,
  kind public.build_package_kind,
  name text,
  description text,
  price public.money_amount,
  price_is_from boolean,
  currency char(3),
  sort_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.kind, p.name, p.description, p.price, p.price_is_from, p.currency, p.sort_order
  from public.build_packages p
  where p.public and p.archived_at is null
  order by p.kind, p.sort_order, p.price, p.name;
$$;

comment on function public.public_build_packages() is
  'D246: anyone: the live, public build packages (no labour split, no service), by kind, sort order and price.';

revoke all on function public.public_build_packages() from public, anon, authenticated, service_role;
grant execute on function public.public_build_packages() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- work_order_builds (D247)
-- ---------------------------------------------------------------------------
create table public.work_order_builds (
  work_order_id uuid primary key references public.work_orders (id),
  build_package_id uuid not null references public.build_packages (id),
  price public.money_amount not null,
  labour_amount public.money_amount not null,
  labour_line_id uuid not null references public.work_order_line_items (id),
  currency char(3) not null,
  created_by uuid null references public.staff (id),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint work_order_builds_price_positive check (price > 0),
  constraint work_order_builds_labour_within_price check (labour_amount <= price),
  constraint work_order_builds_labour_line_id_key unique (labour_line_id)
);

create index work_order_builds_build_package_id_idx on public.work_order_builds (build_package_id);

comment on table public.work_order_builds is
  'D247: the job''s build package with its price and labour amount at the time it was set, and the job''s labour line. Written only by set_work_order_build and clear_work_order_build.';

create trigger work_order_builds_set_updated_at
  before update on public.work_order_builds
  for each row execute function private.set_updated_at();

alter table public.work_order_builds enable row level security;
revoke all on table public.work_order_builds from public, anon, authenticated;
grant select on table public.work_order_builds to authenticated;
grant select on table public.work_order_builds to service_role;

create policy work_order_builds_select_staff on public.work_order_builds
  for select to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Repricing (D248)
-- ---------------------------------------------------------------------------
alter table public.work_order_line_items
  add column unit_list_price_snapshot public.money_amount null;

comment on column public.work_order_line_items.unit_list_price_snapshot is
  'D248: the line''s sale price before its first build repricing (reprice_build_line, fit_build_to_budget); null when never repriced.';

grant select (unit_list_price_snapshot) on table public.work_order_line_items to authenticated;

-- Phase 3's rules (20261004001400) with one new UPDATE path: a sale price
-- change on a live line of an open job, only inside private.reprice_line
-- (which sets bicii.line_reprice for its own statement). Voiding is
-- unchanged and may not touch the list price either.
create or replace function private.work_order_line_items_enforce_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  wo_status public.work_order_status;
  wo_currency char(3);
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'line_immutable',
      detail = 'Lines are kept as evidence; void the line instead.';
  end if;

  if tg_op = 'INSERT' then
    select w.status, w.currency into wo_status, wo_currency
    from public.work_orders w where w.id = new.work_order_id
    for share;
    if not found then
      raise exception 'work order % not found', new.work_order_id using errcode = 'P0002';
    end if;
    if not private.work_order_status_is_open(wo_status) then
      raise exception using
        errcode = 'P0001',
        message = 'work_order_locked',
        detail = 'This job is completed or closed; reopen it to change its lines.';
    end if;
    new.currency := wo_currency;
    new.description_snapshot := pg_catalog.btrim(new.description_snapshot);
    new.void_reason := nullif(pg_catalog.btrim(new.void_reason), '');
    new.unit_list_price_snapshot := null;
    if new.voided_at is not null or new.voided_by is not null or new.void_reason is not null then
      raise exception using
        errcode = 'P0001',
        message = 'line_immutable',
        detail = 'A line is added first and voided afterwards.';
    end if;
    return new;
  end if;

  -- UPDATE (a): D248's repricing, only from private.reprice_line.
  if pg_catalog.current_setting('bicii.line_reprice', true) = 'on'
     and old.voided_at is null and new.voided_at is null
     and new.voided_by is null and new.void_reason is null
     and new.id is not distinct from old.id
     and new.work_order_id is not distinct from old.work_order_id
     and new.line_type is not distinct from old.line_type
     and new.source_service_id is not distinct from old.source_service_id
     and new.source_product_id is not distinct from old.source_product_id
     and new.source_inventory_unit_id is not distinct from old.source_inventory_unit_id
     and new.description_snapshot is not distinct from old.description_snapshot
     and new.quantity is not distinct from old.quantity
     and new.unit_direct_cost_snapshot is not distinct from old.unit_direct_cost_snapshot
     and new.cost_pending is not distinct from old.cost_pending
     and new.cult_commons_rate_snapshot is not distinct from old.cult_commons_rate_snapshot
     and new.currency is not distinct from old.currency
     and new.created_by is not distinct from old.created_by
     and new.created_at is not distinct from old.created_at
     and new.consignment_item_id is not distinct from old.consignment_item_id
     and new.consignor_payout_snapshot is not distinct from old.consignor_payout_snapshot then
    select w.status into wo_status from public.work_orders w where w.id = new.work_order_id for share;
    if not private.work_order_status_is_open(wo_status) then
      raise exception using
        errcode = 'P0001',
        message = 'work_order_locked',
        detail = 'This job is completed or closed; reopen it to change its lines.';
    end if;
    return new;
  end if;

  -- UPDATE (b): only voiding, once.
  new.void_reason := nullif(pg_catalog.btrim(new.void_reason), '');
  if old.voided_at is not null
     or new.voided_at is null
     or old.voided_by is not null
     or new.id is distinct from old.id
     or new.work_order_id is distinct from old.work_order_id
     or new.line_type is distinct from old.line_type
     or new.source_service_id is distinct from old.source_service_id
     or new.source_product_id is distinct from old.source_product_id
     or new.source_inventory_unit_id is distinct from old.source_inventory_unit_id
     or new.description_snapshot is distinct from old.description_snapshot
     or new.quantity is distinct from old.quantity
     or new.unit_sale_price_snapshot is distinct from old.unit_sale_price_snapshot
     or new.unit_list_price_snapshot is distinct from old.unit_list_price_snapshot
     or new.unit_direct_cost_snapshot is distinct from old.unit_direct_cost_snapshot
     or new.cost_pending is distinct from old.cost_pending
     or new.cult_commons_rate_snapshot is distinct from old.cult_commons_rate_snapshot
     or new.currency is distinct from old.currency
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'P0001',
      message = 'line_immutable',
      detail = 'A line cannot be edited, only voided once; void it and add a new one.';
  end if;

  select w.status into wo_status from public.work_orders w where w.id = new.work_order_id for share;
  if not private.work_order_status_is_open(wo_status) then
    raise exception using
      errcode = 'P0001',
      message = 'work_order_locked',
      detail = 'This job is completed or closed; reopen it to change its lines.';
  end if;
  return new;
end;
$$;

-- The one writer of a line's new price (D248); the list price keeps the
-- price before the first change unless list_price names it.
create function private.reprice_line(
  line_id uuid,
  new_price public.money_amount,
  list_price public.money_amount default null
)
returns public.work_order_line_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result public.work_order_line_items;
begin
  perform pg_catalog.set_config('bicii.line_reprice', 'on', true);
  update public.work_order_line_items li
  set unit_list_price_snapshot = coalesce(
        reprice_line.list_price, li.unit_list_price_snapshot, li.unit_sale_price_snapshot
      ),
      unit_sale_price_snapshot = reprice_line.new_price
  where li.id = reprice_line.line_id
  returning li.* into result;
  perform pg_catalog.set_config('bicii.line_reprice', 'off', true);
  if not found then
    raise exception 'line % not found', reprice_line.line_id using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke all on function private.reprice_line(uuid, public.money_amount, public.money_amount)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Setting and clearing a job's package (D247, D251)
-- ---------------------------------------------------------------------------
create function public.set_work_order_build(
  work_order_id uuid,
  build_package_id uuid,
  labour_line_id uuid,
  price public.money_amount default null
)
returns public.work_order_builds
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  pkg public.build_packages;
  existing public.work_order_builds;
  labour_live boolean;
  eff_price public.money_amount;
  eff_labour public.money_amount;
  result public.work_order_builds;
begin
  if set_work_order_build.work_order_id is null or set_work_order_build.build_package_id is null
     or set_work_order_build.labour_line_id is null then
    raise exception 'work_order_id, build_package_id and labour_line_id are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(set_work_order_build.work_order_id);
  select p.* into pkg from public.build_packages p where p.id = set_work_order_build.build_package_id;
  if not found then
    raise exception 'build package % not found', set_work_order_build.build_package_id using errcode = 'P0002';
  end if;
  eff_price := coalesce(set_work_order_build.price, pkg.price);
  if not pkg.price_is_from and eff_price <> pkg.price then
    raise exception using errcode = 'P0001', message = 'build_price_fixed',
      detail = pg_catalog.format('%s has a fixed price of %s.', pkg.name, pkg.price);
  end if;
  if pkg.price_is_from and eff_price < pkg.price then
    raise exception using errcode = 'P0001', message = 'build_price_below_from',
      detail = pg_catalog.format('%s starts at %s.', pkg.name, pkg.price);
  end if;
  -- A "from" price above the base price is labour (build-only work).
  eff_labour := (pkg.labour_amount + (eff_price - pkg.price))::public.money_amount;

  select b.* into existing from public.work_order_builds b where b.work_order_id = wo.id for update;
  if found then
    select li.voided_at is null into labour_live
    from public.work_order_line_items li where li.id = existing.labour_line_id;
    -- Replay: the same package and price with its labour line in place.
    if existing.build_package_id = pkg.id and existing.price = eff_price and labour_live then
      return existing;
    end if;
  end if;

  perform private.require_open_work_order(wo.id);
  if pkg.archived_at is not null then
    raise exception using errcode = 'P0001', message = 'build_package_archived',
      detail = 'That package is archived; choose a live one.';
  end if;
  if pkg.currency <> wo.currency then
    raise exception using errcode = 'P0001', message = 'currency_mismatch',
      detail = 'That package is priced in another currency than the job.';
  end if;

  if existing.work_order_id is not null and labour_live then
    perform private.reprice_line(existing.labour_line_id, eff_labour, eff_labour);
    update public.work_order_builds b
    set build_package_id = pkg.id, price = eff_price, labour_amount = eff_labour
    where b.work_order_id = wo.id
    returning b.* into result;
  else
    perform private.insert_service_line(
      wo, set_work_order_build.labour_line_id, pkg.labour_service_id, 1, eff_labour, null,
      pkg.name || ' · build labour'
    );
    if existing.work_order_id is not null then
      update public.work_order_builds b
      set build_package_id = pkg.id, price = eff_price, labour_amount = eff_labour,
          labour_line_id = set_work_order_build.labour_line_id
      where b.work_order_id = wo.id
      returning b.* into result;
    else
      insert into public.work_order_builds (
        work_order_id, build_package_id, price, labour_amount, labour_line_id, currency, created_by
      )
      values (wo.id, pkg.id, eff_price, eff_labour, set_work_order_build.labour_line_id, wo.currency, actor)
      returning * into result;
    end if;
  end if;

  perform private.record_work_order_event(
    wo.id, 'build_set',
    pg_catalog.jsonb_build_object(
      'build_package_id', pkg.id,
      'name', pkg.name,
      'kind', pkg.kind,
      'price', eff_price,
      'labour_amount', eff_labour,
      'labour_line_id', result.labour_line_id,
      'previous_build_package_id', existing.build_package_id,
      'previous_price', existing.price
    )
  );
  return result;
end;
$$;

comment on function public.set_work_order_build(uuid, uuid, uuid, public.money_amount) is
  'D247: active staff: give an open job a build package (or change it): snapshots the price (fixed, or at least a "from" price) and labour amount and adds or reprices the job''s labour line (a service line at the labour amount, id labour_line_id). Replay-safe; build_set event.';

revoke all on function public.set_work_order_build(uuid, uuid, uuid, public.money_amount) from public, anon, authenticated, service_role;
grant execute on function public.set_work_order_build(uuid, uuid, uuid, public.money_amount) to authenticated;

create function public.clear_work_order_build(work_order_id uuid, reason text)
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

comment on function public.clear_work_order_build(uuid, text) is
  'D251: active staff: take the package off an open job with a reason: repriced parts go back to their list prices and the labour line is voided; build_cleared event. No package: returns the job id.';

revoke all on function public.clear_work_order_build(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.clear_work_order_build(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Repricing one line, and fitting the parts to the budget (D248, D249)
-- ---------------------------------------------------------------------------
create function public.reprice_build_line(line_id uuid, unit_sale_price public.money_amount)
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
  result public.work_order_line_items;
begin
  if reprice_build_line.line_id is null or reprice_build_line.unit_sale_price is null then
    raise exception 'line_id and unit_sale_price are required' using errcode = '22004';
  end if;
  select li.* into target from public.work_order_line_items li where li.id = reprice_build_line.line_id;
  if not found then
    raise exception 'line % not found', reprice_build_line.line_id using errcode = 'P0002';
  end if;
  wo := private.require_open_work_order(target.work_order_id);
  select b.* into build from public.work_order_builds b where b.work_order_id = wo.id;
  if not found then
    raise exception using errcode = 'P0001', message = 'build_missing',
      detail = 'Give the job a build package first.';
  end if;
  select li.* into target from public.work_order_line_items li where li.id = reprice_build_line.line_id for update;
  if target.voided_at is not null then
    raise exception using errcode = 'P0001', message = 'build_line_voided',
      detail = 'That line is voided.';
  end if;
  if target.line_type <> 'inventory' and target.id <> build.labour_line_id then
    raise exception using errcode = 'P0001', message = 'build_line_not_repriceable',
      detail = 'Only the build''s parts and its labour line can be repriced.';
  end if;
  if target.unit_sale_price_snapshot = reprice_build_line.unit_sale_price then
    return target;
  end if;
  result := private.reprice_line(target.id, reprice_build_line.unit_sale_price);
  perform private.record_work_order_event(
    wo.id, 'line_repriced',
    pg_catalog.jsonb_build_object(
      'line_id', target.id,
      'description', target.description_snapshot,
      'quantity', target.quantity,
      'from_price', target.unit_sale_price_snapshot,
      'to_price', result.unit_sale_price_snapshot,
      'list_price', result.unit_list_price_snapshot,
      'sale_total', result.sale_total,
      'currency', result.currency
    )
  );
  return result;
end;
$$;

comment on function public.reprice_build_line(uuid, public.money_amount) is
  'D248: active staff: change the sale price of one live part (inventory line) or the labour line of an open job with a build package; the first change keeps the list price; line_repriced event. Same price: no change, no event.';

revoke all on function public.reprice_build_line(uuid, public.money_amount) from public, anon, authenticated, service_role;
grant execute on function public.reprice_build_line(uuid, public.money_amount) to authenticated;

create function public.fit_build_to_budget(work_order_id uuid)
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
  order by l.id
  for update;
  select coalesce(sum(round(l.quantity * coalesce(l.unit_list_price_snapshot, l.unit_sale_price_snapshot), 2)), 0)
  into list_total
  from public.work_order_line_items l
  where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory';

  budget := build.price - build.labour_amount;
  if list_total > budget and list_total > 0 then
    factor := budget / list_total;
  end if;

  for li in
    select l.id, l.quantity, l.description_snapshot, l.unit_sale_price_snapshot,
           coalesce(l.unit_list_price_snapshot, l.unit_sale_price_snapshot) as list_price
    from public.work_order_line_items l
    where l.work_order_id = wo.id and l.voided_at is null and l.line_type = 'inventory'
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
  'D249: active staff: on an open job with a build package, price the live parts (inventory lines) so they add up to the parts budget (list price × budget / list total, to the cent, when the list total is above the budget; list price otherwise) and give the labour line the rest of the package price; build_fitted event when anything changed. Returns the summary.';

revoke all on function public.fit_build_to_budget(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fit_build_to_budget(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The job's build at a glance (D249)
-- ---------------------------------------------------------------------------
create view public.work_order_build_summary
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
       b.currency
from public.work_order_builds b
join public.build_packages p on p.id = b.build_package_id
cross join lateral (
  select count(*)::integer as parts_count,
         coalesce(sum(round(li.quantity * coalesce(li.unit_list_price_snapshot, li.unit_sale_price_snapshot), 2)), 0)
           as parts_list_total,
         coalesce(sum(li.sale_total), 0) as parts_total
  from public.work_order_line_items li
  where li.work_order_id = b.work_order_id and li.voided_at is null and li.line_type = 'inventory'
) x
left join lateral (
  select li.sale_total as labour_total
  from public.work_order_line_items li
  where li.id = b.labour_line_id and li.voided_at is null
) l on true;

comment on view public.work_order_build_summary is
  'D249: per job with a package: price, labour amount, parts budget, the live parts at list and at their prices, the live labour line, the package total and the difference from the price (0 when fitted). Security invoker: staff through RLS.';

revoke all on table public.work_order_build_summary from public, anon, authenticated;
grant select on table public.work_order_build_summary to authenticated;
