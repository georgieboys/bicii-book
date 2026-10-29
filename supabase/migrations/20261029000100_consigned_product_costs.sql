-- A consigned product's cost is the amount owed on its next consignment
-- (D44; the owner's question of 2026-10-29 SGT after D162; DATA-MODEL §6
-- product_costs, §9 "Reclassifying shop stock"; RISKS R-095).
--
-- public.product_costs computed expected yield and Cult Commons from
-- products.default_direct_cost for every product. For a consignment-owned
-- product that number is not what a sale or a job line costs: D44 snapshots
-- the agreed amount of the consignment item the stock comes from. So a
-- product reclassified from shop stock (D162) showed the cost it had as
-- shop stock, and Edit terms on its item changed what the consignor is
-- owed but not the cost on the product's page.
--
-- Added: private.consigned_unit_cost(product_id). Replaced (same columns,
-- one added at the end, same grants):
--   effective_cost  shop stock: default_direct_cost, as before; consigned
--                   stock: agreed_amount_owed of the item that sells next,
--                   chosen exactly as private.selling_price chooses its
--                   asking price (the oldest active item with stock, by
--                   received_at then short_id), NULL with none.
--   expected_yield, expected_cult_commons  from effective_cost.
-- default_direct_cost stays the product's own field (Edit details).
-- Nothing authoritative reads this view: sales, job lines, the part picker
-- and report_stock_value already take a consigned item's agreed amount
-- (D44, D105).

-- The agreed amount of the consignment that sells next: the item
-- private.selling_price takes its asking price from (same filter, same
-- order). Security definer like private.selling_price, because
-- reporting.consignment_item_position reads tables no API role may read;
-- it answers only a view_costs holder (D48: view_costs sees consignment
-- money) and is not reachable from the API (`private` is not exposed).
create function private.consigned_unit_cost(product_id uuid)
returns public.money_amount
language sql
stable
security definer
set search_path = ''
as $$
  select i.agreed_amount_owed
    from public.consignment_items i
    join reporting.consignment_item_position pos on pos.consignment_item_id = i.id
   where i.product_id = consigned_unit_cost.product_id
     and i.status = 'active'
     and pos.remaining_qty > 0
     and (select private.has_permission('view_costs'))
   order by i.received_at, i.short_id
   limit 1;
$$;

comment on function private.consigned_unit_cost(uuid) is
  'D44: the agreed amount owed per unit on the consignment of a product that sells next (the item private.selling_price prices), for view_costs holders; NULL otherwise or with none.';

revoke all on function private.consigned_unit_cost(uuid) from public, anon, authenticated, service_role;
grant execute on function private.consigned_unit_cost(uuid) to authenticated;

create or replace view public.product_costs
with (security_barrier)
as
  select p.id as product_id,
         p.default_direct_cost,
         p.currency,
         (x.price - c.cost)::public.money_amount as expected_yield,
         (case when x.price is not null and c.cost is not null then
            round(greatest(round(x.price, 2) - round(c.cost, 2), 0) * r.rate, 2)
          end)::public.money_amount as expected_cult_commons,
         c.cost as effective_cost
  from public.products p
  cross join lateral (select private.selling_price(p.id, null) as price) x
  cross join lateral (
    select case
             when p.ownership_type = 'consignment' then private.consigned_unit_cost(p.id)
             else p.default_direct_cost
           end::public.money_amount as cost
  ) c
  cross join (select private.cult_commons_rate_at(now()) as rate) r
  where (select private.has_permission('view_costs'));

comment on view public.product_costs is
  'Per product, for view_costs only: the default direct cost, the effective cost (a consigned product: the agreed amount of the consignment that sells next, D44) and the expected yield and Cult Commons at the selling price from it.';

revoke all on table public.product_costs from public, anon, authenticated, service_role;
grant select on table public.product_costs to authenticated;
