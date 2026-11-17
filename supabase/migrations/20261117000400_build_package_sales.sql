-- D252-D256: selling full builds online with a frame. The owner,
-- 2026-11-17: full payment is taken on Shopify at purchase, but the build's
-- revenue is recognised only when the build is delivered.
--
--   D252 Shopify: a build package may be pushed as its own Shopify product
--        (one variant, inventory not tracked: a service) from Settings;
--        record_build_package_push stores its ids; publish_online says
--        whether it is ACTIVE. public_build_offers(short id) gives the site
--        a frame's cart links: the frame's variant and a package's variant
--        in one Shopify cart.
--   D253 orders: a Shopify order line whose variant is a package's is not a
--        sale line: it becomes one build_orders row per unit (its share of
--        the line total), on the order's sale. The frame and other product
--        lines are recorded as before (D80-D82).
--   D254 money: a build order is customer money held, like a deposit. Once
--        linked to the build's job it counts in work_order_payment_totals
--        (paid_shopify, in net_paid) and reporting.payment_movements
--        (shopify_payment); the job's completion recognises the labour and
--        parts as revenue (D250). Never in the sales figures.
--   D255 linking: link_build_order puts a build order on an open job of
--        the same customer (when the order has one), setting the job's
--        package if it has none; build_order_linked event.
--   D256 refunds: a Shopify refund is still recorded on the order's sale
--        (D85); a refunded build order is handled by staff (R-122).

-- ---------------------------------------------------------------------------
-- Packages on Shopify (D252)
-- ---------------------------------------------------------------------------
alter table public.build_packages
  add column publish_online boolean not null default false,
  add column shopify_product_id text null,
  add column shopify_variant_id text null,
  add column shopify_pushed_at timestamptz null,
  add constraint build_packages_shopify_product_id_format check (
    shopify_product_id is null or shopify_product_id ~ '^gid://shopify/Product/[0-9]+$'
  ),
  add constraint build_packages_shopify_variant_id_format check (
    shopify_variant_id is null or shopify_variant_id ~ '^gid://shopify/ProductVariant/[0-9]+$'
  ),
  add constraint build_packages_shopify_ids_together check (
    (shopify_product_id is null) = (shopify_variant_id is null)
  ),
  add constraint build_packages_shopify_variant_id_key unique (shopify_variant_id),
  add constraint build_packages_online_full_build check (not publish_online or kind = 'full_build');

grant update (publish_online) on table public.build_packages to authenticated;

comment on column public.build_packages.shopify_variant_id is
  'D252: the package''s Shopify variant (record_build_package_push); an order line with it becomes a build order (D253).';

create function public.record_build_package_push(
  build_package_id uuid,
  shopify_product_id text,
  shopify_variant_id text
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
      shopify_pushed_at = pg_catalog.now()
  where p.id = record_build_package_push.build_package_id
  returning p.* into result;
  if not found then
    raise exception 'build package % not found', record_build_package_push.build_package_id using errcode = 'P0002';
  end if;
  return result;
end;
$$;

comment on function public.record_build_package_push(uuid, text, text) is
  'D252: admins: after pushing a package to Shopify (the Admin''s server action), record its product and variant ids.';

revoke all on function public.record_build_package_push(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_build_package_push(uuid, text, text) to authenticated;

-- The site's cart links for one frame (D252): the frame must be on sale
-- online (it has a Buy-online link) and in a frames category; each package
-- must be a live, public, online full build pushed to Shopify.
create function public.public_build_offers(item_short_id text)
returns table (
  build_package_id uuid,
  name text,
  description text,
  price public.money_amount,
  currency char(3),
  cart_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select bp.id, bp.name, bp.description, bp.price, bp.currency,
         st.url || '/cart/' || private.shopify_gid_number(pr.shopify_variant_id) || ':1,'
           || private.shopify_gid_number(bp.shopify_variant_id) || ':1'
  from reporting.public_items pi
  join public.products pr on pr.short_id = pi.short_id
  join public.categories c on c.id = pr.category_id
  cross join lateral (
    select pg_catalog.rtrim(s.storefront_url, '/') as url
    from public.shopify_settings s
    where s.id = 1 and s.storefront_url is not null
  ) st
  join public.build_packages bp
    on bp.kind = 'full_build' and bp.public and bp.publish_online and bp.archived_at is null
       and bp.shopify_variant_id is not null and bp.currency = pr.currency
  where pi.short_id = public_build_offers.item_short_id
    and pi.buy_online_url is not null
    and pr.shopify_variant_id is not null
    and c.name ilike '%frame%'
  order by bp.sort_order, bp.price, bp.name;
$$;

comment on function public.public_build_offers(text) is
  'D252: anyone: for a frame on sale online, each online full build with a Shopify cart link holding the frame and the package.';

revoke all on function public.public_build_offers(text) from public, anon, authenticated, service_role;
grant execute on function public.public_build_offers(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- build_orders (D253-D255)
-- ---------------------------------------------------------------------------
create table public.build_orders (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id),
  integration_event_id uuid null references public.integration_events (id),
  shopify_order_id text not null,
  shopify_order_name text null,
  shopify_line_item_id text not null,
  line_part smallint not null default 1,
  build_package_id uuid not null references public.build_packages (id),
  amount public.money_amount not null,
  currency char(3) not null,
  customer_id uuid null references public.customers (id),
  work_order_id uuid null references public.work_orders (id),
  linked_at timestamptz null,
  linked_by uuid null references public.staff (id),
  created_at timestamptz not null default pg_catalog.now(),
  constraint build_orders_line_part_positive check (line_part >= 1),
  constraint build_orders_link_shape check ((work_order_id is null) = (linked_at is null)),
  constraint build_orders_line_part_key unique (shopify_line_item_id, line_part),
  constraint build_orders_work_order_id_key unique (work_order_id)
);

create index build_orders_sale_id_idx on public.build_orders (sale_id);
create index build_orders_unlinked_idx on public.build_orders (created_at) where work_order_id is null;

comment on table public.build_orders is
  'D253: a build package bought on Shopify, one row per unit: customer money held for the build (D254), linked to its job by link_build_order (D255). Written only by process_shopify_order_paid and link_build_order.';

alter table public.build_orders enable row level security;
revoke all on table public.build_orders from public, anon, authenticated;
grant select on table public.build_orders to authenticated;
grant select on table public.build_orders to service_role;

create policy build_orders_select_staff on public.build_orders
  for select to authenticated
  using ((select private.is_staff()));

create function public.link_build_order(build_order_id uuid, work_order_id uuid, labour_line_id uuid)
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
      least(pkg.labour_amount, bo.amount)::public.money_amount, null, pkg.name || ' · build labour'
    );
    insert into public.work_order_builds (
      work_order_id, build_package_id, price, labour_amount, labour_line_id, currency, created_by
    )
    values (
      wo.id, pkg.id, bo.amount, least(pkg.labour_amount, bo.amount), link_build_order.labour_line_id,
      wo.currency, actor
    );
    perform private.record_work_order_event(
      wo.id, 'build_set',
      pg_catalog.jsonb_build_object(
        'build_package_id', pkg.id, 'name', pkg.name, 'kind', pkg.kind, 'price', bo.amount,
        'labour_amount', least(pkg.labour_amount, bo.amount), 'labour_line_id', link_build_order.labour_line_id,
        'build_order_id', bo.id
      )
    );
  elsif build.build_package_id <> bo.build_package_id then
    raise exception using errcode = 'P0001', message = 'build_order_package_mismatch',
      detail = 'The job has another package than the one ordered; change the job''s package first.';
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
      'currency', bo.currency
    )
  );
  return result;
end;
$$;

comment on function public.link_build_order(uuid, uuid, uuid) is
  'D255: active staff: put an online build order on an open job (same customer when the order has one; one order per job), giving the job the order''s package at the amount paid (even if archived since) when it has none (labour line labour_line_id, at the package''s labour amount, never above the price); replay-safe; build_set and build_order_linked events. The amount then counts as paid on the job (D254).';

revoke all on function public.link_build_order(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.link_build_order(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Orders (D253): process_shopify_order_paid from 20261004004000 with the
-- build package lines (steps 5 and 9b); everything else unchanged.
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
        select bp.id into pkg
        from public.build_packages bp
        where bp.shopify_variant_id = (m ->> 'variant_gid');
        if pkg.id is not null then
          build_lines := build_lines || pg_catalog.jsonb_build_array(
            m || pg_catalog.jsonb_build_object('build_package_id', pkg.id)
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
              line_part, build_package_id, amount, currency, customer_id
            )
            values (
              sale.id, ev.id, order_gid, order_name, m ->> 'line_gid',
              bo_part, (m ->> 'build_package_id')::uuid, split.unit_price, order_currency, sale.customer_id
            )
            on conflict (shopify_line_item_id, line_part) do nothing;
          end loop;
        end loop;
        build_result := build_result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'shopify_line_item_id', m ->> 'line_gid',
          'build_package_id', m ->> 'build_package_id',
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


-- ---------------------------------------------------------------------------
-- Money held (D254): 20261014001300's view with paid_shopify appended and
-- in net_paid; 20261014001500's movements with a shopify_payment branch,
-- so per job Σ signed_amount still equals net_paid.
-- ---------------------------------------------------------------------------
create or replace view public.work_order_payment_totals
with (security_invoker = on)
as
select w.id as work_order_id,
       w.currency,
       x.paid_online::public.money_amount as paid_online,
       x.refunded_online::public.money_amount as refunded_online,
       (x.paid_online - x.refunded_online)::public.money_amount as net_paid_online,
       coalesce(t.sale_total, 0)::public.money_amount as job_total,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest(coalesce(t.sale_total, 0) - n.net_paid, 0)
        end)::public.money_amount as balance_due,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest(n.net_paid - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as paid_ahead,
       -- R-082: what is held above the live-lines total, in every status;
       -- never negative; SGD only, like the two above.
       (case when w.currency = 'SGD'
             then greatest(n.net_paid - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as held_over_total,
       c.paid_at_counter::public.money_amount as paid_at_counter,
       n.net_paid::public.money_amount as net_paid,
       x.processing_online::public.money_amount as processing_online,
       -- D254: build orders paid on Shopify and linked to this job.
       b.paid_shopify::public.money_amount as paid_shopify
from public.work_orders w
cross join lateral (
  select coalesce(sum(coalesce(p.amount_received, p.amount))
                    filter (where p.status in ('paid', 'partially_refunded', 'refunded')), 0) as paid_online,
         coalesce(sum(p.refunded_amount)
                    filter (where p.status in ('paid', 'partially_refunded', 'refunded')), 0) as refunded_online,
         -- Checkout completed, Stripe still confirming (PayNow): shown apart,
         -- never in net_paid or the balance.
         coalesce(sum(p.amount)
                    filter (where p.status = 'pending' and p.checkout_completed_at is not null), 0)
           as processing_online
  from public.payments p
  where p.work_order_id = w.id
) x
cross join lateral (
  select coalesce(sum(cp.amount), 0) as paid_at_counter
  from public.counter_payments cp
  where cp.work_order_id = w.id
    and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
) c
cross join lateral (
  select coalesce(sum(bo.amount), 0) as paid_shopify
  from public.build_orders bo
  where bo.work_order_id = w.id
) b
cross join lateral (
  select x.paid_online - x.refunded_online + c.paid_at_counter + b.paid_shopify as net_paid
) n
left join public.work_order_totals t on t.work_order_id = w.id;


create or replace view reporting.payment_movements
with (security_invoker = true)
as
  -- A Stripe payment received.
  select
    p.paid_at as "at",
    p.id,
    'online_payment'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    coalesce(p.amount_received, p.amount)::numeric as amount,
    coalesce(p.amount_received, p.amount)::numeric as signed_amount,
    p.currency::text as currency,
    (p.amount_received is null) as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payments p
  where p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counted refund, dated by Stripe's created.
  select
    r.stripe_created_at as "at",
    r.id,
    'online_refund'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    r.amount::numeric as amount,
    (-r.amount)::numeric as signed_amount,
    r.currency::text as currency,
    false as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payment_refunds r
  join public.payments p on p.id = r.payment_id
  where r.stripe_created_at is not null
    and r.status = 'succeeded'
    and r.currency = p.currency
    and (r.livemode is null or r.livemode = p.livemode)
    and p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counted refund Stripe sent without created: dated when BICII recorded it.
  select
    r.created_at as "at",
    r.id,
    'online_refund'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    r.amount::numeric as amount,
    (-r.amount)::numeric as signed_amount,
    r.currency::text as currency,
    false as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payment_refunds r
  join public.payments p on p.id = r.payment_id
  where r.stripe_created_at is null
    and r.status = 'succeeded'
    and r.currency = p.currency
    and (r.livemode is null or r.livemode = p.livemode)
    and p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counter payment, unless voided as recorded in error.
  select
    cp.received_at as "at",
    cp.id,
    'counter_payment'::text as movement,
    cp.work_order_id,
    cp.kind::text as kind,
    cp.method::text as method,
    cp.amount::numeric as amount,
    cp.amount::numeric as signed_amount,
    cp.currency::text as currency,
    false as other_currency,
    cp.created_at as recorded_at,
    cp.recorded_by
  from public.counter_payments cp
  where not exists (
    select 1 from public.counter_payment_voids v
    where v.counter_payment_id = cp.id and v.kind = 'recorded_in_error'
  )
  union all
  -- Counter money given back, on the void's day; never before the payment
  -- it reverses (received_at may be up to 5 minutes ahead of the void's
  -- clock): then one microsecond after it, the same shop day, and (at, id)
  -- stays a unique keyset. recorded_at keeps the void's own time.
  select
    greatest(v.voided_at, cp.received_at + interval '1 microsecond') as "at",
    cp.id,
    'counter_given_back'::text as movement,
    cp.work_order_id,
    cp.kind::text as kind,
    cp.method::text as method,
    cp.amount::numeric as amount,
    (-cp.amount)::numeric as signed_amount,
    cp.currency::text as currency,
    false as other_currency,
    v.voided_at as recorded_at,
    v.voided_by as recorded_by
  from public.counter_payment_voids v
  join public.counter_payments cp on cp.id = v.counter_payment_id
  where v.kind = 'given_back'
  union all
  -- D254: a build package paid on Shopify, once linked to its job, at the
  -- order's recognition time (when the customer paid).
  select
    s.recognized_at as "at",
    bo.id,
    'shopify_payment'::text as movement,
    bo.work_order_id,
    'build'::text as kind,
    'shopify'::text as method,
    bo.amount::numeric as amount,
    bo.amount::numeric as signed_amount,
    bo.currency::text as currency,
    false as other_currency,
    bo.linked_at as recorded_at,
    bo.linked_by as recorded_by
  from public.build_orders bo
  join public.sales s on s.id = bo.sale_id
  where bo.work_order_id is not null;

-- ---------------------------------------------------------------------------
-- The payment reports (D254): report_payment_summary gains shopify_count and
-- shopify_total (so its counts still add up to report_payment_items' rows,
-- which the export checks), and report_payments_held considers jobs whose
-- only money is a linked build order. Bodies from 20261014001500.
-- ---------------------------------------------------------------------------
drop function public.report_payment_summary(date, date);

create function public.report_payment_summary(p_from date, p_to date)
returns table (
  currency text,
  online_count integer,
  online_total numeric,
  deposit_online_total numeric,
  balance_online_total numeric,
  refund_count integer,
  refund_total numeric,
  counter_count integer,
  counter_total numeric,
  given_back_count integer,
  given_back_total numeric,
  net_total numeric,
  other_currency_count integer,
  shopify_count integer,
  shopify_total numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
begin
  perform private.require_permission('view_financial_reports');
  perform private.report_require_range(p_from, p_to);
  v_start := private.shop_day_start(p_from);
  v_end := private.shop_day_start(p_to + 1);
  v_currency := private.shop_currency();

  return query
    with m as (
      select x.movement, x.kind, x.amount, x.signed_amount, x.currency, x.other_currency
      from reporting.payment_movements x
      where x."at" >= v_start and x."at" < v_end
    )
    select
      v_currency,
      (count(*) filter (where m.movement = 'online_payment' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'online_payment' and m.currency = v_currency), 0.00)::numeric,
      coalesce(sum(m.amount) filter (
        where m.movement = 'online_payment' and m.kind = 'deposit' and m.currency = v_currency
      ), 0.00)::numeric,
      coalesce(sum(m.amount) filter (
        where m.movement = 'online_payment' and m.kind = 'balance' and m.currency = v_currency
      ), 0.00)::numeric,
      (count(*) filter (where m.movement = 'online_refund' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'online_refund' and m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.movement = 'counter_payment' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'counter_payment' and m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.movement = 'counter_given_back' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (
        where m.movement = 'counter_given_back' and m.currency = v_currency
      ), 0.00)::numeric,
      coalesce(sum(m.signed_amount) filter (where m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.currency <> v_currency or m.other_currency))::integer,
      -- D254: build packages paid on Shopify, once linked to their jobs.
      (count(*) filter (where m.movement = 'shopify_payment' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'shopify_payment' and m.currency = v_currency), 0.00)::numeric
    from m;
end;
$$;



comment on function public.report_payment_summary(date, date) is
  'view_financial_reports (D154d, D254): customer money that moved in the shop days p_from..p_to (reporting.payment_movements, half open on shop_day_start), in the shop currency: online payments (count, total, deposit and balance totals), online refunds (count, positive total), counter payments (count, total), counter money given back (count, positive total), build packages paid on Shopify once linked to their jobs (shopify_count, shopify_total); net_total = online - refunds + counter - given back + Shopify. other_currency_count: movements in another currency plus Stripe payments taken in another currency. Not sales, no GST. report_range_invalid / report_range_too_long.';

revoke all on function public.report_payment_summary(date, date) from public, anon, authenticated, service_role;
grant execute on function public.report_payment_summary(date, date) to authenticated;

create or replace function public.report_payments_held()
returns table (
  grp text,
  work_order_id uuid,
  job_number text,
  status text,
  customer_label text,
  amount numeric,
  net_paid numeric,
  net_paid_online numeric,
  paid_at_counter numeric,
  job_total numeric,
  balance_due numeric,
  paid_ahead numeric,
  currency text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_currency text;
begin
  perform private.require_permission('view_financial_reports');
  v_currency := private.shop_currency();

  return query
    with cand as (
      -- Jobs that can hold money or owe it: a paid-group Stripe payment
      -- (paid_at is set exactly then), a live counter payment, or a
      -- completed or ready job (a balance may be due). Every other job
      -- has net_paid 0 and no balance due.
      select p.work_order_id as job_id
      from public.payments p
      where p.paid_at is not null
      union
      select cp.work_order_id
      from public.counter_payments cp
      where not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
      union
      select w.id
      from public.work_orders w
      where w.status in ('completed', 'ready_for_collection')
      union
      -- D254: a build order paid on Shopify and linked to the job.
      select bo.work_order_id
      from public.build_orders bo
      where bo.work_order_id is not null
    ),
    t as (
      select
        w.id as job_id,
        w.job_number,
        w.status as job_status,
        w.customer_id,
        w.currency::text as job_currency,
        pt.net_paid::numeric as t_net_paid,
        pt.net_paid_online::numeric as t_net_paid_online,
        pt.paid_at_counter::numeric as t_paid_at_counter,
        pt.job_total::numeric as t_job_total,
        pt.balance_due::numeric as t_balance_due,
        pt.paid_ahead::numeric as t_paid_ahead,
        pt.held_over_total::numeric as t_held_over_total
      from cand
      join public.work_orders w on w.id = cand.job_id
      join public.work_order_payment_totals pt on pt.work_order_id = cand.job_id
      where w.currency::text = v_currency
    ),
    g as (
      select 1 as g_rank, 'open'::text as g_name, t.*, t.t_net_paid as g_amount
      from t
      where private.work_order_status_is_open(t.job_status) and t.t_net_paid > 0
      union all
      select 2, 'awaiting_collection'::text, t.*, least(t.t_net_paid, t.t_job_total)
      from t
      where t.job_status in ('completed', 'ready_for_collection')
        and (t.t_net_paid > 0 or t.t_balance_due > 0)
      union all
      select 3, 'above_bill'::text, t.*, t.t_held_over_total
      from t
      where not private.work_order_status_is_open(t.job_status) and t.t_held_over_total > 0
    )
    select
      g.g_name,
      g.job_id,
      g.job_number::text,
      g.job_status::text,
      private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone),
      g.g_amount,
      g.t_net_paid,
      g.t_net_paid_online,
      g.t_paid_at_counter,
      g.t_job_total,
      g.t_balance_due,
      g.t_paid_ahead,
      g.job_currency
    from g
    left join public.customers c on c.id = g.customer_id
    order by g.g_rank, g.job_number, g.job_id;
end;
$$;



-- ---------------------------------------------------------------------------
-- D253: the unmapped-lines list (20261004004000) leaves out package lines,
-- which are not products and need no link.
-- ---------------------------------------------------------------------------
create or replace function private.shopify_unmapped_lines(payload jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'line_item_id', coalesce(private.shopify_gid_or_null('LineItem', x.li ->> 'id'), x.li ->> 'id'),
        'title', x.li ->> 'title',
        'variant_title', x.li ->> 'variant_title',
        'variant_gid', x.variant_gid,
        'product_gid', private.shopify_gid_or_null('Product', x.li ->> 'product_id'),
        'quantity', x.qty
      )
      order by x.ord
    ),
    '[]'::jsonb
  )
  from (
    select e.li, e.ord,
           private.shopify_gid_or_null('ProductVariant', e.li ->> 'variant_id') as variant_gid,
           case
             when coalesce(e.li ->> 'current_quantity', e.li ->> 'quantity') ~ '^[0-9]{1,6}$'
               then coalesce(e.li ->> 'current_quantity', e.li ->> 'quantity')::integer
           end as qty
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(shopify_unmapped_lines.payload -> 'line_items') = 'array'
           then shopify_unmapped_lines.payload -> 'line_items' else '[]'::jsonb end
    ) with ordinality as e(li, ord)
    where pg_catalog.jsonb_typeof(e.li) = 'object'
  ) x
  where coalesce(x.qty, 0) > 0
    and (
      x.variant_gid is null
      or (
        not exists (select 1 from public.products p where p.shopify_variant_id = x.variant_gid)
        and not exists (select 1 from public.build_packages b where b.shopify_variant_id = x.variant_gid)
      )
    );
$$;
