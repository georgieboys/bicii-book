set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D274 SHOPIFY PAYMENTS FEES BORNE BY CULT COMMONS (the owner, 2026-11-25:
-- "include Shopify Payments fees too", after D273). Amends D273; record
-- ADR-020 amendment (cross-referenced from ADR-025's D273 amendment),
-- DATA-MODEL §19a.
--
-- The D273 answers apply unchanged: Cult Commons bears the fees of the
-- full order, floored at 0 per document (BICII absorbs the rest); a
-- recorded, partially refunded or refunded sale bears every fee (Shopify
-- keeps its fee on a refund); a voided sale, an order with no sale (test,
-- POS, dismissed) and a build order that is unlinked or on a cancelled job
-- leave the fee to BICII; history is restated (no effective date); fees are
-- taken without GST. Fees never reduce yield before the 30%.
--
-- Rule, per Shopify order (one sale):
--   fees        = Σ TransactionFee.amount over the order's transactions
--                 (amount read as the fee less GST; taxAmount, the GST, is
--                 kept beside it and never deducted; R-135)
--   charged     = Σ successful SALE and CAPTURE amounts
--   build share = trunc(fees x build_order.amount / greatest(charged,
--                 Σ build order amounts), 2) per build order (D1 of the
--                 brief: pro rata by amount, in Postgres)
--   sale share  = fees - Σ build shares (shipping included: "full order")
--   per sale:   CC borne = least(sale share, Σ its SGD line shares)
--   per job:    Stripe borne  = least(stripe fees, gross)        (D273)
--               Shopify borne = least(build share, gross - Stripe borne)
--
-- What this migration adds or replaces:
--   public.shopify_sale_fees            insert-only fee facts, one per
--                                       online sale, view_costs to read
--   private.shopify_fee_reads           per sale: pending reads, failures,
--                                       the last outcome (the backoff)
--   private.apply_shopify_fee           records the fee from a server read
--   public.record_shopify_fee_read      service_role: the sweep's write
--   public.note_shopify_fee_read_failed service_role: a failed read
--   public.shopify_fees_due             the cron sweep's work list
--   public.sale_shopify_fees            view_costs: net figures per sale
--   reporting.build_order_shopify_fees, reporting.sale_shopify_fees,
--   reporting.work_order_shopify_fees   the split, aggregated before joins
--   reporting.financial_lines           shopify_fee entries (one per online
--                                       sale, one per completed job with a
--                                       build share); shopify_fee and
--                                       shopify_fee_pending appended
--   reporting.report_lines, private.report_rows  the two columns carried;
--                                       every cost gate is entry_kind = 'line'
--   report_period_summary               shopify_fees, shopify_fees_borne,
--                                       shopify_fee_pending_sales,
--                                       shopify_fee_pending_jobs appended;
--                                       sale_count counts sales with lines
--   report_period_series, report_breakdown  sale_count likewise; the
--                                       Shopify fees group
--   private.report_key(_valid)          the 'shopify_fees' pseudo key
--   public.work_order_totals_staff, public.work_order_yield  Shopify
--                                       columns appended; the after-fees
--                                       figures net of both
--   public.financial_lines, report_line_items, today_dashboard  appended
--   private.integration_exceptions      a sale's fee not read a day on
-- History is restated: every online sale that is not voided is pending
-- until the sweep reads its order.

-- ---------------------------------------------------------------------------
-- public.shopify_sale_fees
-- ---------------------------------------------------------------------------
create table public.shopify_sale_fees (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete restrict,
  -- The sale's order, copied once (guarded).
  shopify_order_id text not null,
  -- shopify_payments: read from Shopify Payments transactions; a zero row
  -- otherwise: no_shopify_payments (another gateway: Shopify reports no
  -- fee) or test_order (a test order, D89).
  basis text not null,
  -- Σ TransactionFee.amount (read as the fee less GST, R-135) and Σ its
  -- taxAmount (the GST on the fee), from Shopify's decimal strings.
  fee_ex_tax public.money_amount not null,
  fee_tax public.money_amount not null,
  fee public.money_amount generated always as (fee_ex_tax + fee_tax) stored,
  -- Σ the successful SALE and CAPTURE amounts: the base of the split.
  order_charged public.money_amount not null,
  gateways text[] not null,
  -- The read's evidence: per transaction its id, kind, status, gateway,
  -- test flag, amount and fees (amounts and ids only).
  transactions jsonb not null,
  currency char(3) not null,
  api_version text null,
  fetched_at timestamptz not null default clock_timestamp(),
  constraint shopify_sale_fees_sale_key unique (sale_id),
  constraint shopify_sale_fees_order_check check (shopify_order_id ~ '^gid://shopify/Order/[0-9]{1,20}$'),
  constraint shopify_sale_fees_basis_check check (basis in ('shopify_payments', 'no_shopify_payments', 'test_order')),
  constraint shopify_sale_fees_amounts_check check (fee_ex_tax >= 0 and fee_tax >= 0 and order_charged >= 0),
  constraint shopify_sale_fees_zero_check check (basis = 'shopify_payments' or (fee_ex_tax = 0 and fee_tax = 0)),
  constraint shopify_sale_fees_currency_check check (currency = 'SGD'),
  constraint shopify_sale_fees_transactions_check check (pg_catalog.jsonb_typeof(transactions) = 'array'),
  constraint shopify_sale_fees_api_version_check check (api_version ~ '^[0-9]{4}-[0-9]{2}$')
);

comment on table public.shopify_sale_fees is
  'D274: the Shopify Payments fees on one online sale''s order (Order.transactions.fees, Admin GraphQL), insert-only, written only while a server read of the order is applied (private.apply_shopify_fee via record_shopify_fee_read). fee_ex_tax = Σ TransactionFee.amount (read as the fee less GST, unverified: R-135), fee_tax = Σ taxAmount. A zero row (basis no_shopify_payments or test_order) marks an order with no Shopify Payments fee. Split pro rata between the sale and its build orders by reporting.build_order_shopify_fees. SGD only. view_costs to read.';
comment on column public.shopify_sale_fees.fee_ex_tax is
  'D274: Σ TransactionFee.amount over the order''s transactions; the amount Cult Commons bears (split with the order''s build orders).';
comment on column public.shopify_sale_fees.order_charged is
  'D274: Σ the order''s successful SALE and CAPTURE amounts (shop money): the base of the pro rata split.';

-- Insert-only, for every role including the owner.
create function private.shopify_sale_fees_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sa public.sales;
begin
  if tg_op <> 'INSERT' then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_fee_immutable',
      detail = 'A Shopify fee is kept as Shopify reported it; it is never changed or deleted.';
  end if;
  select s.* into sa from public.sales s where s.id = new.sale_id;
  if not found
     or sa.source <> 'online_shopify'
     or sa.status = 'voided'
     or new.shopify_order_id is distinct from sa.shopify_order_id
     or pg_catalog.current_setting('bicii.shopify_fee_apply', true) is distinct from new.sale_id::text then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_fee_immutable',
      detail = 'A Shopify fee is recorded only while a server read of its online sale is applied.';
  end if;
  return new;
end;
$$;

create trigger shopify_sale_fees_guard
  before insert or update or delete on public.shopify_sale_fees
  for each row execute function private.shopify_sale_fees_guard();

comment on function private.shopify_sale_fees_guard() is
  'D274: a Shopify fee is inserted only for an online sale that is not voided, with that sale''s order, while private.apply_shopify_fee applies a read of it, and never updated or deleted (shopify_fee_immutable).';

-- ---------------------------------------------------------------------------
-- private.shopify_fee_reads: per sale, the reads that found no fee yet
-- (pending_reads), the reads that failed at Shopify or in the database
-- (failures, from note_shopify_fee_read_failed) and the last outcome. The
-- sweep backs off on both (5 minutes doubling, at most a day); after 20
-- pending reads it stops (the sale needs attention). Nobody reads it
-- directly (RLS on, no policy).
-- ---------------------------------------------------------------------------
create table private.shopify_fee_reads (
  sale_id uuid primary key references public.sales (id) on delete cascade,
  pending_reads integer not null default 0 check (pending_reads >= 0),
  last_read_at timestamptz null,
  failures integer not null default 0 check (failures >= 0),
  last_failed_at timestamptz null,
  last_outcome text null check (last_outcome ~ '^[a-z0-9_]{1,64}$')
);

comment on table private.shopify_fee_reads is
  'D274: per online sale, Shopify fee reads that found no fee yet (pending_reads, last_read_at), reads that failed without an answer (failures, last_failed_at) and the last outcome or error; public.shopify_fees_due backs off on them. Written only by public.record_shopify_fee_read and public.note_shopify_fee_read_failed.';

alter table private.shopify_fee_reads enable row level security;
revoke all on table private.shopify_fee_reads from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.shopify_fee_decimal: a non-negative Shopify decimal string, else
-- NULL (never raises: a fee read never fails a transaction).
-- ---------------------------------------------------------------------------
create function private.shopify_fee_decimal(v text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.btrim(shopify_fee_decimal.v) ~ '^[0-9]{1,10}(\.[0-9]{1,6})?$'
              then pg_catalog.btrim(shopify_fee_decimal.v)::numeric end;
$$;

comment on function private.shopify_fee_decimal(text) is
  'D274: a non-negative decimal string of at most 10 digits and 6 decimals as numeric, else NULL.';

-- ---------------------------------------------------------------------------
-- private.apply_shopify_fee: the fee of one online sale's order from a
-- server read of Order.transactions (the GraphQL order node as Shopify
-- returned it). Never raises for Shopify data. Outcomes:
--   shopify_fee_recorded     a row written (Shopify Payments, or a zero row
--                            when no successful charge is on Shopify Payments)
--   shopify_fee_test_order   a zero row: the sale's delivery was a test, or
--                            every successful charge is a test (D7)
--   shopify_fee_unchanged    already recorded (a replay)
--   shopify_fee_pending      a successful Shopify Payments charge has no
--                            fees yet: nothing written, read again later
--   shopify_fee_currency_mismatch, object_invalid, read_mismatch
--                            needs attention: nothing written
--   sale_not_eligible        not an online sale, or voided
-- ---------------------------------------------------------------------------
create function private.apply_shopify_fee(p_sale_id uuid, p_read jsonb, p_api_version text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  sa public.sales;
  is_test boolean;
  t jsonb;
  f jsonb;
  fees jsonb;
  v_kind text;
  v_status text;
  v_gateway text;
  v_amount numeric;
  a numeric;
  x numeric;
  charges integer := 0;
  test_charges integer := 0;
  sp_charges integer := 0;
  sp_without_fees integer := 0;
  charged numeric := 0;
  fee_sum numeric := 0;
  tax_sum numeric := 0;
  bad boolean := false;
  foreign_money boolean := false;
  gws text[] := '{}'::text[];
  proj jsonb := '[]'::jsonb;
  v_basis text;
  v_version text := case when p_api_version ~ '^[0-9]{4}-[0-9]{2}$' then p_api_version end;
begin
  select s.* into sa from public.sales s where s.id = apply_shopify_fee.p_sale_id;
  if not found or sa.source <> 'online_shopify' or sa.status = 'voided' or sa.shopify_order_id is null then
    return 'sale_not_eligible';
  end if;
  -- The order's advisory lock (GLOBAL LOCK ORDER, 20261004004000): the
  -- order and refund processors take it before the sale row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bicii.shopify.order:' || sa.shopify_order_id, 0));
  if exists (select 1 from public.shopify_sale_fees x0 where x0.sale_id = sa.id) then
    return 'shopify_fee_unchanged';
  end if;

  select e.test_delivery into is_test from public.integration_events e where e.id = sa.integration_event_id;
  if coalesce(is_test, false) then
    v_basis := 'test_order';
  else
    if pg_catalog.jsonb_typeof(p_read) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_read -> 'transactions') is distinct from 'array' then
      return 'object_invalid';
    end if;
    if (p_read ->> 'id') is distinct from sa.shopify_order_id then
      return 'read_mismatch';
    end if;
    for t in select value from pg_catalog.jsonb_array_elements(p_read -> 'transactions') loop
      if pg_catalog.jsonb_typeof(t) is distinct from 'object' then
        bad := true;
        continue;
      end if;
      v_kind := pg_catalog.upper(t ->> 'kind');
      v_status := pg_catalog.upper(t ->> 'status');
      v_gateway := pg_catalog.lower(coalesce(t ->> 'gateway', ''));
      v_amount := private.shopify_fee_decimal(t #>> '{amountSet,shopMoney,amount}');
      fees := case when pg_catalog.jsonb_typeof(t -> 'fees') = 'array' then t -> 'fees' else '[]'::jsonb end;
      -- Every fee on every transaction counts (a refund keeps the fee).
      for f in select value from pg_catalog.jsonb_array_elements(fees) loop
        a := private.shopify_fee_decimal(f #>> '{amount,amount}');
        x := private.shopify_fee_decimal(coalesce(f #>> '{taxAmount,amount}', '0'));
        if a is null or x is null then
          bad := true;
          continue;
        end if;
        if (f #>> '{amount,currencyCode}') is distinct from 'SGD'
           or (x > 0 and (f #>> '{taxAmount,currencyCode}') is distinct from 'SGD') then
          foreign_money := true;
        end if;
        fee_sum := fee_sum + a;
        tax_sum := tax_sum + x;
      end loop;
      if v_kind in ('SALE', 'CAPTURE') and v_status = 'SUCCESS' then
        if v_amount is null then
          bad := true;
        elsif (t #>> '{amountSet,shopMoney,currencyCode}') is distinct from 'SGD' then
          foreign_money := true;
        end if;
        charges := charges + 1;
        charged := charged + coalesce(v_amount, 0);
        if (t -> 'test') = 'true'::jsonb then
          test_charges := test_charges + 1;
        end if;
        if v_gateway <> '' and not (v_gateway = any (gws)) then
          gws := gws || pg_catalog.left(v_gateway, 64);
        end if;
        if v_gateway = 'shopify_payments' then
          sp_charges := sp_charges + 1;
          if pg_catalog.jsonb_array_length(fees) = 0 then
            sp_without_fees := sp_without_fees + 1;
          end if;
        end if;
      end if;
      -- The evidence kept: amounts and ids only.
      proj := proj || pg_catalog.jsonb_build_array(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'id', pg_catalog.left(t ->> 'id', 120),
        'kind', pg_catalog.left(v_kind, 32),
        'status', pg_catalog.left(v_status, 32),
        'gateway', pg_catalog.left(v_gateway, 64),
        'test', case when pg_catalog.jsonb_typeof(t -> 'test') = 'boolean' then t -> 'test' end,
        'amount', pg_catalog.left(t #>> '{amountSet,shopMoney,amount}', 32),
        'currency', pg_catalog.left(t #>> '{amountSet,shopMoney,currencyCode}', 3),
        'fees', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                   'type', pg_catalog.left(g.value ->> 'type', 64),
                   'amount', pg_catalog.left(g.value #>> '{amount,amount}', 32),
                   'tax', pg_catalog.left(g.value #>> '{taxAmount,amount}', 32),
                   'currency', pg_catalog.left(g.value #>> '{amount,currencyCode}', 3)))), '[]'::jsonb)
          from pg_catalog.jsonb_array_elements(fees) g
          where pg_catalog.jsonb_typeof(g.value) = 'object')
      )));
    end loop;
    if bad then
      return 'object_invalid';
    end if;
    if foreign_money then
      return 'shopify_fee_currency_mismatch';
    end if;
    if charges > 0 and test_charges = charges then
      v_basis := 'test_order';
    elsif sp_charges = 0 then
      v_basis := 'no_shopify_payments';
    elsif sp_without_fees > 0 then
      -- Shopify has not put the fee on the charge yet (timing unknown, R-135).
      return 'shopify_fee_pending';
    else
      v_basis := 'shopify_payments';
    end if;
  end if;

  perform pg_catalog.set_config('bicii.shopify_fee_apply', sa.id::text, true);
  insert into public.shopify_sale_fees (
    sale_id, shopify_order_id, basis, fee_ex_tax, fee_tax, order_charged, gateways, transactions,
    currency, api_version
  )
  values (
    sa.id, sa.shopify_order_id, v_basis,
    case when v_basis = 'shopify_payments' then pg_catalog.round(fee_sum, 2) else 0 end,
    case when v_basis = 'shopify_payments' then pg_catalog.round(tax_sum, 2) else 0 end,
    pg_catalog.round(charged, 2), gws, proj, 'SGD', v_version
  );
  perform pg_catalog.set_config('bicii.shopify_fee_apply', '', true);
  return case when v_basis = 'test_order' then 'shopify_fee_test_order' else 'shopify_fee_recorded' end;
end;
$$;

comment on function private.apply_shopify_fee(uuid, jsonb, text) is
  'D274: record an online sale''s Shopify Payments fees from a server read of its order (the GraphQL Order node: id and transactions with kind, status, gateway, test, amountSet.shopMoney and fees[amount, taxAmount]); every fee on every transaction counts (a refund keeps the fee). A test delivery or an all-test order and an order with no successful Shopify Payments charge get a zero row; a successful Shopify Payments charge with no fees yet leaves it pending; another currency, an unreadable amount or another order''s answer need attention (nothing written). Outcomes: shopify_fee_recorded, shopify_fee_test_order, shopify_fee_unchanged, shopify_fee_pending, shopify_fee_currency_mismatch, object_invalid, read_mismatch, sale_not_eligible.';

-- ---------------------------------------------------------------------------
-- public.record_shopify_fee_read (service_role): the sweep's one write.
-- Applies the read, and counts a pending or attention outcome for the
-- backoff. Idempotent: a replay after the fee is recorded is unchanged.
-- ---------------------------------------------------------------------------
create function public.record_shopify_fee_read(p_sale_id uuid, p_read jsonb, p_api_version text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o text;
begin
  o := private.apply_shopify_fee(p_sale_id, p_read, p_api_version);
  if o in ('shopify_fee_pending', 'shopify_fee_currency_mismatch', 'object_invalid', 'read_mismatch') then
    insert into private.shopify_fee_reads as r (sale_id, pending_reads, last_read_at, last_outcome)
    select sa.id, case when o = 'shopify_fee_pending' then 1 else 0 end, pg_catalog.now(), o
    from public.sales sa
    where sa.id = record_shopify_fee_read.p_sale_id
    on conflict (sale_id) do update
      set pending_reads = least(r.pending_reads + excluded.pending_reads, 1000),
          last_read_at = excluded.last_read_at,
          last_outcome = excluded.last_outcome;
  elsif o in ('shopify_fee_recorded', 'shopify_fee_test_order') then
    update private.shopify_fee_reads r set last_outcome = o where r.sale_id = record_shopify_fee_read.p_sale_id;
  end if;
  return o;
end;
$$;

comment on function public.record_shopify_fee_read(uuid, jsonb, text) is
  'service_role (the integration cron''s Shopify fee sweep and the read after sale_recorded, src/lib/integrations/shopify/fees.ts): apply a server read of an online sale''s order (private.apply_shopify_fee) and return its outcome; pending and needs-attention outcomes are counted for the backoff (private.shopify_fee_reads). Safe to replay (D274).';

create function public.note_shopify_fee_read_failed(p_sale_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.shopify_fee_reads as x (sale_id, failures, last_failed_at, last_outcome)
  select sa.id, 1, pg_catalog.now(),
         case when coalesce(p_error, '') ~ '^[a-z0-9_]{1,64}$' then p_error else 'unknown' end
  from public.sales sa
  where sa.id = note_shopify_fee_read_failed.p_sale_id
    and sa.source = 'online_shopify'
    and not exists (select 1 from public.shopify_sale_fees f where f.sale_id = sa.id)
  on conflict (sale_id) do update
    set failures = least(x.failures + 1, 1000),
        last_failed_at = excluded.last_failed_at,
        last_outcome = excluded.last_outcome;
$$;

comment on function public.note_shopify_fee_read_failed(uuid, text) is
  'service_role (the integration cron''s Shopify fee sweep): count one failed fee read of an online sale (p_error: the ShopifyError code, else unknown) so public.shopify_fees_due backs off on it. An unknown or retail sale, or one whose fee is recorded, changes nothing (D274).';

-- ---------------------------------------------------------------------------
-- public.shopify_fees_due (service_role): online sales that are not voided
-- and have no fee row, for the cron sweep (and the restated history).
-- A pending read backs off 5 minutes x 2^(n-1), at most a day, and stops
-- after 20; a read needing attention is tried again once a day (a fix is
-- picked up); a failed read backs off the same way without a limit.
-- Never-tried sales first, then the longest untried. p_sale_id: that one
-- sale only (the read after sale_recorded), whatever its backoff.
-- ---------------------------------------------------------------------------
create function public.shopify_fees_due(max_rows integer, p_sale_id uuid default null)
returns table (sale_id uuid, shopify_order_id text, test_order boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select sa.id, sa.shopify_order_id, coalesce(e.test_delivery, false)
  from public.sales sa
  left join public.integration_events e on e.id = sa.integration_event_id
  left join private.shopify_fee_reads r on r.sale_id = sa.id
  where sa.source = 'online_shopify'
    and sa.status <> 'voided'
    and sa.shopify_order_id is not null
    and not exists (select 1 from public.shopify_sale_fees f where f.sale_id = sa.id)
    and (
      sa.id = shopify_fees_due.p_sale_id
      or (shopify_fees_due.p_sale_id is null and (
        r.sale_id is null
        or (
          r.pending_reads < 20
          and (r.last_read_at is null
               or r.last_read_at < pg_catalog.now() - case
                    when r.last_outcome in ('shopify_fee_currency_mismatch', 'object_invalid', 'read_mismatch')
                      then interval '1 day'
                    else least(interval '5 minutes' * pg_catalog.power(2, greatest(r.pending_reads, 1) - 1)::integer,
                               interval '1 day')
                  end)
          and (r.last_failed_at is null
               or r.last_failed_at < pg_catalog.now()
                    - least(interval '5 minutes' * pg_catalog.power(2, least(greatest(r.failures, 1), 20) - 1)::integer,
                            interval '1 day'))
        )
      ))
    )
  order by greatest(r.last_read_at, r.last_failed_at) nulls first, sa.recognized_at, sa.id
  limit greatest(1, least(coalesce(shopify_fees_due.max_rows, 5), 20));
$$;

comment on function public.shopify_fees_due(integer, uuid) is
  'service_role (the integration cron, src/lib/integrations/shopify/fees.ts): up to max_rows (1..20, default 5) online sales that are not voided and have no Shopify fee row, with their order gid and whether their delivery was a test, never-tried first, then the longest since their last attempt (then oldest recognised); skipping a pending read within its backoff (5 min x 2^(n-1), at most a day; none after 20 pending reads), a needs-attention read within a day, and a failed read within the same backoff (no limit). p_sale_id lists that one sale only, whatever its backoff (D274).';

-- ---------------------------------------------------------------------------
-- The split (D1 of the brief), aggregated before any join. These three run
-- as their owner (no security_invoker): public.work_order_totals_staff (a
-- definer view an API role reads) joins them, and an invoker view inside it
-- would check its tables as the caller. No API role may read them (revoked
-- below), so they are reached only through that gated view and the definer
-- report RPCs.
-- ---------------------------------------------------------------------------
create view reporting.build_order_shopify_fees
as
  select b.id as build_order_id,
         b.sale_id,
         b.work_order_id,
         (case when f.id is null then 0.00
               else coalesce(pg_catalog.trunc(
                      f.fee_ex_tax * b.amount / nullif(greatest(f.order_charged, t.build_total), 0), 2), 0.00)
          end)::numeric as shopify_fee,
         (f.id is null) as pending
  from public.build_orders b
  join public.sales sa on sa.id = b.sale_id and sa.source = 'online_shopify' and sa.status <> 'voided'
  left join public.shopify_sale_fees f on f.sale_id = sa.id
  cross join lateral (
    select coalesce(sum(b2.amount), 0)::numeric as build_total
    from public.build_orders b2 where b2.sale_id = b.sale_id
  ) t;

comment on view reporting.build_order_shopify_fees is
  'D274: per build order on an online sale that is not voided, its share of the order''s Shopify fees: trunc(fees x amount / greatest(order_charged, Σ the sale''s build order amounts), 2) (so the shares never add up to more than the fees); pending while the order''s fee is not read. No API grants.';

revoke all on table reporting.build_order_shopify_fees from public, anon, authenticated, service_role;

create view reporting.sale_shopify_fees
as
  select sa.id as sale_id,
         coalesce(f.fee_ex_tax, 0.00)::numeric as order_fees,
         coalesce(bo.shares, 0.00)::numeric as build_order_fees,
         (coalesce(f.fee_ex_tax, 0.00) - coalesce(bo.shares, 0.00))::numeric as shopify_fees,
         (f.id is null) as pending
  from public.sales sa
  left join public.shopify_sale_fees f on f.sale_id = sa.id
  left join (
    select bf.sale_id, sum(bf.shopify_fee) as shares
    from reporting.build_order_shopify_fees bf
    group by bf.sale_id
  ) bo on bo.sale_id = sa.id
  where sa.source = 'online_shopify' and sa.status <> 'voided';

comment on view reporting.sale_shopify_fees is
  'D274: per online sale that is not voided: order_fees (Σ Shopify Payments fees less GST on its order), build_order_fees (the build orders'' shares), shopify_fees = the sale''s share (the rest: lines and shipping, "full order") and pending while the order''s fee is not read (history restated: every such sale until the sweep reads it). No API grants.';

revoke all on table reporting.sale_shopify_fees from public, anon, authenticated, service_role;

create view reporting.work_order_shopify_fees
as
  select bf.work_order_id,
         bf.build_order_id,
         bf.shopify_fee::numeric as shopify_fees,
         (case when bf.pending then 1 else 0 end)::integer as shopify_fee_pending_count
  from reporting.build_order_shopify_fees bf
  where bf.work_order_id is not null;

comment on view reporting.work_order_shopify_fees is
  'D274: per job linked to a build order (build_orders.work_order_id is unique: one row per job), that build order''s share of its order''s Shopify fees and whether it is pending. An unlinked build order is in no job: BICII bears its share. No API grants.';

revoke all on table reporting.work_order_shopify_fees from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.sale_shopify_fees (view_costs): a sale's Cult Commons net of its
-- Shopify fees, for the sale list and detail (the same arithmetic as its
-- financial_lines entry). Online sales only; no rows without view_costs.
-- ---------------------------------------------------------------------------
create function public.sale_shopify_fees(p_sale_ids uuid[])
returns table (
  sale_id uuid,
  cult_commons_share numeric,
  shopify_fees numeric,
  shopify_fees_borne numeric,
  cult_commons_after_fees numeric,
  shopify_fee_pending boolean,
  build_order_fees numeric,
  bicii_yield_after_fees numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select hs.sale_id,
         g.gross,
         hs.shopify_fees,
         least(hs.shopify_fees, g.gross),
         g.gross - least(hs.shopify_fees, g.gross),
         hs.pending,
         hs.build_order_fees,
         g.yield_total - (g.gross - least(hs.shopify_fees, g.gross)) - hs.shopify_fees
  from reporting.sale_shopify_fees hs
  cross join lateral (
    select coalesce(sum(sl.cult_commons_share), 0)::numeric as gross,
           coalesce(sum(sl.yield_total), 0)::numeric as yield_total
    from public.sale_lines sl
    where sl.sale_id = hs.sale_id and sl.currency::text = 'SGD'
  ) g
  where hs.sale_id = any (sale_shopify_fees.p_sale_ids[1:200])
    and (select private.has_permission('view_costs'));
$$;

comment on function public.sale_shopify_fees(uuid[]) is
  'view_costs (no rows otherwise): per online sale of p_sale_ids (at most 200), cult_commons_share (gross: Σ its SGD line shares), shopify_fees (its share of the order''s Shopify Payments fees, less GST), shopify_fees_borne = least(fees, gross), cult_commons_after_fees, shopify_fee_pending (not read yet: provisional) build_order_fees (the shares its build orders'' jobs bear on completion) and bicii_yield_after_fees (Σ SGD line yields - Cult Commons after fees - the sale''s fees). The same arithmetic as the sale''s reporting.financial_lines shopify_fee entry (D274).';


-- ---------------------------------------------------------------------------
-- reporting.financial_lines: the D273 definition, shopify_fee and
-- shopify_fee_pending appended to each branch, and the two D274 Shopify fee
-- branches (a sale's share; a completed job's build order share).
-- ---------------------------------------------------------------------------
create or replace view reporting.financial_lines
with (security_invoker = true)
as
  select
    ('wol:' || l.id::text)::text as entry_key,
    'work_order'::text as source,
    'line'::text as entry_kind,
    l.id as source_line_id,
    wo.id as document_id,
    wo.job_number::text as document_number,
    'workshop'::text as channel,
    wo.completed_at as recognized_at,
    private.shop_day(wo.completed_at) as recognized_day,
    l.line_type::text as line_type,
    l.source_service_id as service_id,
    l.source_product_id as product_id,
    l.source_inventory_unit_id as inventory_unit_id,
    coalesce(s.category_id, p.category_id) as category_id,
    case when l.line_type = 'inventory' then coalesce(u.ownership_type, p.ownership_type)::text end
      as ownership_type,
    l.consignment_item_id as consignment_item_id,
    wo.customer_id,
    wo.bike_id,
    wo.lead_mechanic_id,
    l.description_snapshot::text as description,
    l.quantity::numeric as quantity,
    l.unit_sale_price_snapshot::numeric as unit_sale_price,
    l.unit_direct_cost_snapshot::numeric as unit_direct_cost,
    l.cult_commons_rate_snapshot::numeric as cult_commons_rate,
    l.sale_total::numeric as sale_total,
    l.cost_total::numeric as cost_total,
    l.yield_total::numeric as yield_total,
    l.cult_commons_share::numeric as cult_commons_share,
    (l.yield_total - l.cult_commons_share)::numeric as bicii_yield_after_cc,
    (l.yield_total < 0) as is_loss,
    l.currency::text as currency,
    l.cost_pending,
    0::numeric as stripe_fee,
    false as stripe_fee_pending,
    0::numeric as shopify_fee,
    false as shopify_fee_pending
  from public.work_order_line_items l
  join public.work_orders wo on wo.id = l.work_order_id
  left join public.services s on s.id = l.source_service_id
  left join public.products p on p.id = l.source_product_id
  left join public.inventory_units u on u.id = l.source_inventory_unit_id
  where wo.completed_at is not null
    and l.voided_at is null
  union all
  select
    ('sl:' || sl.id::text)::text as entry_key,
    'sale'::text as source,
    'line'::text as entry_kind,
    sl.id as source_line_id,
    sa.id as document_id,
    sa.sale_number::text as document_number,
    (case sa.source when 'retail' then 'retail' when 'online_shopify' then 'online' end)::text as channel,
    sa.recognized_at as recognized_at,
    private.shop_day(sa.recognized_at) as recognized_day,
    'inventory'::text as line_type,
    null::uuid as service_id,
    sl.product_id as product_id,
    sl.inventory_unit_id as inventory_unit_id,
    p.category_id as category_id,
    coalesce(u.ownership_type, p.ownership_type)::text as ownership_type,
    sl.consignment_item_id as consignment_item_id,
    sa.customer_id,
    null::uuid as bike_id,
    null::uuid as lead_mechanic_id,
    sl.description_snapshot::text as description,
    sl.quantity::numeric as quantity,
    sl.unit_sale_price_snapshot::numeric as unit_sale_price,
    sl.unit_direct_cost_snapshot::numeric as unit_direct_cost,
    sl.cult_commons_rate_snapshot::numeric as cult_commons_rate,
    sl.sale_total::numeric as sale_total,
    sl.cost_total::numeric as cost_total,
    sl.yield_total::numeric as yield_total,
    sl.cult_commons_share::numeric as cult_commons_share,
    (sl.yield_total - sl.cult_commons_share)::numeric as bicii_yield_after_cc,
    (sl.yield_total < 0) as is_loss,
    sl.currency::text as currency,
    false as cost_pending,
    0::numeric as stripe_fee,
    false as stripe_fee_pending,
    0::numeric as shopify_fee,
    false as shopify_fee_pending
  from public.sale_lines sl
  join public.sales sa on sa.id = sl.sale_id
  join public.products p on p.id = sl.product_id
  left join public.inventory_units u on u.id = sl.inventory_unit_id
  where sa.status <> 'voided'
    -- Phase 9: a 'work_order' sale is reserved and never written (no RPC
    -- inserts one). If one existed, its lines would double-count the job's
    -- own work_order_line_items, which the work-order branch already
    -- recognises. Any NEW sale_source value reaches the channel CASE above
    -- without an arm (a NULL channel), which the channel-partition test in
    -- tests/db/period-reports.test.ts catches.
    and sa.source <> 'work_order'
  union all
  -- D273: one Stripe fee entry per completed job with a fee recorded or
  -- pending, on the job's CURRENT completed_at (moves with a reopen and a
  -- D271 re-completion, like its lines). Cult Commons bears the fees up to
  -- the job's gross share (Σ its live SGD line shares); BICII the rest.
  select
    ('fee:' || wo.id::text)::text as entry_key,
    'work_order'::text as source,
    'stripe_fee'::text as entry_kind,
    wo.id as source_line_id,
    wo.id as document_id,
    wo.job_number::text as document_number,
    'workshop'::text as channel,
    wo.completed_at as recognized_at,
    private.shop_day(wo.completed_at) as recognized_day,
    'stripe_fee'::text as line_type,
    null::uuid as service_id,
    null::uuid as product_id,
    null::uuid as inventory_unit_id,
    null::uuid as category_id,
    null::text as ownership_type,
    null::uuid as consignment_item_id,
    wo.customer_id,
    wo.bike_id,
    wo.lead_mechanic_id,
    'Stripe fees'::text as description,
    0::numeric as quantity,
    0::numeric as unit_sale_price,
    0::numeric as unit_direct_cost,
    null::numeric as cult_commons_rate,
    0::numeric as sale_total,
    0::numeric as cost_total,
    0::numeric as yield_total,
    (-least(sf.stripe_fees, g.gross))::numeric as cult_commons_share,
    (-(sf.stripe_fees - least(sf.stripe_fees, g.gross)))::numeric as bicii_yield_after_cc,
    false as is_loss,
    'SGD'::text as currency,
    false as cost_pending,
    sf.stripe_fees::numeric as stripe_fee,
    (sf.stripe_fee_pending_count > 0) as stripe_fee_pending,
    0::numeric as shopify_fee,
    false as shopify_fee_pending
  from public.work_orders wo
  join reporting.work_order_stripe_fees sf on sf.work_order_id = wo.id
  cross join lateral (
    select coalesce(sum(l.cult_commons_share), 0)::numeric as gross
    from public.work_order_line_items l
    where l.work_order_id = wo.id and l.voided_at is null and l.currency::text = 'SGD'
  ) g
  where wo.completed_at is not null
    and wo.status <> 'cancelled'
    and (sf.stripe_fees > 0 or sf.stripe_fee_pending_count > 0)
  union all
  -- D274: one Shopify fee entry per online sale with a share of its order's
  -- fees or a fee pending, on the sale's recognized_at. Cult Commons bears
  -- the share up to the sale's gross (Σ its live SGD line shares); BICII the
  -- rest (a build package bought alone has no lines: its shipping share is
  -- BICII's).
  select
    ('sfee:' || sa.id::text)::text as entry_key,
    'sale'::text as source,
    'shopify_fee'::text as entry_kind,
    sa.id as source_line_id,
    sa.id as document_id,
    sa.sale_number::text as document_number,
    'online'::text as channel,
    sa.recognized_at as recognized_at,
    private.shop_day(sa.recognized_at) as recognized_day,
    'shopify_fee'::text as line_type,
    null::uuid as service_id,
    null::uuid as product_id,
    null::uuid as inventory_unit_id,
    null::uuid as category_id,
    null::text as ownership_type,
    null::uuid as consignment_item_id,
    sa.customer_id,
    null::uuid as bike_id,
    null::uuid as lead_mechanic_id,
    'Shopify fees'::text as description,
    0::numeric as quantity,
    0::numeric as unit_sale_price,
    0::numeric as unit_direct_cost,
    null::numeric as cult_commons_rate,
    0::numeric as sale_total,
    0::numeric as cost_total,
    0::numeric as yield_total,
    (-least(hs.shopify_fees, g.gross))::numeric as cult_commons_share,
    (-(hs.shopify_fees - least(hs.shopify_fees, g.gross)))::numeric as bicii_yield_after_cc,
    false as is_loss,
    'SGD'::text as currency,
    false as cost_pending,
    0::numeric as stripe_fee,
    false as stripe_fee_pending,
    hs.shopify_fees::numeric as shopify_fee,
    hs.pending as shopify_fee_pending
  from public.sales sa
  join reporting.sale_shopify_fees hs on hs.sale_id = sa.id
  cross join lateral (
    select coalesce(sum(sl.cult_commons_share), 0)::numeric as gross
    from public.sale_lines sl
    where sl.sale_id = sa.id and sl.currency::text = 'SGD'
  ) g
  where hs.shopify_fees > 0 or hs.pending
  union all
  -- D274: one Shopify fee entry per completed (not cancelled) job whose
  -- build order carries a share of its order's fees or a fee pending, on the
  -- job's CURRENT completed_at (moves with a reopen, like the Stripe entry).
  -- One floor per job over both fees: Stripe borne = least(stripe, gross),
  -- Shopify borne = least(share, gross - Stripe borne).
  select
    ('sfee:' || wo.id::text)::text as entry_key,
    'work_order'::text as source,
    'shopify_fee'::text as entry_kind,
    hf.build_order_id as source_line_id,
    wo.id as document_id,
    wo.job_number::text as document_number,
    'workshop'::text as channel,
    wo.completed_at as recognized_at,
    private.shop_day(wo.completed_at) as recognized_day,
    'shopify_fee'::text as line_type,
    null::uuid as service_id,
    null::uuid as product_id,
    null::uuid as inventory_unit_id,
    null::uuid as category_id,
    null::text as ownership_type,
    null::uuid as consignment_item_id,
    wo.customer_id,
    wo.bike_id,
    wo.lead_mechanic_id,
    'Shopify fees'::text as description,
    0::numeric as quantity,
    0::numeric as unit_sale_price,
    0::numeric as unit_direct_cost,
    null::numeric as cult_commons_rate,
    0::numeric as sale_total,
    0::numeric as cost_total,
    0::numeric as yield_total,
    (-least(hf.shopify_fees, g.gross - x.stripe_borne))::numeric as cult_commons_share,
    (-(hf.shopify_fees - least(hf.shopify_fees, g.gross - x.stripe_borne)))::numeric as bicii_yield_after_cc,
    false as is_loss,
    'SGD'::text as currency,
    false as cost_pending,
    0::numeric as stripe_fee,
    false as stripe_fee_pending,
    hf.shopify_fees::numeric as shopify_fee,
    (hf.shopify_fee_pending_count > 0) as shopify_fee_pending
  from public.work_orders wo
  join reporting.work_order_shopify_fees hf on hf.work_order_id = wo.id
  left join reporting.work_order_stripe_fees sf on sf.work_order_id = wo.id
  cross join lateral (
    select coalesce(sum(l.cult_commons_share), 0)::numeric as gross
    from public.work_order_line_items l
    where l.work_order_id = wo.id and l.voided_at is null and l.currency::text = 'SGD'
  ) g
  cross join lateral (
    select least(coalesce(sf.stripe_fees, 0.00), g.gross)::numeric as stripe_borne
  ) x
  where wo.completed_at is not null
    and wo.status <> 'cancelled'
    and (hf.shopify_fees > 0 or hf.shopify_fee_pending_count > 0);

comment on view reporting.financial_lines is
  'One row per recognised revenue entry: every live line of a job with a current completed_at, on that shop day (D32), and every line of a sale that is not voided (and not of the reserved source work_order), at the sale''s recognized_at (D35); amounts from the line snapshots only; Cult Commons per line entry = the line''s share (>= 0, D1); cost_pending flagged (D14); refunds not subtracted and restocked lines kept (D49, D102). D273: plus one stripe_fee entry per completed (not cancelled) job whose Stripe payments carry a fee or a fee pending, on the job''s current completed_at: sale, cost and yield 0, stripe_fee = the job''s fees (less GST), cult_commons_share = -least(fees, the job''s gross line shares) (<= 0), bicii_yield_after_cc = -(fees - that), stripe_fee_pending while a paid payment''s fee is not read yet. D274: plus one shopify_fee entry per online sale that is not voided with a share of its order''s Shopify Payments fees or a fee pending (entry_key sfee:<sale id>, on recognized_at, cult_commons_share = -least(share, the sale''s gross line shares)), and one per completed (not cancelled) job whose build order carries a share (sfee:<job id>, source_line_id the build order, on the current completed_at, cult_commons_share = -least(share, gross - the Stripe fees borne)); shopify_fee = the share (less GST), shopify_fee_pending while the order''s fee is not read. So Σ cult_commons_share is net of Stripe and Shopify fees with a floor of 0 per document. Vocabulary: source work_order|sale, channel workshop|retail|online, document_id = work_orders.id|sales.id, document_number = J-|S- number, entry_kind line|stripe_fee|shopify_fee, line_type stripe_fee|shopify_fee on fee entries, entry_key wol:|sl:|fee:|sfee: + line, job or sale id. Count lines with entry_kind = ''line''. No API grants: read through public.financial_lines / daily_summary and the Phase 9 report RPCs (D30).';

revoke all on table reporting.financial_lines from public, anon, authenticated, service_role;

-- reporting.report_lines: the D273 definition with the two D274 columns
-- appended. The work in
-- progress carries no fee entry: a fee on an open job is held until the
-- job is completed (like the lines' recognition, D154 held deposits).
create or replace view reporting.report_lines
with (security_invoker = true)
as
  select
    fl.entry_key,
    fl.source,
    fl.entry_kind,
    fl.source_line_id,
    fl.document_id,
    fl.document_number,
    fl.channel,
    fl.recognized_at,
    fl.recognized_day,
    fl.line_type,
    fl.service_id,
    fl.product_id,
    fl.inventory_unit_id,
    fl.category_id,
    fl.ownership_type,
    fl.consignment_item_id,
    fl.customer_id,
    fl.bike_id,
    fl.lead_mechanic_id,
    fl.description,
    fl.quantity,
    fl.unit_sale_price,
    fl.unit_direct_cost,
    fl.cult_commons_rate,
    fl.sale_total,
    fl.cost_total,
    fl.yield_total,
    fl.cult_commons_share,
    fl.bicii_yield_after_cc,
    fl.is_loss,
    fl.currency,
    fl.cost_pending,
    wo.checked_in_at,
    wo.completed_at,
    wo.collected_at,
    true as recognised,
    fl.stripe_fee,
    fl.stripe_fee_pending,
    fl.shopify_fee,
    fl.shopify_fee_pending
  from reporting.financial_lines fl
  left join public.work_orders wo on fl.source = 'work_order' and wo.id = fl.document_id
  union all
  select
    ('wol:' || l.id::text)::text as entry_key,
    'work_order'::text as source,
    'line'::text as entry_kind,
    l.id as source_line_id,
    wo.id as document_id,
    wo.job_number::text as document_number,
    'workshop'::text as channel,
    null::timestamptz as recognized_at,
    null::date as recognized_day,
    l.line_type::text as line_type,
    l.source_service_id as service_id,
    l.source_product_id as product_id,
    l.source_inventory_unit_id as inventory_unit_id,
    coalesce(s.category_id, p.category_id) as category_id,
    case when l.line_type = 'inventory' then coalesce(u.ownership_type, p.ownership_type)::text end
      as ownership_type,
    l.consignment_item_id as consignment_item_id,
    wo.customer_id,
    wo.bike_id,
    wo.lead_mechanic_id,
    l.description_snapshot::text as description,
    l.quantity::numeric as quantity,
    l.unit_sale_price_snapshot::numeric as unit_sale_price,
    l.unit_direct_cost_snapshot::numeric as unit_direct_cost,
    l.cult_commons_rate_snapshot::numeric as cult_commons_rate,
    l.sale_total::numeric as sale_total,
    l.cost_total::numeric as cost_total,
    l.yield_total::numeric as yield_total,
    l.cult_commons_share::numeric as cult_commons_share,
    (l.yield_total - l.cult_commons_share)::numeric as bicii_yield_after_cc,
    (l.yield_total < 0) as is_loss,
    l.currency::text as currency,
    l.cost_pending,
    wo.checked_in_at,
    wo.completed_at,
    wo.collected_at,
    false as recognised,
    0::numeric as stripe_fee,
    false as stripe_fee_pending,
    0::numeric as shopify_fee,
    false as shopify_fee_pending
  from public.work_order_line_items l
  join public.work_orders wo on wo.id = l.work_order_id
  left join public.services s on s.id = l.source_service_id
  left join public.products p on p.id = l.source_product_id
  left join public.inventory_units u on u.id = l.source_inventory_unit_id
  where wo.completed_at is null
    and wo.status <> 'cancelled'
    and l.voided_at is null;


comment on view reporting.report_lines is
  'D100: every non-voided line that carries money on any date basis: reporting.financial_lines (recognised = true, its D273 Stripe fee entries included) with its job''s checked_in_at, completed_at and collected_at, plus the live lines of jobs neither completed nor cancelled (work in progress, recognised = false, recognized_at NULL; no fee entry: fees on open jobs are deducted at completion). Same columns as financial_lines up to cost_pending, then checked_in_at, completed_at, collected_at, recognised, stripe_fee, stripe_fee_pending, shopify_fee, shopify_fee_pending (D274: Shopify fee entries are recognised entries too; a job''s build order share only once the job is completed). No API grants: read through the Phase 9 report RPCs (D30).';

revoke all on table reporting.report_lines from public, anon, authenticated, service_role;

-- D273, D274: the stripe_fees and shopify_fees pseudo keys (product,
-- category, service, ownership).
create or replace function private.report_key_valid(p_dimension public.report_dimension, p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_key is null or p_dimension is null then false
    when p_dimension = 'ownership' then p_key in ('shop_owned', 'consignment', 'customer_owned', 'service', 'stripe_fees', 'shopify_fees')
    when p_dimension = 'channel' then p_key in ('workshop', 'retail', 'online')
    when p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
    when p_dimension = 'product' then p_key in ('none', 'stripe_fees', 'shopify_fees')
    when p_dimension = 'category' then p_key in ('none', 'stripe_fees', 'shopify_fees')
    when p_dimension = 'service' then p_key in ('products', 'manual', 'stripe_fees', 'shopify_fees')
    when p_dimension = 'mechanic' then p_key in ('unassigned', 'not_workshop')
    else false
  end;
$$;

comment on function private.report_key_valid(public.report_dimension, text) is
  'True when p_key is a lowercase uuid (job, product, category, service, mechanic) or one of the dimension''s pseudo keys: product none | stripe_fees | shopify_fees; category none | stripe_fees | shopify_fees; service products | manual | stripe_fees | shopify_fees; mechanic unassigned | not_workshop; ownership shop_owned | consignment | customer_owned | service | stripe_fees | shopify_fees; channel workshop | retail | online.';
create or replace function private.report_key(
  p_dimension public.report_dimension,
  p_source text,
  p_document_id uuid,
  p_product_id uuid,
  p_category_id uuid,
  p_service_id uuid,
  p_line_type text,
  p_lead_mechanic_id uuid,
  p_ownership_type text,
  p_channel text
)
returns text
language sql
immutable
as $$
  select case
    when p_line_type = 'stripe_fee' and p_dimension in ('product', 'category', 'service', 'ownership')
      then 'stripe_fees'
    when p_line_type = 'shopify_fee' and p_dimension in ('product', 'category', 'service', 'ownership')
      then 'shopify_fees'
    else case p_dimension
    when 'job' then p_document_id::text
    when 'product' then coalesce(p_product_id::text, 'none')
    when 'category' then coalesce(p_category_id::text, 'none')
    when 'service' then
      case
        when p_service_id is not null then p_service_id::text
        when p_line_type = 'manual' then 'manual'
        else 'products'
      end
    when 'mechanic' then
      case when p_source = 'sale' then 'not_workshop' else coalesce(p_lead_mechanic_id::text, 'unassigned') end
    when 'ownership' then
      case when p_line_type in ('service', 'manual') then 'service' else p_ownership_type end
    when 'channel' then p_channel
    end
  end;
$$;

comment on function private.report_key(public.report_dimension, text, uuid, uuid, uuid, uuid, text, uuid, text, text) is
  'The breakdown group of a report line: job document_id; product product_id (none: service and manual lines); category category_id (none); service service_id (products: inventory and sale lines, manual: custom lines); mechanic the current lead (unassigned; not_workshop for retail and online, D103); ownership shop_owned | consignment | customer_owned (service: service and manual lines); channel workshop | retail | online; a D273 Stripe fee entry (line_type stripe_fee) is stripe_fees in product, category, service and ownership and its job, lead mechanic and channel otherwise; a D274 Shopify fee entry (line_type shopify_fee) is shopify_fees in those four and its sale or job, mechanic (not_workshop for a sale) and channel otherwise. Pure CASE without SET so the planner inlines it.';

-- private.report_rows: shopify_fee and shopify_fee_pending appended (D274);
-- every fee entry is a cost figure: callers without view_costs get lines only.
drop function private.report_rows(date, date, public.report_date_basis, timestamptz, uuid, integer, boolean);
create function private.report_rows(
  p_from date,
  p_to date,
  p_basis public.report_date_basis,
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default null,
  p_foreign boolean default false
)
returns table (
  entry_key text,
  source text,
  entry_kind text,
  source_line_id uuid,
  document_id uuid,
  document_number text,
  channel text,
  recognized_at timestamptz,
  recognized_day date,
  line_type text,
  service_id uuid,
  product_id uuid,
  inventory_unit_id uuid,
  category_id uuid,
  ownership_type text,
  consignment_item_id uuid,
  customer_id uuid,
  bike_id uuid,
  lead_mechanic_id uuid,
  description text,
  quantity numeric,
  unit_sale_price numeric,
  unit_direct_cost numeric,
  cult_commons_rate numeric,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  bicii_yield_after_cc numeric,
  is_loss boolean,
  currency text,
  cost_pending boolean,
  checked_in_at timestamptz,
  completed_at timestamptz,
  collected_at timestamptz,
  recognised boolean,
  basis_at timestamptz,
  stripe_fee numeric,
  stripe_fee_pending boolean,
  shopify_fee numeric,
  shopify_fee_pending boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := private.shop_day_start(p_from);
  v_end timestamptz := private.shop_day_start(p_to + 1);
  v_currency text := private.shop_currency();
  v_tz text := private.shop_timezone();
  v_basis public.report_date_basis := coalesce(p_basis, 'sale');
  -- Page bounds (only with p_limit): the basis instant of the p_limit-th
  -- newest job (sale) that has a counted line and lies before the cursor.
  -- Each such document has at least one line after the cursor, so no line
  -- older than that instant can be on the page; the bound lets each
  -- per-basis query read a few documents through the stamp's index instead
  -- of the whole range. Without p_limit (or with fewer documents) the
  -- bound is the range start.
  v_before timestamptz := least(coalesce(p_after_at, v_end), v_end);
  v_t_wo timestamptz;
  v_t_sa timestamptz;
  -- D273, D274, D30: a fee entry (Stripe or Shopify) is a cost figure: only
  -- view_costs callers get it (its amounts and that a document carried a
  -- fee at all). Gated as entry_kind = 'line' so a later kind cannot leak.
  v_costs boolean := private.has_permission('view_costs');
begin
  if p_limit is not null and p_limit > 0 then
    if v_basis in ('sale', 'completion') then
      select wo.completed_at into v_t_wo
      from public.work_orders wo
      where wo.completed_at >= v_start and wo.completed_at < v_before
        and exists (
          select 1 from public.work_order_line_items l
          where l.work_order_id = wo.id and l.voided_at is null
            and (l.currency::text = v_currency) is distinct from p_foreign
        )
      order by wo.completed_at desc
      offset p_limit - 1 limit 1;
    elsif v_basis = 'collection' then
      select wo.collected_at into v_t_wo
      from public.work_orders wo
      where wo.collected_at >= v_start and wo.collected_at < v_before
        and exists (
          select 1 from public.work_order_line_items l
          where l.work_order_id = wo.id and l.voided_at is null
            and (l.currency::text = v_currency) is distinct from p_foreign
        )
      order by wo.collected_at desc
      offset p_limit - 1 limit 1;
    else
      select wo.checked_in_at into v_t_wo
      from public.work_orders wo
      where wo.checked_in_at >= v_start and wo.checked_in_at < v_before
        and wo.status <> 'cancelled'
        and exists (
          select 1 from public.work_order_line_items l
          where l.work_order_id = wo.id and l.voided_at is null
            and (l.currency::text = v_currency) is distinct from p_foreign
        )
      order by wo.checked_in_at desc
      offset p_limit - 1 limit 1;
    end if;
    if v_basis = 'sale' then
      select sa.recognized_at into v_t_sa
      from public.sales sa
      where sa.recognized_at >= v_start and sa.recognized_at < v_before
        and sa.status <> 'voided' and sa.source <> 'work_order'
        and exists (
          select 1 from public.sale_lines sl
          where sl.sale_id = sa.id and (sl.currency::text = v_currency) is distinct from p_foreign
        )
      order by sa.recognized_at desc
      offset p_limit - 1 limit 1;
    end if;
  end if;
  v_t_wo := coalesce(v_t_wo, v_start);
  v_t_sa := coalesce(v_t_sa, v_start);

  if v_basis = 'sale' then
    return query
      select rl.entry_key, rl.source, rl.entry_kind, rl.source_line_id, rl.document_id, rl.document_number,
             rl.channel, rl.recognized_at, (rl.recognized_at at time zone v_tz)::date, rl.line_type,
             rl.service_id, rl.product_id, rl.inventory_unit_id, rl.category_id, rl.ownership_type,
             rl.consignment_item_id, rl.customer_id, rl.bike_id, rl.lead_mechanic_id, rl.description,
             rl.quantity, rl.unit_sale_price, rl.unit_direct_cost, rl.cult_commons_rate, rl.sale_total,
             rl.cost_total, rl.yield_total, rl.cult_commons_share, rl.bicii_yield_after_cc, rl.is_loss,
             rl.currency, rl.cost_pending, rl.checked_in_at, rl.completed_at, rl.collected_at,
             rl.recognised, rl.recognized_at, rl.stripe_fee, rl.stripe_fee_pending,
             rl.shopify_fee, rl.shopify_fee_pending
      from reporting.report_lines rl
      where rl.recognised
        and rl.recognized_at >= v_start
        and rl.recognized_at < v_end
        and (rl.currency = v_currency) is distinct from p_foreign
        and (v_costs or rl.entry_kind = 'line')
        and (rl.source <> 'work_order' or rl.recognized_at >= v_t_wo)
        and (rl.source <> 'sale' or rl.recognized_at >= v_t_sa)
        and (p_after_at is null or (rl.recognized_at, rl.source_line_id) < (p_after_at, p_after_id))
      order by rl.recognized_at desc, rl.source_line_id desc
      limit p_limit;
  elsif v_basis = 'completion' then
    -- A workshop line's recognized_at IS its job's current completed_at.
    return query
      select rl.entry_key, rl.source, rl.entry_kind, rl.source_line_id, rl.document_id, rl.document_number,
             rl.channel, rl.recognized_at, (rl.recognized_at at time zone v_tz)::date, rl.line_type,
             rl.service_id, rl.product_id, rl.inventory_unit_id, rl.category_id, rl.ownership_type,
             rl.consignment_item_id, rl.customer_id, rl.bike_id, rl.lead_mechanic_id, rl.description,
             rl.quantity, rl.unit_sale_price, rl.unit_direct_cost, rl.cult_commons_rate, rl.sale_total,
             rl.cost_total, rl.yield_total, rl.cult_commons_share, rl.bicii_yield_after_cc, rl.is_loss,
             rl.currency, rl.cost_pending, rl.checked_in_at, rl.completed_at, rl.collected_at,
             rl.recognised, rl.recognized_at, rl.stripe_fee, rl.stripe_fee_pending,
             rl.shopify_fee, rl.shopify_fee_pending
      from reporting.report_lines rl
      where rl.source = 'work_order'
        and rl.recognised
        and rl.recognized_at >= v_start
        and rl.recognized_at < v_end
        and (rl.currency = v_currency) is distinct from p_foreign
        and (v_costs or rl.entry_kind = 'line')
        and rl.recognized_at >= v_t_wo
        and (p_after_at is null or (rl.recognized_at, rl.source_line_id) < (p_after_at, p_after_id))
      order by rl.recognized_at desc, rl.source_line_id desc
      limit p_limit;
  elsif v_basis = 'collection' then
    return query
      select rl.entry_key, rl.source, rl.entry_kind, rl.source_line_id, rl.document_id, rl.document_number,
             rl.channel, rl.recognized_at, (rl.recognized_at at time zone v_tz)::date, rl.line_type,
             rl.service_id, rl.product_id, rl.inventory_unit_id, rl.category_id, rl.ownership_type,
             rl.consignment_item_id, rl.customer_id, rl.bike_id, rl.lead_mechanic_id, rl.description,
             rl.quantity, rl.unit_sale_price, rl.unit_direct_cost, rl.cult_commons_rate, rl.sale_total,
             rl.cost_total, rl.yield_total, rl.cult_commons_share, rl.bicii_yield_after_cc, rl.is_loss,
             rl.currency, rl.cost_pending, rl.checked_in_at, rl.completed_at, rl.collected_at,
             rl.recognised, rl.collected_at, rl.stripe_fee, rl.stripe_fee_pending,
             rl.shopify_fee, rl.shopify_fee_pending
      from reporting.report_lines rl
      where rl.source = 'work_order'
        and rl.collected_at >= v_start
        and rl.collected_at < v_end
        and (rl.currency = v_currency) is distinct from p_foreign
        and (v_costs or rl.entry_kind = 'line')
        and rl.collected_at >= v_t_wo
        and (p_after_at is null or (rl.collected_at, rl.source_line_id) < (p_after_at, p_after_id))
      order by rl.collected_at desc, rl.source_line_id desc
      limit p_limit;
  else
    -- check_in: both branches (work in progress included).
    return query
      select rl.entry_key, rl.source, rl.entry_kind, rl.source_line_id, rl.document_id, rl.document_number,
             rl.channel, rl.recognized_at, (rl.recognized_at at time zone v_tz)::date, rl.line_type,
             rl.service_id, rl.product_id, rl.inventory_unit_id, rl.category_id, rl.ownership_type,
             rl.consignment_item_id, rl.customer_id, rl.bike_id, rl.lead_mechanic_id, rl.description,
             rl.quantity, rl.unit_sale_price, rl.unit_direct_cost, rl.cult_commons_rate, rl.sale_total,
             rl.cost_total, rl.yield_total, rl.cult_commons_share, rl.bicii_yield_after_cc, rl.is_loss,
             rl.currency, rl.cost_pending, rl.checked_in_at, rl.completed_at, rl.collected_at,
             rl.recognised, rl.checked_in_at, rl.stripe_fee, rl.stripe_fee_pending,
             rl.shopify_fee, rl.shopify_fee_pending
      from reporting.report_lines rl
      where rl.source = 'work_order'
        and rl.checked_in_at >= v_start
        and rl.checked_in_at < v_end
        and (rl.currency = v_currency) is distinct from p_foreign
        and (v_costs or rl.entry_kind = 'line')
        and rl.checked_in_at >= v_t_wo
        and (p_after_at is null or (rl.checked_in_at, rl.source_line_id) < (p_after_at, p_after_id))
      order by rl.checked_in_at desc, rl.source_line_id desc
      limit p_limit;
  end if;
end;
$$;

comment on function private.report_rows(date, date, public.report_date_basis, timestamptz, uuid, integer, boolean) is
  'D100/D104: the report_lines a basis counts in the shop days p_from..p_to (no range check: callers check), in the shop currency (p_foreign: in any other), newest basis_at first; the keyset cursor (basis_at, source_line_id) < (p_after_at, p_after_id) and p_limit apply inside each per-basis query, with p_limit also bounding the instants read (the p_limit-th newest document with a counted line before the cursor). basis_at = recognized_at (sale, completion), collected_at or checked_in_at; D273 Stripe fee entries come with their job (stripe_fee, stripe_fee_pending appended; 0 and false on lines), for view_costs callers only (a fee is a cost figure, D30); D274 Shopify fee entries likewise (shopify_fee, shopify_fee_pending appended; callers without view_costs get entry_kind line only).';

-- report_period_summary: D274 columns appended; sales counted by their lines.
drop function public.report_period_summary(date, date, public.report_date_basis);
create function public.report_period_summary(
  p_from date,
  p_to date,
  p_basis public.report_date_basis default 'sale'
)
returns table (
  basis public.report_date_basis,
  from_date date,
  to_date date,
  currency text,
  line_count integer,
  job_count integer,
  sale_count integer,
  loss_line_count integer,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  yield_after_cc numeric,
  cost_pending_lines integer,
  refunds_total numeric,
  refund_count integer,
  consignment_sales integer,
  consignment_sales_total numeric,
  new_consignor_liability numeric,
  settlements_paid_total numeric,
  purchases_received_total numeric,
  excluded_foreign_line_count integer,
  stripe_fees numeric,
  stripe_fees_borne numeric,
  stripe_fee_pending_jobs integer,
  shopify_fees numeric,
  shopify_fees_borne numeric,
  shopify_fee_pending_sales integer,
  shopify_fee_pending_jobs integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_costs boolean;
  v_basis public.report_date_basis;
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
  v_sale boolean;
begin
  perform private.require_permission('view_financial_reports');
  v_costs := private.has_permission('view_costs');
  perform private.report_require_range(p_from, p_to);
  v_basis := coalesce(p_basis, 'sale');
  v_sale := v_basis = 'sale';
  v_start := private.shop_day_start(p_from);
  v_end := private.shop_day_start(p_to + 1);
  v_currency := private.shop_currency();

  return query
    with r as materialized (
      select * from private.report_rows(p_from, p_to, v_basis)
    ),
    agg as (
      select
        (count(*) filter (where r.entry_kind = 'line'))::integer as line_count,
        (count(distinct r.document_id) filter (where r.source = 'work_order' and r.entry_kind = 'line'))::integer
          as job_count,
        (count(distinct r.document_id) filter (where r.source = 'sale' and r.entry_kind = 'line'))::integer as sale_count,
        (count(*) filter (where r.is_loss))::integer as loss_line_count,
        coalesce(sum(r.sale_total), 0.00)::numeric as sale_total,
        coalesce(sum(r.cost_total), 0.00)::numeric as cost_total,
        coalesce(sum(r.yield_total), 0.00)::numeric as yield_total,
        -- D1: the sum of the lines' own shares, less what each completed
        -- job's Cult Commons bears of its Stripe fees (D273).
        coalesce(sum(r.cult_commons_share), 0.00)::numeric as cult_commons_share,
        coalesce(sum(r.bicii_yield_after_cc), 0.00)::numeric as yield_after_cc,
        coalesce(sum(r.stripe_fee), 0.00)::numeric as stripe_fees,
        coalesce(-sum(r.cult_commons_share) filter (where r.entry_kind = 'stripe_fee'), 0.00)::numeric
          as stripe_fees_borne,
        (count(*) filter (where r.stripe_fee_pending))::integer as stripe_fee_pending_jobs,
        -- D274: the sales' and jobs' shares of their orders' Shopify fees.
        coalesce(sum(r.shopify_fee), 0.00)::numeric as shopify_fees,
        coalesce(-sum(r.cult_commons_share) filter (where r.entry_kind = 'shopify_fee'), 0.00)::numeric
          as shopify_fees_borne,
        (count(*) filter (where r.shopify_fee_pending and r.source = 'sale'))::integer
          as shopify_fee_pending_sales,
        (count(*) filter (where r.shopify_fee_pending and r.source = 'work_order'))::integer
          as shopify_fee_pending_jobs,
        (count(*) filter (where r.cost_pending))::integer as cost_pending_lines
      from r
    ),
    cons as (
      select
        (count(distinct r.document_id))::integer as consignment_sales,
        coalesce(sum(r.sale_total), 0.00)::numeric as consignment_sales_total,
        coalesce(
          sum(round(r.quantity * coalesce(sl.consignor_payout_snapshot, li.consignor_payout_snapshot), 2)), 0.00
        )::numeric as new_consignor_liability
      from r
      left join public.sale_lines sl on r.source = 'sale' and sl.id = r.source_line_id
      left join public.work_order_line_items li on r.source = 'work_order' and li.id = r.source_line_id
      where r.consignment_item_id is not null
    )
    select
      v_basis,
      p_from,
      p_to,
      v_currency,
      a.line_count,
      a.job_count,
      a.sale_count,
      case when v_costs then a.loss_line_count end,
      a.sale_total,
      case when v_costs then a.cost_total end,
      case when v_costs then a.yield_total end,
      case when v_costs then a.cult_commons_share end,
      case when v_costs then a.yield_after_cc end,
      a.cost_pending_lines,
      -- D102: refunds recorded in the range, beside gross, never netted.
      case when v_sale then (
        select coalesce(sum(rf.amount), 0.00)::numeric
        from public.sale_refunds rf
        where rf.created_at >= v_start and rf.created_at < v_end and rf.currency::text = v_currency
      ) end,
      case when v_sale then (
        select count(*)::integer
        from public.sale_refunds rf
        where rf.created_at >= v_start and rf.created_at < v_end and rf.currency::text = v_currency
      ) end,
      case when v_sale then c.consignment_sales end,
      case when v_sale then c.consignment_sales_total end,
      case when v_sale and v_costs then c.new_consignor_liability end,
      -- D46, D47: settlements paid in the range that are not reversed.
      case when v_sale and v_costs then (
        select coalesce(sum(cs.amount), 0.00)::numeric
        from public.consignment_settlements cs
        where cs.paid_at >= v_start and cs.paid_at < v_end
          and cs.currency::text = v_currency
          and not exists (
            select 1 from public.consignment_settlement_reversals x where x.settlement_id = cs.id
          )
      ) end,
      -- D105: purchases received in the range at their actual cost.
      case when v_sale and v_costs then (
        select coalesce(sum(prl.received_total), 0.00)::numeric
        from public.purchase_receipts pr
        join public.purchase_receipt_lines prl on prl.purchase_receipt_id = pr.id
        where pr.received_at >= v_start and pr.received_at < v_end
          and prl.currency::text = v_currency
      ) end,
      private.report_foreign_rows(p_from, p_to, v_basis),
      case when v_costs then a.stripe_fees end,
      case when v_costs then a.stripe_fees_borne end,
      case when v_costs then a.stripe_fee_pending_jobs end,
      case when v_costs then a.shopify_fees end,
      case when v_costs then a.shopify_fees_borne end,
      case when v_costs then a.shopify_fee_pending_sales end,
      case when v_costs then a.shopify_fee_pending_jobs end
    from agg a
    cross join cons c;
end;
$$;

comment on function public.report_period_summary(date, date, public.report_date_basis) is
  'view_financial_reports: one row of period totals for shop days p_from..p_to on a date basis (D100; null = sale): line, job and sale counts, gross sale_total, cost-pending lines and the foreign-currency exclusions (D104) for every caller; loss_line_count, cost_total, yield_total, cult_commons_share (Σ line shares, D1, less what each completed job''s Cult Commons bears of its Stripe fees, D273), yield_after_cc (Σ bicii_yield_after_cc: yield less net Cult Commons less Stripe fees), stripe_fees, stripe_fees_borne and stripe_fee_pending_jobs (jobs whose Stripe fee is not read yet: Cult Commons provisional) need view_costs (NULL otherwise, D30; private.report_rows gives fee entries to view_costs callers only); line_count and job_count count lines only. D274: cult_commons_share and yield_after_cc are also net of each online sale''s and completed job''s share of its order''s Shopify Payments fees; shopify_fees, shopify_fees_borne, shopify_fee_pending_sales and shopify_fee_pending_jobs need view_costs; sale_count counts sales with a line. Sale basis only (NULL otherwise): refunds_total and refund_count (D102, by sale_refunds.created_at, never netted), consignment_sales and consignment_sales_total, and (view_costs) new_consignor_liability, settlements_paid_total (not reversed) and purchases_received_total (D105). report_range_invalid / report_range_too_long.';

-- report_period_series: the same D274 definitions per bucket.
create or replace function public.report_period_series(
  p_from date,
  p_to date,
  p_basis public.report_date_basis default 'sale',
  p_grain public.report_grain default 'day'
)
returns table (
  bucket_start date,
  bucket_end date,
  partial boolean,
  line_count integer,
  job_count integer,
  sale_count integer,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  yield_after_cc numeric,
  loss_line_count integer,
  refunds_total numeric,
  consignment_sales integer,
  consignment_sales_total numeric,
  new_consignor_liability numeric,
  settlements_paid_total numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_costs boolean;
  v_basis public.report_date_basis;
  v_grain text;
  v_step interval;
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
  v_tz text;
  v_sale boolean;
begin
  perform private.require_permission('view_financial_reports');
  v_costs := private.has_permission('view_costs');
  perform private.report_require_range(p_from, p_to);
  v_basis := coalesce(p_basis, 'sale');
  v_sale := v_basis = 'sale';
  v_grain := coalesce(p_grain, 'day')::text;
  v_step := ('1 ' || v_grain)::interval;
  v_start := private.shop_day_start(p_from);
  v_end := private.shop_day_start(p_to + 1);
  v_currency := private.shop_currency();
  v_tz := private.shop_timezone();

  return query
    with buckets as (
      select g.ts::date as raw_start, (g.ts + v_step - interval '1 day')::date as raw_end
      from pg_catalog.generate_series(
        pg_catalog.date_trunc(v_grain, p_from::timestamp), p_to::timestamp, v_step
      ) g(ts)
    ),
    r as materialized (
      select
        pg_catalog.date_trunc(v_grain, (x.basis_at at time zone v_tz)::date::timestamp)::date as b,
        x.*
      from private.report_rows(p_from, p_to, v_basis) x
    ),
    agg as (
      select
        r.b,
        (count(*) filter (where r.entry_kind = 'line'))::integer as line_count,
        (count(distinct r.document_id) filter (where r.source = 'work_order' and r.entry_kind = 'line'))::integer
          as job_count,
        (count(distinct r.document_id) filter (where r.source = 'sale' and r.entry_kind = 'line'))::integer as sale_count,
        sum(r.sale_total)::numeric as sale_total,
        sum(r.cost_total)::numeric as cost_total,
        sum(r.yield_total)::numeric as yield_total,
        sum(r.cult_commons_share)::numeric as cult_commons_share,
        sum(r.bicii_yield_after_cc)::numeric as yield_after_cc,
        (count(*) filter (where r.is_loss))::integer as loss_line_count
      from r
      group by r.b
    ),
    cons as (
      select
        r.b,
        (count(distinct r.document_id))::integer as consignment_sales,
        sum(r.sale_total)::numeric as consignment_sales_total,
        sum(round(r.quantity * coalesce(sl.consignor_payout_snapshot, li.consignor_payout_snapshot), 2))::numeric
          as new_consignor_liability
      from r
      left join public.sale_lines sl on r.source = 'sale' and sl.id = r.source_line_id
      left join public.work_order_line_items li on r.source = 'work_order' and li.id = r.source_line_id
      where r.consignment_item_id is not null
      group by r.b
    ),
    refunds as (
      select
        pg_catalog.date_trunc(v_grain, (rf.created_at at time zone v_tz)::date::timestamp)::date as b,
        sum(rf.amount)::numeric as refunds_total
      from public.sale_refunds rf
      where v_sale and rf.created_at >= v_start and rf.created_at < v_end and rf.currency::text = v_currency
      group by 1
    ),
    settlements as (
      select
        pg_catalog.date_trunc(v_grain, (cs.paid_at at time zone v_tz)::date::timestamp)::date as b,
        sum(cs.amount)::numeric as settlements_paid_total
      from public.consignment_settlements cs
      where v_sale and v_costs
        and cs.paid_at >= v_start and cs.paid_at < v_end
        and cs.currency::text = v_currency
        and not exists (
          select 1 from public.consignment_settlement_reversals x where x.settlement_id = cs.id
        )
      group by 1
    )
    select
      greatest(bk.raw_start, p_from),
      least(bk.raw_end, p_to),
      (bk.raw_start < p_from or bk.raw_end > p_to),
      coalesce(a.line_count, 0),
      coalesce(a.job_count, 0),
      coalesce(a.sale_count, 0),
      coalesce(a.sale_total, 0.00)::numeric,
      case when v_costs then coalesce(a.cost_total, 0.00) end::numeric,
      case when v_costs then coalesce(a.yield_total, 0.00) end::numeric,
      case when v_costs then coalesce(a.cult_commons_share, 0.00) end::numeric,
      case when v_costs then coalesce(a.yield_after_cc, 0.00) end::numeric,
      case when v_costs then coalesce(a.loss_line_count, 0) end::integer,
      case when v_sale then coalesce(rf.refunds_total, 0.00) end::numeric,
      case when v_sale then coalesce(c.consignment_sales, 0) end::integer,
      case when v_sale then coalesce(c.consignment_sales_total, 0.00) end::numeric,
      case when v_sale and v_costs then coalesce(c.new_consignor_liability, 0.00) end::numeric,
      case when v_sale and v_costs then coalesce(st.settlements_paid_total, 0.00) end::numeric
    from buckets bk
    left join agg a on a.b = bk.raw_start
    left join cons c on c.b = bk.raw_start
    left join refunds rf on rf.b = bk.raw_start
    left join settlements st on st.b = bk.raw_start
    order by bk.raw_start;
end;
$$;

comment on function public.report_period_series(date, date, public.report_date_basis, public.report_grain) is
  'view_financial_reports: one row per day, ISO week or month bucket overlapping p_from..p_to (zeros when empty; bucket_start/bucket_end clipped to the range, partial when clipped), with report_period_summary''s definitions per bucket (D273, D274: Cult Commons net of Stripe and Shopify fees, lines and sales counted by entry_kind); cost-derived columns need view_costs (NULL otherwise, D30); refunds and consignment and settlement figures on the sale basis only. At most 731 days, so at most 731 rows.';

-- report_breakdown: the D274 definitions and the Shopify fees group.
create or replace function public.report_breakdown(
  p_from date,
  p_to date,
  p_basis public.report_date_basis default 'sale',
  p_dimension public.report_dimension default 'job',
  p_max_rows integer default 200,
  p_key text default null,
  p_after_sale_total numeric default null,
  p_after_key text default null
)
returns table (
  key text,
  entity_type text,
  entity_id uuid,
  label text,
  detail text,
  line_count integer,
  job_count integer,
  sale_count integer,
  quantity numeric,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  yield_after_cc numeric,
  first_at timestamptz,
  last_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_costs boolean;
  v_basis public.report_date_basis;
  v_dimension public.report_dimension;
  v_max integer;
begin
  perform private.require_permission('view_financial_reports');
  v_costs := private.has_permission('view_costs');
  perform private.report_require_range(p_from, p_to);
  v_basis := coalesce(p_basis, 'sale');
  v_dimension := coalesce(p_dimension, 'job');
  if (p_after_sale_total is null) <> (p_after_key is null)
     or (p_after_key is not null and p_key is not null)
     or (p_key is not null and not private.report_key_valid(v_dimension, p_key)) then
    raise exception using
      errcode = 'P0001',
      message = 'report_key_invalid',
      detail = 'The breakdown key or cursor does not fit the dimension.';
  end if;
  v_max := greatest(1, least(coalesce(p_max_rows, 200), 500));

  return query
    with g as (
      select
        private.report_key(
          v_dimension, r.source, r.document_id, r.product_id, r.category_id, r.service_id, r.line_type,
          r.lead_mechanic_id, r.ownership_type, r.channel
        ) as k,
        min(r.source) as src,
        (count(*) filter (where r.entry_kind = 'line'))::integer as line_count,
        (count(distinct r.document_id) filter (where r.source = 'work_order' and r.entry_kind = 'line'))::integer
          as job_count,
        (count(distinct r.document_id) filter (where r.source = 'sale' and r.entry_kind = 'line'))::integer as sale_count,
        sum(r.quantity)::numeric as quantity,
        sum(r.sale_total)::numeric as sale_total,
        sum(r.cost_total)::numeric as cost_total,
        sum(r.yield_total)::numeric as yield_total,
        sum(r.cult_commons_share)::numeric as cult_commons_share,
        sum(r.bicii_yield_after_cc)::numeric as yield_after_cc,
        min(r.basis_at) as first_at,
        max(r.basis_at) as last_at
      from private.report_rows(p_from, p_to, v_basis) r
      group by 1
    ),
    page as (
      select
        g.*,
        case when g.k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then g.k::uuid end as eid
      from g
      where (p_key is null or g.k = p_key)
        and (
          p_after_key is null
          or g.sale_total < p_after_sale_total
          or (g.sale_total = p_after_sale_total and g.k collate "C" > p_after_key collate "C")
        )
      order by g.sale_total desc, g.k collate "C" asc
      limit v_max
    )
    select
      pg.k,
      case
        when v_dimension = 'job' then pg.src
        when pg.eid is null then null
        when v_dimension = 'mechanic' then 'staff'
        else v_dimension::text
      end,
      pg.eid,
      (case when pg.k = 'stripe_fees' then 'Stripe fees' when pg.k = 'shopify_fees' then 'Shopify fees' else case v_dimension
         when 'job' then coalesce(wo.job_number, sa.sale_number)
         when 'product' then coalesce(p.name, 'Services and labour')
         when 'category' then coalesce(cat.name, 'Uncategorised')
         when 'service' then
           case pg.k when 'products' then 'Parts and products' when 'manual' then 'Custom lines' else s.name end
         when 'mechanic' then
           case pg.k when 'unassigned' then 'Unassigned' when 'not_workshop' then 'Not workshop' else st.display_name end
         when 'ownership' then
           case pg.k
             when 'shop_owned' then 'Shop-owned stock'
             when 'consignment' then 'Consignment'
             when 'customer_owned' then 'Customer-owned'
             else 'Services and labour'
           end
         when 'channel' then
           case pg.k when 'workshop' then 'Workshop' when 'retail' then 'Retail' else 'Online' end
       end end)::text,
      (case v_dimension
         when 'job' then
           case
             when wo.id is not null then pg_catalog.concat_ws(
               ' · ',
               private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone),
               b.brand || ' ' || b.model || coalesce(' ' || b.variant, '')
             )
             when sa.source = 'online_shopify' then 'Online order ' || coalesce(sa.shopify_order_name, '')
             else 'Retail sale'
           end
         when 'product' then nullif(pg_catalog.concat_ws(' · ', p.short_id, p.sku), '')
         when 'category' then
           case cat.kind when 'service' then 'Service category' when 'product' then 'Product category' end
         when 'mechanic' then case when st.id is not null and not st.active then 'No longer active' end
       end)::text,
      pg.line_count,
      pg.job_count,
      pg.sale_count,
      case when v_dimension = 'product' then pg.quantity end,
      pg.sale_total,
      case when v_costs then pg.cost_total end,
      case when v_costs then pg.yield_total end,
      case when v_costs then pg.cult_commons_share end,
      case when v_costs then pg.yield_after_cc end,
      pg.first_at,
      pg.last_at
    from page pg
    left join public.work_orders wo on v_dimension = 'job' and wo.id = pg.eid
    left join public.customers c on c.id = wo.customer_id
    left join public.bikes b on b.id = wo.bike_id
    left join public.sales sa on v_dimension = 'job' and sa.id = pg.eid
    left join public.products p on v_dimension = 'product' and p.id = pg.eid
    left join public.categories cat on v_dimension = 'category' and cat.id = pg.eid
    left join public.services s on v_dimension = 'service' and s.id = pg.eid
    left join public.staff st on v_dimension = 'mechanic' and st.id = pg.eid
    order by pg.sale_total desc, pg.k collate "C" asc;
end;
$$;

comment on function public.report_breakdown(date, date, public.report_date_basis, public.report_dimension, integer, text, numeric, text) is
  'view_financial_reports: the period''s lines grouped by a dimension (private.report_key; every line in exactly one group), ordered sale_total desc, key asc (collation C), which is also the keyset: (p_after_sale_total, p_after_key) returns the groups after it; p_key returns that one group (drill-down header). p_max_rows clamped 1..500 (ask for one more than shown). Labels by name, archived and inactive included (SPEC §23); quantity = Σ quantity for the product dimension only; cost-derived columns need view_costs (NULL otherwise, D30). D273: a job''s Stripe fee entry joins its job, mechanic and channel groups and the Stripe fees group (key stripe_fees) of the other dimensions; line_count and job_count count lines only; D274: a Shopify fee entry joins its sale''s or job''s group, the mechanic and channel groups, and the Shopify fees group (key shopify_fees) of the other dimensions, and sale_count counts sales with a line; yield_after_cc = Σ bicii_yield_after_cc. report_key_invalid for a key that fits no dimension value, half a cursor, or a cursor with p_key.';

-- private.integration_exceptions: the D273 definition with the D274 Shopify
-- fee rows (same signature; its privileges are kept).
create or replace function private.integration_exceptions()
returns table (
  kind text,
  severity text,
  entity_type text,
  entity_id uuid,
  entity_label text,
  subject_label text,
  days integer,
  quantity integer,
  since timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'integration_failed'::text,
         'danger'::text,
         'integration_job'::text,
         q.id,
         (case when q.kind = 'shopify_event' then coalesce(e.subject, e.topic) else p.short_id end)::text,
         pg_catalog.left(q.last_error, 300)::text,
         (private.shop_today() - private.shop_day(q.created_at))::integer,
         null::integer,
         q.created_at
  from public.integration_retry_queue q
  left join public.integration_events e on e.id = q.integration_event_id
  left join public.products p on p.id = q.product_id
  where q.status = 'needs_attention'
    and private.is_admin()

  union all

  -- D159b: payment conditions (public.payment_issues), admins and managers.
  select 'payment_attention'::text,
         iss.severity::text,
         'work_order'::text,
         iss.work_order_id,
         w.job_number::text,
         pg_catalog.left(iss.message, 300)::text,
         (private.shop_today() - private.shop_day(iss.since))::integer,
         null::integer,
         iss.since
  from public.payment_issues iss
  join public.work_orders w on w.id = iss.work_order_id
  where private.can_record_refunds()

  union all

  -- D159b, D86: Stripe deliveries BICII could not apply, or could not
  -- store, admins only. A not_recorded rejection clears once one of
  -- Stripe's retries of the same body is stored. An event about a refund
  -- in another currency or mode (currency_mismatch, livemode_mismatch)
  -- whose refund row payment_attention lists as refund_not_counted (linked
  -- to its payment, not failed or canceled, another currency or a stored
  -- mode that is not the payment's: the same test as payment_issues) is
  -- left to that row, so it is listed once. A failed or canceled one, which
  -- refund_not_counted leaves out, and an event whose own mode differs
  -- while its stored refund row matches (counted) keep this row. Several
  -- events about the same object with the same outcome are one row: the
  -- earliest in the window.
  select 'stripe_attention'::text,
         'danger'::text,
         (case when e.work_order_id is null then 'stripe_event' else 'work_order' end)::text,
         coalesce(e.work_order_id, e.id),
         coalesce(w.job_number, 'Stripe')::text,
         (case coalesce(e.outcome, e.rejection_reason::text)
            when 'payment_not_found' then 'Stripe reported a payment BICII has no record of. Check it in Stripe.'
            when 'session_mismatch' then 'A Stripe payment did not match its BICII record. Check it in Stripe.'
            when 'livemode_mismatch' then 'Stripe data from the other mode (test or live) was not applied. Check the Stripe keys.'
            when 'currency_mismatch' then 'Stripe reported a refund in another currency, and BICII did not count it. Check it in Stripe.'
            when 'stripe_fee_currency_mismatch' then 'Stripe charged this payment''s fee in another currency, so BICII did not record it and Cult Commons is provisional. Ask engineering.'
            when 'object_invalid' then 'Stripe sent data BICII could not read. Check Settings → Customer payments.'
            when 'unexpected_payment_status' then 'Stripe reported an unexpected payment status. Check it in Stripe.'
            when 'read_mismatch' then 'A Stripe read did not match its payment. Ask engineering.'
            when 'not_recorded' then 'A Stripe delivery could not be recorded; Stripe is retrying it. Ask engineering if this stays.'
            else 'A Stripe event needs attention. Check it in Stripe.'
          end)::text,
         (private.shop_today() - private.shop_day(e.received_at))::integer,
         null::integer,
         e.received_at
  from public.stripe_events e
  left join public.work_orders w on w.id = e.work_order_id
  where private.is_admin()
    and ((e.status = 'needs_attention' and e.received_at > pg_catalog.now() - interval '30 days'
          and not exists (
            select 1
            from public.payment_refunds r
            join public.payments p on p.id = r.payment_id
            where e.outcome in ('currency_mismatch', 'livemode_mismatch')
              and e.object_type = 'refund'
              and r.stripe_refund_id = e.object_id
              and r.status not in ('failed', 'canceled')
              and (r.currency <> p.currency or (r.livemode is not null and r.livemode <> p.livemode)))
          and not exists (
            select 1
            from public.stripe_events o
            where e.object_id is not null
              and o.object_id = e.object_id
              and o.object_type is not distinct from e.object_type
              and o.outcome = e.outcome
              and o.status = 'needs_attention'
              and o.received_at > pg_catalog.now() - interval '30 days'
              and (o.received_at, o.id) < (e.received_at, e.id)))
      or (e.rejection_reason = 'not_recorded' and e.last_delivered_at > pg_catalog.now() - interval '3 days'
          and not exists (select 1 from public.stripe_events v
                          where v.body_sha256 = e.body_sha256 and v.rejection_reason is null)))

  union all

  -- D273: a completed job whose Stripe payment was paid more than a day
  -- ago and whose fee is still not read (the key lacks Balance: Read, or
  -- Stripe has not settled it): its Cult Commons is provisional. Admins only.
  select 'stripe_attention'::text,
         'warning'::text,
         'work_order'::text,
         w.id,
         w.job_number::text,
         'Stripe''s fee on a payment for this job has not been read yet, so its Cult Commons is provisional. Check the Stripe key has Balance: Read, then press Check with Stripe.'::text,
         (private.shop_today() - private.shop_day(min(p.paid_at)))::integer,
         (count(*))::integer,
         min(p.paid_at)
  from public.payments p
  join public.work_orders w on w.id = p.work_order_id
  where private.is_admin()
    and p.status in ('paid', 'partially_refunded', 'refunded')
    and w.completed_at is not null and w.status <> 'cancelled'
    and p.paid_at < pg_catalog.now() - interval '1 day'
    and not exists (select 1 from public.stripe_payment_fees f where f.payment_id = p.id)
  group by w.id, w.job_number

  union all

  -- D274: an online sale whose Shopify Payments fee the sweep has tried and
  -- still not read a day after the sale (warning: the app may lack orders access, or Shopify has
  -- not put the fee on yet), or whose read needs attention or stopped after
  -- 20 pending reads (danger): its Cult Commons is provisional. Admins only
  -- (integration_failed, D86).
  select 'integration_failed'::text,
         (case when r.last_outcome in ('shopify_fee_currency_mismatch', 'object_invalid', 'read_mismatch')
                 or coalesce(r.pending_reads, 0) >= 20
               then 'danger' else 'warning' end)::text,
         'sale'::text,
         sa.id,
         sa.sale_number::text,
         (case
            when r.last_outcome = 'shopify_fee_currency_mismatch'
              then 'Shopify charged this sale''s fee in another currency, so BICII did not record it and Cult Commons is provisional. Ask engineering.'
            when r.last_outcome in ('object_invalid', 'read_mismatch')
              then 'Shopify sent fee data for this sale BICII could not read, so Cult Commons is provisional. Ask engineering.'
            when coalesce(r.pending_reads, 0) >= 20
              then 'Shopify has still not reported the fee on this sale, so Cult Commons is provisional. Ask engineering.'
            else 'Shopify''s fee on this online sale has not been read yet, so its Cult Commons is provisional. Check the Shopify app has the read_orders and read_all_orders scopes.'
          end)::text,
         (private.shop_today() - private.shop_day(sa.recognized_at))::integer,
         null::integer,
         sa.recognized_at
  from public.sales sa
  left join private.shopify_fee_reads r on r.sale_id = sa.id
  where private.is_admin()
    -- Only once the sweep has tried it: while Shopify is off nothing reads
    -- fees (the reports still flag the sale pending).
    and r.sale_id is not null
    and sa.source = 'online_shopify'
    and sa.status <> 'voided'
    and (sa.recognized_at < pg_catalog.now() - interval '1 day'
         or r.last_outcome in ('shopify_fee_currency_mismatch', 'object_invalid', 'read_mismatch'))
    and not exists (select 1 from public.shopify_sale_fees f where f.sale_id = sa.id);
$$;
comment on function private.integration_exceptions() is
  'D86, D159b: the integration rows of reporting.operational_exceptions, Phase 10''s nine-column shape. integration_failed (danger): one per needs_attention Shopify job, admins only. payment_attention: one per public.payment_issues row (its severity; entity the job; subject the issue''s message), active admins and managers (private.can_record_refunds). stripe_attention (danger): a Stripe event left needs_attention in the last 30 days (except a currency_mismatch or livemode_mismatch about a refund that payment_attention lists as refund_not_counted: linked, not failed or canceled, in another currency or stored mode; a failed or canceled one stays here; one row per Stripe object and outcome, the earliest), or a not_recorded delivery in the last 3 days that no stored retry of the same body has cleared, admins only (entity the job, else the event). D273: stripe_attention also lists a fee read in another currency (stripe_fee_currency_mismatch, danger) and (warning, quantity = payments) a completed job with a Stripe payment paid more than a day ago whose fee is still not read. D274: integration_failed also lists (entity the sale) an online sale whose Shopify fee the sweep has tried and not read a day after the sale (warning) or whose fee read needs attention or stopped after 20 pending reads (danger), admins only. Computed live, never stored. Read only through reporting.operational_exceptions inside the definer RPCs; no API role may execute it.';

-- ---------------------------------------------------------------------------
-- public.work_order_totals_staff: the D273 definition with the job's
-- Shopify share appended (D274) and the after-fees figures net of both
-- fees, under one floor: Stripe borne = least(stripe, gross), Shopify
-- borne = least(share, gross - Stripe borne). A cancelled job's Cult
-- Commons bears nothing.
-- ---------------------------------------------------------------------------
create or replace view public.work_order_totals_staff
with (security_barrier)
as
  select t.work_order_id, t.currency, t.line_count, t.sale_total, t.cost_total, t.yield_total,
         t.cult_commons_share,
         (t.yield_total - t.cult_commons_share)::public.money_amount as bicii_yield_after_cc,
         t.cost_pending_count,
         f.stripe_fees::public.money_amount as stripe_fees,
         f.borne::public.money_amount as stripe_fees_borne,
         (t.cult_commons_share - f.borne - h.borne)::public.money_amount as cult_commons_after_fees,
         (t.yield_total - (t.cult_commons_share - f.borne - h.borne) - f.stripe_fees - h.shopify_fees)::public.money_amount
           as bicii_yield_after_fees,
         f.pending as stripe_fee_pending_count,
         h.shopify_fees::public.money_amount as shopify_fees,
         h.borne::public.money_amount as shopify_fees_borne,
         h.pending as shopify_fee_pending_count
  from (
    select w.id as work_order_id,
           w.currency,
           w.status,
           (count(li.id) filter (where li.voided_at is null))::integer as line_count,
           coalesce(sum(li.sale_total) filter (where li.voided_at is null), 0)::public.money_amount as sale_total,
           coalesce(sum(li.cost_total) filter (where li.voided_at is null), 0)::public.money_amount as cost_total,
           coalesce(sum(li.yield_total) filter (where li.voided_at is null), 0)::public.money_amount as yield_total,
           -- D1: the job's Cult Commons is the sum of its lines' shares.
           coalesce(sum(li.cult_commons_share) filter (where li.voided_at is null), 0)::public.money_amount
             as cult_commons_share,
           -- D14: live lines with no cost entered; while > 0 the figures
           -- above treat their cost as 0 and are provisional.
           (count(li.id) filter (where li.voided_at is null and li.cost_pending))::integer
             as cost_pending_count
    from public.work_orders w
    left join public.work_order_line_items li on li.work_order_id = w.id
    group by w.id, w.currency
  ) t
  left join reporting.work_order_stripe_fees sf on sf.work_order_id = t.work_order_id
  left join reporting.work_order_shopify_fees hf on hf.work_order_id = t.work_order_id
  cross join lateral (
    select coalesce(sf.stripe_fees, 0.00)::numeric as stripe_fees,
           (case when t.status = 'cancelled' then 0.00
                 else least(coalesce(sf.stripe_fees, 0.00), t.cult_commons_share) end)::numeric as borne,
           coalesce(sf.stripe_fee_pending_count, 0)::integer as pending
  ) f
  cross join lateral (
    select coalesce(hf.shopify_fees, 0.00)::numeric as shopify_fees,
           (case when t.status = 'cancelled' then 0.00
                 else least(coalesce(hf.shopify_fees, 0.00), t.cult_commons_share - f.borne) end)::numeric as borne,
           coalesce(hf.shopify_fee_pending_count, 0)::integer as pending
  ) h
  where (select private.has_permission('view_costs'));

comment on view public.work_order_totals_staff is
  'Per job: sale, cost, yield, Cult Commons (sum of line shares, D1), BICII yield after CC and the number of live lines with no cost entered (D14), for view_costs only. D273: stripe_fees (Stripe''s fees less GST on the job''s paid, partly refunded or refunded Stripe payments), stripe_fees_borne (least(fees, Cult Commons); 0 for a cancelled job) and stripe_fee_pending_count (paid payments whose fee is not read yet). D274: shopify_fees (the job''s build order share of its order''s Shopify Payments fees, less GST), shopify_fees_borne (least(that, Cult Commons - Stripe fees borne); 0 for a cancelled job) and shopify_fee_pending_count; cult_commons_after_fees and bicii_yield_after_fees (yield - CC after fees - both fees) are net of both. Reports deduct the fees on the job''s completion.';


-- ---------------------------------------------------------------------------
-- public.work_order_yield: the D273 definition with the D274 Shopify columns
-- appended and the after-fees figures net of both (drop and create).
-- ---------------------------------------------------------------------------
drop function public.work_order_yield(uuid);

create function public.work_order_yield(target_work_order_id uuid)
returns table (
  work_order_id uuid,
  job_number text,
  status public.work_order_status,
  currency text,
  line_count integer,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  bicii_yield_after_cc numeric,
  loss_line_count integer,
  loss_total numeric,
  cult_commons_rates numeric[],
  recognized_at timestamptz,
  recognized_day date,
  cost_pending_count integer,
  stripe_fees numeric,
  stripe_fees_borne numeric,
  cult_commons_after_fees numeric,
  bicii_yield_after_fees numeric,
  stripe_fee_pending_count integer,
  shopify_fees numeric,
  shopify_fees_borne numeric,
  shopify_fee_pending_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('view_costs');
  if not exists (select 1 from public.work_orders w where w.id = work_order_yield.target_work_order_id) then
    raise exception 'work order % not found', work_order_yield.target_work_order_id using errcode = 'P0002';
  end if;

  return query
    with y as (
      select
        wo.id,
        wo.job_number::text as job_number,
        wo.status,
        wo.currency::text as currency,
        (count(li.id))::integer as line_count,
        coalesce(sum(li.sale_total), 0)::numeric as sale_total,
        coalesce(sum(li.cost_total), 0)::numeric as cost_total,
        coalesce(sum(li.yield_total), 0)::numeric as yield_total,
        -- D1: the sum of the lines' own shares.
        coalesce(sum(li.cult_commons_share), 0)::numeric as cc,
        coalesce(sum(li.yield_total - li.cult_commons_share), 0)::numeric as after_cc,
        (count(li.id) filter (where li.yield_total < 0))::integer as loss_lines,
        coalesce(sum(li.yield_total) filter (where li.yield_total < 0), 0)::numeric as loss_total,
        coalesce(
          array(
            select distinct r.cult_commons_rate_snapshot::numeric
            from public.work_order_line_items r
            where r.work_order_id = wo.id and r.voided_at is null
            order by 1
          ),
          '{}'::numeric[]
        ) as rates,
        wo.completed_at,
        private.shop_day(wo.completed_at) as completed_day,
        (count(li.id) filter (where li.cost_pending))::integer as cost_pending
      from public.work_orders wo
      left join public.work_order_line_items li on li.work_order_id = wo.id and li.voided_at is null
      where wo.id = work_order_yield.target_work_order_id
      group by wo.id
    )
    select
      y.id, y.job_number, y.status, y.currency, y.line_count, y.sale_total, y.cost_total,
      y.yield_total, y.cc, y.after_cc, y.loss_lines, y.loss_total, y.rates, y.completed_at,
      y.completed_day, y.cost_pending,
      f.fees,
      f.borne,
      y.cc - f.borne - h.borne,
      y.yield_total - (y.cc - f.borne - h.borne) - f.fees - h.fees,
      f.pending,
      h.fees,
      h.borne,
      h.pending
    from y
    left join reporting.work_order_stripe_fees sf on sf.work_order_id = y.id
    left join reporting.work_order_shopify_fees hf on hf.work_order_id = y.id
    cross join lateral (
      select coalesce(sf.stripe_fees, 0.00)::numeric as fees,
             (case when y.status = 'cancelled' then 0.00
                   else least(coalesce(sf.stripe_fees, 0.00), y.cc) end)::numeric as borne,
             coalesce(sf.stripe_fee_pending_count, 0)::integer as pending
    ) f
    -- D274: the build order's Shopify share, under the same floor.
    cross join lateral (
      select coalesce(hf.shopify_fees, 0.00)::numeric as fees,
             (case when y.status = 'cancelled' then 0.00
                   else least(coalesce(hf.shopify_fees, 0.00), y.cc - f.borne) end)::numeric as borne,
             coalesce(hf.shopify_fee_pending_count, 0)::integer as pending
    ) h;
end;
$$;

comment on function public.work_order_yield(uuid) is
  'view_costs: one job''s running economics over its live lines (sale, cost, yield, Cult Commons = sum of line shares (D1), BICII after CC, losses, snapshot rates, cost-pending count (D14)) and its recognition (completed_at and its shop day, D32; NULL while open, cancelled or reopened). D273: stripe_fees (less GST), stripe_fees_borne (least(fees, Cult Commons); 0 once cancelled), cult_commons_after_fees, bicii_yield_after_fees and stripe_fee_pending_count; reports deduct the fees on completion. D274: shopify_fees (the job''s build order share of its order''s Shopify Payments fees, less GST), shopify_fees_borne (least(that, Cult Commons less Stripe fees borne); 0 once cancelled) and shopify_fee_pending_count; cult_commons_after_fees and bicii_yield_after_fees are net of both fees. Unknown job P0002.';

-- ---------------------------------------------------------------------------
-- public.financial_lines: the D273 definition with shopify_fee and
-- shopify_fee_pending appended (drop and create). A fee entry of either kind
-- is a cost figure: only view_costs callers get it (D30).
-- ---------------------------------------------------------------------------
drop function public.financial_lines(date, date);

create function public.financial_lines(from_day date, to_day date)
returns table (
  entry_key text,
  source text,
  entry_kind text,
  source_line_id uuid,
  document_id uuid,
  document_number text,
  channel text,
  recognized_at timestamptz,
  recognized_day date,
  line_type text,
  service_id uuid,
  product_id uuid,
  inventory_unit_id uuid,
  category_id uuid,
  ownership_type text,
  consignment_item_id uuid,
  customer_id uuid,
  bike_id uuid,
  lead_mechanic_id uuid,
  description text,
  quantity numeric,
  unit_sale_price numeric,
  unit_direct_cost numeric,
  cult_commons_rate numeric,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  bicii_yield_after_cc numeric,
  is_loss boolean,
  currency text,
  cost_pending boolean,
  stripe_fee numeric,
  stripe_fee_pending boolean,
  shopify_fee numeric,
  shopify_fee_pending boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  costs boolean;
  first_day date;
  last_day date;
begin
  perform private.require_permission('view_financial_reports');
  costs := private.has_permission('view_costs');

  first_day := coalesce(financial_lines.from_day, financial_lines.to_day, private.shop_today());
  last_day := coalesce(financial_lines.to_day, financial_lines.from_day, private.shop_today());
  if first_day > last_day then
    raise exception using
      errcode = 'P0001',
      message = 'report_range_invalid',
      detail = 'The start day is after the end day.';
  end if;
  if last_day - first_day > 30 then
    raise exception using
      errcode = 'P0001',
      message = 'report_range_invalid',
      detail = 'Financial lines cover at most 31 days at a time.';
  end if;

  return query
    select
      fl.entry_key,
      fl.source,
      fl.entry_kind,
      fl.source_line_id,
      fl.document_id,
      fl.document_number,
      fl.channel,
      fl.recognized_at,
      fl.recognized_day,
      fl.line_type,
      fl.service_id,
      fl.product_id,
      fl.inventory_unit_id,
      fl.category_id,
      fl.ownership_type,
      fl.consignment_item_id,
      fl.customer_id,
      fl.bike_id,
      fl.lead_mechanic_id,
      fl.description,
      fl.quantity,
      fl.unit_sale_price,
      case when costs then fl.unit_direct_cost end,
      case when costs then fl.cult_commons_rate end,
      fl.sale_total,
      case when costs then fl.cost_total end,
      case when costs then fl.yield_total end,
      case when costs then fl.cult_commons_share end,
      case when costs then fl.bicii_yield_after_cc end,
      case when costs then fl.is_loss end,
      fl.currency,
      fl.cost_pending,
      case when costs then fl.stripe_fee end,
      case when costs then fl.stripe_fee_pending end,
      case when costs then fl.shopify_fee end,
      case when costs then fl.shopify_fee_pending end
    from reporting.financial_lines fl
    where fl.recognized_at >= private.shop_day_start(first_day)
      and fl.recognized_at < private.shop_day_start(last_day + 1)
      and (costs or fl.entry_kind = 'line')
    order by fl.recognized_at, fl.document_number, fl.entry_kind, fl.source_line_id;
end;
$$;

comment on function public.financial_lines(date, date) is
  'view_financial_reports: recognised entries (D32) of from_day..to_day inclusive (at most 31 days, else report_range_invalid); cost-derived columns need view_costs, NULL otherwise (D30). D273: stripe_fee and stripe_fee_pending appended (view_costs); the stripe_fee entries (entry_kind stripe_fee, one per completed job with Stripe fees) only for view_costs callers. D274: shopify_fee and shopify_fee_pending appended (view_costs); the shopify_fee entries (one per online sale, one per completed job with a build order share) only for view_costs callers. Count lines with entry_kind = ''line''. Callers page with .range().';

-- ---------------------------------------------------------------------------
-- public.report_line_items: the D273 definition with shopify_fee appended
-- (D274, view_costs). Before it, the 20261006001000 definition with stripe_fee
-- and bicii_yield_after_cc appended (view_costs, D30), so the line list and
-- its export carry the part of a job's Stripe fees BICII bears (on a fee
-- entry whose fees exceed the job's gross share, yield - CC is not
-- bicii_yield_after_cc). Drop and create (the return type grows).
-- ---------------------------------------------------------------------------
drop function public.report_line_items(date, date, public.report_date_basis, public.report_dimension, text, integer, timestamptz, uuid);

create function public.report_line_items(
  p_from date,
  p_to date,
  p_basis public.report_date_basis default 'sale',
  p_dimension public.report_dimension default null,
  p_key text default null,
  p_max_rows integer default 100,
  p_after_at timestamptz default null,
  p_after_id uuid default null
)
returns table (
  source_line_id uuid,
  source text,
  channel text,
  basis_at timestamptz,
  document_id uuid,
  document_number text,
  line_type text,
  description text,
  quantity numeric,
  unit_sale_price numeric,
  sale_total numeric,
  cost_total numeric,
  yield_total numeric,
  cult_commons_share numeric,
  cost_pending boolean,
  ownership_type text,
  category_name text,
  mechanic_name text,
  currency text,
  stripe_fee numeric,
  bicii_yield_after_cc numeric,
  shopify_fee numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_costs boolean;
  v_basis public.report_date_basis;
  v_max integer;
begin
  perform private.require_permission('view_financial_reports');
  v_costs := private.has_permission('view_costs');
  perform private.report_require_range(p_from, p_to);
  v_basis := coalesce(p_basis, 'sale');
  if (p_dimension is null) <> (p_key is null)
     or (p_key is not null and not private.report_key_valid(p_dimension, p_key))
     or (p_after_at is null) <> (p_after_id is null) then
    raise exception using
      errcode = 'P0001',
      message = 'report_key_invalid',
      detail = 'The dimension, key or cursor of the line list does not fit.';
  end if;
  v_max := greatest(1, least(coalesce(p_max_rows, 100), 1000));

  return query
    select
      r.source_line_id,
      r.source,
      r.channel,
      r.basis_at,
      r.document_id,
      r.document_number,
      r.line_type,
      r.description,
      r.quantity,
      r.unit_sale_price,
      r.sale_total,
      case when v_costs then r.cost_total end,
      case when v_costs then r.yield_total end,
      case when v_costs then r.cult_commons_share end,
      r.cost_pending,
      r.ownership_type,
      cat.name::text,
      st.display_name::text,
      r.currency,
      case when v_costs then r.stripe_fee end,
      case when v_costs then r.bicii_yield_after_cc end,
      case when v_costs then r.shopify_fee end
    from private.report_rows(
      p_from, p_to, v_basis, p_after_at, p_after_id,
      -- Without a key filter the page limit goes into the per-basis query.
      case when p_dimension is null then v_max end
    ) r
    left join public.categories cat on cat.id = r.category_id
    left join public.staff st on st.id = r.lead_mechanic_id
    where p_dimension is null
       or private.report_key(
            p_dimension, r.source, r.document_id, r.product_id, r.category_id, r.service_id, r.line_type,
            r.lead_mechanic_id, r.ownership_type, r.channel
          ) = p_key
    order by r.basis_at desc, r.source_line_id desc
    limit v_max;
end;
$$;

comment on function public.report_line_items(date, date, public.report_date_basis, public.report_dimension, text, integer, timestamptz, uuid) is
  'view_financial_reports: the lines a basis counts in p_from..p_to (optionally one breakdown group: p_dimension and p_key together), newest basis_at first; keyset (p_after_at, p_after_id) = the last row''s (basis_at, source_line_id); p_max_rows clamped 1..1000. cost_total, yield_total, cult_commons_share, stripe_fee and bicii_yield_after_cc need view_costs (NULL otherwise, D30); a 0.00 price or cost is a known value (D24 amended). D273: a completed job''s Stripe fee entry (line_type stripe_fee) is listed for view_costs callers only, with stripe_fee = its fees and bicii_yield_after_cc = -(fees - what Cult Commons bore), so the Σ of bicii_yield_after_cc over the list is the summary''s yield_after_cc. D274: a Shopify fee entry (line_type shopify_fee) likewise, with shopify_fee = its fees. report_key_invalid for half a dimension/key pair, a key that fits no dimension value, or half a cursor.';

-- ---------------------------------------------------------------------------
-- public.today_dashboard: the D273 definition with the day's Shopify fees
-- appended (D274: shopify_fees, shopify_fees_borne, shopify_fee_pending_sales,
-- shopify_fee_pending_jobs). Before it: the 20261006001300 definition with
-- the day's Stripe fees appended (D273; view_costs, NULL otherwise): stripe_fees,
-- stripe_fees_borne (what Cult Commons bore of them) and
-- stripe_fee_pending_jobs (jobs completed that day whose fee is not read
-- yet). cult_commons_share and bicii_yield_after_cc already come net of the
-- fees (reporting.daily_summary sums the fee entries). Drop and create.
-- ---------------------------------------------------------------------------
drop function public.today_dashboard(date);

create function public.today_dashboard(on_day date default null)
returns table (
  day date,
  is_today boolean,
  generated_at timestamptz,
  can_see_financials boolean,
  can_see_costs boolean,
  jobs_checked_in integer,
  jobs_started integer,
  jobs_completed integer,
  jobs_ready_for_collection integer,
  jobs_collected integer,
  jobs_cancelled integer,
  currency text,
  lines_recognised integer,
  gross_sales numeric,
  cogs numeric,
  yield_total numeric,
  cult_commons_share numeric,
  bicii_yield_after_cc numeric,
  loss_lines integer,
  loss_total numeric,
  parts_consumed_qty integer,
  parts_consumed_lines integer,
  parts_returned_qty integer,
  stock_adjustments integer,
  significant_stock_adjustments integer,
  appointments_scheduled integer,
  appointments_arrived integer,
  appointments_no_show integer,
  consignment_sales integer,
  consignment_sales_total numeric,
  new_consignor_liability numeric,
  received_now integer,
  waiting_now integer,
  ready_to_start_now integer,
  in_progress_now integer,
  awaiting_collection_now integer,
  open_jobs_now integer,
  overdue_now integer,
  low_stock_now integer,
  exceptions_now integer,
  cost_pending_lines integer,
  stripe_fees numeric,
  stripe_fees_borne numeric,
  stripe_fee_pending_jobs integer,
  shopify_fees numeric,
  shopify_fees_borne numeric,
  shopify_fee_pending_sales integer,
  shopify_fee_pending_jobs integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fin boolean;
  costs boolean;
  today date;
  d date;
  snap_received integer;
  snap_waiting integer;
  snap_ready integer;
  snap_in_progress integer;
  snap_awaiting integer;
  snap_open integer;
  snap_overdue integer;
  snap_low_stock integer;
  snap_exceptions integer;
  pending integer;
  fee_total numeric;
  fee_borne numeric;
  fee_pending integer;
  sfee_total numeric;
  sfee_borne numeric;
  sfee_pending_sales integer;
  sfee_pending_jobs integer;
begin
  perform private.require_staff();
  fin := private.has_permission('view_financial_reports');
  costs := fin and private.has_permission('view_costs');
  today := private.shop_today();
  d := coalesce(today_dashboard.on_day, today);
  if d > today then
    raise exception using
      errcode = 'P0001',
      message = 'report_range_invalid',
      detail = 'The dashboard shows today or an earlier day.';
  end if;

  -- D31: the current snapshot, from status, for today only (grouped as
  -- BOARD_GROUPS in src/lib/workshop.ts).
  if d = today then
    select
      (count(*) filter (where wo.status in ('received', 'diagnosing')))::integer,
      (count(*) filter (where wo.status in ('awaiting_customer', 'awaiting_parts', 'paused')))::integer,
      (count(*) filter (where wo.status = 'ready_to_start'))::integer,
      (count(*) filter (where wo.status = 'in_progress'))::integer,
      (count(*) filter (where wo.status in ('completed', 'ready_for_collection')))::integer,
      (count(*) filter (where private.work_order_status_is_open(wo.status)))::integer
    into snap_received, snap_waiting, snap_ready, snap_in_progress, snap_awaiting, snap_open
    from public.work_orders wo;

    select count(*)::integer into snap_overdue from reporting.work_order_activity wa where wa.is_overdue;
    select count(*)::integer into snap_low_stock from reporting.low_stock ls;
    -- D108: only the kinds this caller may see (the visibility of each kind
    -- is decided once, by private.exception_visible).
    with oe as materialized (
      select o.kind from reporting.operational_exceptions o
    )
    select count(*)::integer into snap_exceptions
    from oe
    where oe.kind in (
      select k.kind from (select distinct x.kind from oe x) k where private.exception_visible(k.kind)
    );
  end if;

  if fin then
    select count(*)::integer into pending
    from reporting.financial_lines fl
    where fl.recognized_at >= private.shop_day_start(d)
      and fl.recognized_at < private.shop_day_start(d + 1)
      and fl.currency = private.shop_currency()
      and fl.cost_pending;
  end if;

  -- D273: the day's Stripe fee entries (cost figures, view_costs only).
  if costs then
    select coalesce(sum(fl.stripe_fee), 0.00)::numeric,
           coalesce(-sum(fl.cult_commons_share), 0.00)::numeric,
           (count(*) filter (where fl.stripe_fee_pending))::integer
      into fee_total, fee_borne, fee_pending
    from reporting.financial_lines fl
    where fl.entry_kind = 'stripe_fee'
      and fl.recognized_at >= private.shop_day_start(d)
      and fl.recognized_at < private.shop_day_start(d + 1)
      and fl.currency = private.shop_currency();
    -- D274: the day's Shopify fee entries (sales and completed jobs).
    select coalesce(sum(fl.shopify_fee), 0.00)::numeric,
           coalesce(-sum(fl.cult_commons_share), 0.00)::numeric,
           (count(*) filter (where fl.shopify_fee_pending and fl.source = 'sale'))::integer,
           (count(*) filter (where fl.shopify_fee_pending and fl.source = 'work_order'))::integer
      into sfee_total, sfee_borne, sfee_pending_sales, sfee_pending_jobs
    from reporting.financial_lines fl
    where fl.entry_kind = 'shopify_fee'
      and fl.recognized_at >= private.shop_day_start(d)
      and fl.recognized_at < private.shop_day_start(d + 1)
      and fl.currency = private.shop_currency();
  end if;

  return query
    select
      d,
      d = today,
      pg_catalog.now(),
      fin,
      costs,
      s.jobs_checked_in,
      s.jobs_started,
      s.jobs_completed,
      s.jobs_ready_for_collection,
      s.jobs_collected,
      s.jobs_cancelled,
      s.currency,
      s.lines_recognised,
      s.gross_sales,
      s.cogs,
      s.yield_total,
      s.cult_commons_share,
      s.bicii_yield_after_cc,
      s.loss_lines,
      s.loss_total,
      s.parts_consumed_qty,
      s.parts_consumed_lines,
      s.parts_returned_qty,
      s.stock_adjustments,
      s.significant_stock_adjustments,
      s.appointments_scheduled,
      s.appointments_arrived,
      s.appointments_no_show,
      s.consignment_sales,
      s.consignment_sales_total,
      s.new_consignor_liability,
      snap_received,
      snap_waiting,
      snap_ready,
      snap_in_progress,
      snap_awaiting,
      snap_open,
      snap_overdue,
      snap_low_stock,
      snap_exceptions,
      pending,
      fee_total,
      fee_borne,
      fee_pending,
      sfee_total,
      sfee_borne,
      sfee_pending_sales,
      sfee_pending_jobs
    from public.daily_summary(d, d) s;
end;
$$;

comment on function public.today_dashboard(date) is
  'Active staff: one row for on_day (null = today; a future day raises report_range_invalid): the daily summary (gated by D30) plus, for today only, the current job snapshot grouped as BOARD_GROUPS, overdue (D20), low stock and the exceptions the caller may see (D31, D108: private.exception_visible), and the day''s cost-pending entries (D14; NULL without view_financial_reports). D273, view_costs (NULL otherwise): the day''s stripe_fees (less GST), stripe_fees_borne (what Cult Commons bore; cult_commons_share is already net of it) and stripe_fee_pending_jobs (jobs completed that day whose Stripe fee is not read yet: provisional). D274, view_costs: shopify_fees (the day''s sales'' and completed jobs'' shares of their orders'' Shopify Payments fees, less GST), shopify_fees_borne, shopify_fee_pending_sales and shopify_fee_pending_jobs (not read yet: provisional).';

-- ---------------------------------------------------------------------------
-- Privileges and RLS (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  private.shopify_sale_fees_guard(),
  private.shopify_fee_decimal(text),
  private.apply_shopify_fee(uuid, jsonb, text),
  private.report_key_valid(public.report_dimension, text),
  private.report_key(public.report_dimension, text, uuid, uuid, uuid, uuid, text, uuid, text, text),
  private.report_rows(date, date, public.report_date_basis, timestamptz, uuid, integer, boolean),
  private.integration_exceptions()
from public, anon, authenticated, service_role;

revoke all on function
  public.record_shopify_fee_read(uuid, jsonb, text),
  public.note_shopify_fee_read_failed(uuid, text),
  public.shopify_fees_due(integer, uuid),
  public.sale_shopify_fees(uuid[]),
  public.report_period_summary(date, date, public.report_date_basis),
  public.report_period_series(date, date, public.report_date_basis, public.report_grain),
  public.report_breakdown(date, date, public.report_date_basis, public.report_dimension, integer, text, numeric, text),
  public.work_order_yield(uuid),
  public.financial_lines(date, date),
  public.report_line_items(date, date, public.report_date_basis, public.report_dimension, text, integer, timestamptz, uuid),
  public.today_dashboard(date)
from public, anon, authenticated, service_role;

grant execute on function
  public.record_shopify_fee_read(uuid, jsonb, text),
  public.note_shopify_fee_read_failed(uuid, text),
  public.shopify_fees_due(integer, uuid)
to service_role;

grant execute on function
  public.sale_shopify_fees(uuid[]),
  public.report_period_summary(date, date, public.report_date_basis),
  public.report_period_series(date, date, public.report_date_basis, public.report_grain),
  public.report_breakdown(date, date, public.report_date_basis, public.report_dimension, integer, text, numeric, text),
  public.work_order_yield(uuid),
  public.financial_lines(date, date),
  public.report_line_items(date, date, public.report_date_basis, public.report_dimension, text, integer, timestamptz, uuid),
  public.today_dashboard(date)
to authenticated;

alter table public.shopify_sale_fees enable row level security;
revoke all on table public.shopify_sale_fees from public, anon, authenticated, service_role;
-- Read-only for the API; written only inside record_shopify_fee_read.
grant select on table public.shopify_sale_fees to authenticated;

-- D274, D30: a fee is a cost figure: view_costs only.
create policy shopify_sale_fees_select_costs on public.shopify_sale_fees
  for select to authenticated
  using ((select private.has_permission('view_costs')));
