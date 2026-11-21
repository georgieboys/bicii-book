set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D262 (audit A-04, 2026-11-22; amends D83): a paid Shopify order that
-- BICII has not recorded (pending, or failed and needing attention, for
-- example a mixed order with a line that is not linked) has already taken
-- its units off Shopify's count but not off the ledger. orders_in_flight
-- only defers a sync for ten minutes; after that the sync overwrote
-- Shopify's count with the ledger's and put those units back on sale.
--
--   - product_sync_state carries unrecorded_online_quantity: the units of
--     the product's variant on such orders, at any age, one delivery per
--     order; the sync pushes the ledger less those units.
--   - When such an order is recorded, skipped or dismissed, the products on
--     it are queued for a sync again, so the hold ends with the order.

alter type public.shopify_product_sync_state add attribute unrecorded_online_quantity integer;

-- product_sync_state reads the unrecorded orders/paid events on every sync.
create index integration_events_unrecorded_topic_idx
  on public.integration_events (topic)
  where status in ('pending', 'failed');

-- product_sync_state from 20261120000300 with unrecorded_online_quantity.
create or replace function public.product_sync_state(product_id uuid)
returns public.shopify_product_sync_state
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  prod public.products;
  sync public.shopify_product_sync;
  settings public.shopify_settings;
  r public.shopify_product_sync_state;
begin
  if product_sync_state.product_id is null then
    raise exception 'product_id is required' using errcode = '22004';
  end if;
  select p.* into prod from public.products p where p.id = product_sync_state.product_id;
  if not found then
    raise exception 'product % not found', product_sync_state.product_id using errcode = 'P0002';
  end if;
  select s.* into settings from public.shopify_settings s where s.id = 1;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_settings_missing',
      detail = 'Shopify settings are missing. Ask an admin to set the online location.';
  end if;
  select s.* into sync from public.shopify_product_sync s where s.product_id = prod.id;

  r.product_id := prod.id;
  r.short_id := prod.short_id;
  r.sku := prod.sku;
  r.name := prod.name;
  r.description := prod.description;
  r.brand := prod.brand;
  -- D260: a frame's grade, shown in its Shopify title, tags and description.
  r.frame_grade := prod.frame_grade;
  r.tracking_type := prod.tracking_type;
  r.ownership_type := prod.ownership_type;
  r.publication_status := prod.publication_status;
  r.active := prod.active;
  r.archived := prod.archived_at is not null;
  r.sale_price := private.shopify_online_price(prod.id);
  r.currency := prod.currency;
  r.publish_online := coalesce(sync.publish_online, false);
  r.effective_online := private.shopify_effective_online(prod, sync.publish_online);

  if prod.tracking_type = 'unique' then
    -- D81: the units an online order can take, oldest first.
    select count(*)::integer,
           coalesce(
             pg_catalog.array_agg(u.short_id order by u.created_at, u.id)
               filter (where private.selling_price(prod.id, u.id) is distinct from r.sale_price),
             '{}'
           )
    into r.available_quantity, r.unit_price_conflicts
    from public.inventory_units u
    where u.product_id = prod.id
      and u.location_id = settings.online_location_id
      and u.status = 'available'
      and u.ownership_type <> 'customer_owned'
      and u.archived_at is null;
  else
    r.available_quantity := greatest(private.stock_on_hand(prod.id, settings.online_location_id), 0);
    r.unit_price_conflicts := '{}';
  end if;

  select coalesce(pg_catalog.array_agg(a.storage_path order by a.created_at, a.id), '{}')
  into r.public_photo_paths
  from public.attachments a
  where a.entity_type = 'product' and a.entity_id = prod.id and a.visibility = 'public'
    and a.storage_bucket = 'media-public';

  -- D245: a grouped member's Shopify product is its group's.
  r.handle := case
    when sync.shopify_origin = 'external' then null
    when prod.product_group_id is not null then (
      select private.shopify_handle(g.short_id) from public.product_groups g where g.id = prod.product_group_id
    )
    else private.shopify_handle(prod.short_id)
  end;
  r.shopify_origin := sync.shopify_origin;
  r.shopify_product_id := prod.shopify_product_id;
  r.shopify_variant_id := prod.shopify_variant_id;
  r.shopify_inventory_item_id := sync.shopify_inventory_item_id;
  r.shopify_location_id := settings.shopify_location_id;
  select l.name into r.online_location_name from public.locations l where l.id = settings.online_location_id;
  r.last_desired_hash := sync.desired_hash;
  r.last_pushed_quantity := sync.last_pushed_quantity;
  -- D83: an online order may be about to take stock BICII has not recorded.
  r.orders_in_flight := exists (
    select 1
    from public.integration_events e
    where e.topic = 'orders/paid'
      and e.received_at > pg_catalog.now() - interval '10 minutes'
      and (
        e.status = 'pending'
        or (e.status = 'failed' and exists (
          select 1 from public.integration_retry_queue q
          where q.integration_event_id = e.id and q.status in ('queued', 'running')
        ))
      )
  );
  -- A-04: units of this variant on paid online orders BICII has not
  -- recorded yet (pending, or failed: queued or needing attention, at any
  -- age). Shopify has already taken them off its count; the sync subtracts
  -- them so it never puts them back on sale. A grouped member is matched by
  -- its own variant. A line whose quantity or variant cannot be read counts
  -- nothing here (processing refuses it).
  r.unrecorded_online_quantity := coalesce((
    select sum(
      case when q.qty ~ '^[0-9]{1,6}$' then q.qty::integer else 0 end
    )::integer
    from (
      -- One delivery per order (the latest): Shopify may deliver an order
      -- under several webhook ids, and each must not hold the units again.
      -- An order already recorded under another delivery holds nothing.
      select distinct on (coalesce(x.shopify_order_gid, x.id::text)) x.payload
      from public.integration_events x
      where x.topic = 'orders/paid'
        and x.status in ('pending', 'failed')
        and not exists (
          select 1 from public.integration_events p
          where p.topic = 'orders/paid' and p.status = 'processed'
            and p.shopify_order_gid = x.shopify_order_gid
        )
      order by coalesce(x.shopify_order_gid, x.id::text), x.received_at desc, x.id
    ) e
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(e.payload -> 'line_items') = 'array'
        then e.payload -> 'line_items' else '[]'::jsonb end
    ) li(v)
    cross join lateral (
      select pg_catalog.btrim(coalesce(li.v ->> 'current_quantity', li.v ->> 'quantity')) as qty
    ) q
    where prod.shopify_variant_id is not null
      and pg_catalog.jsonb_typeof(li.v) = 'object'
      and private.shopify_gid_or_null('ProductVariant', nullif(pg_catalog.btrim(li.v ->> 'variant_id'), ''))
        = prod.shopify_variant_id
  ), 0);
  r.sync_status := coalesce(sync.sync_status, 'not_synced');
  return r;
end;
$$;

comment on function public.product_sync_state(uuid) is
  'service_role (the sync worker, step 3): a product''s desired Shopify state. sale_price = private.shopify_online_price (D81: a consigned item at its asking price, like its label and public page); effective_online (D84: published, public or a sold-out unique product, active, not archived, not customer-owned); available_quantity at the online location floored at 0 (D83: the ledger for quantity products, available non-customer-owned units for unique ones); unit_price_conflicts (units whose own selling price differs: sync refuses, D81); public photo paths oldest first; handle bicii-<short id> unless the Shopify product was made in Shopify (a grouped member: its group''s, D245); frame_grade (D260); orders_in_flight (an orders/paid event of the last 10 minutes pending, or failed with its job queued or running); unrecorded_online_quantity (D262: the units of this product''s variant on paid orders still pending or failed, at any age, one delivery per order and none for an order recorded under another delivery, which the sync subtracts from available_quantity). P0002 unknown product; shopify_settings_missing.';

revoke all on function public.product_sync_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.product_sync_state(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- The hold ends with the order: recorded, skipped or dismissed, each product
-- on it is queued for a sync (D262).
-- ---------------------------------------------------------------------------
create function private.integration_events_release_online_hold()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pid uuid;
begin
  if new.topic <> 'orders/paid'
     or old.status not in ('pending', 'failed')
     or new.status in ('pending', 'failed') then
    return null;
  end if;
  for pid in
    select distinct p.id
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(new.payload -> 'line_items') = 'array'
        then new.payload -> 'line_items' else '[]'::jsonb end
    ) li(v)
    join public.products p
      on p.shopify_variant_id = private.shopify_gid_or_null(
        'ProductVariant', nullif(pg_catalog.btrim(li.v ->> 'variant_id'), '')
      )
    where pg_catalog.jsonb_typeof(li.v) = 'object'
    order by p.id
  loop
    perform private.enqueue_product_sync(pid);
  end loop;
  return null;
end;
$$;

comment on function private.integration_events_release_online_hold() is
  'D262: when a paid order''s event leaves pending or failed (recorded, skipped or dismissed), queue a sync for each product on it, so the units held back for it are pushed from the ledger again. enqueue_product_sync queues only products that are online or were pushed.';

revoke all on function private.integration_events_release_online_hold() from public, anon, authenticated, service_role;

-- Deferred to commit like the other enqueue triggers, so it never takes
-- the sync locks in the middle of order processing.
create constraint trigger integration_events_release_online_hold
  after update of status on public.integration_events
  deferrable initially deferred
  for each row
  when (old.status is distinct from new.status)
  execute function private.integration_events_release_online_hold();
