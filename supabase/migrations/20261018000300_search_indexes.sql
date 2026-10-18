-- ---------------------------------------------------------------------------
-- Index tidy-up (audit 2026-10-18; DATA-MODEL §4 indexes).
--
-- * Substring search on job numbers, bike short IDs and sale numbers
--   (staff_search, list_sales) matches `replace(x, '-', '') like '%key%'`
--   for keys of three or more characters; with no index each search read
--   every row. Trigram GIN indexes on exactly those expressions (pg_trgm in
--   `extensions`, as 20261004000600_customers installs it) serve them, as
--   bikes_serial_key_trgm_idx already does for serial numbers.
-- * The three foreign keys without a supporting index get one, so archiving
--   a location or a staff member never scans the ledger or the rate table.
-- * inventory_movements_id_desc_idx duplicated the primary key (a b-tree
--   reads backwards as well as forwards) on the busiest append-only table.
-- No function, policy or column changes.
-- ---------------------------------------------------------------------------

create index work_orders_job_key_trgm_idx
  on public.work_orders using gin (pg_catalog.replace(job_number, '-', '') extensions.gin_trgm_ops);

create index bikes_short_key_trgm_idx
  on public.bikes using gin (pg_catalog.replace(short_id, '-', '') extensions.gin_trgm_ops);

create index sales_sale_key_trgm_idx
  on public.sales using gin (pg_catalog.replace(sale_number, '-', '') extensions.gin_trgm_ops);

create index inventory_movements_location_id_idx on public.inventory_movements (location_id);
create index cult_commons_rates_created_by_idx on public.cult_commons_rates (created_by);
create index cult_commons_rates_cancelled_by_idx on public.cult_commons_rates (cancelled_by);

drop index public.inventory_movements_id_desc_idx;
