-- Audit fixes for build packages and their Shopify listings (2026-11-22).
--
-- 1. reprice_build_line and set_build_line_extra return only sale-side
--    figures (build_line_result), like the columns staff may read on a line;
--    the costs stay behind work_order_line_items_staff (D14).
-- 2. link_build_order: a job that already has the ordered package at another
--    price takes the price paid (less a donor strip), as a job without a
--    package does (D255: the paid order is the agreement).
-- 3. A package's own-frame and donor variants (D257) are package lines too:
--    the unmapped-lines list leaves them out, and link_shopify_variant
--    refuses any build package's product or variant.
-- 4. A package on sale on Shopify cannot be archived until it is taken off.

create type public.build_line_result as (
  line_id uuid,
  unit_sale_price public.money_amount,
  unit_list_price public.money_amount,
  sale_total public.money_amount,
  currency char(3)
);

comment on type public.build_line_result is
  'What staff see of a build line after repricing or marking it extra: no cost, yield, Cult Commons or payout.';


-- ---------------------------------------------------------------------------
-- 1. Narrow results (D248, D261 otherwise unchanged)
-- ---------------------------------------------------------------------------
drop function public.reprice_build_line(uuid, public.money_amount);

create function public.reprice_build_line(line_id uuid, unit_sale_price public.money_amount)
returns public.build_line_result
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
  narrow public.build_line_result;
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
    narrow := row(target.id, target.unit_sale_price_snapshot, target.unit_list_price_snapshot, target.sale_total, target.currency);
    return narrow;
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
  narrow := row(result.id, result.unit_sale_price_snapshot, result.unit_list_price_snapshot, result.sale_total, result.currency);
  return narrow;
end;
$$;


comment on function public.reprice_build_line(uuid, public.money_amount) is
  'D248: active staff: change the sale price of one live part (inventory line) or the labour line of an open job with a build package; the first change keeps the list price; line_repriced event. Same price: no change, no event. Returns sale-side figures only.';

revoke all on function public.reprice_build_line(uuid, public.money_amount) from public, anon, authenticated, service_role;
grant execute on function public.reprice_build_line(uuid, public.money_amount) to authenticated;

drop function public.set_build_line_extra(uuid, boolean);

create function public.set_build_line_extra(line_id uuid, extra boolean)
returns public.build_line_result
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
  narrow public.build_line_result;
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
    narrow := row(target.id, target.unit_sale_price_snapshot, target.unit_list_price_snapshot, target.sale_total, target.currency);
    return narrow;
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
  narrow := row(result.id, result.unit_sale_price_snapshot, result.unit_list_price_snapshot, result.sale_total, result.currency);
  return narrow;
end;
$$;


comment on function public.set_build_line_extra(uuid, boolean) is
  'D261: active staff: on an open job with a build package, make one live part (inventory line) an extra, charged on top of the package at its own price (a fitted part goes back to its shelf price), or put it back in the package; build_extra_marked or build_extra_unmarked event. No change: no event. Returns sale-side figures only.';

revoke all on function public.set_build_line_extra(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_build_line_extra(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Linking at the price paid (D255, D258 otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.link_build_order(
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
  new_labour public.money_amount;
  labour public.work_order_line_items;
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
  elsif build.price <> build_price then
    -- The job already has the package at another price (its list price, or
    -- a "from" price): the paid order is the agreement, as above. Labour as
    -- the package's, never above the price; the parts budget follows.
    select p.* into pkg from public.build_packages p where p.id = bo.build_package_id;
    select l.* into labour from public.work_order_line_items l where l.id = build.labour_line_id for update;
    if labour.voided_at is not null then
      raise exception using errcode = 'P0001', message = 'build_labour_line_voided',
        detail = 'The build''s labour line was voided; set the package again first.';
    end if;
    new_labour := least(pkg.labour_amount, build_price)::public.money_amount;
    perform private.reprice_line(labour.id, new_labour, new_labour);
    update public.work_order_builds b
    set price = build_price, labour_amount = new_labour
    where b.work_order_id = wo.id;
    perform private.record_work_order_event(
      wo.id, 'build_set',
      pg_catalog.jsonb_build_object(
        'build_package_id', pkg.id, 'name', pkg.name, 'kind', pkg.kind, 'price', build_price,
        'previous_price', build.price, 'labour_amount', new_labour,
        'labour_line_id', labour.id, 'build_order_id', bo.id
      )
    );
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


-- ---------------------------------------------------------------------------
-- 3. Package variants are not products (D253, D257)
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
        and not exists (
          select 1 from public.build_packages b
          where x.variant_gid in (b.shopify_variant_id, b.shopify_own_frame_variant_id, b.shopify_donor_variant_id)
        )
      )
    );
$$;


create or replace function public.link_shopify_variant(
  product_id uuid,
  shopify_product_id text,
  shopify_variant_id text,
  reason text
)
returns public.shopify_product_sync
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_admin();
  cleaned text := private.require_reason(link_shopify_variant.reason);
  product_gid text := private.shopify_gid('Product', link_shopify_variant.shopify_product_id);
  variant_gid text := private.shopify_gid('ProductVariant', link_shopify_variant.shopify_variant_id);
  prod public.products;
  sync public.shopify_product_sync;
begin
  if link_shopify_variant.product_id is null or product_gid is null or variant_gid is null then
    raise exception 'product_id, shopify_product_id and shopify_variant_id are required' using errcode = '22004';
  end if;
  select pr.* into prod from public.products pr where pr.id = link_shopify_variant.product_id for update;
  if not found then
    raise exception 'product % not found', link_shopify_variant.product_id using errcode = 'P0002';
  end if;
  select s.* into sync from public.shopify_product_sync s where s.product_id = prod.id;

  -- Same ids: a replay.
  if prod.shopify_product_id is not distinct from product_gid and prod.shopify_variant_id is not distinct from variant_gid
     and sync.product_id is not null then
    return sync;
  end if;
  if (prod.shopify_variant_id is not null and prod.shopify_variant_id <> variant_gid)
     or (prod.shopify_product_id is not null and prod.shopify_product_id <> product_gid
         and prod.shopify_variant_id is not null) then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_ids_conflict',
      detail = 'This product is already linked to a different Shopify product.';
  end if;
  -- A Shopify product BICII created belongs to that one BICII product.
  if exists (
    select 1
    from public.products o
    join public.shopify_product_sync os on os.product_id = o.id
    where o.shopify_product_id = product_gid and o.id <> prod.id and os.shopify_origin = 'bicii'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_ids_conflict',
      detail = 'That Shopify product belongs to another BICII product.';
  end if;

  -- A build package's product and variants are not products (D253, D257).
  if exists (
    select 1 from public.build_packages b
    where b.shopify_product_id = product_gid
       or variant_gid in (b.shopify_variant_id, b.shopify_own_frame_variant_id, b.shopify_donor_variant_id)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_ids_conflict',
      detail = 'That Shopify product is a build package, not a product.';
  end if;

  perform private.set_change_reason(cleaned);
  -- A variant on another product raises products_shopify_variant_id_key.
  update public.products pr
  set shopify_product_id = product_gid, shopify_variant_id = variant_gid
  where pr.id = prod.id;
  perform private.set_change_reason(null);

  insert into public.shopify_product_sync as s (product_id, shopify_origin, shopify_handle)
  values (prod.id, 'external', null)
  on conflict (product_id) do update
    set shopify_origin = case when s.shopify_origin = 'bicii' then 'bicii' else 'external' end,
        shopify_handle = case when s.shopify_origin = 'bicii' then s.shopify_handle else null end
  returning s.* into sync;

  insert into public.integration_audit_events (
    event_type, product_id, actor_staff_id, reason, payload, correlation_id
  )
  values (
    'variant_linked', prod.id, actor, cleaned,
    pg_catalog.jsonb_build_object(
      'from', pg_catalog.jsonb_build_object('product', prod.shopify_product_id, 'variant', prod.shopify_variant_id),
      'to', pg_catalog.jsonb_build_object('product', product_gid, 'variant', variant_gid)
    ),
    private.current_correlation_id()
  );
  return sync;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Take a package off Shopify before archiving it (D246, D252)
-- ---------------------------------------------------------------------------
create or replace function private.build_packages_enforce_rules()
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
  -- Audit 2026-11-22: a package on sale on Shopify is taken off first, so
  -- archiving never leaves it buying there (the Admin hides its button).
  if tg_op = 'UPDATE' and new.archived_at is not null and old.archived_at is null
     and new.publish_online then
    raise exception using errcode = 'P0001', message = 'build_package_online',
      detail = 'Take the package off Shopify before archiving it.';
  end if;
  return new;
end;
$$;

