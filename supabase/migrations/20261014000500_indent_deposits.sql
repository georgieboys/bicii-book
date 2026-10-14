-- Phase 14 step 2: indent deposits in Postgres (PLAN Phase 14 step 2, D151,
-- D152, D154, D157, D158; ADR-025; DATA-MODEL §5, §19, §14, §15, §16).
--
--   shop_settings.indent_deposit_percent   D151/D157: the percent of a
--                      quote's approved indent parts asked as a deposit;
--                      ships at 0 (no deposit, no gate) and is set by an
--                      admin through set_indent_deposit_percent (history in
--                      schedule_events). The Admin refuses a value above 0
--                      while Stripe is off (the database cannot see the
--                      environment).
--   quotes.deposit_percent, deposit_amount  D158a/b: a snapshot. The
--                      percent is copied when the quote is sent, the amount
--                      computed when it is answered (round(sum of approved
--                      part lines x percent / 100, 2); services and declined
--                      items excluded; none under S$0.50 or over
--                      S$999,999.99; SGD in the shop currency only), by the
--                      quotes_deposit_snapshot trigger, so send_quote and
--                      answer_quote are not copied. Quotes sent before this
--                      file keep a null percent and ask nothing.
--   quote_deposits     the one SQL definition of a deposit's state (paid,
--                      refunded, processing, due, none; D158e).
--   payment_issues     D159b: the "needs attention" payment conditions,
--                      derived live, never stored.
--   work_order_payment_totals  D154: paid online and the balance due.
--   prepare_deposit_checkout, record_deposit_checkout  service role only
--                      (src/lib/integrations/stripe/): decide whether a
--                      Checkout is due, and record the session Stripe has
--                      just created. anon gains nothing.
--   order_part_requests  dropped and recreated with override_reason: the
--                      D152 gate (an approved part whose quote's deposit is
--                      not paid is ordered only by an active admin or
--                      manager, with a reason recorded on part_ordered).
--                      Fitting is not gated.
--   exceptions         payment_attention (admins and managers) and
--                      stripe_attention (admins), through the existing
--                      extension point; computed live (D34, D108).
--
-- Replaced with the same signatures (grants kept): private.quote_view
-- (public.quotes) (adds the 'deposit' key), private.integration_exceptions()
-- and private.exception_visible(text). Replaced with a new signature:
-- public.order_part_requests (adds override_reason text default null).
--
-- Lock order (DATA-MODEL §19): record_deposit_checkout takes the job
-- (private.lock_work_order), then the quote FOR UPDATE, then inserts the
-- payment; prepare_deposit_checkout takes no locks. The gate reads payments
-- under the job locks order_part_requests already holds, and every writer
-- of payments holds that job's lock, so ordering and applying a payment
-- serialise. No path here takes a Stripe advisory lock.

-- ---------------------------------------------------------------------------
-- D151, D157: the setting (a copy of D107, 20261006001300:63-108)
-- ---------------------------------------------------------------------------
alter table public.shop_settings
  add column indent_deposit_percent integer not null default 0,
  add constraint shop_settings_indent_deposit_percent_check
    check (indent_deposit_percent between 0 and 100);

comment on column public.shop_settings.indent_deposit_percent is
  'D151/D157: percent of a quote''s approved indent parts asked as a deposit (0 asks none; ships at 0 until Stripe is set up). Copied onto each quote when it is sent (D158). Written only by set_indent_deposit_percent (admin); history in schedule_events.';

create function public.set_indent_deposit_percent(p_percent integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_percent integer;
begin
  perform private.require_admin();

  if set_indent_deposit_percent.p_percent is null
     or set_indent_deposit_percent.p_percent < 0 or set_indent_deposit_percent.p_percent > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_percent_out_of_range',
      detail = 'The deposit is from 0 to 100% of the approved parts.';
  end if;

  select s.indent_deposit_percent into current_percent
  from public.shop_settings s
  where s.id = 1
  for update;

  if current_percent = set_indent_deposit_percent.p_percent then
    return current_percent;  -- no write, no history row
  end if;

  update public.shop_settings s
  set indent_deposit_percent = set_indent_deposit_percent.p_percent
  where s.id = 1;
  return set_indent_deposit_percent.p_percent;
end;
$$;

comment on function public.set_indent_deposit_percent(integer) is
  'Admin (D151, D157): set shop_settings.indent_deposit_percent (0..100, else deposit_percent_out_of_range). The current value again changes nothing and writes no history; a change is recorded in schedule_events by the shop_settings triggers. Returns the value in force. The Admin refuses a value above 0 while Stripe is off.';

-- ---------------------------------------------------------------------------
-- D158a, b: the deposit snapshot on quotes
-- ---------------------------------------------------------------------------
alter table public.quotes
  add column deposit_percent integer null,               -- null: sent before Phase 14 step 2
  add column deposit_amount public.money_amount null,    -- null: no deposit asked, no D152 gate
  add constraint quotes_deposit_percent_check check (deposit_percent between 0 and 100),
  add constraint quotes_deposit_amount_check check (deposit_amount between 0.50 and 999999.99),
  add constraint quotes_deposit_shape check (
    deposit_amount is null or (status = 'answered' and deposit_percent between 1 and 100 and currency = 'SGD')
  );

create index quotes_deposit_idx on public.quotes (work_order_id) where deposit_amount is not null;

comment on column public.quotes.deposit_percent is
  'D158a: the shop''s indent_deposit_percent when the quote was sent (0 for a quote not in SGD, the shop currency); null for a quote sent before Phase 14 step 2. Never changes (quotes_deposit_snapshot).';
comment on column public.quotes.deposit_amount is
  'D151, D158a/b: computed in Postgres when the quote is answered: round(sum of approved part lines x deposit_percent / 100, 2), services and declined items excluded; null when no deposit is asked (percent 0 or null, under S$0.50 or over S$999,999.99). A non-null amount is the D152 gate. Never changes afterwards.';

-- Fires from send_quote (insert), answer_quote (open -> answered),
-- private.withdraw_open_quote (open -> withdrawn: both unchanged) and
-- owner fixtures. Not security definer: it runs as the definer RPC's owner,
-- which reads shop_settings and calls private.shop_currency().
create function private.quotes_deposit_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parts_total numeric;
  deposit numeric;
begin
  if tg_op = 'INSERT' then
    -- D158a/b: the percent in force when the quote is sent; SGD in the shop
    -- currency only.
    new.deposit_percent := case
      when new.currency = 'SGD' and new.currency = private.shop_currency()
        then coalesce((select s.indent_deposit_percent from public.shop_settings s where s.id = 1), 0)
      else 0
    end;
    new.deposit_amount := null;
    return new;
  end if;
  if new.deposit_percent is distinct from old.deposit_percent then
    raise exception using
      errcode = 'P0001',
      message = 'quote_deposit_immutable',
      detail = 'A quote keeps the deposit percent it was sent with.';
  end if;
  if old.status = 'open' and new.status = 'answered' then
    new.deposit_amount := null;
    if coalesce(new.deposit_percent, 0) > 0 then
      -- answer_quote writes quote_items.decision (20261014000200:888-891)
      -- before it sets the status (900-903), so the decisions are visible
      -- here. Parts only (D151).
      select coalesce(sum(i.line_total) filter (where i.kind = 'part' and i.decision = 'approved'), 0)
        into parts_total
      from public.quote_items i
      where i.quote_id = new.id;
      deposit := pg_catalog.round(parts_total * new.deposit_percent / 100, 2);  -- half away from zero
      if deposit >= 0.50 and deposit <= 999999.99 then
        new.deposit_amount := deposit;  -- D158b: never rounded up to the minimum
      end if;
    end if;
  elsif new.deposit_amount is distinct from old.deposit_amount then
    raise exception using
      errcode = 'P0001',
      message = 'quote_deposit_immutable',
      detail = 'A quote''s deposit is fixed when the customer answers.';
  end if;
  return new;
end;
$$;

comment on function private.quotes_deposit_snapshot() is
  'D158a/b: BEFORE INSERT OR UPDATE on quotes. Insert: copies the shop''s indent_deposit_percent (0 unless the quote is SGD in the shop currency). Open -> answered: computes deposit_amount from the approved part items (services and declined excluded), none outside S$0.50..S$999,999.99. Otherwise neither column changes (quote_deposit_immutable), for every role.';

create trigger quotes_deposit_snapshot
  before insert or update on public.quotes
  for each row execute function private.quotes_deposit_snapshot();

-- Staff read the snapshot (extends 20261014000200:1347-1350; never the
-- token hash).
grant select (deposit_percent, deposit_amount) on table public.quotes to authenticated;

-- ---------------------------------------------------------------------------
-- View public.quote_deposits: the one definition of a deposit's state
-- ---------------------------------------------------------------------------
create view public.quote_deposits
with (security_invoker = on)
as
select q.id as quote_id,
       q.work_order_id,
       q.sent_at,
       q.answered_at,
       q.currency,
       q.deposit_percent,
       q.deposit_amount,
       case
         when exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit'
                        and p.status in ('paid', 'partially_refunded')) then 'paid'
         when exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit' and p.status = 'refunded') then 'refunded'
         when exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit'
                        and p.status = 'pending' and p.checkout_completed_at is not null) then 'processing'
         when exists (select 1 from public.quote_items i
                      join public.job_part_requests r on r.id = i.part_request_id
                      where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
                        and r.status in ('approved', 'ordered', 'fitted')) then 'due'
         else 'none'
       end as state,
       coalesce((select pg_catalog.array_agg(i.part_request_id order by i.position)
                 from public.quote_items i
                 where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'),
                '{}'::uuid[]) as part_request_ids
from public.quotes q
where q.status = 'answered' and q.deposit_amount is not null;

comment on view public.quote_deposits is
  'D151/D152/D158: each answered quote''s deposit and its state: paid (paid or partly refunded, D158e), refunded, processing (Checkout complete, Stripe still confirming), due, none (every approved part cancelled). Security invoker: staff through RLS; the definer RPCs (the gate, quote_view, the Checkout RPCs) read it as owner. One definition for all of them.';

-- ---------------------------------------------------------------------------
-- View public.payment_issues: the derived "needs attention" list (D159b)
-- ---------------------------------------------------------------------------
create view public.payment_issues
with (security_invoker = on)
as
select p.id as payment_id, p.work_order_id, p.quote_id, x.issue, x.severity, x.since, x.message
from public.payments p
join public.work_orders w on w.id = p.work_order_id
cross join lateral (
  -- Money as the screens print it (formatMoney, en-SG: $1,234.50);
  -- payments are SGD only (payments_currency_check).
  select '$' || pg_catalog.to_char(coalesce(p.amount_received, p.amount) - p.refunded_amount,
                                   'FM999,999,990.00') as held,
         '$' || pg_catalog.to_char(p.amount, 'FM999,999,990.00') as asked,
         '$' || pg_catalog.to_char(p.amount_received, 'FM999,999,990.00') as received,
         '$' || pg_catalog.to_char(p.refunded_amount, 'FM999,999,990.00') as refunded,
         -- D159c: the counted refund (succeeded or failed, in the payment's
         -- currency and mode) whose outcome Stripe reported last, by when
         -- the apply recorded that status (status_changed_at; linking an
         -- unmatched refund leaves it alone). Its failure stands until a
         -- later refund succeeds ("Refund again in Stripe").
         (select case when lr.status = 'failed' then lr.status_changed_at end
          from public.payment_refunds lr
          where lr.payment_id = p.id and lr.status in ('succeeded', 'failed')
            and lr.currency = p.currency and (lr.livemode is null or lr.livemode = p.livemode)
          order by lr.status_changed_at desc, lr.created_at desc, lr.id
          limit 1) as refund_failed_at,
         -- Linked refunds that payment_refund_total never counts: another
         -- currency or mode (DATA-MODEL §19, step 1's apply_stripe_refund;
         -- one adopted by the completion is flagged on no event).
         (select pg_catalog.max(r.updated_at) from public.payment_refunds r
          where r.payment_id = p.id and r.status not in ('failed', 'canceled')
            and (r.currency <> p.currency or (r.livemode is not null and r.livemode <> p.livemode)))
           as uncounted_refund_at
) h
cross join lateral (values
  ('paid_job_cancelled', 'danger', p.paid_at,
   pg_catalog.format('%s is held but this job is cancelled. Refund it in Stripe if it is due back.', h.held),
   p.status in ('paid', 'partially_refunded') and w.status = 'cancelled'),
  ('paid_parts_cancelled', 'danger', p.paid_at,
   pg_catalog.format('%s is held but every part it was for is cancelled. Refund it in Stripe, or agree with the customer that it counts towards the job.',
                     h.held),
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded') and w.status <> 'cancelled'
     and not exists (select 1 from public.quote_items i
                     join public.job_part_requests r on r.id = i.part_request_id
                     where i.quote_id = p.quote_id and i.kind = 'part' and i.decision = 'approved'
                       and r.status in ('approved', 'ordered', 'fitted'))),
  ('paid_twice', 'danger', p.paid_at,
   pg_catalog.format('This deposit was paid twice (%s again). Refund one payment in Stripe.', h.held),
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded') and exists (
     select 1 from public.payments o
     where o.quote_id = p.quote_id and o.kind = 'deposit' and o.id <> p.id
       and o.status in ('paid', 'partially_refunded') and (o.paid_at, o.id) < (p.paid_at, p.id))),
  ('amount_mismatch', 'danger', p.paid_at,
   case when p.amount_received is null
     then pg_catalog.format('Stripe took this payment in another currency, not the %s asked. Check it in Stripe.',
                            h.asked)
     else pg_catalog.format('Stripe received %s, not the %s asked. Check the payment in Stripe.',
                            h.received, h.asked) end,
   p.status in ('paid', 'partially_refunded') and p.amount_received is distinct from p.amount),
  ('refund_failed', 'danger', h.refund_failed_at,
   'A refund failed in Stripe and the money went back to the Stripe balance. Refund again in Stripe.',
   p.status <> 'refunded' and h.refund_failed_at is not null),
  ('refund_not_counted', 'danger', h.uncounted_refund_at,
   'Stripe reported a refund of this payment in another currency or mode (test or live), and BICII did not count it. Check it in Stripe.',
   h.uncounted_refund_at is not null),
  ('refund_exceeds_payment', 'danger', p.updated_at,
   pg_catalog.format('Stripe refunded %s, more than BICII recorded as paid. Check the payment in Stripe.',
                     h.refunded),
   p.refunded_amount > coalesce(p.amount_received, p.amount)),
  -- R-086: before Checkout completed, a read settles it (expired or
  -- paid); after it, Check with Stripe also reads the PaymentIntent, and a
  -- payment Stripe still has not decided is checked in the Dashboard.
  ('pending_unconfirmed', 'warning', p.stripe_session_expires_at,
   case when p.checkout_completed_at is null
     then pg_catalog.format('Stripe has not confirmed a payment of %s. Press Check with Stripe on the job.',
                            h.asked)
     else pg_catalog.format('The customer completed Checkout for %s, but Stripe has not confirmed the payment. Press Check with Stripe on the job; if it stays, look the payment up in the Stripe Dashboard.',
                            h.asked) end,
   p.status = 'pending' and p.stripe_session_expires_at < pg_catalog.now() - interval '15 minutes')
) as x (issue, severity, since, message, hit)
where x.hit;

comment on view public.payment_issues is
  'D159b: payment conditions needing an admin or manager, derived live (clear when their cause clears). The message is the sentence shown on the job card and in Exceptions (money as the screens print it: $1,234.50). Issues: paid_job_cancelled, paid_parts_cancelled, paid_twice, amount_mismatch, refund_failed, refund_not_counted (a linked refund in another currency or mode), refund_exceeds_payment (danger); pending_unconfirmed (warning, 15 minutes after the session expired). Security invoker: staff through RLS.';

-- ---------------------------------------------------------------------------
-- View public.work_order_payment_totals: D154's "paid and balance due"
-- ---------------------------------------------------------------------------
create view public.work_order_payment_totals
with (security_invoker = on)
as
select w.id as work_order_id,
       w.currency,
       x.paid_online::public.money_amount as paid_online,
       x.refunded_online::public.money_amount as refunded_online,
       (x.paid_online - x.refunded_online)::public.money_amount as net_paid_online,
       coalesce(t.sale_total, 0)::public.money_amount as job_total,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest(coalesce(t.sale_total, 0) - (x.paid_online - x.refunded_online), 0)
        end)::public.money_amount as balance_due,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest((x.paid_online - x.refunded_online) - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as paid_ahead
from public.work_orders w
cross join lateral (
  select coalesce(sum(coalesce(p.amount_received, p.amount)), 0) as paid_online,
         coalesce(sum(p.refunded_amount), 0) as refunded_online
  from public.payments p
  where p.work_order_id = w.id and p.status in ('paid', 'partially_refunded', 'refunded')
) x
left join public.work_order_totals t on t.work_order_id = w.id
where exists (select 1 from public.payments p where p.work_order_id = w.id);

comment on view public.work_order_payment_totals is
  'D154: per job with a payment: what Stripe confirmed (paid_online), what was refunded, the net, the live-lines sale total (job_total, as work_order_totals) and, while the job is open (not collected or cancelled) and in SGD, balance_due and paid_ahead (both never negative). Money held, not revenue: no report reads it. Security invoker: staff through RLS.';

-- ---------------------------------------------------------------------------
-- private.quote_view: the Phase 13 body (20261014000200:274-326) with one
-- new key, 'deposit', last (D143 allows the deposit on the page).
-- ---------------------------------------------------------------------------
create or replace function private.quote_view(quote public.quotes)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  wo public.work_orders;
  bike public.bikes;
  first_name text;
  state text;
  deposit jsonb;
  dstate text;
  ordered boolean;
begin
  select w.* into wo from public.work_orders w where w.id = quote.work_order_id;
  state := case
    when quote.status = 'open' and quote.expires_at <= pg_catalog.clock_timestamp() then 'expired'
    else quote.status::text
  end;
  if state in ('withdrawn', 'expired') then
    return pg_catalog.jsonb_build_object('status', state, 'job_number', wo.job_number);
  end if;
  select b.* into bike from public.bikes b where b.id = wo.bike_id;
  select c.first_name into first_name from public.customers c where c.id = wo.customer_id;
  -- D151, D158: the deposit the page may show. Open: the percent only (the
  -- amount is fixed when the customer answers). Answered: the amount and
  -- its state; a due deposit only while the job is open (D158c); and
  -- parts_ordered, true once every approved part still live is ordered or
  -- fitted (D152: an admin or manager ordered them before the deposit was
  -- paid, so the page stops saying the order waits for it).
  if quote.status = 'open' then
    if coalesce(quote.deposit_percent, 0) > 0
       and exists (select 1 from public.quote_items i where i.quote_id = quote.id and i.kind = 'part') then
      deposit := pg_catalog.jsonb_build_object('percent', quote.deposit_percent, 'amount', null,
                                               'status', 'on_answer');
    end if;
  elsif quote.deposit_amount is not null then
    select d.state into dstate from public.quote_deposits d where d.quote_id = quote.id;
    if dstate in ('processing', 'paid', 'refunded')
       or (dstate = 'due' and private.work_order_status_is_open(wo.status)) then
      select pg_catalog.bool_and(r.status in ('ordered', 'fitted')) into ordered
      from public.quote_items i
      join public.job_part_requests r on r.id = i.part_request_id
      where i.quote_id = quote.id and i.kind = 'part' and i.decision = 'approved'
        and r.status in ('approved', 'ordered', 'fitted');
      deposit := pg_catalog.jsonb_build_object('percent', quote.deposit_percent,
                                               'amount', quote.deposit_amount, 'status', dstate,
                                               'parts_ordered', coalesce(ordered, false));
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'status', state,
    'job_number', wo.job_number,
    'bike', pg_catalog.concat_ws(' ', bike.brand, bike.model, bike.variant),
    'first_name', first_name,
    'currency', quote.currency,
    'total', quote.total,
    'sent_at', quote.sent_at,
    'expires_at', quote.expires_at,
    'answered_at', quote.answered_at,
    'answered_name', quote.answered_name,
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', i.id,
          'kind', i.kind,
          'description', i.description,
          'quantity', i.quantity,
          'unit_sale_price', i.unit_sale_price,
          'line_total', i.line_total,
          'decision', i.decision
        )
        order by i.position
      )
      from public.quote_items i
      where i.quote_id = quote.id
    ), '[]'::jsonb),
    'deposit', deposit
  );
end;
$$;

comment on function private.quote_view(public.quotes) is
  'D143, D151, D158: what the quote page may show for one quote: never costs, notes, staff, contact details, other jobs or any Stripe id or URL. Withdrawn or expired: status and job number only. Otherwise 12 keys, the last ''deposit'': null, or {percent, amount, status} with status on_answer (open; amount null), or {percent, amount, status, parts_ordered} with status due (answered, job open), processing, paid or refunded (quote_deposits) and parts_ordered true once every approved part still live is ordered or fitted.';

-- ---------------------------------------------------------------------------
-- Starting Checkout (service role only, src/lib/integrations/stripe/)
-- ---------------------------------------------------------------------------

-- Decides, without locks, what the quote page's Pay does: create a new
-- Checkout session, check the open one at Stripe, or report the deposit
-- paid, refunded or still being confirmed.
create function public.prepare_deposit_checkout(token text)
returns table (
  outcome text,
  payment_id uuid,
  work_order_id uuid,
  quote_id uuid,
  job_number text,
  amount public.money_amount,
  amount_cents bigint,
  currency char(3),
  stripe_checkout_session_id text,
  expires_at bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  hashed bytea := private.quote_token_hash(prepare_deposit_checkout.token);
  q public.quotes;
  wo public.work_orders;
  st text;
  pay public.payments;
begin
  if hashed is null then
    raise exception using errcode = 'P0002', message = 'quote_not_found', detail = 'This link is not valid.';
  end if;
  select x.* into q from public.quotes x where x.token_hash = hashed;
  if not found then
    raise exception using errcode = 'P0002', message = 'quote_not_found', detail = 'This link is not valid.';
  end if;
  select w.* into wo from public.work_orders w where w.id = q.work_order_id;

  if q.status <> 'answered' or q.deposit_amount is null then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_not_due',
      detail = 'There is no deposit to pay on this quote.';
  end if;

  select d.state into st from public.quote_deposits d where d.quote_id = q.id;
  if st in ('paid', 'refunded', 'processing') then
    select p.* into pay
    from public.payments p
    where p.quote_id = q.id and p.kind = 'deposit'
      and case st
            when 'paid' then p.status in ('paid', 'partially_refunded')
            when 'refunded' then p.status = 'refunded'
            else p.status = 'pending' and p.checkout_completed_at is not null
          end
    order by p.created_at desc, p.id desc
    limit 1;
    return query select st, pay.id, wo.id, q.id, wo.job_number::text, pay.amount, pay.amount_cents, pay.currency,
      pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;
  if st = 'none' then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_parts_cancelled',
      detail = 'The parts this deposit was for were cancelled. Ask the shop.';
  end if;
  if not private.work_order_status_is_open(wo.status) then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_job_closed',
      detail = 'This job is closed. Ask the shop about the deposit.';
  end if;

  -- At most one pending deposit payment per quote (payments_one_open_deposit).
  select p.* into pay
  from public.payments p
  where p.quote_id = q.id and p.kind = 'deposit' and p.status = 'pending';
  if found then
    return query select 'check'::text, pay.id, wo.id, q.id, wo.job_number::text, pay.amount, pay.amount_cents,
      pay.currency, pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;

  return query select 'create'::text, gen_random_uuid(), wo.id, q.id, wo.job_number::text, q.deposit_amount,
    (q.deposit_amount * 100)::bigint, 'SGD'::char(3), null::text,
    extract(
      epoch from pg_catalog.date_trunc('second', pg_catalog.clock_timestamp()) + interval '60 minutes'
    )::bigint;
end;
$$;

comment on function public.prepare_deposit_checkout(text) is
  'service_role (src/lib/integrations/stripe/ only; D151, D158): for a quote link, what Pay deposit does, with no locks: create (a fresh payment id, the amount and cents computed here, a 60-minute expiry as a Unix time), check (the pending Checkout to re-read at Stripe), or paid, refunded or processing (the newest such payment). Raises quote_not_found (P0002), deposit_not_due, deposit_parts_cancelled or deposit_job_closed.';

-- Records the Checkout session the app has just created at Stripe for a
-- payment id prepare_deposit_checkout gave it. Validates Stripe's echo of
-- what was asked; only Stripe's data moves the row afterwards. The input
-- names carry p_ because the result has a payment_id column.
create function public.record_deposit_checkout(p_payment_id uuid, p_quote_id uuid, session jsonb)
returns table (outcome text, payment_id uuid, stripe_checkout_session_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s jsonb := record_deposit_checkout.session;
  q public.quotes;
  wo public.work_orders;
  st text;
  pay public.payments;
  sid text;
  expires bigint;
begin
  -- 1. Load and lock: the job, then the quote.
  if record_deposit_checkout.p_payment_id is null or record_deposit_checkout.p_quote_id is null or s is null then
    raise exception 'p_payment_id, p_quote_id and session are required' using errcode = '22004';
  end if;
  select x.* into q from public.quotes x where x.id = record_deposit_checkout.p_quote_id;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(q.work_order_id);
  select x.* into q from public.quotes x where x.id = q.id for update;
  sid := case when pg_catalog.jsonb_typeof(s) = 'object' then s ->> 'id' end;

  -- 2. Replay of the same payment id.
  select p.* into pay from public.payments p where p.id = record_deposit_checkout.p_payment_id;
  if found then
    if pay.stripe_checkout_session_id = sid and pay.kind = 'deposit'
       and pay.quote_id = record_deposit_checkout.p_quote_id then
      return query select 'existing'::text, pay.id, pay.stripe_checkout_session_id;
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_conflict',
      detail = 'That payment already has another Checkout session or quote.';
  end if;

  -- 3. Re-check under the locks.
  if q.status <> 'answered' or q.deposit_amount is null then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_not_due',
      detail = 'There is no deposit to pay on this quote.';
  end if;
  select d.state into st from public.quote_deposits d where d.quote_id = q.id;
  if st in ('paid', 'refunded', 'processing') then
    return query select st, null::uuid, null::text;  -- the app expires the session it just made
    return;
  end if;
  if st = 'none' then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_parts_cancelled',
      detail = 'The parts this deposit was for were cancelled. Ask the shop.';
  end if;
  if not private.work_order_status_is_open(wo.status) then
    raise exception using
      errcode = 'P0001',
      message = 'deposit_job_closed',
      detail = 'This job is closed. Ask the shop about the deposit.';
  end if;

  -- 4. A concurrent click won: the app expires its new session and re-reads
  -- this one.
  select p.* into pay
  from public.payments p
  where p.quote_id = q.id and p.kind = 'deposit' and p.status = 'pending';
  if found then
    return query select 'existing'::text, pay.id, pay.stripe_checkout_session_id;
    return;
  end if;

  -- 5. Stripe's echo of what was asked.
  expires := private.stripe_int(s -> 'expires_at');
  if pg_catalog.jsonb_typeof(s) is distinct from 'object'
     or (s ->> 'object') is distinct from 'checkout.session'
     or coalesce(sid, '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$'
     or (s ->> 'status') is distinct from 'open'
     or private.stripe_int(s -> 'amount_total') is distinct from (q.deposit_amount * 100)::bigint
     or pg_catalog.lower(s ->> 'currency') is distinct from 'sgd'
     or (s -> 'metadata' ->> 'bicii_payment_id') is distinct from record_deposit_checkout.p_payment_id::text
     or (s -> 'metadata' ->> 'bicii_quote_id') is distinct from record_deposit_checkout.p_quote_id::text
     or (s ->> 'client_reference_id') is distinct from record_deposit_checkout.p_payment_id::text
     or pg_catalog.jsonb_typeof(s -> 'livemode') is distinct from 'boolean'
     or expires is null
     or pg_catalog.to_timestamp(expires) <= pg_catalog.clock_timestamp()
     -- prepare_deposit_checkout asks 60 minutes ahead (D158d)
     or pg_catalog.to_timestamp(expires) > pg_catalog.clock_timestamp() + interval '61 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_mismatch',
      detail = 'The Checkout session Stripe returned does not match the deposit asked.';
  end if;

  -- 6. A session belongs to one payment.
  if exists (select 1 from public.payments p where p.stripe_checkout_session_id = sid) then
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_conflict',
      detail = 'That Checkout session is already recorded for another payment.';
  end if;

  -- 7. Insert (the FK KEY SHARE locks on the job and the quote come after
  -- their FOR UPDATE). No timeline entry: anon can repeat this.
  insert into public.payments as p (
    id, work_order_id, quote_id, kind, amount, currency, stripe_checkout_session_id,
    stripe_session_expires_at, livemode
  )
  values (
    record_deposit_checkout.p_payment_id, wo.id, q.id, 'deposit', q.deposit_amount, 'SGD', sid,
    pg_catalog.to_timestamp(expires), (s ->> 'livemode')::boolean
  );
  return query select 'created'::text, record_deposit_checkout.p_payment_id, sid;
end;
$$;

comment on function public.record_deposit_checkout(uuid, uuid, jsonb) is
  'service_role (src/lib/integrations/stripe/ only; D153, D158d): record the Checkout session Stripe returned for a payment id from prepare_deposit_checkout, under the job and quote locks: created (a pending payment), existing (a replay of the same pair, or another pending attempt won; its id and session), or paid, refunded or processing (no row). Raises checkout_session_mismatch when Stripe''s echo differs from the deposit asked (object, id, open, amount_total in cents, sgd, metadata, client_reference_id, livemode, an expires_at in the next 61 minutes), checkout_session_conflict (that payment id already holds another session or quote, or that session another payment), deposit_not_due, deposit_parts_cancelled or deposit_job_closed. Writes no timeline entry.';

-- ---------------------------------------------------------------------------
-- order_part_requests: the Phase 13 body (20261014000200:961-1103) with the
-- D152 gate and override_reason.
-- ---------------------------------------------------------------------------
drop function public.order_part_requests(uuid[], uuid, uuid, boolean);

-- manage_purchasing. Orders approved indent parts from one supplier: they
-- go on the supplier's newest draft purchase order, or on a new draft with
-- purchase_order_id when the supplier has none; each product's line rises
-- by the requests' quantities (cost: the line's, else the requests'
-- expected cost, else purchase_cost_defaults), and each request is linked
-- to its line. move_to_waiting moves each open job not already waiting on
-- parts to Waiting on parts when its status allows it. Replay: when every
-- request is already ordered, their purchase order is returned. D152: a
-- part whose answered quote asked a deposit that is not paid needs an
-- active admin or manager and override_reason, recorded on the job's
-- part_ordered entry. Returns the purchase order id.
create function public.order_part_requests(
  request_ids uuid[],
  supplier_id uuid,
  purchase_order_id uuid,
  move_to_waiting boolean default true,
  override_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_purchasing');
  wanted integer;
  job record;
  po_id uuid;
  po public.purchase_orders;
  prod record;
  line public.purchase_order_lines;
  line_id uuid;
  cost public.money_amount;
  ordered_po uuid;
  ordered_count integer;
  unpaid_quotes uuid[];
  unpaid_jobs uuid[];
  override text;
begin
  if order_part_requests.request_ids is null or order_part_requests.supplier_id is null
     or order_part_requests.purchase_order_id is null or order_part_requests.move_to_waiting is null then
    raise exception 'request_ids, supplier_id, purchase_order_id and move_to_waiting are required'
      using errcode = '22004';
  end if;
  wanted := pg_catalog.cardinality(order_part_requests.request_ids);
  if wanted is null or wanted < 1 or wanted > 50
     or wanted <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(order_part_requests.request_ids) as x) then
    raise exception using
      errcode = 'P0001',
      message = 'order_items_invalid',
      detail = 'Choose 1 to 50 different parts.';
  end if;

  -- The jobs first, in id order (lock order), then the requests.
  for job in
    select distinct r.work_order_id as id
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    order by r.work_order_id
  loop
    perform private.lock_work_order(job.id);
  end loop;
  perform 1 from public.job_part_requests r where r.id = any (order_part_requests.request_ids) for update;

  -- Replay: everything already ordered, on one purchase order.
  select pg_catalog.count(*), pg_catalog.min(l.purchase_order_id::text)::uuid
  into ordered_count, ordered_po
  from public.job_part_requests r
  join public.purchase_order_lines l on l.id = r.purchase_order_line_id
  where r.id = any (order_part_requests.request_ids) and r.status = 'ordered';
  if ordered_count = wanted then
    return ordered_po;
  end if;

  if (select pg_catalog.count(*) from public.job_part_requests r
      where r.id = any (order_part_requests.request_ids) and r.kind = 'part' and r.status = 'approved') <> wanted then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_approved',
      detail = 'Only approved parts that are not ordered yet can be ordered.';
  end if;

  -- D152/D158e: an approved part whose answered quote asked a deposit that
  -- is not paid (paid or partly refunded) is ordered only by an active
  -- admin or manager with a reason (a role check, D94's: no permission or
  -- exception grants it).
  select pg_catalog.array_agg(distinct d.quote_id), pg_catalog.array_agg(distinct d.work_order_id)
    into unpaid_quotes, unpaid_jobs
  from public.job_part_requests r
  join public.quote_items i on i.part_request_id = r.id and i.kind = 'part' and i.decision = 'approved'
  join public.quote_deposits d on d.quote_id = i.quote_id
  where r.id = any (order_part_requests.request_ids) and d.state <> 'paid';
  if unpaid_quotes is not null then
    override := nullif(pg_catalog.btrim(coalesce(order_part_requests.override_reason, '')), '');
    if override is null then
      raise exception using
        errcode = 'P0001',
        message = 'deposit_unpaid',
        detail = 'The customer has not paid the deposit for these parts. An admin or manager can order them anyway with a reason.';
    end if;
    if not private.can_record_refunds() then
      raise exception 'only an active admin or manager can order parts before their deposit is paid'
        using errcode = '42501';
    end if;
    override := private.require_reason(override);  -- reason_too_long over 500
  end if;

  if not exists (
    select 1 from public.suppliers s where s.id = order_part_requests.supplier_id and s.archived_at is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'supplier_unavailable',
      detail = 'That supplier does not exist or is archived.';
  end if;

  select o.id into po_id
  from public.purchase_orders o
  where o.supplier_id = order_part_requests.supplier_id and o.status = 'draft'
  order by o.created_at desc, o.id
  limit 1;
  if po_id is null then
    po := public.create_purchase_order(order_part_requests.purchase_order_id, order_part_requests.supplier_id);
    po_id := po.id;
  end if;

  for prod in
    select r.product_id, sum(r.quantity)::integer as quantity,
           (pg_catalog.array_agg(r.expected_unit_cost order by r.created_at)
              filter (where r.expected_unit_cost is not null))[1] as expected_cost,
           pg_catalog.string_agg(distinct w.job_number, ', ') as jobs
    from public.job_part_requests r
    join public.work_orders w on w.id = r.work_order_id
    where r.id = any (order_part_requests.request_ids)
    group by r.product_id
    order by r.product_id
  loop
    select l.* into line
    from public.purchase_order_lines l
    where l.purchase_order_id = po_id and l.product_id = prod.product_id;
    if found then
      line_id := line.id;
      cost := line.unit_cost;
      perform public.set_purchase_order_line(
        line.id, po_id, prod.product_id, line.quantity_ordered + prod.quantity, cost,
        line.expected_at, line.notes, null
      );
    else
      line_id := gen_random_uuid();
      cost := coalesce(
        prod.expected_cost,
        (select d.unit_cost
         from public.purchase_cost_defaults(order_part_requests.supplier_id, array[prod.product_id]) d
         where d.product_id = prod.product_id),
        0
      );
      perform public.set_purchase_order_line(
        line_id, po_id, prod.product_id, prod.quantity, cost, null,
        pg_catalog.left('For ' || prod.jobs, 500), null
      );
    end if;
    update public.job_part_requests r
    set status = 'ordered', purchase_order_line_id = line_id, ordered_at = pg_catalog.clock_timestamp(),
        ordered_by = actor
    where r.id = any (order_part_requests.request_ids) and r.product_id = prod.product_id;
  end loop;

  select o.* into po from public.purchase_orders o where o.id = po_id;
  for job in
    select r.work_order_id as id, pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('request_id', r.id, 'description', r.description, 'quantity', r.quantity)
             order by r.created_at
           ) as items
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    group by r.work_order_id
    order by r.work_order_id
  loop
    perform private.record_work_order_event(
      job.id,
      'part_ordered',
      pg_catalog.jsonb_build_object('purchase_order', po.po_number, 'items', job.items)
      || case when override is not null and job.id = any (unpaid_jobs) then
           pg_catalog.jsonb_build_object('deposit_override', pg_catalog.jsonb_build_object(
             'reason', override,
             'quote_ids', (select pg_catalog.to_jsonb(pg_catalog.array_agg(x.id order by x.id))
                           from public.quotes x
                           where x.id = any (unpaid_quotes) and x.work_order_id = job.id)))
         else '{}'::jsonb end
    );
    if order_part_requests.move_to_waiting then
      perform public.set_work_order_status(job.id, 'awaiting_parts', 'Indent parts ordered: ' || po.po_number)
      from public.work_orders w
      where w.id = job.id
        and w.status <> 'awaiting_parts'
        and private.work_order_status_is_open(w.status)
        and private.work_order_transition_rule(w.status, 'awaiting_parts') = 'allowed';
    end if;
  end loop;
  return po_id;
end;
$$;

comment on function public.order_part_requests(uuid[], uuid, uuid, boolean, text) is
  'D145/D152: manage_purchasing orders approved indent parts on the supplier''s draft purchase order (or a new one), linking each request to its line; a part whose quote''s deposit is not paid needs an active admin or manager and override_reason (deposit_unpaid without one; recorded on part_ordered as deposit_override); replay-safe.';

-- ---------------------------------------------------------------------------
-- Exceptions: two new kinds through the existing extension point (D34;
-- D108 kept: computed live, never stored). The Phase 10 select
-- (20261004004000:1891-1905) is unchanged; two branches follow it.
-- ---------------------------------------------------------------------------
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
  -- Stripe's retries of the same body is stored. A refund in another
  -- currency (currency_mismatch, always linked to its payment) is left to
  -- payment_attention's refund_not_counted, so it is listed once.
  select 'stripe_attention'::text,
         'danger'::text,
         (case when e.work_order_id is null then 'stripe_event' else 'work_order' end)::text,
         coalesce(e.work_order_id, e.id),
         coalesce(w.job_number, 'Stripe')::text,
         (case coalesce(e.outcome, e.rejection_reason::text)
            when 'payment_not_found' then 'Stripe reported a payment BICII has no record of. Check it in Stripe.'
            when 'session_mismatch' then 'A Stripe payment did not match its BICII record. Check it in Stripe.'
            when 'livemode_mismatch' then 'Stripe data from the other mode (test or live) was not applied. Check the Stripe keys.'
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
          and e.outcome is distinct from 'currency_mismatch')
      or (e.rejection_reason = 'not_recorded' and e.last_delivered_at > pg_catalog.now() - interval '3 days'
          and not exists (select 1 from public.stripe_events v
                          where v.body_sha256 = e.body_sha256 and v.rejection_reason is null)));
$$;

comment on function private.integration_exceptions() is
  'D86, D159b: the integration rows of reporting.operational_exceptions, Phase 10''s nine-column shape. integration_failed (danger): one per needs_attention Shopify job, admins only. payment_attention: one per public.payment_issues row (its severity; entity the job; subject the issue''s message), active admins and managers (private.can_record_refunds). stripe_attention (danger): a Stripe event left needs_attention in the last 30 days (except currency_mismatch, which payment_attention lists as refund_not_counted), or a not_recorded delivery in the last 3 days that no stored retry of the same body has cleared, admins only (entity the job, else the event). Computed live, never stored. Read only through reporting.operational_exceptions inside the definer RPCs; no API role may execute it.';

create or replace function private.exception_visible(p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case exception_visible.p_kind
    when 'unsettled_consignment' then private.can_view_consignment_money()
    when 'integration_failed' then private.is_admin()
    when 'payment_attention' then private.can_record_refunds()
    when 'stripe_attention' then private.is_admin()
    else private.is_staff()
  end;
$$;

comment on function private.exception_visible(text) is
  'D108 EXCEPTION-VISIBILITY: unsettled_consignment needs consignment money access (private.can_view_consignment_money(): manage_consignments or view_costs, D48); integration_failed is admins only (private.is_admin(), D86); payment_attention is active admins and managers (private.can_record_refunds(), D94, D159b); stripe_attention is admins only (D86, D159b); every other kind (Phase 5''s and unit_state_mismatch) any active staff member. The one rule for public.operational_exceptions, public.report_exception_counts and today_dashboard.exceptions_now.';

comment on view reporting.operational_exceptions is
  'Operational exceptions (D34, extended by Phase 9 D106-D108 and Phase 14 D159b). Columns: Phase 5''s nine (kind, severity, entity_type, entity_id, entity_label, subject_label, days, quantity, since), then issue, short_id, title, detail, amount, currency. Kinds: overdue_job (D20: open and now() - checked_in_at > 7 days; 7 = OVERDUE_AFTER_DAYS in src/lib/workshop.ts), uncollected_job (completed or ready >= 7 shop days), negative_stock (issue negative_on_hand), unit_hold_stale (held unit with no live line on an open job), currency_mismatch (a would-be-recognised workshop line or a sale line not in the shop currency, D104), unit_state_mismatch (D106: unit_reconciliation issues, and stock_reconciliation unit_count_mismatch / unique_movement_without_unit; never negative_on_hand, never a held unit unit_hold_stale lists), unsettled_consignment (D107: outstanding > 0 and the latest sale more than shop_settings.consignment_settlement_alert_days shop days ago), and from private.integration_exceptions(): integration_failed (Phase 10, admins only), payment_attention (public.payment_issues, admins and managers) and stripe_attention (Stripe events needing attention, admins only); their issue is the kind, title the entity label and detail the subject label. Rows are not filtered per caller here: the RPCs apply private.exception_visible(kind) (D108). Computed live, never stored. No API grants.';

-- ---------------------------------------------------------------------------
-- Step 2 privileges (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  private.quotes_deposit_snapshot(),
  public.set_indent_deposit_percent(integer),
  public.prepare_deposit_checkout(text),
  public.record_deposit_checkout(uuid, uuid, jsonb),
  public.order_part_requests(uuid[], uuid, uuid, boolean, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.set_indent_deposit_percent(integer),
  public.order_part_requests(uuid[], uuid, uuid, boolean, text)
to authenticated;

grant execute on function
  public.prepare_deposit_checkout(text),
  public.record_deposit_checkout(uuid, uuid, jsonb)
to service_role;

-- Restated for the record (create or replace keeps the grants).
revoke all on function
  private.quote_view(public.quotes),
  private.integration_exceptions(),
  private.exception_visible(text)
from public, anon, authenticated, service_role;

revoke all on table public.quote_deposits, public.payment_issues, public.work_order_payment_totals
  from public, anon, authenticated, service_role;
grant select on table public.quote_deposits, public.payment_issues, public.work_order_payment_totals
  to authenticated;
