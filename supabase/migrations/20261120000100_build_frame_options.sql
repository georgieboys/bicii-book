-- D257-D259: where a full build's frame comes from, chosen on Shopify.
-- The owner, 2026-11-20: each full build on Shopify offers three frame
-- options, and has a picture.
--
--   D257 options: a package pushed to Shopify has a "Frame" option with a
--        variant each for a prepared frame from BICII (the existing
--        variant, kept for the site's cart links), the customer's own
--        prepared frame (accepted only after a free inspection; frame work
--        quoted separately), both at the package price, and a complete
--        donor bike, at the package price plus the donor service's price
--        (S$185 on 2026-11-20). An order line on any of them becomes a build
--        order that remembers its frame option.
--   D258 donor money: a donor-bike build order holds the strip's share
--        (the pushed donor amount, never above what was paid); linking it
--        to a job adds that as a line of the donor service and prices the
--        build at the rest, so the job's total still equals what was paid.
--   D259 pictures: a package has an image URL (the site's
--        /builds/packages/<package>.png), pushed as its Shopify media.

create type public.build_frame_source as enum ('bicii_frame', 'own_frame', 'donor_bike');

comment on type public.build_frame_source is
  'D257: where a full build''s frame comes from: a prepared frame bought from BICII, the customer''s own prepared frame (inspected first), or a donor bike stripped and prepared.';

-- ---------------------------------------------------------------------------
-- Packages (D257, D259)
-- ---------------------------------------------------------------------------
alter table public.build_packages
  add column image_url text null,
  add column donor_service_id uuid null references public.services (id) on delete restrict,
  add column shopify_own_frame_variant_id text null,
  add column shopify_donor_variant_id text null,
  add column shopify_donor_amount public.money_amount null,
  add constraint build_packages_image_url_https check (image_url is null or image_url ~ '^https://[^[:space:]]+$'),
  add constraint build_packages_own_frame_variant_format check (
    shopify_own_frame_variant_id is null or shopify_own_frame_variant_id ~ '^gid://shopify/ProductVariant/[0-9]+$'
  ),
  add constraint build_packages_donor_variant_format check (
    shopify_donor_variant_id is null or shopify_donor_variant_id ~ '^gid://shopify/ProductVariant/[0-9]+$'
  ),
  add constraint build_packages_own_frame_variant_key unique (shopify_own_frame_variant_id),
  add constraint build_packages_donor_variant_key unique (shopify_donor_variant_id),
  add constraint build_packages_option_variants_need_product check (
    shopify_variant_id is not null or (shopify_own_frame_variant_id is null and shopify_donor_variant_id is null)
  ),
  add constraint build_packages_donor_amount_shape check (
    (shopify_donor_variant_id is null) = (shopify_donor_amount is null) and coalesce(shopify_donor_amount, 0) >= 0
  );

create index build_packages_donor_service_id_idx on public.build_packages (donor_service_id);

grant insert (image_url, donor_service_id) on table public.build_packages to authenticated;
grant update (image_url, donor_service_id) on table public.build_packages to authenticated;

comment on column public.build_packages.image_url is
  'D259: the package''s picture (https), pushed as its Shopify media.';
comment on column public.build_packages.donor_service_id is
  'D257: the service a donor bike''s strip and prep is charged as; null: no donor-bike option online.';
comment on column public.build_packages.shopify_variant_id is
  'D252, D257: the package''s Shopify variant for a prepared frame from BICII (the site''s cart links use it); an order line with it becomes a build order (D253).';
comment on column public.build_packages.shopify_own_frame_variant_id is
  'D257: the Shopify variant for the customer''s own prepared frame (record_build_package_push).';
comment on column public.build_packages.shopify_donor_variant_id is
  'D257: the Shopify variant for a donor bike (record_build_package_push).';
comment on column public.build_packages.shopify_donor_amount is
  'D258: what the donor variant was pushed at above the package price: the strip''s share of a donor-bike order.';

-- The prices a package is pushed at (D257): money arithmetic stays here.
create function public.build_package_online_prices(build_package_id uuid)
returns table (
  price public.money_amount,
  donor_service_id uuid,
  donor_amount public.money_amount,
  donor_price public.money_amount
)
language sql
stable
security invoker
set search_path = ''
as $$
  select bp.price, s.id, s.default_sale_price, (bp.price + s.default_sale_price)::public.money_amount
  from public.build_packages bp
  left join public.services s
    on s.id = bp.donor_service_id and s.active and s.archived_at is null and s.currency = bp.currency
  where bp.id = build_package_online_prices.build_package_id;
$$;

comment on function public.build_package_online_prices(uuid) is
  'D257: staff: a package''s Shopify prices: the package price (BICII frame, own frame) and, with an active donor service, the donor amount and donor-bike price.';

revoke all on function public.build_package_online_prices(uuid) from public, anon, authenticated, service_role;
grant execute on function public.build_package_online_prices(uuid) to authenticated;

drop function public.record_build_package_push(uuid, text, text);

create function public.record_build_package_push(
  build_package_id uuid,
  shopify_product_id text,
  shopify_variant_id text,
  shopify_own_frame_variant_id text default null,
  shopify_donor_variant_id text default null,
  shopify_donor_amount public.money_amount default null
)
returns public.build_packages
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result public.build_packages;
begin
  perform private.require_admin();
  if record_build_package_push.build_package_id is null or record_build_package_push.shopify_product_id is null
     or record_build_package_push.shopify_variant_id is null then
    raise exception 'build_package_id, shopify_product_id and shopify_variant_id are required' using errcode = '22004';
  end if;
  update public.build_packages p
  set shopify_product_id = record_build_package_push.shopify_product_id,
      shopify_variant_id = record_build_package_push.shopify_variant_id,
      shopify_own_frame_variant_id = record_build_package_push.shopify_own_frame_variant_id,
      shopify_donor_variant_id = record_build_package_push.shopify_donor_variant_id,
      shopify_donor_amount = case when record_build_package_push.shopify_donor_variant_id is not null
                                  then record_build_package_push.shopify_donor_amount end,
      shopify_pushed_at = pg_catalog.now()
  where p.id = record_build_package_push.build_package_id
  returning p.* into result;
  if not found then
    raise exception 'build package % not found', record_build_package_push.build_package_id using errcode = 'P0002';
  end if;
  return result;
end;
$$;

comment on function public.record_build_package_push(uuid, text, text, text, text, public.money_amount) is
  'D252, D257: admins: after pushing a package to Shopify (the Admin''s server action), record its product id and the variant of each frame option it has (BICII frame always; own frame and donor bike when pushed, with the donor amount).';

revoke all on function public.record_build_package_push(uuid, text, text, text, text, public.money_amount) from public, anon, authenticated, service_role;
grant execute on function public.record_build_package_push(uuid, text, text, text, text, public.money_amount) to authenticated;

-- ---------------------------------------------------------------------------
-- Build orders (D257, D258)
-- ---------------------------------------------------------------------------
alter table public.build_orders
  add column frame_source public.build_frame_source not null default 'bicii_frame',
  add column donor_service_id uuid null references public.services (id),
  add column donor_amount public.money_amount not null default 0,
  add constraint build_orders_donor_shape check (
    donor_amount >= 0 and donor_amount <= amount
    and (frame_source = 'donor_bike' or (donor_amount = 0 and donor_service_id is null))
  );

create index build_orders_donor_service_id_idx on public.build_orders (donor_service_id);

comment on column public.build_orders.frame_source is
  'D257: the frame option bought: a BICII frame, the customer''s own (inspect before accepting) or a donor bike.';
comment on column public.build_orders.donor_amount is
  'D258: the donor strip''s share of amount (donor_service_id), added to the job as its own line on linking; 0 otherwise.';

drop function public.link_build_order(uuid, uuid, uuid);

create function public.link_build_order(
  build_order_id uuid,
  work_order_id uuid,
  labour_line_id uuid,
  donor_line_id uuid default null
)
returns public.build_orders
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  bo public.build_orders;
  build public.work_order_builds;
  pkg public.build_packages;
  build_price public.money_amount;
  result public.build_orders;
begin
  if link_build_order.build_order_id is null or link_build_order.work_order_id is null
     or link_build_order.labour_line_id is null then
    raise exception 'build_order_id, work_order_id and labour_line_id are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(link_build_order.work_order_id);
  select b.* into bo from public.build_orders b where b.id = link_build_order.build_order_id for update;
  if not found then
    raise exception 'build order % not found', link_build_order.build_order_id using errcode = 'P0002';
  end if;
  if bo.work_order_id = wo.id then
    return bo;
  end if;
  if bo.work_order_id is not null then
    raise exception using errcode = 'P0001', message = 'build_order_linked_elsewhere',
      detail = 'That online order is already on another job.';
  end if;
  perform private.require_open_work_order(wo.id);
  if exists (select 1 from public.build_orders b where b.work_order_id = wo.id) then
    raise exception using errcode = 'P0001', message = 'build_order_job_taken',
      detail = 'This job already has an online build order.';
  end if;
  if bo.customer_id is not null and bo.customer_id <> wo.customer_id then
    raise exception using errcode = 'P0001', message = 'build_order_customer_mismatch',
      detail = 'That online order belongs to another customer.';
  end if;
  if bo.currency <> wo.currency then
    raise exception using errcode = 'P0001', message = 'currency_mismatch',
      detail = 'That order was paid in another currency than the job.';
  end if;
  -- D258: the donor strip's share goes on its own line; the build is the rest.
  if bo.donor_amount > 0 then
    if link_build_order.donor_line_id is null then
      raise exception 'donor_line_id is required for a donor-bike order' using errcode = '22004';
    end if;
    if bo.donor_service_id is null then
      raise exception using errcode = 'P0001', message = 'build_order_donor_service_missing',
        detail = 'That donor-bike order has no donor service. Add the strip to the job by hand.';
    end if;
  end if;
  build_price := (bo.amount - bo.donor_amount)::public.money_amount;
  select b.* into build from public.work_order_builds b where b.work_order_id = wo.id for update;
  if not found then
    -- The package at what the customer paid (a Shopify discount, or a price
    -- changed since), even if it has been archived since: the paid order
    -- is the agreement. Labour as the package's, never above the price.
    select p.* into pkg from public.build_packages p where p.id = bo.build_package_id;
    if pkg.currency <> wo.currency then
      raise exception using errcode = 'P0001', message = 'currency_mismatch',
        detail = 'That package is priced in another currency than the job.';
    end if;
    perform private.insert_service_line(
      wo, link_build_order.labour_line_id, pkg.labour_service_id, 1,
      least(pkg.labour_amount, build_price)::public.money_amount, null, pkg.name || ' · build labour'
    );
    insert into public.work_order_builds (
      work_order_id, build_package_id, price, labour_amount, labour_line_id, currency, created_by
    )
    values (
      wo.id, pkg.id, build_price, least(pkg.labour_amount, build_price), link_build_order.labour_line_id,
      wo.currency, actor
    );
    perform private.record_work_order_event(
      wo.id, 'build_set',
      pg_catalog.jsonb_build_object(
        'build_package_id', pkg.id, 'name', pkg.name, 'kind', pkg.kind, 'price', build_price,
        'labour_amount', least(pkg.labour_amount, build_price), 'labour_line_id', link_build_order.labour_line_id,
        'build_order_id', bo.id
      )
    );
  elsif build.build_package_id <> bo.build_package_id then
    raise exception using errcode = 'P0001', message = 'build_order_package_mismatch',
      detail = 'The job has another package than the one ordered; change the job''s package first.';
  end if;
  if bo.donor_amount > 0 then
    perform private.insert_service_line(
      wo, link_build_order.donor_line_id, bo.donor_service_id, 1, bo.donor_amount, null, null
    );
  end if;
  update public.build_orders b
  set work_order_id = wo.id, linked_at = pg_catalog.now(), linked_by = actor
  where b.id = bo.id
  returning b.* into result;
  perform private.record_work_order_event(
    wo.id, 'build_order_linked',
    pg_catalog.jsonb_build_object(
      'build_order_id', bo.id,
      'shopify_order_name', bo.shopify_order_name,
      'build_package_id', bo.build_package_id,
      'amount', bo.amount,
      'currency', bo.currency,
      'frame_source', bo.frame_source,
      'donor_amount', bo.donor_amount,
      'donor_line_id', case when bo.donor_amount > 0 then link_build_order.donor_line_id end
    )
  );
  return result;
end;
$$;

comment on function public.link_build_order(uuid, uuid, uuid, uuid) is
  'D255, D258: active staff: put an online build order on an open job (same customer when the order has one; one order per job), giving the job the order''s package when it has none, priced at the amount paid less any donor strip (labour line labour_line_id, at the package''s labour amount, never above that price); a donor-bike order also adds its strip as line donor_line_id of its donor service; replay-safe; build_set and build_order_linked events. The amount then counts as paid on the job (D254).';

revoke all on function public.link_build_order(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.link_build_order(uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Orders (D257): process_shopify_order_paid from 20261117000400 with the
-- package lookup over the three frame-option variants (step 5) and the
-- build order's frame option and donor share (step 9b); everything else
-- unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.process_shopify_order_paid(event_id uuid)
returns table (
  event_status public.integration_event_status,
  outcome text,
  sale_id uuid,
  error_code text,
  error_message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- Arguments and outputs are never referenced bare in SQL; a bare name is
-- the column.
#variable_conflict use_column
declare
  ev public.integration_events;
  accept_tests boolean;
  p jsonb;
  settings public.shopify_settings;
  online_name text;
  order_name text;
  order_gid text;
  order_currency text;
  recognized timestamptz;
  taxes_included boolean;
  tax numeric;
  customer_gid text;
  customer_key uuid;
  li jsonb;
  disc jsonb;
  qty integer;
  current_qty integer;
  price numeric;
  discount numeric;
  line_total numeric;
  variant_raw text;
  variant_gid text;
  line_gid text;
  title text;
  parsed jsonb := '[]'::jsonb;
  mapped jsonb := '[]'::jsonb;
  unmapped_parts text[] := '{}';
  has_variant_unmapped boolean := false;
  has_custom_unmapped boolean := false;
  m jsonb;
  prod record;
  existing_sale uuid;
  sale public.sales;
  pid uuid;
  need integer;
  have integer;
  first_title text;
  pool uuid[];
  all_units uuid[] := '{}';
  unit_pool jsonb := '{}'::jsonb;
  used jsonb := '{}'::jsonb;
  unique_pids uuid[] := '{}';
  quantity_pids uuid[] := '{}';
  line_no integer := 0;
  prices numeric[];
  split record;
  split_rows integer;
  part integer;
  uid uuid;
  cursor_at integer;
  unit_ids uuid[];
  unit_prices numeric[];
  p_line jsonb;
  result_lines jsonb := '[]'::jsonb;
  -- D253: lines whose variant is a build package's, held as build orders.
  pkg record;
  build_lines jsonb := '[]'::jsonb;
  build_result jsonb := '[]'::jsonb;
  bo_part integer;
  err_code text;
  err_message text;
  err_detail text;
  err_state text;
  err_text text;
begin
  if process_shopify_order_paid.event_id is null then
    raise exception 'event_id is required' using errcode = '22004';
  end if;

  -- (a) The event row (lock order 0) and replays.
  select e.* into ev from public.integration_events e where e.id = process_shopify_order_paid.event_id for update;
  if not found then
    raise exception 'integration event % not found', process_shopify_order_paid.event_id using errcode = 'P0002';
  end if;
  if ev.topic <> 'orders/paid' then
    raise exception 'event % is not an orders/paid event', ev.id using errcode = '22023';
  end if;
  if ev.status in ('processed', 'skipped', 'rejected') then
    perform private.shopify_close_event_job(ev.id);
    return query select ev.status, ev.outcome, ev.sale_id, ev.last_error_code, ev.last_error;
    return;
  end if;
  select s.accept_test_orders into accept_tests from public.shopify_settings s where s.id = 1;
  if ev.test_delivery and not coalesce(accept_tests, false) then
    update public.integration_events e
    set status = 'skipped', outcome = 'test_order', processed_at = pg_catalog.now()
    where e.id = ev.id;
    perform private.shopify_close_event_job(ev.id);
    return query select 'skipped'::public.integration_event_status, 'test_order'::text, null::uuid, null::text, null::text;
    return;
  end if;
  update public.integration_events e set attempts = e.attempts + 1 where e.id = ev.id;
  p := ev.payload;
  order_name := coalesce(nullif(pg_catalog.btrim(ev.subject), ''), 'from Shopify');

  -- (b) The business writes: all or nothing.
  begin
    -- 1. Parse and validate the REST order.
    if p is null or pg_catalog.jsonb_typeof(p) <> 'object' then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (no payload). Check the payload in the event inspector.');
    end if;
    order_gid := private.shopify_gid_or_null('Order', p ->> 'id');
    if order_gid is null then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (missing id). Check the payload in the event inspector.');
    end if;
    order_name := pg_catalog.left(coalesce(
      nullif(pg_catalog.btrim(p ->> 'name'), ''),
      '#' || nullif(pg_catalog.btrim(p ->> 'order_number'), ''),
      'Order ' || private.shopify_gid_number(order_gid)
    ), 100);
    order_currency := p ->> 'currency';
    if order_currency is null or order_currency !~ '^[A-Z]{3}$' then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (missing currency). Check the payload in the event inspector.');
    end if;
    if nullif(pg_catalog.btrim(p ->> 'processed_at'), '') is not null then
      begin
        recognized := (p ->> 'processed_at')::timestamptz;
      exception
        when others then
          perform private.shopify_raise('shopify_payload_invalid',
            'Shopify sent an order BICII cannot read (processed_at). Check the payload in the event inspector.');
      end;
    end if;
    -- D80: the payload's processed_at, else the trigger time, else receipt.
    recognized := coalesce(recognized, ev.triggered_at, ev.received_at);
    if p ? 'taxes_included' and pg_catalog.jsonb_typeof(p -> 'taxes_included') not in ('boolean', 'null') then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (taxes_included). Check the payload in the event inspector.');
    end if;
    taxes_included := coalesce((p ->> 'taxes_included')::boolean, false);
    tax := coalesce(
      private.shopify_decimal(private.shopify_money_text(p, 'current_total_tax'), 'current_total_tax', 'an order'),
      private.shopify_decimal(private.shopify_money_text(p, 'total_tax'), 'total_tax', 'an order'),
      0
    );
    if p ? 'customer' and pg_catalog.jsonb_typeof(p -> 'customer') = 'object' and (p #>> '{customer,id}') is not null then
      customer_gid := private.shopify_gid_or_null('Customer', p #>> '{customer,id}');
      if customer_gid is null then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (customer id). Check the payload in the event inspector.');
      end if;
    end if;
    if pg_catalog.jsonb_typeof(p -> 'line_items') is distinct from 'array'
       or pg_catalog.jsonb_array_length(p -> 'line_items') = 0 then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (missing line_items). Check the payload in the event inspector.');
    end if;
    for li in select e.v from pg_catalog.jsonb_array_elements(p -> 'line_items') with ordinality e(v, n) order by e.n loop
      if pg_catalog.jsonb_typeof(li) <> 'object' then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (a line item). Check the payload in the event inspector.');
      end if;
      line_gid := private.shopify_gid_or_null('LineItem', li ->> 'id');
      qty := private.shopify_count(li ->> 'quantity', 'line item quantity', 'an order');
      current_qty := private.shopify_count(li ->> 'current_quantity', 'line item current_quantity', 'an order');
      if line_gid is null or qty is null then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (a line item id or quantity). Check the payload in the event inspector.');
      end if;
      qty := coalesce(current_qty, qty);
      continue when qty = 0;
      price := private.shopify_decimal(private.shopify_money_text(li, 'price'), 'line item price', 'an order');
      if price is null or price < 0 then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (a line item price). Check the payload in the event inspector.');
      end if;
      discount := 0;
      if pg_catalog.jsonb_typeof(li -> 'discount_allocations') = 'array' then
        for disc in select d.v from pg_catalog.jsonb_array_elements(li -> 'discount_allocations') d(v) loop
          discount := discount + coalesce(
            private.shopify_decimal(private.shopify_money_text(disc, 'amount'), 'a discount allocation', 'an order'), 0
          );
        end loop;
      end if;
      -- D80: what Shopify charged for the line.
      line_total := round(price * qty - discount, 2);
      if line_total < 0 then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (a discount larger than its line). Check the payload in the event inspector.');
      end if;
      variant_raw := nullif(pg_catalog.btrim(li ->> 'variant_id'), '');
      variant_gid := private.shopify_gid_or_null('ProductVariant', variant_raw);
      if variant_raw is not null and variant_gid is null then
        perform private.shopify_raise('shopify_payload_invalid',
          'Shopify sent an order BICII cannot read (a variant id). Check the payload in the event inspector.');
      end if;
      title := coalesce(nullif(pg_catalog.btrim(li ->> 'title'), ''), 'Untitled line');
      parsed := parsed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'line_gid', line_gid, 'title', title, 'variant_gid', variant_gid, 'qty', qty, 'total', line_total
      ));
    end loop;
    if pg_catalog.jsonb_array_length(parsed) = 0 then
      perform private.shopify_raise('shopify_payload_invalid',
        'Shopify sent an order BICII cannot read (no line item has a quantity). Check the payload in the event inspector.');
    end if;

    -- 2. Deliveries of one order, one at a time.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bicii.shopify.order:' || order_gid, 0));

    -- 3. Already recorded (another delivery or webhook id): one effect.
    select s.id into existing_sale from public.sales s where s.shopify_order_id = order_gid;
    if found then
      update public.integration_events e
      set status = 'processed', processed_at = pg_catalog.now(), outcome = 'duplicate_order',
          sale_id = existing_sale, last_error_code = null, last_error = null, last_error_detail = null
      where e.id = ev.id;
      perform private.shopify_close_event_job(ev.id);
      perform private.shopify_close_order_siblings(ev.id, order_gid, existing_sale);
    elsif exists (
      select 1 from public.integration_events o
      where o.topic = 'orders/paid' and o.shopify_order_gid = order_gid and o.id <> ev.id and o.status = 'skipped'
    ) then
      -- 3b. Another delivery of this order was closed without a sale
      -- (dismissed, a test or a POS order): that is final for the order
      -- (D87), so a delivery under a new webhook id records nothing.
      update public.integration_events e
      set status = 'skipped', processed_at = pg_catalog.now(), outcome = 'earlier_delivery_skipped',
          last_error_code = null, last_error = null, last_error_detail = null
      where e.id = ev.id;
      perform private.shopify_close_event_job(ev.id);
    else
      -- 4. Settings, currency (D35) and tax basis (D89).
      select s.* into settings from public.shopify_settings s where s.id = 1;
      if not found then
        perform private.shopify_raise('shopify_settings_missing',
          'Shopify settings are missing, so BICII does not know which location sells online. An admin must set them; this will be retried.');
      end if;
      select l.name into online_name from public.locations l where l.id = settings.online_location_id;
      if order_currency <> private.shop_currency() then
        perform private.shopify_raise('shopify_currency_mismatch', pg_catalog.format(
          'Order %s is in %s but the shop records sales in %s. Record it by hand and dismiss this.',
          order_name, order_currency, private.shop_currency()));
      end if;
      if not taxes_included and tax > 0 then
        perform private.shopify_raise('shopify_tax_basis_unsupported', pg_catalog.format(
          'Order %s was charged tax on top of the price; BICII records tax-inclusive prices. Record it by hand and dismiss this.',
          order_name));
      end if;

      -- 5. Every line maps to a product through its variant (never by
      -- title or SKU), or nothing is recorded. D253: a build package's
      -- variant is not a product; its line becomes a build order (step 9b).
      for m in select e.v from pg_catalog.jsonb_array_elements(parsed) with ordinality e(v, n) order by e.n loop
        -- D257: any of the package's three frame-option variants.
        select bp.id, fs.frame_source, bp.donor_service_id, bp.shopify_donor_amount into pkg
        from public.build_packages bp
        cross join lateral (values
          ('bicii_frame'::public.build_frame_source, bp.shopify_variant_id),
          ('own_frame'::public.build_frame_source, bp.shopify_own_frame_variant_id),
          ('donor_bike'::public.build_frame_source, bp.shopify_donor_variant_id)
        ) fs(frame_source, variant_id)
        where fs.variant_id = (m ->> 'variant_gid');
        if pkg.id is not null then
          build_lines := build_lines || pg_catalog.jsonb_build_array(
            m || pg_catalog.jsonb_build_object(
              'build_package_id', pkg.id, 'frame_source', pkg.frame_source,
              'donor_service_id', pkg.donor_service_id, 'donor_amount', pkg.shopify_donor_amount
            )
          );
          continue;
        end if;
        select pr.id, pr.tracking_type into prod
        from public.products pr
        where pr.shopify_variant_id = (m ->> 'variant_gid');
        if (m ->> 'variant_gid') is null then
          has_custom_unmapped := true;
          unmapped_parts := unmapped_parts
            || pg_catalog.format('"%s" is a custom Shopify line with no product', m ->> 'title');
        elsif prod.id is null then
          has_variant_unmapped := true;
          unmapped_parts := unmapped_parts || pg_catalog.format(
            '"%s" (Shopify variant %s) is not linked to a BICII product',
            m ->> 'title', private.shopify_gid_number(m ->> 'variant_gid'));
        else
          mapped := mapped || pg_catalog.jsonb_build_array(
            m || pg_catalog.jsonb_build_object('product_id', prod.id, 'tracking', prod.tracking_type::text)
          );
        end if;
      end loop;
      if pg_catalog.cardinality(unmapped_parts) > 0 then
        perform private.shopify_raise('shopify_variant_unmapped', pg_catalog.format(
          'Order %s: %s.%s%s', order_name, pg_catalog.array_to_string(unmapped_parts, '; '),
          case when has_variant_unmapped then
            case when pg_catalog.cardinality(unmapped_parts) > 1 and not has_custom_unmapped
                 then ' Link each to the product it is, then retry.'
                 else ' Link it to the product it is, then retry.' end
          else '' end,
          case when has_custom_unmapped
               then ' Record it by hand if needed and dismiss this with a reason.' else '' end));
      end if;

      -- 6. The sale header (lock order 0); its S- number and created_by come
      -- from sales_enforce_rules. The customer only through a linked
      -- Shopify customer id, never by email (D86).
      if customer_gid is not null then
        select c.id into customer_key from public.customers c where c.shopify_customer_id = customer_gid;
      end if;
      insert into public.sales as s (
        id, source, customer_id, shopify_order_id, shopify_order_name, recognized_at, status, currency,
        shopify_customer_id, integration_event_id
      )
      values (
        gen_random_uuid(), 'online_shopify', customer_key, order_gid, order_name, recognized, 'recorded',
        order_currency, customer_gid, ev.id
      )
      returning s.* into sale;

      -- 7. Locks in the global order: the stock of every product (3) ...
      for pid in
        select distinct (x.v ->> 'product_id')::uuid from pg_catalog.jsonb_array_elements(mapped) x(v) order by 1
      loop
        perform private.lock_stock(pid);
      end loop;
      -- ... the oldest available units of each unique product at the
      -- online location (D81), chosen under the stock lock (every stock
      -- writer of the product holds it) and then locked in id order (5) ...
      for pid, need, first_title in
        select (x.v ->> 'product_id')::uuid, sum((x.v ->> 'qty')::integer)::integer,
               (pg_catalog.array_agg(x.v ->> 'title' order by x.n))[1]
        from pg_catalog.jsonb_array_elements(mapped) with ordinality x(v, n)
        where x.v ->> 'tracking' = 'unique'
        group by 1
        order by 1
      loop
        select coalesce(pg_catalog.array_agg(c.id order by c.created_at, c.id), '{}') into pool
        from (
          select u.id, u.created_at
          from public.inventory_units u
          where u.product_id = pid and u.location_id = settings.online_location_id and u.status = 'available'
            and u.ownership_type <> 'customer_owned' and u.archived_at is null
          order by u.created_at, u.id
          limit need
        ) c;
        have := coalesce(pg_catalog.cardinality(pool), 0);
        if have < need then
          perform private.shopify_raise('shopify_unit_unavailable', pg_catalog.format(
            'Order %s: "%s" needs %s available unit%s at %s but %s. It may have sold in the shop. Refund it in Shopify and dismiss this, or make a unit available and retry.',
            order_name, first_title, need, case when need = 1 then '' else 's' end, online_name,
            case when have = 0 then 'none is available'
                 when have = 1 then 'only 1 is available'
                 else pg_catalog.format('only %s are available', have) end));
        end if;
        unit_pool := unit_pool || pg_catalog.jsonb_build_object(pid::text, pg_catalog.to_jsonb(pool));
        all_units := all_units || pool;
        unique_pids := unique_pids || pid;
      end loop;
      perform 1 from public.inventory_units u where u.id = any (all_units) order by u.id for update;
      -- ... their consignment items and every active item of each consigned
      -- quantity product on the order (sell_line's FIFO reads them) (6).
      select coalesce(pg_catalog.array_agg(distinct (x.v ->> 'product_id')::uuid), '{}') into quantity_pids
      from pg_catalog.jsonb_array_elements(mapped) x(v)
      where x.v ->> 'tracking' = 'quantity';
      perform 1
      from public.consignment_items i
      where i.id in (select u.consignment_item_id from public.inventory_units u where u.id = any (all_units))
         or (i.status = 'active' and i.product_id = any (quantity_pids))
      order by i.id
      for update;
      -- Quantity products: enough on hand at the online location (D82; a
      -- sale never takes stock below zero). sell_line checks each line again.
      for pid, need, first_title in
        select (x.v ->> 'product_id')::uuid, sum((x.v ->> 'qty')::integer)::integer,
               (pg_catalog.array_agg(x.v ->> 'title' order by x.n))[1]
        from pg_catalog.jsonb_array_elements(mapped) with ordinality x(v, n)
        where x.v ->> 'tracking' = 'quantity'
        group by 1
        order by 1
      loop
        have := private.stock_on_hand(pid, settings.online_location_id);
        if have < need then
          perform private.shopify_raise('shopify_insufficient_stock', pg_catalog.format(
            'Order %s: "%s" needs %s but BICII shows %s on hand at %s. Count and adjust the stock, then retry, or refund in Shopify and dismiss this.',
            order_name, first_title, need, have, online_name));
        end if;
      end loop;

      -- 8. The lines, through THE sale-line writer (online_sale), priced so
      -- that they sum to Shopify's discounted line totals (D80).
      for m in select e.v from pg_catalog.jsonb_array_elements(mapped) with ordinality e(v, n) order by e.n loop
        pid := (m ->> 'product_id')::uuid;
        qty := (m ->> 'qty')::integer;
        line_total := (m ->> 'total')::numeric;
        unit_ids := '{}';
        unit_prices := '{}';
        if m ->> 'tracking' = 'unique' then
          -- One line per unit; the last unit absorbs the remainder.
          prices := '{}';
          for split in select * from private.shopify_split_amount(line_total, qty) loop
            for i in 1 .. split.quantity loop
              prices := prices || split.unit_price;
            end loop;
          end loop;
          cursor_at := coalesce((used ->> pid::text)::integer, 0);
          for i in 1 .. qty loop
            uid := (unit_pool -> pid::text ->> cursor_at)::uuid;
            cursor_at := cursor_at + 1;
            line_no := line_no + 1;
            perform private.sell_line(
              sale, line_no,
              pg_catalog.jsonb_build_object(
                'inventory_unit_id', uid,
                'unit_sale_price', prices[i]::text,
                'shopify_line_item_id', m ->> 'line_gid'
              ),
              'online_sale'
            );
            unit_ids := unit_ids || uid;
            unit_prices := unit_prices || prices[i];
          end loop;
          used := used || pg_catalog.jsonb_build_object(pid::text, cursor_at);
        else
          -- One line, or two parts for an uneven split.
          select count(*)::integer into split_rows from private.shopify_split_amount(line_total, qty);
          part := 0;
          for split in select * from private.shopify_split_amount(line_total, qty) loop
            part := part + 1;
            line_no := line_no + 1;
            p_line := pg_catalog.jsonb_build_object(
              'product_id', pid,
              'location_id', settings.online_location_id,
              'quantity', split.quantity,
              'unit_sale_price', split.unit_price::text,
              'shopify_line_item_id', m ->> 'line_gid'
            );
            if split_rows > 1 then
              p_line := p_line || pg_catalog.jsonb_build_object('shopify_line_part', part);
            end if;
            perform private.sell_line(sale, line_no, p_line, 'online_sale');
            unit_prices := unit_prices || split.unit_price;
          end loop;
        end if;
        result_lines := result_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'shopify_line_item_id', m ->> 'line_gid',
          'product_id', pid,
          'unit_ids', pg_catalog.to_jsonb(unit_ids),
          'quantity', qty,
          'line_total', line_total,
          'unit_prices', pg_catalog.to_jsonb(unit_prices)
        ));
      end loop;

      -- 9. Products last (lock order 7): a public unique product with no
      -- unit left becomes sold (D26).
      for pid in select x.id from pg_catalog.unnest(unique_pids) x(id) order by 1 loop
        perform private.refresh_unique_publication(pid);
      end loop;

      -- 9b. D253: each build package bought becomes one build order per
      -- unit, at its share of Shopify's line total: money held for the
      -- build, not a sale line; staff link it to the build's job, whose
      -- completion recognises the revenue (D250).
      for m in select e.v from pg_catalog.jsonb_array_elements(build_lines) with ordinality e(v, n) order by e.n loop
        bo_part := 0;
        for split in select * from private.shopify_split_amount((m ->> 'total')::numeric, (m ->> 'qty')::integer) loop
          for i in 1 .. split.quantity loop
            bo_part := bo_part + 1;
            insert into public.build_orders (
              sale_id, integration_event_id, shopify_order_id, shopify_order_name, shopify_line_item_id,
              line_part, build_package_id, amount, currency, customer_id,
              frame_source, donor_service_id, donor_amount
            )
            values (
              sale.id, ev.id, order_gid, order_name, m ->> 'line_gid',
              bo_part, (m ->> 'build_package_id')::uuid, split.unit_price, order_currency, sale.customer_id,
              (m ->> 'frame_source')::public.build_frame_source,
              case when (m ->> 'frame_source') = 'donor_bike' then (m ->> 'donor_service_id')::uuid end,
              -- D258: the strip's share, as pushed, never above what was paid.
              case when (m ->> 'frame_source') = 'donor_bike'
                   then least(coalesce((m ->> 'donor_amount')::numeric, 0), split.unit_price)
                   else 0 end
            )
            on conflict (shopify_line_item_id, line_part) do nothing;
          end loop;
        end loop;
        build_result := build_result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'shopify_line_item_id', m ->> 'line_gid',
          'build_package_id', m ->> 'build_package_id',
          'frame_source', m ->> 'frame_source',
          'quantity', (m ->> 'qty')::integer,
          'line_total', (m ->> 'total')::numeric
        ));
      end loop;

      -- 10. Done: the event, its job, the order's other open deliveries
      -- (duplicate_order) and any refund that waited for this order (D87).
      update public.integration_events e
      set status = 'processed', processed_at = pg_catalog.now(), outcome = 'sale_recorded', sale_id = sale.id,
          last_error_code = null, last_error = null, last_error_detail = null,
          result = pg_catalog.jsonb_build_object(
            'sale_id', sale.id, 'sale_number', sale.sale_number, 'lines', result_lines,
            'build_orders', build_result
          )
      where e.id = ev.id;
      perform private.shopify_close_event_job(ev.id);
      perform private.shopify_close_order_siblings(ev.id, order_gid, sale.id);
      update public.integration_retry_queue q
      set status = 'queued', next_attempt_at = pg_catalog.now(), locked_at = null,
          max_attempts = greatest(q.max_attempts, q.attempts + 3)
      from public.integration_events r
      where q.integration_event_id = r.id and q.kind = 'shopify_event' and q.status in ('queued', 'needs_attention')
        and r.topic = 'refunds/create' and r.shopify_order_gid = order_gid;
    end if;
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics err_code = message_text, err_message = pg_exception_detail;
      if err_code not like 'shopify\_%' then
        -- A sell_line refusal (insufficient_stock, consignment_quantity_
        -- unavailable, sale_before_stock, sale_cost_missing, ...).
        err_message := pg_catalog.format('Order %s could not be recorded: %s', order_name, coalesce(nullif(err_message, ''), err_code));
        err_code := 'shopify_sale_refused';
      end if;
    when others then
      get stacked diagnostics err_state = returned_sqlstate, err_text = message_text;
      err_code := 'shopify_unexpected_error';
      err_message := 'Something unexpected went wrong while recording this. It will be retried automatically.';
      err_detail := err_state || ': ' || err_text;
  end;

  -- (c) Failure: nothing above survived; the event and its job say why.
  if err_code is not null then
    perform private.shopify_event_failed(
      ev.id, err_code, err_message, err_detail,
      case when err_code = 'shopify_variant_unmapped'
           then pg_catalog.jsonb_build_object('unmapped_lines', private.shopify_unmapped_lines(ev.payload))
           else '{}'::jsonb end
    );
    return query select 'failed'::public.integration_event_status, null::text, null::uuid, err_code, err_message;
    return;
  end if;

  select e.* into ev from public.integration_events e where e.id = ev.id;
  return query select ev.status, ev.outcome, ev.sale_id, null::text, null::text;
end;
$$;
