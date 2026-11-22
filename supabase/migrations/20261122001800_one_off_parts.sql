set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D264 (the owner, 2026-11-22: "add ad hoc parts, shop owned or consignment,
-- on the job ... I do not want to have to go add everything on a separate
-- page"): a one-off part is created and put on an open job in one step.
--
--   add_one_off_part creates a quantity-tracked product named for the part,
--   takes the quantity into stock at the location and adds it to the job as
--   an ordinary part line, all in one transaction:
--     - the shop's: a shop-owned product at its price and cost, taken in
--       with a stock adjustment ("One-off item for J-…"), the same rights as
--       New product and Adjust stock (manage_inventory, adjust_stock; a cost
--       needs view_costs);
--     - consigned: a consignment item for the consignor at the agreed amount
--       owed and the price as asking price (create_consignment_item, so
--       manage_consignments), owed when the job is completed (D44).
--   The line is then add_inventory_line's own, so stock, yield, Cult Commons,
--   consignor liability and revenue follow the existing rules. On a build it
--   may be charged on top (D261). Replay-safe by line id.

create type public.one_off_part_result as (
  line_id uuid,
  product_id uuid,
  product_short_id text,
  replayed boolean
);

comment on type public.one_off_part_result is
  'D264: the job line a one-off part became, its new product and whether the call was a replay.';

create function public.add_one_off_part(
  line_id uuid,
  work_order_id uuid,
  name text,
  quantity integer,
  unit_sale_price public.money_amount,
  consigned boolean,
  consignor_id uuid default null,
  agreed_amount_owed public.money_amount default null,
  unit_direct_cost public.money_amount default null,
  location_id uuid default null,
  build_extra boolean default false
)
returns public.one_off_part_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  existing public.work_order_line_items;
  clean_name text := nullif(pg_catalog.btrim(coalesce(add_one_off_part.name, '')), '');
  loc uuid := add_one_off_part.location_id;
  new_product uuid := gen_random_uuid();
  item public.consignment_item_result;
  prod public.products;
  result public.one_off_part_result;
begin
  if add_one_off_part.line_id is null or add_one_off_part.work_order_id is null
     or add_one_off_part.quantity is null or add_one_off_part.unit_sale_price is null
     or add_one_off_part.consigned is null then
    raise exception 'line_id, work_order_id, quantity, unit_sale_price and consigned are required'
      using errcode = '22004';
  end if;

  -- The job first (the lock order add_inventory_line keeps), then a replay.
  wo := private.lock_work_order(add_one_off_part.work_order_id);
  select li.* into existing from public.work_order_line_items li where li.id = add_one_off_part.line_id;
  if found then
    -- A replay is the same part line; anything else reusing the id is a clash.
    if existing.work_order_id <> wo.id or existing.line_type <> 'inventory'
       or existing.quantity <> add_one_off_part.quantity then
      raise exception using errcode = 'P0001', message = 'line_conflict',
        detail = 'That line id is already used for another line.';
    end if;
    select p.* into prod from public.products p where p.id = existing.source_product_id;
    result := row(existing.id, prod.id, prod.short_id, true);
    return result;
  end if;
  perform private.require_open_work_order(wo.id);

  if clean_name is null or pg_catalog.char_length(clean_name) > 200 then
    raise exception using errcode = 'P0001', message = 'one_off_name_required',
      detail = 'Name the part (up to 200 characters).';
  end if;
  if add_one_off_part.quantity < 1 or add_one_off_part.quantity > 999 then
    raise exception using errcode = 'P0001', message = 'quantity_invalid', detail = 'Add between 1 and 999.';
  end if;
  if loc is null then
    select l.id into loc from public.locations l where l.active order by l.sort_order, l.name limit 1;
    if loc is null then
      raise exception using errcode = 'P0001', message = 'location_required',
        detail = 'There is no active stock location; add one first.';
    end if;
  end if;

  if add_one_off_part.consigned then
    if add_one_off_part.consignor_id is null or add_one_off_part.agreed_amount_owed is null then
      raise exception using errcode = 'P0001', message = 'one_off_consignor_required',
        detail = 'Choose whose it is and what they are owed for each.';
    end if;
    -- manage_consignments, the consignor's checks and the movement are its own.
    item := public.create_consignment_item(
      item_id => gen_random_uuid(),
      consignor_id => add_one_off_part.consignor_id,
      location_id => loc,
      agreed_amount_owed => add_one_off_part.agreed_amount_owed,
      asking_price => add_one_off_part.unit_sale_price,
      product_name => clean_name,
      tracking_type => 'quantity',
      quantity => add_one_off_part.quantity,
      internal_notes => 'One-off item for ' || wo.job_number,
      new_product_id => new_product
    );
    new_product := item.product_id;
  else
    perform private.require_permission('manage_inventory');
    if add_one_off_part.unit_direct_cost is null then
      raise exception using errcode = 'P0001', message = 'one_off_cost_required',
        detail = 'Enter what each cost the shop (0 when nothing).';
    end if;
    if not private.has_permission('view_costs') then
      raise exception 'permission view_costs required to set a cost' using errcode = '42501';
    end if;
    insert into public.products (
      id, name, tracking_type, ownership_type, publication_status, default_sale_price,
      default_direct_cost, currency
    )
    values (
      new_product, clean_name, 'quantity', 'shop_owned', 'draft', add_one_off_part.unit_sale_price,
      add_one_off_part.unit_direct_cost, wo.currency
    );
    -- adjust_stock checks adjust_stock (and view_costs for the cost).
    perform public.adjust_stock(
      gen_random_uuid(), new_product, loc, add_one_off_part.quantity, 'stock_adjustment',
      'One-off item for ' || wo.job_number, add_one_off_part.unit_direct_cost
    );
  end if;

  perform public.add_inventory_line(
    add_one_off_part.line_id, wo.id, new_product, add_one_off_part.quantity, loc, null,
    add_one_off_part.unit_sale_price
  );
  if add_one_off_part.build_extra then
    perform public.set_build_line_extra(add_one_off_part.line_id, true);
  end if;

  select p.* into prod from public.products p where p.id = new_product;
  result := row(add_one_off_part.line_id, prod.id, prod.short_id, false);
  return result;
end;
$$;

comment on function public.add_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid, boolean
) is
  'D264: active staff with the rights of the separate pages: create a one-off part (a quantity product named for it), take the quantity into stock at the location (the shop''s: manage_inventory and adjust_stock, a cost needs view_costs; consigned: create_consignment_item, manage_consignments) and add it to the open job as an ordinary part line (add_inventory_line), optionally charged on top of a build (D261). Replay-safe by line id.';

revoke all on function public.add_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.add_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid, boolean
) to authenticated;
