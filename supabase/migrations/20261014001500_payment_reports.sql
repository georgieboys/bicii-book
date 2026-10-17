-- Phase 14 step 3: payment reports (PLAN D154 and its build defaults
-- D154a-e; ADR-025, ADR-022; DATA-MODEL §14, §15, §16; RISKS R-055,
-- R-087, R-089, R-090).
--
-- A "Customer payments" section on Reports, apart from the sales figures
-- and not driven by the date basis (D154a): money taken online, refunded
-- online, recorded at the counter and given back at the counter, by the
-- shop day it moved, and what is held on jobs now. A payment is money
-- held, not revenue (D154): nothing here changes reporting.financial_lines,
-- reporting.report_lines, daily_summary, today_dashboard or any
-- report_period_* RPC (tests/db/stripe-payments.test.ts §15 and
-- tests/db/payment-reports.test.ts snapshot them). GST: nothing.
--
--   reporting.payment_movements  the ONE definition of money moved, one
--                         row per movement (security invoker, no API
--                         grants; read through the RPCs below):
--     online_payment      a Stripe payment in the paid group (paid,
--                         partially_refunded, refunded), at paid_at
--                         (Stripe's time, or the read time when a server
--                         read confirmed it; D159d), amount
--                         coalesce(amount_received, amount): the job
--                         card's paid_online rule. other_currency when
--                         Stripe took another currency (amount_received
--                         null): counted at the amount asked, as on the
--                         card, and flagged.
--     online_refund       a refund counted by private.payment_refund_total's
--                         rule (succeeded, the payment's currency, livemode
--                         null or the payment's) of a paid-group payment
--                         (matched refunds only: an unmatched refund is not
--                         BICII's money), at coalesce(stripe_created_at,
--                         created_at), negative. The two dates are two
--                         branches (Stripe's created, else the row's
--                         created_at when Stripe sent none), so a range on
--                         "at" reads as
--                           (stripe_created_at >= s and stripe_created_at < e)
--                           or (stripe_created_at is null
--                               and created_at >= s and created_at < e)
--                         and each branch uses its own index. Per payment
--                         the refund movements add up to refunded_amount.
--     counter_payment     a D161 counter payment at received_at, unless a
--                         recorded_in_error void took it out (its day
--                         restates, D101, like a reversed settlement).
--     counter_given_back  a given_back void: the payment stays on its day
--                         and this negative movement is dated voided_at,
--                         or one microsecond after the payment's
--                         received_at if that is later (a payment dated
--                         up to 5 minutes ahead and given back at once),
--                         so a give-back never comes before its payment.
--                         Its id is the counter payment's; recorded_at is
--                         voided_at.
--                         recorded_at / recorded_by: counter rows only (when
--                         and by whom an admin recorded the payment or the
--                         give-back), so back-dating shows; Stripe rows are
--                         Stripe's word (null).
--   Per job, the signed movements over all time add up to
--   work_order_payment_totals.net_paid (online - refunds + counter - given
--   back).
--
--   report_payment_summary(p_from, p_to)  one row for the shop days
--                         p_from..p_to (half open: shop_day_start(p_from) <=
--                         at < shop_day_start(p_to + 1)), shop currency.
--   report_payment_items(p_from, p_to, p_max_rows, p_after_at, p_after_id)
--                         the movements, newest first, keyset (at, id) as
--                         report_line_items.
--   report_payments_held()  NOW, from work_order_payment_totals (so it
--                         equals the job card), three groups and no grand
--                         total (D154c): open (work_order_status_is_open,
--                         net_paid > 0; amount net_paid, paid_ahead as a
--                         memo), awaiting_collection (completed or
--                         ready_for_collection; amount least(net_paid,
--                         job_total), balance_due beside it; nothing paid
--                         but a balance due included) and above_bill
--                         (held_over_total > 0 on a job that is not open).
--                         A job's amounts add up to net_paid while it is
--                         not collected; once collected, to held_over_total
--                         (the bill is settled; only the excess is held).
--
-- All three are security definer with search_path '', check
-- view_financial_reports first (D30, D154d; nothing here is cost-derived),
-- the period ones then private.report_require_range (731 days), and return
-- numeric only. Execute: authenticated only.
--
-- Indexes: payments (paid_at) for the paid group, payment_refunds
-- (stripe_created_at) and (created_at) where stripe_created_at is null.
-- counter_payments (received_at) and counter_payment_voids (voided_at)
-- exist since 20261014001300.

-- ---------------------------------------------------------------------------
-- Indexes (tests/db/period-reports.test.ts "Report queries are indexed")
-- ---------------------------------------------------------------------------
-- payments_paid_shape: paid_at is set exactly in the paid group.
create index payments_paid_at_idx on public.payments (paid_at) where paid_at is not null;
create index payment_refunds_stripe_created_idx on public.payment_refunds (stripe_created_at);
create index payment_refunds_created_fallback_idx on public.payment_refunds (created_at)
  where stripe_created_at is null;

-- ---------------------------------------------------------------------------
-- D154b, D154e: reporting.payment_movements
-- ---------------------------------------------------------------------------
create view reporting.payment_movements
with (security_invoker = true)
as
  -- A Stripe payment received.
  select
    p.paid_at as "at",
    p.id,
    'online_payment'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    coalesce(p.amount_received, p.amount)::numeric as amount,
    coalesce(p.amount_received, p.amount)::numeric as signed_amount,
    p.currency::text as currency,
    (p.amount_received is null) as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payments p
  where p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counted refund, dated by Stripe's created.
  select
    r.stripe_created_at as "at",
    r.id,
    'online_refund'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    r.amount::numeric as amount,
    (-r.amount)::numeric as signed_amount,
    r.currency::text as currency,
    false as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payment_refunds r
  join public.payments p on p.id = r.payment_id
  where r.stripe_created_at is not null
    and r.status = 'succeeded'
    and r.currency = p.currency
    and (r.livemode is null or r.livemode = p.livemode)
    and p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counted refund Stripe sent without created: dated when BICII recorded it.
  select
    r.created_at as "at",
    r.id,
    'online_refund'::text as movement,
    p.work_order_id,
    p.kind::text as kind,
    'stripe'::text as method,
    r.amount::numeric as amount,
    (-r.amount)::numeric as signed_amount,
    r.currency::text as currency,
    false as other_currency,
    null::timestamptz as recorded_at,
    null::uuid as recorded_by
  from public.payment_refunds r
  join public.payments p on p.id = r.payment_id
  where r.stripe_created_at is null
    and r.status = 'succeeded'
    and r.currency = p.currency
    and (r.livemode is null or r.livemode = p.livemode)
    and p.status in ('paid', 'partially_refunded', 'refunded')
  union all
  -- A counter payment, unless voided as recorded in error.
  select
    cp.received_at as "at",
    cp.id,
    'counter_payment'::text as movement,
    cp.work_order_id,
    cp.kind::text as kind,
    cp.method::text as method,
    cp.amount::numeric as amount,
    cp.amount::numeric as signed_amount,
    cp.currency::text as currency,
    false as other_currency,
    cp.created_at as recorded_at,
    cp.recorded_by
  from public.counter_payments cp
  where not exists (
    select 1 from public.counter_payment_voids v
    where v.counter_payment_id = cp.id and v.kind = 'recorded_in_error'
  )
  union all
  -- Counter money given back, on the void's day; never before the payment
  -- it reverses (received_at may be up to 5 minutes ahead of the void's
  -- clock): then one microsecond after it, the same shop day, and (at, id)
  -- stays a unique keyset. recorded_at keeps the void's own time.
  select
    greatest(v.voided_at, cp.received_at + interval '1 microsecond') as "at",
    cp.id,
    'counter_given_back'::text as movement,
    cp.work_order_id,
    cp.kind::text as kind,
    cp.method::text as method,
    cp.amount::numeric as amount,
    (-cp.amount)::numeric as signed_amount,
    cp.currency::text as currency,
    false as other_currency,
    v.voided_at as recorded_at,
    v.voided_by as recorded_by
  from public.counter_payment_voids v
  join public.counter_payments cp on cp.id = v.counter_payment_id
  where v.kind = 'given_back';

comment on view reporting.payment_movements is
  'D154b: one row per movement of customer money (money held, not revenue; never in the sales figures). movement online_payment (a paid-group Stripe payment at paid_at, amount coalesce(amount_received, amount), other_currency when Stripe took another currency), online_refund (a refund counted by payment_refund_total''s rule of a paid-group payment, at coalesce(stripe_created_at, created_at), as two branches so a range uses each column''s index), counter_payment (received_at; left out once voided recorded_in_error, D101) and counter_given_back (a given_back void, at voided_at, or one microsecond after the payment''s received_at if that is later, so never before its payment; recorded_at = voided_at; negative; id = the counter payment''s). amount is positive, signed_amount carries the sign; kind deposit | balance; method stripe or the counter method; recorded_at and recorded_by for counter rows only. Per job, Σ signed_amount over all time = work_order_payment_totals.net_paid. No API grants: read through report_payment_summary and report_payment_items (D30).';

revoke all on table reporting.payment_movements from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D154e: report_payment_summary
-- ---------------------------------------------------------------------------
create function public.report_payment_summary(p_from date, p_to date)
returns table (
  currency text,
  online_count integer,
  online_total numeric,
  deposit_online_total numeric,
  balance_online_total numeric,
  refund_count integer,
  refund_total numeric,
  counter_count integer,
  counter_total numeric,
  given_back_count integer,
  given_back_total numeric,
  net_total numeric,
  other_currency_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
begin
  perform private.require_permission('view_financial_reports');
  perform private.report_require_range(p_from, p_to);
  v_start := private.shop_day_start(p_from);
  v_end := private.shop_day_start(p_to + 1);
  v_currency := private.shop_currency();

  return query
    with m as (
      select x.movement, x.kind, x.amount, x.signed_amount, x.currency, x.other_currency
      from reporting.payment_movements x
      where x."at" >= v_start and x."at" < v_end
    )
    select
      v_currency,
      (count(*) filter (where m.movement = 'online_payment' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'online_payment' and m.currency = v_currency), 0.00)::numeric,
      coalesce(sum(m.amount) filter (
        where m.movement = 'online_payment' and m.kind = 'deposit' and m.currency = v_currency
      ), 0.00)::numeric,
      coalesce(sum(m.amount) filter (
        where m.movement = 'online_payment' and m.kind = 'balance' and m.currency = v_currency
      ), 0.00)::numeric,
      (count(*) filter (where m.movement = 'online_refund' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'online_refund' and m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.movement = 'counter_payment' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (where m.movement = 'counter_payment' and m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.movement = 'counter_given_back' and m.currency = v_currency))::integer,
      coalesce(sum(m.amount) filter (
        where m.movement = 'counter_given_back' and m.currency = v_currency
      ), 0.00)::numeric,
      coalesce(sum(m.signed_amount) filter (where m.currency = v_currency), 0.00)::numeric,
      (count(*) filter (where m.currency <> v_currency or m.other_currency))::integer
    from m;
end;
$$;

comment on function public.report_payment_summary(date, date) is
  'view_financial_reports (D154d): customer money that moved in the shop days p_from..p_to (D154b; reporting.payment_movements, half open on shop_day_start), in the shop currency: online payments (count, total, deposit and balance totals), online refunds (count, positive total), counter payments recorded by an admin (count, total; a given-back payment stays on its day) and counter money given back (count, positive total, on the void''s day); net_total = online - refunds + counter - given back. other_currency_count: movements in another currency (not in the totals, D104) plus Stripe payments taken in another currency (counted at the amount asked, as on the job card). Not sales, not by the date basis, no GST. report_range_invalid / report_range_too_long.';

-- ---------------------------------------------------------------------------
-- D154e: report_payment_items
-- ---------------------------------------------------------------------------
create function public.report_payment_items(
  p_from date,
  p_to date,
  p_max_rows integer default 100,
  p_after_at timestamptz default null,
  p_after_id uuid default null
)
returns table (
  "at" timestamptz,
  id uuid,
  movement text,
  work_order_id uuid,
  job_number text,
  customer_label text,
  kind text,
  method text,
  amount numeric,
  signed_amount numeric,
  currency text,
  other_currency boolean,
  recorded_at timestamptz,
  recorded_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
  v_max integer;
begin
  perform private.require_permission('view_financial_reports');
  perform private.report_require_range(p_from, p_to);
  if (p_after_at is null) <> (p_after_id is null) then
    raise exception using
      errcode = 'P0001',
      message = 'report_key_invalid',
      detail = 'The cursor of the payment list needs both its time and its id.';
  end if;
  v_start := private.shop_day_start(p_from);
  v_end := private.shop_day_start(p_to + 1);
  v_currency := private.shop_currency();
  v_max := greatest(1, least(coalesce(p_max_rows, 100), 1000));

  return query
    select
      m."at",
      m.id,
      m.movement,
      m.work_order_id,
      wo.job_number::text,
      private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone),
      m.kind,
      m.method,
      m.amount,
      m.signed_amount,
      m.currency,
      m.other_currency,
      m.recorded_at,
      st.display_name::text
    from reporting.payment_movements m
    join public.work_orders wo on wo.id = m.work_order_id
    left join public.customers c on c.id = wo.customer_id
    left join public.staff st on st.id = m.recorded_by
    where m."at" >= v_start
      and m."at" < v_end
      and m.currency = v_currency
      and (p_after_at is null or (m."at", m.id) < (p_after_at, p_after_id))
    order by m."at" desc, m.id desc, m.movement desc
    limit v_max;
end;
$$;

comment on function public.report_payment_items(date, date, integer, timestamptz, uuid) is
  'view_financial_reports (D154d): the movements report_payment_summary counts (shop currency), newest first; keyset (p_after_at, p_after_id) = the last row''s (at, id), as report_line_items; p_max_rows clamped 1..1000 (ask for one more than shown). Each row: when it moved (at: paid_at, refund created, received_at, or the give-back''s voided_at), the movement, the job number and customer label, kind, method (stripe or the counter method), amount (positive) and signed_amount, other_currency, and for counter rows when and by whom an admin recorded it (recorded_at, recorded_by_name), so a back-dated record shows. A given-back row carries the counter payment''s id. report_key_invalid for half a cursor; report_range_invalid / report_range_too_long.';

-- ---------------------------------------------------------------------------
-- D154c, D154e: report_payments_held
-- ---------------------------------------------------------------------------
create function public.report_payments_held()
returns table (
  grp text,
  work_order_id uuid,
  job_number text,
  status text,
  customer_label text,
  amount numeric,
  net_paid numeric,
  net_paid_online numeric,
  paid_at_counter numeric,
  job_total numeric,
  balance_due numeric,
  paid_ahead numeric,
  currency text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_currency text;
begin
  perform private.require_permission('view_financial_reports');
  v_currency := private.shop_currency();

  return query
    with cand as (
      -- Jobs that can hold money or owe it: a paid-group Stripe payment
      -- (paid_at is set exactly then), a live counter payment, or a
      -- completed or ready job (a balance may be due). Every other job
      -- has net_paid 0 and no balance due.
      select p.work_order_id as job_id
      from public.payments p
      where p.paid_at is not null
      union
      select cp.work_order_id
      from public.counter_payments cp
      where not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
      union
      select w.id
      from public.work_orders w
      where w.status in ('completed', 'ready_for_collection')
    ),
    t as (
      select
        w.id as job_id,
        w.job_number,
        w.status as job_status,
        w.customer_id,
        w.currency::text as job_currency,
        pt.net_paid::numeric as t_net_paid,
        pt.net_paid_online::numeric as t_net_paid_online,
        pt.paid_at_counter::numeric as t_paid_at_counter,
        pt.job_total::numeric as t_job_total,
        pt.balance_due::numeric as t_balance_due,
        pt.paid_ahead::numeric as t_paid_ahead,
        pt.held_over_total::numeric as t_held_over_total
      from cand
      join public.work_orders w on w.id = cand.job_id
      join public.work_order_payment_totals pt on pt.work_order_id = cand.job_id
      where w.currency::text = v_currency
    ),
    g as (
      select 1 as g_rank, 'open'::text as g_name, t.*, t.t_net_paid as g_amount
      from t
      where private.work_order_status_is_open(t.job_status) and t.t_net_paid > 0
      union all
      select 2, 'awaiting_collection'::text, t.*, least(t.t_net_paid, t.t_job_total)
      from t
      where t.job_status in ('completed', 'ready_for_collection')
        and (t.t_net_paid > 0 or t.t_balance_due > 0)
      union all
      select 3, 'above_bill'::text, t.*, t.t_held_over_total
      from t
      where not private.work_order_status_is_open(t.job_status) and t.t_held_over_total > 0
    )
    select
      g.g_name,
      g.job_id,
      g.job_number::text,
      g.job_status::text,
      private.customer_label(c.first_name, c.last_name, c.display_name, c.email::text, c.phone),
      g.g_amount,
      g.t_net_paid,
      g.t_net_paid_online,
      g.t_paid_at_counter,
      g.t_job_total,
      g.t_balance_due,
      g.t_paid_ahead,
      g.job_currency
    from g
    left join public.customers c on c.id = g.customer_id
    order by g.g_rank, g.job_number, g.job_id;
end;
$$;

comment on function public.report_payments_held() is
  'view_financial_reports (D154c, D154d): customer money held on jobs NOW (any period), per job, from work_order_payment_totals so it equals the job card; shop-currency jobs only. Three groups (grp), no grand total: open (private.work_order_status_is_open and net_paid > 0; amount = net_paid, deposits and prepayments, not yet sales; paid_ahead a memo), awaiting_collection (completed or ready_for_collection with net_paid > 0 or a balance due; amount = least(net_paid, job_total), already in sales on the sale date basis; balance_due beside it) and above_bill (held_over_total > 0 on a job that is not open: to refund in Stripe or give back at the counter). A job''s amounts add up to net_paid while it is not collected, and to held_over_total once collected. Ordered by group, then job number.';

-- ---------------------------------------------------------------------------
-- Privileges (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  public.report_payment_summary(date, date),
  public.report_payment_items(date, date, integer, timestamptz, uuid),
  public.report_payments_held()
from public, anon, authenticated, service_role;

grant execute on function
  public.report_payment_summary(date, date),
  public.report_payment_items(date, date, integer, timestamptz, uuid),
  public.report_payments_held()
to authenticated;
