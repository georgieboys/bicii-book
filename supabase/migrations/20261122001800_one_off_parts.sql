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
--
-- D265 (the owner, 2026-11-22: "the one off part needs to be there when i
-- propose parts as well"; amends D62/D140 for quotes): a part already in
-- the shop on consignment can be proposed on a job's quote like a
-- shop-owned one. It is never ordered (set_purchase_order_line refuses
-- anything but shop stock); once approved, Fit takes it from stock with
-- add_inventory_line, so the consignor is owed when the job is completed.
-- propose_one_off_part makes a new one-off item (as above) and proposes it
-- in the same transaction.

create type public.one_off_part_result as (
  line_id uuid,
  product_id uuid,
  product_short_id text,
  replayed boolean
);

comment on type public.one_off_part_result is
  'D264: the job line a one-off part became, its new product and whether the call was a replay.';

-- ---------------------------------------------------------------------------
-- The stock-taking both one-off paths share (D264)
-- ---------------------------------------------------------------------------
create function private.create_one_off_stock(
  wo public.work_orders,
  name text,
  quantity integer,
  unit_sale_price public.money_amount,
  consigned boolean,
  consignor_id uuid,
  agreed_amount_owed public.money_amount,
  unit_direct_cost public.money_amount,
  location_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_name text := nullif(pg_catalog.btrim(coalesce(create_one_off_stock.name, '')), '');
  loc uuid := create_one_off_stock.location_id;
  new_product uuid := gen_random_uuid();
  item public.consignment_item_result;
begin
  if clean_name is null or pg_catalog.char_length(clean_name) > 200 then
    raise exception using errcode = 'P0001', message = 'one_off_name_required',
      detail = 'Name the part (up to 200 characters).';
  end if;
  if create_one_off_stock.quantity is null or create_one_off_stock.quantity < 1
     or create_one_off_stock.quantity > 999 then
    raise exception using errcode = 'P0001', message = 'quantity_invalid', detail = 'Add between 1 and 999.';
  end if;
  if create_one_off_stock.unit_sale_price is null then
    raise exception using errcode = 'P0001', message = 'part_price_missing', detail = 'Enter a price.';
  end if;
  if loc is null then
    select l.id into loc from public.locations l where l.active order by l.sort_order, l.name limit 1;
    if loc is null then
      raise exception using errcode = 'P0001', message = 'location_required',
        detail = 'There is no active stock location; add one first.';
    end if;
  end if;

  if create_one_off_stock.consigned then
    if create_one_off_stock.consignor_id is null or create_one_off_stock.agreed_amount_owed is null then
      raise exception using errcode = 'P0001', message = 'one_off_consignor_required',
        detail = 'Choose whose it is and what they are owed for each.';
    end if;
    -- manage_consignments, the consignor's checks and the movement are its own.
    item := public.create_consignment_item(
      item_id => gen_random_uuid(),
      consignor_id => create_one_off_stock.consignor_id,
      location_id => loc,
      agreed_amount_owed => create_one_off_stock.agreed_amount_owed,
      asking_price => create_one_off_stock.unit_sale_price,
      product_name => clean_name,
      tracking_type => 'quantity',
      quantity => create_one_off_stock.quantity,
      internal_notes => 'One-off item for ' || create_one_off_stock.wo.job_number,
      new_product_id => new_product
    );
    return item.product_id;
  end if;

  perform private.require_permission('manage_inventory');
  if create_one_off_stock.unit_direct_cost is null then
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
    new_product, clean_name, 'quantity', 'shop_owned', 'draft', create_one_off_stock.unit_sale_price,
    create_one_off_stock.unit_direct_cost, create_one_off_stock.wo.currency
  );
  -- adjust_stock checks adjust_stock (and view_costs for the cost).
  perform public.adjust_stock(
    gen_random_uuid(), new_product, loc, create_one_off_stock.quantity, 'stock_adjustment',
    'One-off item for ' || create_one_off_stock.wo.job_number, create_one_off_stock.unit_direct_cost
  );
  return new_product;
end;
$$;

comment on function private.create_one_off_stock(
  public.work_orders, text, integer, public.money_amount, boolean, uuid, public.money_amount,
  public.money_amount, uuid
) is
  'D264: make a one-off part''s product and take its quantity into stock at the location (or the first active one): consigned through create_consignment_item, the shop''s as a draft shop-owned product and an adjust_stock. Returns the product id. Used by add_one_off_part and propose_one_off_part.';

revoke all on function private.create_one_off_stock(
  public.work_orders, text, integer, public.money_amount, boolean, uuid, public.money_amount,
  public.money_amount, uuid
) from public, anon, authenticated, service_role;

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
  loc uuid := add_one_off_part.location_id;
  new_product uuid;
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

  new_product := private.create_one_off_stock(
    wo, add_one_off_part.name, add_one_off_part.quantity, add_one_off_part.unit_sale_price,
    add_one_off_part.consigned, add_one_off_part.consignor_id, add_one_off_part.agreed_amount_owed,
    add_one_off_part.unit_direct_cost, add_one_off_part.location_id
  );
  if add_one_off_part.location_id is null then
    select l.id into loc from public.locations l where l.active order by l.sort_order, l.name limit 1;
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

-- ---------------------------------------------------------------------------
-- D265: consigned stock on a quote, and a new one-off item proposed
-- ---------------------------------------------------------------------------
create or replace function public.propose_part(
  request_id uuid,
  work_order_id uuid,
  product_id uuid,
  quantity integer default 1,
  unit_sale_price public.money_amount default null,
  expected_unit_cost public.money_amount default null,
  supplier_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  existing public.job_part_requests;
  prod public.products;
  price public.money_amount;
begin
  if propose_part.request_id is null or propose_part.work_order_id is null
     or propose_part.product_id is null or propose_part.quantity is null then
    raise exception 'request_id, work_order_id, product_id and quantity are required' using errcode = '22004';
  end if;

  wo := private.lock_work_order(propose_part.work_order_id);
  select r.* into existing from public.job_part_requests r where r.id = propose_part.request_id;
  if found then
    if existing.work_order_id <> wo.id or existing.kind <> 'part'
       or existing.product_id is distinct from propose_part.product_id then
      raise exception using
        errcode = 'P0001',
        message = 'part_request_conflict',
        detail = 'That request id is already used for another item.';
    end if;
    return existing.id;
  end if;
  perform private.require_open_work_order(wo.id);

  if propose_part.quantity < 1 or propose_part.quantity > 999 then
    raise exception using
      errcode = 'P0001',
      message = 'quantity_invalid',
      detail = 'Add between 1 and 999.';
  end if;
  select p.* into prod from public.products p where p.id = propose_part.product_id;
  if not found then
    raise exception 'product % not found', propose_part.product_id using errcode = 'P0002';
  end if;
  if prod.archived_at is not null then
    raise exception using errcode = 'P0001', message = 'product_archived', detail = 'That product is archived.';
  end if;
  if not prod.active then
    raise exception using errcode = 'P0001', message = 'product_inactive', detail = 'That product is inactive.';
  end if;
  -- D62: what a purchase order can order; D265: or consigned stock, which
  -- is quoted and fitted from stock but never ordered.
  if prod.tracking_type <> 'quantity' or prod.ownership_type not in ('shop_owned', 'consignment') then
    raise exception using
      errcode = 'P0001',
      message = 'indent_product_invalid',
      detail = 'Only products counted by quantity, the shop''s or consigned, can be proposed for a job.';
  end if;
  if prod.currency <> wo.currency then
    raise exception using
      errcode = 'P0001',
      message = 'currency_mismatch',
      detail = 'That product is priced in another currency than the job.';
  end if;

  price := coalesce(propose_part.unit_sale_price, private.selling_price(prod.id, null));
  if price is null then
    raise exception using
      errcode = 'P0001',
      message = 'part_price_missing',
      detail = 'Set a price for this part before proposing it.';
  end if;
  if price < 0 then
    raise exception using errcode = 'P0001', message = 'price_invalid', detail = 'A price cannot be negative.';
  end if;

  if (propose_part.expected_unit_cost is not null or propose_part.supplier_id is not null)
     and not private.can_view_purchase_costs() then
    raise exception 'permission view_costs or manage_purchasing required to set a cost or supplier'
      using errcode = '42501';
  end if;
  if propose_part.expected_unit_cost is not null and propose_part.expected_unit_cost < 0 then
    raise exception using errcode = 'P0001', message = 'cost_invalid', detail = 'A cost cannot be negative.';
  end if;
  if propose_part.supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = propose_part.supplier_id and s.archived_at is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'supplier_unavailable',
      detail = 'That supplier does not exist or is archived.';
  end if;

  insert into public.job_part_requests (
    id, work_order_id, kind, product_id, description, quantity, unit_sale_price, currency,
    expected_unit_cost, supplier_id, created_by
  ) values (
    propose_part.request_id, wo.id, 'part', prod.id, prod.name, propose_part.quantity, price, wo.currency,
    propose_part.expected_unit_cost, propose_part.supplier_id, actor
  );
  perform private.record_work_order_event(
    wo.id,
    'part_requested',
    pg_catalog.jsonb_build_object(
      'request_id', propose_part.request_id, 'kind', 'part', 'description', prod.name,
      'quantity', propose_part.quantity
    )
  );
  return propose_part.request_id;
end;
$$;


comment on function public.propose_part(uuid, uuid, uuid, integer, public.money_amount, public.money_amount, uuid) is
  'D140, D265: active staff propose an indent part on an open job (no movement, no line): a shop-owned product (ordered from a supplier) or consigned stock (quoted, then fitted from stock; never ordered); cost and supplier need view_costs or manage_purchasing; replay-safe.';

create function public.propose_one_off_part(
  request_id uuid,
  work_order_id uuid,
  name text,
  quantity integer,
  unit_sale_price public.money_amount,
  consigned boolean,
  consignor_id uuid default null,
  agreed_amount_owed public.money_amount default null,
  unit_direct_cost public.money_amount default null,
  location_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  existing public.job_part_requests;
  new_product uuid;
begin
  if propose_one_off_part.request_id is null or propose_one_off_part.work_order_id is null
     or propose_one_off_part.consigned is null then
    raise exception 'request_id, work_order_id and consigned are required' using errcode = '22004';
  end if;
  wo := private.lock_work_order(propose_one_off_part.work_order_id);
  -- A replay returns the request before anything is made again.
  select r.* into existing from public.job_part_requests r where r.id = propose_one_off_part.request_id;
  if found then
    if existing.work_order_id <> wo.id or existing.kind <> 'part'
       or existing.quantity <> propose_one_off_part.quantity then
      raise exception using errcode = 'P0001', message = 'part_request_conflict',
        detail = 'That request id is already used for another item.';
    end if;
    return existing.id;
  end if;
  perform private.require_open_work_order(wo.id);
  new_product := private.create_one_off_stock(
    wo, propose_one_off_part.name, propose_one_off_part.quantity, propose_one_off_part.unit_sale_price,
    propose_one_off_part.consigned, propose_one_off_part.consignor_id,
    propose_one_off_part.agreed_amount_owed, propose_one_off_part.unit_direct_cost,
    propose_one_off_part.location_id
  );
  return public.propose_part(
    propose_one_off_part.request_id, wo.id, new_product, propose_one_off_part.quantity,
    propose_one_off_part.unit_sale_price
  );
end;
$$;

comment on function public.propose_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid
) is
  'D264, D265: active staff with the rights of the separate pages: make a one-off part (private.create_one_off_stock: consigned or the shop''s, taken into stock) and propose it on the open job''s quote (propose_part). Once approved, Fit takes it from stock. Replay-safe by request id.';

revoke all on function public.propose_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.propose_one_off_part(
  uuid, uuid, text, integer, public.money_amount, boolean, uuid, public.money_amount, public.money_amount, uuid
) to authenticated;
