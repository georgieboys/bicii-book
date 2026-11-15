-- D240 (amends D162a): a purchase order that was cancelled before anything
-- arrived, and a job part request that was cancelled or declined, are not
-- trading history. The owner entered the 2026-11-14 shipment as PO-000001,
-- then said the goods are his own, consigned to the shop; with the PO
-- cancelled, reclassify_as_consignment must accept its products. A
-- receipt line, a PO that is still open, partly or fully received, and any
-- live part request still refuse (product_has_trading_history), as before.

create or replace function public.reclassify_as_consignment(
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
     or exists (
       select 1 from public.purchase_order_lines pl
       join public.purchase_orders po on po.id = pl.purchase_order_id
       where pl.product_id = prod.id and po.status <> 'cancelled'
     )
     or exists (select 1 from public.purchase_receipt_lines rl where rl.product_id = prod.id)
     or exists (select 1 from public.supplier_products sp where sp.product_id = prod.id)
     or exists (
       select 1 from public.job_part_requests jr
       where jr.product_id = prod.id and jr.status not in ('cancelled', 'declined')
     )
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
