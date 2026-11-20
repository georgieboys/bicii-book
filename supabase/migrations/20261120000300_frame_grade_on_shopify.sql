-- D260 on Shopify: a frame's grade shows in its listing. The owner,
-- 2026-11-20: the title ends "· B+ frame", the product is tagged
-- "Grade B+", and the description opens with the grade. The sync state
-- carries the grade, and changing it queues the product's sync.

alter type public.shopify_product_sync_state add attribute frame_grade text;

-- What Shopify shows now includes the frame grade.
drop trigger products_enqueue_shopify_sync on public.products;
create constraint trigger products_enqueue_shopify_sync
  after update of name, description, brand, sku, default_sale_price, publication_status, active, archived_at,
    product_group_id, option_value, frame_grade
  on public.products
  deferrable initially deferred
  for each row
  when (
    (old.name, old.description, old.brand, old.sku, old.default_sale_price, old.publication_status, old.active,
     old.archived_at, old.product_group_id, old.option_value, old.frame_grade)
    is distinct from
    (new.name, new.description, new.brand, new.sku, new.default_sale_price, new.publication_status, new.active,
     new.archived_at, new.product_group_id, new.option_value, new.frame_grade)
  )
  execute function private.shopify_enqueue_product_change();

-- product_sync_state from 20261115000200 with the frame grade.
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
  r.sync_status := coalesce(sync.sync_status, 'not_synced');
  return r;
end;
$$;
