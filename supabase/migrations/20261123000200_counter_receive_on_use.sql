set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D267 AT THE COUNTER (the owner, 2026-11-23: operators finish what they
-- are doing in place; the software does the missing step or records it for
-- a manager to tidy later). A counter sale of a consigned quantity item
-- BICII holds too little of at that location is recorded anyway: what the
-- named consignment and then the oldest consignments hold there is sold
-- first (one sale line per consignment, D54), and the rest is received
-- from the consignor at that moment (private.receive_for_use, flagged
-- received_on_use for a manager to check, D268 terms) and sold, in one
-- transaction. Consigned stock still never goes below zero.
--
--   private.receive_for_use   re-created with received_at (default now):
--                             a backdated sale ("Sold earlier?") receives
--                             at the sale's time, so D55 holds.
--   public.record_retail_sale re-created: step (5) splits and receives.
--                             A line one consignment covers, shop-owned
--                             stock (never below zero for a sale; D23 is
--                             for job parts) and units are sold exactly as
--                             before. Replay-safe as before: the header row
--                             and the fingerprint of the caller's lines.
--   public.saleable_stock     re-created: also offers a consigned quantity
--                             product with no consignment stock anywhere,
--                             at the default location, on hand 0.
--
-- Lock order: as in add_part_lines, receive_for_use takes the consignor
-- FOR SHARE (0b) after the product's stock lock (3); it waits only on a
-- consignor being archived. Shopify sales (process_shopify_order_paid) are
-- untouched.

-- ---------------------------------------------------------------------------
-- The intake at the moment of use, at a given time
-- ---------------------------------------------------------------------------
drop function private.receive_for_use(public.products, uuid, integer, public.money_amount, text);

create function private.receive_for_use(
  prod public.products,
  location_id uuid,
  quantity integer,
  unit_sale_price public.money_amount,
  job_number text,
  received_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  last_item public.consignment_items;
  chosen_consignor uuid;
  consignor_archived timestamptz;
  agreed public.money_amount;
  asking public.money_amount;
  new_item uuid := gen_random_uuid();
  -- A backdated sale's own time; never in the future.
  at_time timestamptz := least(coalesce(receive_for_use.received_at, pg_catalog.now()), pg_catalog.now());
begin
  -- The product's latest consignment gives its consignor and terms.
  select i.* into last_item
  from public.consignment_items i
  join public.consignors c on c.id = i.consignor_id
  where i.product_id = prod.id and c.archived_at is null
  order by i.received_at desc, i.short_id desc
  limit 1;
  chosen_consignor := last_item.consignor_id;
  if chosen_consignor is null then
    -- Never consigned before: the consignor with the most items (the owner).
    select c.id into chosen_consignor
    from public.consignors c
    left join public.consignment_items i on i.consignor_id = c.id
    where c.archived_at is null
    group by c.id
    order by count(i.id) desc, c.created_at
    limit 1;
  end if;
  if chosen_consignor is null then
    raise exception using errcode = 'P0001', message = 'consignor_required',
      detail = 'No consignor is set up yet; add one under Consignment.';
  end if;
  -- Lock order 0b (as create_consignment_item): archiving waits.
  select c.archived_at into consignor_archived
  from public.consignors c where c.id = chosen_consignor for share;

  asking := coalesce(receive_for_use.unit_sale_price, last_item.asking_price, prod.default_sale_price);
  -- D268: the last agreed amount, else half the price, else nothing.
  agreed := coalesce(
    last_item.agreed_amount_owed,
    pg_catalog.round(coalesce(asking, 0) * 0.5, 2)
  );

  insert into public.consignment_items (
    id, consignor_id, product_id, quantity, received_at, agreed_amount_owed, asking_price, currency,
    internal_notes, request_fingerprint, received_on_use
  )
  values (
    new_item, chosen_consignor, prod.id, receive_for_use.quantity, at_time, agreed, asking,
    prod.currency, 'Received on use for ' || coalesce(receive_for_use.job_number, 'a job'),
    pg_catalog.md5('receive_for_use:' || new_item::text), true
  );
  perform private.record_linked_movement(
    prod.id, null, receive_for_use.location_id, receive_for_use.quantity, 'consignment_received', null,
    agreed, new_item, null, null, null, null, new_item
  );
  return new_item;
end;
$$;

comment on function private.receive_for_use(public.products, uuid, integer, public.money_amount, text, timestamptz) is
  'D267/D268: take in a consigned quantity at the moment of use (a job part, or a counter sale: job_number is then "counter sale S-..."), from the product''s latest consignor (else the consignor with the most items) at its last agreed amount (else half the price), flagged received_on_use, received at received_at (default now, never later than now). The caller holds the stock locks.';

revoke all on function private.receive_for_use(public.products, uuid, integer, public.money_amount, text, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- record_retail_sale: 20261004003500_sales.sql's body, except step (5)
-- ---------------------------------------------------------------------------
create or replace function public.record_retail_sale(
  sale_id uuid,
  lines jsonb,
  customer_id uuid default null,
  recognized_at timestamptz default null,
  notes text default null
)
returns public.sale_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  fingerprint text;
  sale public.sales;
  customer_archived timestamptz;
  pid uuid;
  line_index integer := 0;
  element jsonb;
  result public.sale_result;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
  -- D267: a consigned quantity line BICII holds too little of.
  prod public.products;
  loc uuid;
  loc_active boolean;
  qty integer;
  named uuid;
  avail integer;
  remaining integer;
  take integer;
  piece record;
  base jsonb;
  new_item uuid;
begin
  -- (1) Shape.
  if record_retail_sale.sale_id is null then
    raise exception 'sale_id is required' using errcode = '22004';
  end if;
  if record_retail_sale.lines is null or pg_catalog.jsonb_typeof(record_retail_sale.lines) <> 'array'
     or pg_catalog.jsonb_array_length(record_retail_sale.lines) = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'sale_lines_required',
      detail = 'Add at least one item to the sale.';
  end if;
  if pg_catalog.jsonb_array_length(record_retail_sale.lines) > 50 then
    raise exception using
      errcode = 'P0001',
      message = 'sale_too_many_lines',
      detail = 'A sale holds at most 50 lines; record the rest as another sale.';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
    where (e.l ->> 'inventory_unit_id') is not null
    group by (e.l ->> 'inventory_unit_id')::uuid
    having count(*) > 1
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'sale_duplicate_unit',
      detail = 'The same unit is on the sale twice.';
  end if;
  -- A Shopify line id is written only by Phase 10's ingestion through
  -- private.sell_line: an in-store sale never claims one.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
    where pg_catalog.jsonb_typeof(e.l) = 'object' and e.l ? 'shopify_line_item_id'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'sale_line_invalid',
      detail = 'In-store sales do not carry Shopify references.';
  end if;
  if record_retail_sale.customer_id is not null and not exists (
    select 1 from public.customers c where c.id = record_retail_sale.customer_id
  ) then
    raise exception 'customer % not found', record_retail_sale.customer_id using errcode = 'P0002';
  end if;
  if record_retail_sale.recognized_at > pg_catalog.now() + interval '5 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'sale_recognized_in_future',
      detail = 'A sale cannot be dated in the future.';
  end if;
  fingerprint := private.sale_request_fingerprint(
    record_retail_sale.lines, record_retail_sale.customer_id, record_retail_sale.recognized_at,
    record_retail_sale.notes
  );

  -- (2) Idempotency: the request's own row (lock order 0). A concurrent
  -- replay waits on this insert and then finds the committed sale.
  begin
    insert into public.sales as s (
      id, source, customer_id, recognized_at, currency, notes, request_fingerprint, created_by
    )
    values (
      record_retail_sale.sale_id, 'retail', record_retail_sale.customer_id,
      coalesce(record_retail_sale.recognized_at, pg_catalog.now()), private.shop_currency(),
      record_retail_sale.notes, fingerprint, actor
    )
    on conflict (id) do nothing
    returning s.* into sale;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  if sale.id is null then
    select s.* into sale from public.sales s where s.id = record_retail_sale.sale_id;
    if sale.request_fingerprint is not distinct from fingerprint and sale.source = 'retail' then
      result := row(sale.id, sale.sale_number, sale.status, sale.recognized_at, true);
      return result;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'sale_conflict',
      detail = 'That sale id is already used for another sale.';
  end if;

  -- (3) State.
  if record_retail_sale.customer_id is not null then
    select c.archived_at into customer_archived from public.customers c where c.id = record_retail_sale.customer_id;
    if customer_archived is not null then
      raise exception using
        errcode = 'P0001',
        message = 'customer_archived',
        detail = 'That customer is archived; unarchive them or sell to a walk-in.';
    end if;
  end if;

  -- (4) Locks, in the global order. Units' products are read without a
  -- lock (immutable); an unknown unit or product is reported by sell_line.
  for pid in
    select distinct x.product_id
    from (
      select (e.l ->> 'product_id')::uuid as product_id
      from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
      union
      select u.product_id
      from public.inventory_units u
      where u.id in (
        select (e.l ->> 'inventory_unit_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
      )
    ) x
    where x.product_id is not null
    order by 1
  loop
    perform private.lock_stock(pid);
  end loop;

  perform 1
  from public.inventory_units u
  where u.id in (
    select (e.l ->> 'inventory_unit_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
  )
  order by u.id
  for update;

  -- Lock order 6: the locked units' items, every active item of each
  -- consigned quantity product on the sale (FIFO reads them) and any item
  -- named.
  perform 1
  from public.consignment_items i
  where i.id in (
      select u.consignment_item_id
      from public.inventory_units u
      where u.id in (
        select (e.l ->> 'inventory_unit_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
      )
    )
    or i.id in (
      select (e.l ->> 'consignment_item_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
    )
    or (
      i.status = 'active'
      and i.product_id in (
        select (e.l ->> 'product_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
      )
    )
  order by i.id
  for update;

  -- (5) The lines, in array order. D267: a consigned quantity line that no
  -- single consignment covers at its location (the named one, else the
  -- FIFO head) is split, one sale line per consignment (D54): the named
  -- item's stock there, then the oldest consignments' there, then what is
  -- still missing is received on use and sold. Everything else, and every
  -- line one consignment covers, goes to sell_line unchanged.
  for element in
    select e.l from pg_catalog.jsonb_array_elements(record_retail_sale.lines) with ordinality e(l, ord) order by e.ord
  loop
    prod := null;
    loc := null;
    loc_active := null;
    qty := null;
    named := null;
    avail := null;
    if pg_catalog.jsonb_typeof(element) = 'object'
       and (element ->> 'product_id') is not null
       and (element ->> 'location_id') is not null
       and pg_catalog.btrim(element ->> 'quantity') ~ '^[0-9]{1,3}$'
       and not exists (
         select 1 from pg_catalog.jsonb_object_keys(element) k
         where k not in ('product_id', 'location_id', 'quantity', 'consignment_item_id', 'unit_sale_price')
       ) then
      select p.* into prod
      from public.products p
      where p.id = (element ->> 'product_id')::uuid
        and p.ownership_type = 'consignment' and p.tracking_type = 'quantity'
        and p.active and p.archived_at is null and p.currency = sale.currency;
      loc := (element ->> 'location_id')::uuid;
      qty := pg_catalog.btrim(element ->> 'quantity')::integer;
      named := (element ->> 'consignment_item_id')::uuid;
      select l.active into loc_active from public.locations l where l.id = loc;
    end if;
    if prod.id is null or qty < 1 or not coalesce(loc_active, false) then
      line_index := line_index + 1;
      perform private.sell_line(sale, line_index, element, 'retail_sale');
      continue;
    end if;

    if named is not null then
      select case when i.status = 'active'
               then least(pos.remaining_qty, private.consignment_item_on_hand(i.id, loc)) end
        into avail
      from public.consignment_items i
      join reporting.consignment_item_position pos on pos.consignment_item_id = i.id
      where i.id = named and i.product_id = prod.id;
      -- Unknown, another product's or no longer with the shop (sell_line
      -- says so), or covering the line: as before.
      if avail is null or avail >= qty then
        line_index := line_index + 1;
        perform private.sell_line(sale, line_index, element, 'retail_sale');
        continue;
      end if;
    elsif exists (
      select 1
      from public.consignment_items i
      join reporting.consignment_item_position pos on pos.consignment_item_id = i.id
      where i.product_id = prod.id and i.status = 'active' and pos.remaining_qty >= qty
        and private.consignment_item_on_hand(i.id, loc) >= qty
    ) then
      -- One consignment covers it: sell_line's FIFO, as before.
      line_index := line_index + 1;
      perform private.sell_line(sale, line_index, element, 'retail_sale');
      continue;
    end if;

    remaining := qty;
    base := element - 'quantity' - 'consignment_item_id';
    if named is not null and avail > 0 then
      line_index := line_index + 1;
      perform private.sell_line(
        sale, line_index, base || pg_catalog.jsonb_build_object('quantity', avail, 'consignment_item_id', named),
        'retail_sale'
      );
      remaining := remaining - avail;
    end if;
    for piece in
      select i.id as item_id,
             least(pos.remaining_qty, private.consignment_item_on_hand(i.id, loc)) as available
      from public.consignment_items i
      join reporting.consignment_item_position pos on pos.consignment_item_id = i.id
      where i.product_id = prod.id and i.status = 'active' and i.id is distinct from named
      order by i.received_at, i.short_id
    loop
      exit when remaining = 0;
      continue when piece.available is null or piece.available < 1;
      take := least(piece.available, remaining);
      line_index := line_index + 1;
      perform private.sell_line(
        sale, line_index,
        base || pg_catalog.jsonb_build_object('quantity', take, 'consignment_item_id', piece.item_id),
        'retail_sale'
      );
      remaining := remaining - take;
    end loop;
    if remaining > 0 then
      -- Received at the sale's own time, so D55 holds for a backdated sale.
      new_item := private.receive_for_use(
        prod, loc, remaining, (element ->> 'unit_sale_price')::public.money_amount,
        'counter sale ' || sale.sale_number, sale.recognized_at
      );
      line_index := line_index + 1;
      perform private.sell_line(
        sale, line_index,
        base || pg_catalog.jsonb_build_object('quantity', remaining, 'consignment_item_id', new_item),
        'retail_sale'
      );
    end if;
  end loop;

  -- (6) Products last (lock order 7): a public unique product with nothing
  -- left in stock becomes sold (D26).
  for pid in
    select distinct u.product_id
    from public.inventory_units u
    where u.id in (
      select (e.l ->> 'inventory_unit_id')::uuid from pg_catalog.jsonb_array_elements(record_retail_sale.lines) e(l)
    )
    order by 1
  loop
    perform private.refresh_unique_publication(pid);
  end loop;

  result := row(sale.id, sale.sale_number, sale.status, sale.recognized_at, false);
  return result;
end;
$$;

comment on function public.record_retail_sale(uuid, jsonb, uuid, timestamptz, text) is
  'Active staff (D48): record an in-store sale of units and quantities (lines snapshot price, cost, rate and consignor payout; one retail_sale movement each; units sold; consigned items follow, D45/D46/D54); a consigned quantity line no one consignment covers is split one line per consignment and what is still missing is received on use (D267, received_on_use); dated in the past at most back to its stock''s arrival (D55), never with a Shopify line id; replay-safe by sale id with a request fingerprint of the caller''s lines; never returns a cost.';

-- ---------------------------------------------------------------------------
-- saleable_stock: 20261004003700_consignment_reporting.sql's body plus the
-- consigned products with nothing recorded
-- ---------------------------------------------------------------------------
create or replace function public.saleable_stock(q text, max_results integer default 20)
returns table (
  kind text,
  product_id uuid,
  product_short_id text,
  inventory_unit_id uuid,
  unit_short_id text,
  title text,
  subtitle text,
  location_id uuid,
  location_name text,
  on_hand integer,
  unit_price numeric,
  ownership_type public.ownership_type,
  consignment_item_id uuid,
  consignment_short_id text,
  consignor_name text,
  rank real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  term text := pg_catalog.left(pg_catalog.btrim(coalesce(saleable_stock.q, '')), 200);
  n integer := greatest(1, least(coalesce(saleable_stock.max_results, 20), 50));
  terms text[];
  patterns text[];
  lq text;
  key text;
begin
  perform private.require_staff();
  if term = '' then
    return;
  end if;
  terms := private.search_terms(term);
  patterns := array(select private.contains_pattern(t) from pg_catalog.unnest(terms) as t);
  lq := pg_catalog.lower(term);
  key := private.search_key(term);

  return query
    with
    stock as (
      select m.product_id, m.location_id, sum(m.quantity_delta)::integer as qty
      from public.inventory_movements m
      join public.products p on p.id = m.product_id
      where p.tracking_type = 'quantity'
      group by m.product_id, m.location_id
      having sum(m.quantity_delta) > 0
    ),
    -- D54: each consignor's quantity stock where it is (every consigned
    -- movement names its item; private.consignment_item_on_hand per row).
    item_stock as (
      select m.consignment_item_id, m.location_id, sum(m.quantity_delta)::integer as qty
      from public.inventory_movements m
      join public.products p on p.id = m.product_id
      where p.tracking_type = 'quantity' and p.ownership_type = 'consignment'
        and m.consignment_item_id is not null
      group by m.consignment_item_id, m.location_id
      having sum(m.quantity_delta) > 0
    ),
    candidates as (
      select 'unit'::text as c_kind, p.id as c_product_id, p.short_id::text as c_product_short_id,
             u.id as c_unit_id, u.short_id::text as c_unit_short_id, p.name::text as c_title,
             pg_catalog.concat_ws(
               ' · ', u.short_id, 'S/N ' || u.serial_number, l.name,
               case when ci.id is not null then ci.short_id || ' · consigned by ' || c.display_name end
             ) as c_subtitle,
             u.location_id as c_location_id, l.name::text as c_location_name, 1 as c_on_hand,
             private.selling_price(p.id, u.id)::numeric as c_unit_price, u.ownership_type as c_ownership,
             ci.id as c_item_id, ci.short_id::text as c_item_short_id, c.display_name::text as c_consignor,
             pg_catalog.lower(p.name || ' ' || coalesce(p.brand, '') || ' ' || coalesce(c.display_name, ''))
               as c_words,
             array[u.short_id, p.short_id, ci.short_id]::text[] as c_ids,
             p.sku_key as c_sku_key, u.serial_key as c_serial_key
      from public.inventory_units u
      join public.products p on p.id = u.product_id
      join public.locations l on l.id = u.location_id
      left join public.consignment_items ci on ci.id = u.consignment_item_id
      left join public.consignors c on c.id = ci.consignor_id
      where u.status = 'available' and u.archived_at is null and u.ownership_type <> 'customer_owned'
        and (ci.id is null or ci.status = 'active')
      union all
      select 'product', p.id, p.short_id::text, null::uuid, null::text, p.name::text,
             pg_catalog.concat_ws(' · ', p.short_id, p.sku, s.qty::text || ' at ' || l.name),
             s.location_id, l.name::text, s.qty, private.selling_price(p.id, null)::numeric, p.ownership_type,
             null::uuid, null::text, null::text,
             pg_catalog.lower(p.name || ' ' || coalesce(p.brand, '')),
             array[p.short_id]::text[], p.sku_key, null::text
      from public.products p
      join stock s on s.product_id = p.id
      join public.locations l on l.id = s.location_id
      where p.tracking_type = 'quantity' and p.ownership_type = 'shop_owned' and p.active and p.archived_at is null
      union all
      select 'product', p.id, p.short_id::text, null::uuid, null::text, p.name::text,
             pg_catalog.concat_ws(
               ' · ', p.short_id, ci.short_id || ' · consigned by ' || c.display_name,
               least(ist.qty, s.qty, pos.remaining_qty)::text || ' at ' || l.name
             ),
             ist.location_id, l.name::text, least(ist.qty, s.qty, pos.remaining_qty),
             coalesce(ci.asking_price, p.default_sale_price)::numeric, p.ownership_type,
             ci.id, ci.short_id::text, c.display_name::text,
             pg_catalog.lower(p.name || ' ' || coalesce(p.brand, '') || ' ' || c.display_name),
             array[p.short_id, ci.short_id]::text[], p.sku_key, null::text
      from public.products p
      join public.consignment_items ci on ci.product_id = p.id and ci.status = 'active'
      join item_stock ist on ist.consignment_item_id = ci.id
      join stock s on s.product_id = p.id and s.location_id = ist.location_id
      join public.locations l on l.id = ist.location_id
      join reporting.consignment_item_position pos on pos.consignment_item_id = ci.id and pos.remaining_qty > 0
      join public.consignors c on c.id = ci.consignor_id
      where p.tracking_type = 'quantity' and p.ownership_type = 'consignment' and p.active and p.archived_at is null
      union all
      -- D267: a consigned quantity product with no consignment stock
      -- recorded anywhere, at the default location: received when sold.
      select 'product', p.id, p.short_id::text, null::uuid, null::text, p.name::text,
             pg_catalog.concat_ws(' · ', p.short_id, p.sku, 'Consigned · none recorded: received when sold'),
             dl.id, dl.name::text, 0,
             coalesce(
               (select i.asking_price from public.consignment_items i
                 where i.product_id = p.id order by i.received_at desc, i.short_id desc limit 1),
               p.default_sale_price
             )::numeric,
             p.ownership_type, null::uuid, null::text, null::text,
             pg_catalog.lower(p.name || ' ' || coalesce(p.brand, '')),
             array[p.short_id]::text[], p.sku_key, null::text
      from public.products p
      cross join lateral (
        select l.id, l.name from public.locations l where l.active order by l.sort_order, l.name limit 1
      ) dl
      where p.tracking_type = 'quantity' and p.ownership_type = 'consignment' and p.active and p.archived_at is null
        and not exists (
          select 1
          from public.consignment_items ci
          join item_stock ist on ist.consignment_item_id = ci.id
          join reporting.consignment_item_position pos on pos.consignment_item_id = ci.id and pos.remaining_qty > 0
          where ci.product_id = p.id and ci.status = 'active'
        )
    ),
    ranked as (
      select cd.*,
             greatest(
               case when key is not null and (
                      exists (select 1 from pg_catalog.unnest(cd.c_ids) x(sid) where pg_catalog.replace(x.sid, '-', '') = key)
                      or cd.c_sku_key = key or cd.c_serial_key = key
                    ) then 1.0 end,
               case when pg_catalog.length(key) >= 3 and exists (
                      select 1 from pg_catalog.unnest(cd.c_ids) x(sid)
                      where pg_catalog.replace(x.sid, '-', '') like '%' || key || '%'
                    ) then 0.6 end,
               case when pg_catalog.cardinality(terms) > 0 and cd.c_words like all (patterns)
                 then 0.45 + 0.4 * extensions.word_similarity(lq, cd.c_words) end
             )::real as c_rank
      from candidates cd
    )
    select r.c_kind, r.c_product_id, r.c_product_short_id, r.c_unit_id, r.c_unit_short_id, r.c_title, r.c_subtitle,
           r.c_location_id, r.c_location_name, r.c_on_hand, r.c_unit_price, r.c_ownership, r.c_item_id,
           r.c_item_short_id, r.c_consignor, r.c_rank
    from ranked r
    where r.c_rank is not null
    order by r.c_rank desc, r.c_title, r.c_kind, r.c_unit_short_id, r.c_location_name, r.c_item_short_id
    limit n;
end;
$$;

comment on function public.saleable_stock(text, integer) is
  'Active staff: available units (shop-owned and consigned) and quantity stock per location (consigned: per active item and the location where that item has stock, D54, at its asking price) matching q, for the sale sheet; a consigned quantity product with no consignment stock recorded is offered at the default location with on hand 0 (D267: received when sold). unit_price is the single selling price (D45). Exact U-/P-/C- ID, SKU or serial first. No cost.';
