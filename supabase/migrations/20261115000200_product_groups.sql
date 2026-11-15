-- D241-D245: product groups (variants). The owner's request 2026-11-15: a
-- style sold in several colours or sizes is several BICII products (stock,
-- cost, labels and consignment stay per product, D45) gathered in one
-- product group, so Shopify shows ONE product with a variant per member and
-- the public site one page with a picker.
--
--   D241 product_groups: G-######, name, description, brand, the option's
--        name ("Colour"); a member product carries its option value. One
--        option per group; values unique in the group (archived members too,
--        since their Shopify variants stay).
--   D242 membership: a product with Shopify ids (pushed or linked) cannot
--        join, leave or change its group; a member is never linked to a
--        Shopify-made product; an archived group takes no members and a
--        group with live members is not archived.
--   D243 Shopify: one BICII-created Shopify product per group (handle
--        bicii-g-<n>), title, description and vendor from the group, one
--        variant per member that is published online with a price or was
--        pushed before, photos of those members; ACTIVE while any of them is
--        effectively online. Each member's own sync job sets its own stock
--        and price (D83 unchanged); the first job to push a changed group
--        writes the whole product, records every member's variant ids
--        (record_product_group_push) and queues the others.
--   D244 public: reporting.public_items gains group_short_id, group_name,
--        option_name and option_value; a grouped row's Buy online link names
--        its variant.
--   D245 handles: a grouped member's handle is its group's.

-- ---------------------------------------------------------------------------
-- Short IDs: G for groups.
-- ---------------------------------------------------------------------------
create sequence private.seq_short_id_g;

create or replace function private.next_short_id(prefix text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  case prefix
    when 'B' then n := nextval('private.seq_short_id_b');
    when 'J' then n := nextval('private.seq_short_id_j');
    when 'P' then n := nextval('private.seq_short_id_p');
    when 'U' then n := nextval('private.seq_short_id_u');
    when 'C' then n := nextval('private.seq_short_id_c');
    when 'PO' then n := nextval('private.seq_short_id_po');
    when 'S' then n := nextval('private.seq_short_id_s');
    when 'G' then n := nextval('private.seq_short_id_g');
    else
      raise exception 'unknown short id prefix: %', coalesce(prefix, '(null)')
        using errcode = '22023';
  end case;
  return prefix || '-' || pg_catalog.lpad(n::text, 6, '0');
end;
$$;
revoke all on function private.next_short_id(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- product_groups (D241)
-- ---------------------------------------------------------------------------
create table public.product_groups (
  id uuid primary key default gen_random_uuid(),
  short_id text not null default '' unique,
  name text not null,
  description text null,
  brand text null,
  option_name text not null default 'Colour',
  shopify_product_id text null,
  last_pushed_hash text null,
  created_by uuid null references public.staff (id),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz null,
  constraint product_groups_short_id_format check (short_id ~ '^G-[0-9]{6}$'),
  constraint product_groups_name_length check (pg_catalog.char_length(name) between 1 and 200),
  constraint product_groups_description_length check (description is null or pg_catalog.char_length(description) <= 10000),
  constraint product_groups_brand_length check (brand is null or pg_catalog.char_length(brand) between 1 and 200),
  constraint product_groups_option_name_length check (pg_catalog.char_length(option_name) between 1 and 40),
  constraint product_groups_shopify_product_id_format check (
    shopify_product_id is null or shopify_product_id ~ '^gid://shopify/Product/[0-9]+$'
  ),
  constraint product_groups_shopify_product_id_key unique (shopify_product_id)
);

comment on table public.product_groups is
  'D241: a style sold as several products (colours, sizes). Members are products with product_group_id; Shopify shows the group as one product with a variant per member (D243).';

create trigger product_groups_set_updated_at
  before update on public.product_groups
  for each row execute function private.set_updated_at();

create function private.product_groups_enforce_rules()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  new.name := pg_catalog.btrim(coalesce(new.name, ''));
  new.description := nullif(pg_catalog.btrim(coalesce(new.description, '')), '');
  new.brand := nullif(pg_catalog.btrim(coalesce(new.brand, '')), '');
  new.option_name := pg_catalog.btrim(coalesce(new.option_name, ''));
  if tg_op = 'INSERT' then
    new.short_id := private.next_short_id('G');
    new.created_by := private.current_staff_id();
    new.shopify_product_id := null;
    new.last_pushed_hash := null;
  else
    if new.short_id is distinct from old.short_id then
      raise exception using errcode = 'P0001', message = 'product_group_short_id_immutable',
        detail = 'A group''s short ID never changes.';
    end if;
    if new.archived_at is not null and old.archived_at is null and exists (
      select 1 from public.products p where p.product_group_id = new.id and p.archived_at is null
    ) then
      raise exception using errcode = 'P0001', message = 'product_group_has_members',
        detail = 'Take the products out of this group, or archive them, before archiving it.';
    end if;
  end if;
  return new;
end;
$$;

create trigger product_groups_enforce_rules
  before insert or update on public.product_groups
  for each row execute function private.product_groups_enforce_rules();

alter table public.product_groups enable row level security;

-- Hosted Supabase grants ALL on new public tables: start from nothing.
revoke all on table public.product_groups from public, anon, authenticated;

grant select (
  id, short_id, name, description, brand, option_name, shopify_product_id, created_by, created_at,
  updated_at, archived_at
) on table public.product_groups to authenticated;
grant insert (id, name, description, brand, option_name) on table public.product_groups to authenticated;
grant update (name, description, brand, option_name, archived_at) on table public.product_groups to authenticated;
grant select on table public.product_groups to service_role;

create policy product_groups_select_staff on public.product_groups
  for select to authenticated
  using ((select private.is_staff()));

create policy product_groups_insert_manage_inventory on public.product_groups
  for insert to authenticated
  with check ((select private.has_permission('manage_inventory')));

create policy product_groups_update_manage_inventory on public.product_groups
  for update to authenticated
  using ((select private.has_permission('manage_inventory')))
  with check ((select private.has_permission('manage_inventory')));

-- ---------------------------------------------------------------------------
-- Members (D241, D242)
-- ---------------------------------------------------------------------------
alter table public.products
  add column product_group_id uuid null references public.product_groups (id),
  add column option_value text null,
  add constraint products_option_value_length check (
    option_value is null or pg_catalog.char_length(option_value) between 1 and 60
  ),
  add constraint products_group_option_pair check ((product_group_id is null) = (option_value is null));

create unique index products_group_option_value_key
  on public.products (product_group_id, pg_catalog.lower(option_value))
  where product_group_id is not null;

create index products_product_group_id_idx on public.products (product_group_id)
  where product_group_id is not null;

comment on column public.products.product_group_id is
  'D241: the product group this product is a variant of, or null. Cannot change once the product has Shopify ids (D242).';
comment on column public.products.option_value is
  'D241: this member''s value of its group''s option ("Black", "M"); unique in the group; required exactly when grouped.';

grant select (product_group_id, option_value) on table public.products to authenticated;
grant insert (product_group_id, option_value) on table public.products to authenticated;
grant update (product_group_id, option_value) on table public.products to authenticated;

create function private.products_group_rules()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  grp public.product_groups;
begin
  new.option_value := nullif(pg_catalog.btrim(coalesce(new.option_value, '')), '');
  if tg_op = 'UPDATE' and new.product_group_id is not distinct from old.product_group_id then
    return new;
  end if;
  if tg_op = 'UPDATE' and (old.shopify_product_id is not null or old.shopify_variant_id is not null) then
    raise exception using errcode = 'P0001', message = 'product_group_shopify_linked',
      detail = 'This product is already on Shopify, so its group cannot change.';
  end if;
  if new.product_group_id is not null then
    select g.* into grp from public.product_groups g where g.id = new.product_group_id for share;
    if not found then
      raise exception 'product group % not found', new.product_group_id using errcode = 'P0002';
    end if;
    if grp.archived_at is not null then
      raise exception using errcode = 'P0001', message = 'product_group_archived',
        detail = 'That group is archived.';
    end if;
    if exists (
      select 1 from public.shopify_product_sync s
      where s.product_id = new.id and s.shopify_origin = 'external'
    ) then
      raise exception using errcode = 'P0001', message = 'product_group_shopify_linked',
        detail = 'This product is linked to a product made in Shopify, so it cannot join a group.';
    end if;
  end if;
  return new;
end;
$$;

create trigger products_group_rules
  before insert or update of product_group_id, option_value on public.products
  for each row execute function private.products_group_rules();

-- A grouped product is never linked to a Shopify-made product (D242).
create function private.shopify_sync_group_rules()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.shopify_origin = 'external' and exists (
    select 1 from public.products p where p.id = new.product_id and p.product_group_id is not null
  ) then
    raise exception using errcode = 'P0001', message = 'product_group_shopify_linked',
      detail = 'A product in a group cannot be linked to a product made in Shopify.';
  end if;
  return new;
end;
$$;

create trigger shopify_product_sync_group_rules
  before insert or update of shopify_origin on public.shopify_product_sync
  for each row execute function private.shopify_sync_group_rules();

-- What Shopify shows now includes the member's group and option value.
drop trigger products_enqueue_shopify_sync on public.products;
create constraint trigger products_enqueue_shopify_sync
  after update of name, description, brand, sku, default_sale_price, publication_status, active, archived_at,
    product_group_id, option_value
  on public.products
  deferrable initially deferred
  for each row
  when (
    (old.name, old.description, old.brand, old.sku, old.default_sale_price, old.publication_status, old.active,
     old.archived_at, old.product_group_id, old.option_value)
    is distinct from
    (new.name, new.description, new.brand, new.sku, new.default_sale_price, new.publication_status, new.active,
     new.archived_at, new.product_group_id, new.option_value)
  )
  execute function private.shopify_enqueue_product_change();

-- A group edit queues every member (each push re-reads the whole group).
create function private.shopify_enqueue_group_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  for member in
    select p.id from public.products p where p.product_group_id = new.id order by p.id
  loop
    perform private.enqueue_product_sync(member);
  end loop;
  return null;
end;
$$;

create constraint trigger product_groups_enqueue_shopify_sync
  after update of name, description, brand, option_name on public.product_groups
  deferrable initially deferred
  for each row
  when ((old.name, old.description, old.brand, old.option_name)
        is distinct from (new.name, new.description, new.brand, new.option_name))
  execute function private.shopify_enqueue_group_change();

revoke all on function private.product_groups_enforce_rules() from public, anon, authenticated, service_role;
revoke all on function private.products_group_rules() from public, anon, authenticated, service_role;
revoke all on function private.shopify_sync_group_rules() from public, anon, authenticated, service_role;
revoke all on function private.shopify_enqueue_group_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- product_group_sync_state (service role, D243): the group a sync pushes.
-- ---------------------------------------------------------------------------
create function public.product_group_sync_state(product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  prod public.products;
  grp public.product_groups;
  members jsonb;
begin
  if product_group_sync_state.product_id is null then
    raise exception 'product_id is required' using errcode = '22004';
  end if;
  select p.* into prod from public.products p where p.id = product_group_sync_state.product_id;
  if not found then
    raise exception 'product % not found', product_group_sync_state.product_id using errcode = 'P0002';
  end if;
  if prod.product_group_id is null then
    return null;
  end if;
  select g.* into grp from public.product_groups g where g.id = prod.product_group_id;

  select coalesce(pg_catalog.jsonb_agg(m.member order by m.created_at, m.short_id), '[]'::jsonb)
  into members
  from (
    select p.created_at, p.short_id,
           pg_catalog.jsonb_build_object(
             'product_id', p.id,
             'short_id', p.short_id,
             'sku', coalesce(nullif(pg_catalog.btrim(coalesce(p.sku, '')), ''), p.short_id),
             'option_value', p.option_value,
             'price', private.shopify_online_price(p.id),
             'variant_id', p.shopify_variant_id,
             'inventory_item_id', s.shopify_inventory_item_id,
             'effective_online', private.shopify_effective_online(p, s.publish_online),
             'photo_paths', coalesce((
               select pg_catalog.jsonb_agg(a.storage_path order by a.created_at, a.id)
               from public.attachments a
               where a.entity_type = 'product' and a.entity_id = p.id and a.visibility = 'public'
                 and a.storage_bucket = 'media-public'
             ), '[]'::jsonb)
           ) as member
    from public.products p
    left join public.shopify_product_sync s on s.product_id = p.id
    where p.product_group_id = grp.id
      and (
        p.shopify_variant_id is not null
        or (coalesce(s.publish_online, false) and p.archived_at is null
            and private.shopify_online_price(p.id) is not null)
      )
  ) m;

  return pg_catalog.jsonb_build_object(
    'group_id', grp.id,
    'short_id', grp.short_id,
    'handle', private.shopify_handle(grp.short_id),
    'name', grp.name,
    'description', grp.description,
    'brand', grp.brand,
    'option_name', grp.option_name,
    'shopify_product_id', grp.shopify_product_id,
    'last_pushed_hash', grp.last_pushed_hash,
    'members', members
  );
end;
$$;

comment on function public.product_group_sync_state(uuid) is
  'service_role (D243): the group of a member product, or NULL when it has none: handle bicii-g-<n>, name, description, brand, option name, the group''s Shopify product and last pushed hash, and its variants in member order (created, then short ID): every member pushed before, and every live member published online with an online price; each with its SKU (else short ID), option value, online price, variant and inventory item ids, whether it is effectively online and its public photo paths. P0002 unknown product.';

-- ---------------------------------------------------------------------------
-- record_product_group_push (service role, D243)
-- ---------------------------------------------------------------------------
create function public.record_product_group_push(
  group_id uuid,
  product_id uuid,
  shopify_product_id text,
  pushed_hash text,
  variants jsonb
)
returns public.product_groups
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grp public.product_groups;
  product_gid text := private.shopify_gid('Product', record_product_group_push.shopify_product_id);
  v jsonb;
  member public.products;
  variant_gid text;
  item_gid text;
  changed boolean;
  other uuid;
begin
  if record_product_group_push.group_id is null or product_gid is null
     or record_product_group_push.pushed_hash is null then
    raise exception 'group_id, shopify_product_id and pushed_hash are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(record_product_group_push.variants, 'null'::jsonb)) <> 'array' then
    raise exception 'variants must be an array' using errcode = '22023';
  end if;
  select g.* into grp from public.product_groups g where g.id = record_product_group_push.group_id for update;
  if not found then
    raise exception 'product group % not found', record_product_group_push.group_id using errcode = 'P0002';
  end if;
  if grp.shopify_product_id is not null and grp.shopify_product_id <> product_gid then
    raise exception using errcode = 'P0001', message = 'shopify_ids_conflict',
      detail = 'This group is already linked to a different Shopify product.';
  end if;
  changed := grp.last_pushed_hash is distinct from record_product_group_push.pushed_hash;
  update public.product_groups g
  set shopify_product_id = product_gid, last_pushed_hash = record_product_group_push.pushed_hash
  where g.id = grp.id
  returning g.* into grp;

  perform private.set_change_reason('Created in Shopify by the BICII sync');
  for v in select * from pg_catalog.jsonb_array_elements(record_product_group_push.variants) order by 1
  loop
    variant_gid := private.shopify_gid('ProductVariant', v ->> 'variant_id');
    item_gid := private.shopify_gid('InventoryItem', v ->> 'inventory_item_id');
    if variant_gid is null then
      raise exception 'each variant needs its Shopify variant id' using errcode = '22004';
    end if;
    select p.* into member from public.products p where p.id = (v ->> 'product_id')::uuid for update;
    if not found or member.product_group_id is distinct from grp.id then
      raise exception 'product % is not in group %', v ->> 'product_id', grp.short_id using errcode = '22023';
    end if;
    if (member.shopify_product_id is not null and member.shopify_product_id <> product_gid)
       or (member.shopify_variant_id is not null and member.shopify_variant_id <> variant_gid) then
      raise exception using errcode = 'P0001', message = 'shopify_ids_conflict',
        detail = pg_catalog.format('%s is already linked to a different Shopify variant.', member.short_id);
    end if;
    if member.shopify_product_id is null or member.shopify_variant_id is null then
      update public.products p
      set shopify_product_id = product_gid, shopify_variant_id = variant_gid
      where p.id = member.id;
    end if;
    update public.shopify_product_sync s
    set shopify_origin = 'bicii',
        shopify_inventory_item_id = coalesce(item_gid, s.shopify_inventory_item_id),
        shopify_handle = private.shopify_handle(grp.short_id)
    where s.product_id = member.id;
  end loop;
  perform private.set_change_reason(null);

  -- The others push their own stock against the new product (D83).
  if changed then
    for other in
      select p.id from public.products p
      where p.product_group_id = grp.id and p.id is distinct from record_product_group_push.product_id
      order by p.id
    loop
      perform private.enqueue_product_sync(other);
    end loop;
  end if;
  return grp;
end;
$$;

comment on function public.record_product_group_push(uuid, uuid, text, text, jsonb) is
  'service_role (D243): after a productSet of a group, store the group''s Shopify product and pushed hash, each member''s variant ids (products) and inventory item (sync row, origin bicii, the group''s handle); different ids -> shopify_ids_conflict. When the hash changed, queue every other member so each pushes its own stock. 22004 / 22023 on a bad shape; P0002 unknown group.';

revoke all on function public.product_group_sync_state(uuid) from public, anon, authenticated;
revoke all on function public.record_product_group_push(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.product_group_sync_state(uuid) to service_role;
grant execute on function public.record_product_group_push(uuid, uuid, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- D245 / D243: product_sync_state and record_product_sync_result know groups.
-- ---------------------------------------------------------------------------
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

create or replace function public.record_product_sync_result(
  product_id uuid,
  job_id uuid,
  outcome text,
  shopify_product_id text,
  shopify_variant_id text,
  shopify_inventory_item_id text,
  shopify_location_id text,
  pushed_quantity integer,
  pushed_price public.money_amount,
  desired_hash text,
  api_version text,
  error_code text,
  error_message text,
  retriable boolean
)
returns public.shopify_product_sync
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- Arguments are always written qualified (record_product_sync_result.x);
-- a bare name is the column.
#variable_conflict use_column
declare
  prod public.products;
  sync public.shopify_product_sync;
  job public.integration_retry_queue;
  has_job boolean := false;
  product_gid text;
  variant_gid text;
  item_gid text;
  location_gid text;
  origin text;
  successor uuid;
  settled public.shopify_sync_status;
  clean_message text := nullif(pg_catalog.btrim(record_product_sync_result.error_message), '');
  clean_code text := nullif(pg_catalog.btrim(record_product_sync_result.error_code), '');
begin
  if record_product_sync_result.product_id is null or record_product_sync_result.outcome is null then
    raise exception 'product_id and outcome are required' using errcode = '22004';
  end if;
  if record_product_sync_result.outcome not in ('pushed', 'unchanged', 'deferred', 'failed') then
    raise exception 'unknown sync outcome %', record_product_sync_result.outcome using errcode = '22023';
  end if;
  if record_product_sync_result.outcome = 'failed' and clean_message is null then
    raise exception 'a failed sync needs its human message' using errcode = '22004';
  end if;

  -- Lock order: the settings row (only when filling the Shopify location),
  -- the product (7), its sync row (8), then the job.
  if record_product_sync_result.outcome = 'pushed' then
    product_gid := private.shopify_gid('Product', record_product_sync_result.shopify_product_id);
    variant_gid := private.shopify_gid('ProductVariant', record_product_sync_result.shopify_variant_id);
    item_gid := private.shopify_gid('InventoryItem', record_product_sync_result.shopify_inventory_item_id);
    location_gid := private.shopify_gid('Location', record_product_sync_result.shopify_location_id);
    if product_gid is null or variant_gid is null or record_product_sync_result.pushed_quantity is null then
      raise exception 'a push needs the Shopify product and variant and the pushed quantity' using errcode = '22004';
    end if;
    if location_gid is not null then
      update public.shopify_settings s
      set shopify_location_id = location_gid
      where s.id = 1 and s.shopify_location_id is null;
    end if;
  end if;

  select p.* into prod from public.products p where p.id = record_product_sync_result.product_id for update;
  if not found then
    raise exception 'product % not found', record_product_sync_result.product_id using errcode = 'P0002';
  end if;
  select s.* into sync from public.shopify_product_sync s where s.product_id = prod.id for update;
  if not found then
    raise exception 'product % has no Shopify sync record', prod.id using errcode = 'P0002';
  end if;
  if record_product_sync_result.job_id is not null then
    select q.* into job from public.integration_retry_queue q where q.id = record_product_sync_result.job_id for update;
    if not found then
      raise exception 'integration job % not found', record_product_sync_result.job_id using errcode = 'P0002';
    end if;
    if job.kind <> 'product_sync' or job.product_id <> prod.id then
      raise exception 'job % is not a sync of product %', job.id, prod.id using errcode = '22023';
    end if;
    -- A job closed meanwhile (dismissed, superseded) is left as it is.
    has_job := job.status in ('queued', 'running', 'needs_attention');
  end if;
  select q.id into successor
  from public.integration_retry_queue q
  where q.kind = 'product_sync' and q.product_id = prod.id and q.status = 'queued'
    and q.id is distinct from record_product_sync_result.job_id;

  if record_product_sync_result.outcome = 'pushed' then
    if (prod.shopify_product_id is not null and prod.shopify_product_id <> product_gid)
       or (prod.shopify_variant_id is not null and prod.shopify_variant_id <> variant_gid) then
      raise exception using
        errcode = 'P0001',
        message = 'shopify_ids_conflict',
        detail = 'This product is already linked to a different Shopify product.';
    end if;
    origin := coalesce(sync.shopify_origin, 'bicii');
    -- A Shopify product BICII created belongs to this one product (D84).
    -- D243: a group's members share the group's Shopify product.
    if origin = 'bicii' and exists (
      select 1 from public.products o where o.shopify_product_id = product_gid and o.id <> prod.id
    ) and not (
      prod.product_group_id is not null and exists (
        select 1 from public.product_groups g
        where g.id = prod.product_group_id and g.shopify_product_id = product_gid
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'shopify_ids_conflict',
        detail = 'That Shopify product belongs to another BICII product.';
    end if;
    if prod.shopify_product_id is null or prod.shopify_variant_id is null then
      perform private.set_change_reason('Created in Shopify by the BICII sync');
      -- Another product's variant raises products_shopify_variant_id_key.
      update public.products p
      set shopify_product_id = product_gid, shopify_variant_id = variant_gid
      where p.id = prod.id;
      perform private.set_change_reason(null);
    end if;
    update public.shopify_product_sync s
    set shopify_origin = origin,
        shopify_inventory_item_id = coalesce(item_gid, s.shopify_inventory_item_id),
        shopify_handle = case
          when origin <> 'bicii' then null
          when prod.product_group_id is not null then (
            select private.shopify_handle(g.short_id) from public.product_groups g where g.id = prod.product_group_id
          )
          else private.shopify_handle(prod.short_id)
        end,
        last_pushed_at = pg_catalog.now(),
        last_checked_at = pg_catalog.now(),
        last_pushed_quantity = record_product_sync_result.pushed_quantity,
        last_pushed_price = record_product_sync_result.pushed_price,
        desired_hash = record_product_sync_result.desired_hash,
        api_version = record_product_sync_result.api_version,
        last_error_code = null,
        last_error = null
    where s.product_id = prod.id
    returning s.* into sync;
  elsif record_product_sync_result.outcome = 'unchanged' then
    update public.shopify_product_sync s
    set last_checked_at = pg_catalog.now(), last_error_code = null, last_error = null
    where s.product_id = prod.id
    returning s.* into sync;
  end if;

  if record_product_sync_result.outcome in ('pushed', 'unchanged') then
    settled := case
      when successor is not null then 'pending'
      when private.shopify_effective_online(prod, sync.publish_online) then 'synced'
      when sync.last_pushed_at is null then 'not_synced'
      else 'unpublished'
    end;
    update public.shopify_product_sync s set sync_status = settled where s.product_id = prod.id
    returning s.* into sync;
    if has_job then
      update public.integration_retry_queue q
      set status = 'done', resolved_at = pg_catalog.now(), locked_at = null,
          last_error_code = null, last_error = null
      where q.id = job.id;
    end if;
    -- A later successful sync resolves an older one that needed attention.
    update public.integration_retry_queue q
    set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
        resolution_reason = 'Resolved by a later sync'
    where q.kind = 'product_sync' and q.product_id = prod.id and q.status = 'needs_attention'
      and q.id is distinct from record_product_sync_result.job_id;

  elsif record_product_sync_result.outcome = 'deferred' then
    -- D83: wait two minutes for the order webhook; a deferral consumes no
    -- attempt. A newer queued job of the product takes the wait instead.
    if has_job then
      if successor is not null then
        update public.integration_retry_queue q
        set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
            resolution_reason = 'Superseded by a newer change'
        where q.id = job.id;
        update public.integration_retry_queue q
        set next_attempt_at = greatest(q.next_attempt_at, pg_catalog.now() + interval '2 minutes')
        where q.id = successor;
      else
        update public.integration_retry_queue q
        set status = 'queued', locked_at = null,
            next_attempt_at = pg_catalog.now() + interval '2 minutes',
            attempts = greatest(q.attempts - 1, 0),
            last_error_code = pg_catalog.left(clean_code, 100),
            last_error = pg_catalog.left(clean_message, 2000)
        where q.id = job.id;
      end if;
    end if;

  else
    -- 'failed' (D87).
    update public.shopify_product_sync s
    set sync_status = 'error', last_checked_at = pg_catalog.now(),
        last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
        last_error = pg_catalog.left(clean_message, 1000)
    where s.product_id = prod.id
    returning s.* into sync;
    if has_job then
      if coalesce(record_product_sync_result.retriable, false) and job.attempts < job.max_attempts then
        if successor is not null then
          update public.integration_retry_queue q
          set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
              resolution_reason = 'Superseded by a newer change'
          where q.id = job.id;
          update public.integration_retry_queue q
          set next_attempt_at = greatest(q.next_attempt_at, pg_catalog.now() + private.integration_backoff(job.attempts))
          where q.id = successor;
        else
          update public.integration_retry_queue q
          set status = 'queued', locked_at = null,
              next_attempt_at = pg_catalog.now() + private.integration_backoff(job.attempts),
              last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
              last_error = pg_catalog.left(clean_message, 2000)
          where q.id = job.id;
        end if;
      else
        update public.integration_retry_queue q
        set status = 'needs_attention', locked_at = null, next_attempt_at = pg_catalog.now(),
            last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
            last_error = pg_catalog.left(clean_message, 2000)
        where q.id = job.id;
      end if;
    end if;
  end if;

  return sync;
end;
$$;

-- ---------------------------------------------------------------------------
-- D244: the public view names each row's group and option; a grouped row's
-- Buy online link opens its variant.
-- ---------------------------------------------------------------------------
create or replace view reporting.public_items
with (security_barrier)
as
 WITH visible_products AS (
         SELECT p.id,
            p.short_id,
            p.sku,
            p.sku_key,
            p.name,
            p.description,
            p.brand,
            p.category_id,
            p.tracking_type,
            p.ownership_type,
            p.publication_status,
            p.public_slug,
            p.default_sale_price,
            p.default_direct_cost,
            p.currency,
            p.reorder_point,
            p.shopify_product_id,
            p.shopify_variant_id,
            p.active,
            p.search_text,
            p.created_by,
            p.created_at,
            p.updated_at,
            p.archived_at,
            p.product_group_id,
            p.option_value
           FROM products p
          WHERE (p.publication_status = ANY (ARRAY['public'::publication_status, 'sold'::publication_status])) AND p.archived_at IS NULL
        )
 SELECT 'product'::text AS kind,
    p.short_id,
    p.public_slug AS slug,
    p.name,
    p.description,
    p.brand,
    c.name AS category,
    NULL::text AS condition,
    private.selling_price(p.id, NULL::uuid) AS sale_price,
    p.currency::text AS currency,
    av.availability,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('bucket', a.storage_bucket, 'path', a.storage_path, 'width', a.width, 'height', a.height, 'caption', a.caption) ORDER BY a.created_at, a.id) AS jsonb_agg
           FROM attachments a
          WHERE a.entity_type = 'product'::attachment_entity AND a.entity_id = p.id AND a.visibility = 'public'::attachment_visibility), '[]'::jsonb) AS photos,
    p.updated_at,
        CASE
            WHEN av.availability = 'available'::text AND ps.publish_online AND ps.sync_status = 'synced'::shopify_sync_status AND ps.shopify_origin = 'bicii'::text AND ps.shopify_handle IS NOT NULL AND ss.storefront_url IS NOT NULL AND (p.tracking_type = 'quantity'::tracking_type OR NOT private.selling_price(p.id, NULL::uuid)::numeric IS DISTINCT FROM private.selling_price(p.id, ou.id)::numeric) THEN ((ss.storefront_url || '/products/'::text) || ps.shopify_handle) || CASE WHEN p.product_group_id IS NOT NULL AND p.shopify_variant_id IS NOT NULL THEN '?variant='::text || substring(p.shopify_variant_id from '[0-9]+$') ELSE ''::text END
            ELSE NULL::text
        END AS buy_online_url,
    g.short_id AS group_short_id,
    g.name AS group_name,
    g.option_name,
    CASE WHEN g.id IS NOT NULL THEN p.option_value END AS option_value
   FROM visible_products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_groups g ON g.id = p.product_group_id AND g.archived_at IS NULL
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.tracking_type = 'quantity'::tracking_type THEN
                    CASE
                        WHEN p.publication_status = 'sold'::publication_status THEN 'sold'::text
                        WHEN COALESCE(( SELECT sum(m.quantity_delta) AS sum
                           FROM inventory_movements m
                          WHERE m.product_id = p.id), 0::bigint) > 0 THEN 'available'::text
                        ELSE 'sold_out'::text
                    END
                    ELSE
                    CASE
                        WHEN (EXISTS ( SELECT 1
                           FROM inventory_units u
                          WHERE u.product_id = p.id AND u.status = 'available'::unit_status AND u.archived_at IS NULL)) THEN 'available'::text
                        WHEN p.publication_status = 'sold'::publication_status THEN 'sold'::text
                        ELSE 'unavailable'::text
                    END
                END AS availability) av
     LEFT JOIN shopify_product_sync ps ON ps.product_id = p.id
     LEFT JOIN shopify_settings ss ON ss.id = 1
     LEFT JOIN LATERAL ( SELECT o.id
           FROM inventory_units o
          WHERE p.tracking_type = 'unique'::tracking_type AND o.product_id = p.id AND o.location_id = ss.online_location_id AND o.status = 'available'::unit_status AND o.ownership_type <> 'customer_owned'::ownership_type AND o.archived_at IS NULL
          ORDER BY o.created_at, o.id
         LIMIT 1) ou ON true
UNION ALL
 SELECT 'unit'::text AS kind,
    u.short_id,
    p.public_slug AS slug,
    p.name,
    p.description,
    p.brand,
    c.name AS category,
    u.condition,
    private.selling_price(p.id, u.id) AS sale_price,
    p.currency::text AS currency,
    uav.availability,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('bucket', ph.storage_bucket, 'path', ph.storage_path, 'width', ph.width, 'height', ph.height, 'caption', ph.caption) ORDER BY ph.source_order, ph.created_at, ph.id) AS jsonb_agg
           FROM ( SELECT a.id,
                    a.entity_type,
                    a.entity_id,
                    a.storage_bucket,
                    a.storage_path,
                    a.media_type,
                    a.byte_size,
                    a.width,
                    a.height,
                    a.caption,
                    a.visibility,
                    a.created_by,
                    a.created_at,
                    a.updated_at,
                    1 AS source_order
                   FROM attachments a
                  WHERE a.entity_type = 'inventory_unit'::attachment_entity AND a.entity_id = u.id AND a.visibility = 'public'::attachment_visibility
                UNION ALL
                 SELECT a.id,
                    a.entity_type,
                    a.entity_id,
                    a.storage_bucket,
                    a.storage_path,
                    a.media_type,
                    a.byte_size,
                    a.width,
                    a.height,
                    a.caption,
                    a.visibility,
                    a.created_by,
                    a.created_at,
                    a.updated_at,
                    2
                   FROM attachments a
                  WHERE a.entity_type = 'product'::attachment_entity AND a.entity_id = p.id AND a.visibility = 'public'::attachment_visibility
                UNION ALL
                 SELECT a.id,
                    a.entity_type,
                    a.entity_id,
                    a.storage_bucket,
                    a.storage_path,
                    a.media_type,
                    a.byte_size,
                    a.width,
                    a.height,
                    a.caption,
                    a.visibility,
                    a.created_by,
                    a.created_at,
                    a.updated_at,
                    3
                   FROM attachments a
                  WHERE u.bike_id IS NOT NULL AND a.entity_type = 'bike'::attachment_entity AND a.entity_id = u.bike_id AND a.visibility = 'public'::attachment_visibility AND a.created_at < COALESCE(LEAST(u.sold_at, ( SELECT min(e.created_at) AS min
                           FROM bike_ownership_events e
                          WHERE e.bike_id = u.bike_id AND e.to_customer_id IS NOT NULL AND e.created_at >= u.created_at)), 'infinity'::timestamp with time zone)) ph), '[]'::jsonb) AS photos,
    GREATEST(u.updated_at, p.updated_at) AS updated_at,
        CASE
            WHEN uav.availability = 'available'::text AND ps.publish_online AND ps.sync_status = 'synced'::shopify_sync_status AND ps.shopify_origin = 'bicii'::text AND ps.shopify_handle IS NOT NULL AND ss.storefront_url IS NOT NULL AND u.id = ou.id THEN ((ss.storefront_url || '/products/'::text) || ps.shopify_handle) || CASE WHEN p.product_group_id IS NOT NULL AND p.shopify_variant_id IS NOT NULL THEN '?variant='::text || substring(p.shopify_variant_id from '[0-9]+$') ELSE ''::text END
            ELSE NULL::text
        END AS buy_online_url,
    g.short_id AS group_short_id,
    g.name AS group_name,
    g.option_name,
    CASE WHEN g.id IS NOT NULL THEN p.option_value END AS option_value
   FROM visible_products p
     JOIN inventory_units u ON u.product_id = p.id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_groups g ON g.id = p.product_group_id AND g.archived_at IS NULL
     CROSS JOIN LATERAL ( SELECT
                CASE u.status
                    WHEN 'available'::unit_status THEN 'available'::text
                    WHEN 'sold'::unit_status THEN 'sold'::text
                    ELSE 'unavailable'::text
                END AS availability) uav
     LEFT JOIN shopify_product_sync ps ON ps.product_id = p.id
     LEFT JOIN shopify_settings ss ON ss.id = 1
     LEFT JOIN LATERAL ( SELECT o.id
           FROM inventory_units o
          WHERE p.tracking_type = 'unique'::tracking_type AND o.product_id = p.id AND o.location_id = ss.online_location_id AND o.status = 'available'::unit_status AND o.ownership_type <> 'customer_owned'::ownership_type AND o.archived_at IS NULL
          ORDER BY o.created_at, o.id
         LIMIT 1) ou ON true
  WHERE u.archived_at IS NULL AND (u.status <> ALL (ARRAY['written_off'::unit_status, 'returned_to_consignor'::unit_status]));
