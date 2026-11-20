-- D260: frame grades. The owner, 2026-11-20: a frame's price is said as a
-- grade, C to S with two pluses each (C, C+, C++, B ... S++, S best), so a
-- sale reads "a B++ frame with a Classic+ build". Each grade has a
-- suggested price; every frame is still priced on its own ("fine tune").
-- Letters start at round numbers and step within: C S$200 by 50, B S$400
-- by 100, A S$800 by 200, S S$1,500 by 500.

create table public.frame_grades (
  grade text primary key,
  sort_order smallint not null,
  suggested_price public.money_amount not null,
  currency char(3) not null default 'SGD',
  updated_at timestamptz not null default pg_catalog.now(),
  constraint frame_grades_grade_format check (grade ~ '^[SABC]\+{0,2}$'),
  constraint frame_grades_sort_order_key unique (sort_order),
  constraint frame_grades_suggested_price_positive check (suggested_price > 0)
);

comment on table public.frame_grades is
  'D260: the frame grades, C (lowest) to S++ (best), each with a suggested price; a frame is still priced on its own.';

insert into public.frame_grades (grade, sort_order, suggested_price) values
  ('C', 1, 200), ('C+', 2, 250), ('C++', 3, 300),
  ('B', 4, 400), ('B+', 5, 500), ('B++', 6, 600),
  ('A', 7, 800), ('A+', 8, 1000), ('A++', 9, 1200),
  ('S', 10, 1500), ('S+', 11, 2000), ('S++', 12, 2500);

alter table public.frame_grades enable row level security;
revoke all on table public.frame_grades from public, anon, authenticated;
grant select on table public.frame_grades to authenticated;
grant update (suggested_price) on table public.frame_grades to authenticated;
grant select on table public.frame_grades to service_role;

create policy frame_grades_select_staff on public.frame_grades
  for select to authenticated
  using ((select private.is_staff()));

create policy frame_grades_update_admin on public.frame_grades
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- The site's frame pricing reads the grades (anon, like public_shop_hours).
create function public.public_frame_grades()
returns table (grade text, suggested_price public.money_amount, currency char(3))
language sql
stable
security definer
set search_path = ''
as $$
  select g.grade, g.suggested_price, g.currency from public.frame_grades g order by g.sort_order;
$$;

comment on function public.public_frame_grades() is
  'D260: anyone: the frame grades in order with their suggested prices, for the site''s frame pricing.';

revoke all on function public.public_frame_grades() from public, anon, authenticated, service_role;
grant execute on function public.public_frame_grades() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- A product's grade (a frame's, in practice)
-- ---------------------------------------------------------------------------
alter table public.products
  add column frame_grade text null references public.frame_grades (grade) on update cascade on delete restrict;

create index products_frame_grade_idx on public.products (frame_grade);

grant select (frame_grade) on table public.products to authenticated;
grant insert (frame_grade) on table public.products to authenticated;
grant update (frame_grade) on table public.products to authenticated;

comment on column public.products.frame_grade is
  'D260: the frame''s grade (C ... S++), shown to staff and on its public page; its price is still its own.';

-- ---------------------------------------------------------------------------
-- The public view names a published frame's grade (appended column).
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
            p.option_value,
            p.frame_grade
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
    CASE WHEN g.id IS NOT NULL THEN p.option_value END AS option_value,
    p.frame_grade
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
    CASE WHEN g.id IS NOT NULL THEN p.option_value END AS option_value,
    p.frame_grade
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
