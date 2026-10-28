-- Reclassifying shop stock entered by mistake as consigned stock (PLAN D162,
-- the owner's request of 2026-10-28 SGT; ADR-016 amendment "D162";
-- DATA-MODEL §9 "Reclassifying shop stock", §16).
--
-- On 2026-10-28 an admin entered 25 products the owner had consigned to the
-- shop as ordinary shop-owned products, counted their stock in with stock
-- adjustments and printed their labels. D45 keeps a product's owner fixed
-- once it has stock history, so the only route was to count the stock out,
-- archive the products and take everything in again on new products, with
-- new P- numbers and new labels. This file adds the narrow correction
-- instead:
--
--   public.reclassify_as_consignment(item_id, product_id, consignor_id,
--       agreed_amount_owed, reason, asking_price, received_at)
--     Admin only. For a shop-owned, quantity-tracked, active product whose
--     only history is stock counts (stock_adjustment, damaged, transfer
--     movements) and that nothing else refers to (no sale line, job line,
--     purchase order or receipt line, supplier link, indent request or
--     Shopify sync row; print jobs and photos are fine), with its stock at
--     one location: counts the stock out with one stock_adjustment
--     ("Reclassified as consigned stock: " + reason), changes the product's
--     owner to consignment, and takes the same quantity in through
--     public.create_consignment_item on the same product (item_id, the
--     consignor, the agreed amount per unit, asking price defaulting to the
--     product's price, the intake date). The product keeps its id, P-
--     number and labels. With no stock, only the owner changes and no item
--     is created. Replays by item_id.
--   private.products_ownership_rules
--     Replaced: still refuses an owner change once a product has a unit or
--     a movement (D45), except shop_owned -> consignment inside
--     reclassify_as_consignment, which sets the transaction-local
--     bicii.reclassify_product to the product id after counting its stock
--     out (net on-hand 0 is checked here too).
--
-- Not a change to consignment semantics: from the intake on, the product is
-- ordinary consigned stock (D44, D45, D46, D50). The shop's earlier stock
-- counts stay in the ledger with the stock adjustment that offsets them.

-- ---------------------------------------------------------------------------
-- products: D45 with its one exception.
-- ---------------------------------------------------------------------------
create or replace function private.products_ownership_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.ownership_type is distinct from old.ownership_type
     and (
       exists (select 1 from public.inventory_units u where u.product_id = new.id)
       or exists (select 1 from public.inventory_movements m where m.product_id = new.id)
     ) then
    -- D162: reclassify_as_consignment, after counting the stock out.
    if old.ownership_type = 'shop_owned' and new.ownership_type = 'consignment'
       and coalesce(pg_catalog.current_setting('bicii.reclassify_product', true), '') = new.id::text
       and not exists (select 1 from public.inventory_units u where u.product_id = new.id)
       and (
         select coalesce(sum(m.quantity_delta), 0) from public.inventory_movements m where m.product_id = new.id
       ) = 0 then
      return new;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'product_ownership_immutable',
      detail = 'A product with stock history keeps its owner; consigned stock lives on its own products.';
  end if;
  return new;
end;
$$;

comment on function private.products_ownership_rules() is
  'D45: a product''s ownership_type never changes once it has a unit or a movement, except shop_owned -> consignment inside reclassify_as_consignment (D162), with its stock counted out first.';

-- ---------------------------------------------------------------------------
-- reclassify_as_consignment
-- ---------------------------------------------------------------------------
create type public.reclassify_result as (
  product_id uuid,
  consignment_item_id uuid,
  consignment_item_short_id text,
  quantity integer,
  location_id uuid
);

create function public.reclassify_as_consignment(
  item_id uuid,
  product_id uuid,
  consignor_id uuid,
  agreed_amount_owed public.money_amount,
  reason text,
  asking_price public.money_amount default null,
  received_at timestamptz default null
)
returns public.reclassify_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  cleaned text := nullif(pg_catalog.btrim(coalesce(reclassify_as_consignment.reason, '')), '');
  existing public.consignment_items;
  prod public.products;
  consignor_archived timestamptz;
  stock_locations integer;
  stock_location uuid;
  stock_quantity integer;
  created public.consignment_item_result;
  result public.reclassify_result;
begin
  -- (a) Shape.
  if reclassify_as_consignment.item_id is null or reclassify_as_consignment.product_id is null
     or reclassify_as_consignment.consignor_id is null or reclassify_as_consignment.agreed_amount_owed is null then
    raise exception 'item_id, product_id, consignor_id and agreed_amount_owed are required' using errcode = '22004';
  end if;
  if cleaned is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why this stock is being reclassified.';
  end if;
  -- The stock adjustment's reason is "Reclassified as consigned stock: "
  -- (33 characters) + this, under the ledger's 500.
  if pg_catalog.char_length(cleaned) > 460 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 460 characters.';
  end if;

  -- (b) The intake's own lock (lock order 0, as create_consignment_item
  -- takes it), then the replay by item id.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bicii.consignment_item:' || reclassify_as_consignment.item_id::text, 0)
  );
  select i.* into existing from public.consignment_items i where i.id = reclassify_as_consignment.item_id;
  if found then
    if existing.product_id = reclassify_as_consignment.product_id
       and existing.consignor_id = reclassify_as_consignment.consignor_id then
      result.product_id := existing.product_id;
      result.consignment_item_id := existing.id;
      result.consignment_item_short_id := existing.short_id;
      result.quantity := existing.quantity;
      result.location_id := (
        select m.location_id from public.inventory_movements m
        where m.consignment_item_id = existing.id and m.movement_type = 'consignment_received'
        order by m.id limit 1
      );
      return result;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'consignment_item_conflict',
      detail = 'That consignment item id is already used for another intake.';
  end if;

  -- (c) The consignor FOR SHARE (lock order 0b, before the stock lock, as
  -- the intake orders them).
  select c.archived_at into consignor_archived
  from public.consignors c where c.id = reclassify_as_consignment.consignor_id
  for share;
  if not found then
    raise exception 'consignor % not found', reclassify_as_consignment.consignor_id using errcode = 'P0002';
  end if;
  if consignor_archived is not null then
    raise exception using
      errcode = 'P0001',
      message = 'consignor_archived',
      detail = 'That consignor is archived; unarchive them first.';
  end if;

  -- (d) The stock lock (lock order 3), then the product under it.
  perform private.lock_stock(reclassify_as_consignment.product_id);
  select p.* into prod from public.products p where p.id = reclassify_as_consignment.product_id for update;
  if not found then
    raise exception 'product % not found', reclassify_as_consignment.product_id using errcode = 'P0002';
  end if;
  if prod.ownership_type <> 'shop_owned' then
    raise exception using
      errcode = 'P0001',
      message = 'product_not_shop_owned',
      detail = 'Only shop stock can be reclassified as consigned stock.';
  end if;
  if prod.tracking_type <> 'quantity' then
    raise exception using
      errcode = 'P0001',
      message = 'reclassify_not_quantity',
      detail = 'Only stock counted by quantity can be reclassified; a unique item is taken in again.';
  end if;
  if prod.archived_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'product_archived',
      detail = 'That product is archived; unarchive it first.';
  end if;
  if not prod.active then
    raise exception using
      errcode = 'P0001',
      message = 'product_inactive',
      detail = 'That product is inactive.';
  end if;
  if exists (
       select 1 from public.inventory_movements m
       where m.product_id = prod.id and m.movement_type not in ('stock_adjustment', 'damaged', 'transfer')
     )
     or exists (select 1 from public.inventory_units u where u.product_id = prod.id)
     or exists (select 1 from public.sale_lines sl where sl.product_id = prod.id)
     or exists (select 1 from public.work_order_line_items wl where wl.source_product_id = prod.id)
     or exists (select 1 from public.purchase_order_lines pl where pl.product_id = prod.id)
     or exists (select 1 from public.purchase_receipt_lines rl where rl.product_id = prod.id)
     or exists (select 1 from public.supplier_products sp where sp.product_id = prod.id)
     or exists (select 1 from public.job_part_requests jr where jr.product_id = prod.id)
     or exists (select 1 from public.shopify_product_sync ss where ss.product_id = prod.id)
     or prod.shopify_variant_id is not null or prod.shopify_product_id is not null then
    raise exception using
      errcode = 'P0001',
      message = 'product_has_trading_history',
      detail = 'This product has been sold, used, bought or linked; only stock that was only ever counted can be reclassified.';
  end if;

  -- Its stock, which must be at one location.
  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(s.location_id))[1], (pg_catalog.array_agg(s.on_hand))[1]
    into stock_locations, stock_location, stock_quantity
  from (
    select m.location_id, sum(m.quantity_delta)::integer as on_hand
    from public.inventory_movements m
    where m.product_id = prod.id
    group by m.location_id
    having sum(m.quantity_delta) <> 0
  ) s;
  if stock_locations > 1 then
    raise exception using
      errcode = 'P0001',
      message = 'reclassify_several_locations',
      detail = 'Move this stock to one location first.';
  end if;

  perform pg_catalog.set_config('app.change_reason', cleaned, true);

  -- (e) Count the shop's stock out (as adjust_stock writes it), change the
  -- owner, take the same quantity in.
  if stock_locations = 1 then
    perform private.record_movement(
      prod.id, null, stock_location, -stock_quantity, 'stock_adjustment',
      'Reclassified as consigned stock: ' || cleaned, prod.default_direct_cost,
      pg_catalog.md5('bicii.reclassify:' || reclassify_as_consignment.item_id::text)::uuid,
      null, null, null
    );
  end if;
  perform pg_catalog.set_config('bicii.reclassify_product', prod.id::text, true);
  update public.products p set ownership_type = 'consignment' where p.id = prod.id;
  perform pg_catalog.set_config('bicii.reclassify_product', '', true);

  result.product_id := prod.id;
  result.quantity := coalesce(stock_quantity, 0);
  if stock_locations = 1 then
    created := public.create_consignment_item(
      item_id => reclassify_as_consignment.item_id,
      consignor_id => reclassify_as_consignment.consignor_id,
      location_id => stock_location,
      agreed_amount_owed => reclassify_as_consignment.agreed_amount_owed,
      asking_price => coalesce(reclassify_as_consignment.asking_price, prod.default_sale_price),
      product_id => prod.id,
      tracking_type => 'quantity',
      quantity => stock_quantity,
      received_at => reclassify_as_consignment.received_at,
      internal_notes => 'Reclassified from shop stock: ' || cleaned
    );
    result.consignment_item_id := created.item_id;
    result.consignment_item_short_id := created.short_id;
    result.location_id := stock_location;
  end if;
  return result;
end;
$$;

comment on function public.reclassify_as_consignment(
  uuid, uuid, uuid, public.money_amount, text, public.money_amount, timestamptz
) is
  'D162 (admin only): shop stock entered by mistake becomes consigned stock on the same product (P- number and labels kept). Only a shop-owned, active quantity product whose history is stock counts alone, at one location. Counts the stock out, changes the owner, takes it in through create_consignment_item. Replays by item_id.';

revoke all on function
  public.reclassify_as_consignment(uuid, uuid, uuid, public.money_amount, text, public.money_amount, timestamptz)
from public, anon, authenticated, service_role;

-- Any signed-in caller; require_admin() inside refuses everyone else (42501).
grant execute on function
  public.reclassify_as_consignment(uuid, uuid, uuid, public.money_amount, text, public.money_amount, timestamptz)
to authenticated;
