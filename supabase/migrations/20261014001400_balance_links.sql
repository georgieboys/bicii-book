-- Phase 14 step 3: balance links (PLAN D156 and its build defaults
-- D156a-h; ADR-025; DATA-MODEL §5, §15, §16, §19; RISKS R-088, R-091,
-- R-092).
--
-- Any active staff member sends the customer a link once a job is
-- completed or ready for collection (D156a, D156e); the customer pays what
-- is left by Stripe Checkout from a BICII page that creates a 60-minute
-- session on each Pay (ADR-025: Checkout URLs are never stored or sent).
-- The amount is live, computed here at every read and Pay: the job's
-- live-lines total less net_paid (Stripe net + live counter payments,
-- work_order_payment_totals; D156b). Paying never collects the job (D154).
--
--   balance_links          one row per link sent (D156c): the token's
--                          sha256 only (private.quote_token_hash's format:
--                          32 random bytes, base64url, 43 characters), one
--                          live link per job, withdrawn when it is replaced
--                          (replaced_by), when the job is reopened or
--                          collected (D156d). Guarded for every role:
--                          never deleted; only the withdrawal moves, once.
--                          Staff read every column but token_hash.
--   payments.balance_link_id  the link a balance payment was made from
--                          (set on insert only; payments_guard keeps it).
--   payments_one_open_balance  at most one pending linked balance payment
--                          per job.
--   work_orders_withdraw_balance_link  AFTER UPDATE OF status: leaving
--                          completed/ready withdraws the live link.
--   send_balance_link      staff (D156h); returns the token once.
--   balance_by_token       the pay page (anon and authenticated, D156f).
--   prepare_balance_checkout, record_balance_checkout  service role only
--                          (src/lib/integrations/stripe/), D156h.
--   prepare_deposit_checkout, record_deposit_checkout  replaced (same
--                          signatures and grants) for the reverse
--                          direction: a balance payment on the job still
--                          being confirmed answers job_payment_processing,
--                          a live one is replaced before a deposit session
--                          is created, and either makes the deposit's
--                          record 'existing'.
--
-- Invariant (DATA-MODEL §19): a live (unexpired, Checkout not completed)
-- or processing (Checkout completed, Stripe still confirming) balance
-- payment never sits beside any other live or processing Stripe payment on
-- the same job, and a job has at most one pending linked balance payment
-- (payments_one_open_balance). A row past its expiry whose answer from
-- Stripe is not yet recorded does not block the other kind; a session paid
-- just before it expired is R-092's accepted case, recorded by D159b and
-- flagged paid_above_bill (or paid_online_and_counter; 20261014001300).
-- Every Checkout record holds the job lock, so the checks serialise.
--
-- Lock order (DATA-MODEL §19): send_balance_link takes the job
-- (private.lock_work_order), refuses a used id, withdraws the live link,
-- inserts the new one, then the timeline. record_balance_checkout takes
-- the job, then the link FOR UPDATE, then inserts the payment.
-- prepare_balance_checkout and balance_by_token take no locks. The status
-- trigger runs under the job's row lock of the UPDATE that fired it. None
-- takes the Stripe payment-intent advisory lock.
--
-- 20261014000500 already ran on the hosted project, so its two deposit
-- Checkout RPCs are replaced here, not edited there; while no balance
-- payment exists they behave exactly as before.

-- ---------------------------------------------------------------------------
-- D156c: balance_links
-- ---------------------------------------------------------------------------
create table public.balance_links (
  -- Client-chosen (the send form's id); a used id is refused, never replayed.
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  -- SHA-256 of the link's token text. Never granted to anyone but the
  -- definer RPCs: a database read cannot open the pay page.
  token_hash bytea not null,
  channel public.quote_channel not null,
  valid_days integer not null default 7,
  expires_at timestamptz not null,
  -- What was left to pay when it was sent: the staff record and timeline
  -- only; the page and Pay always use the live balance (D156b).
  amount_at_send public.money_amount not null,
  sent_by uuid not null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  withdrawn_at timestamptz null,
  withdrawn_reason text null,
  replaced_by uuid null,
  constraint balance_links_token_hash_key unique (token_hash),
  constraint balance_links_token_hash_length check (pg_catalog.octet_length(token_hash) = 32),
  constraint balance_links_valid_days_check check (valid_days between 1 and 30),
  constraint balance_links_amount_check check (amount_at_send between 0.50 and 999999.99),
  constraint balance_links_withdrawn_reason_check check (
    withdrawn_reason in ('replaced', 'reopened', 'collected')
  ),
  constraint balance_links_withdrawn_shape check ((withdrawn_at is null) = (withdrawn_reason is null)),
  -- replaced_by exactly when the link was withdrawn because another replaced it.
  constraint balance_links_replaced_shape check (
    (replaced_by is not null) = (withdrawn_reason is not distinct from 'replaced')
  ),
  -- Deferred: send_balance_link withdraws the live link (replaced_by = the
  -- new id) before it inserts the new one, which the one-live-link index
  -- requires.
  constraint balance_links_replaced_by_fkey foreign key (replaced_by)
    references public.balance_links (id) on delete restrict deferrable initially deferred
);

-- D156c: one live link per job.
create unique index balance_links_one_live on public.balance_links (work_order_id)
  where withdrawn_at is null;
create index balance_links_work_order_idx on public.balance_links (work_order_id, created_at);
create index balance_links_sent_by_idx on public.balance_links (sent_by);
create index balance_links_replaced_by_idx on public.balance_links (replaced_by)
  where replaced_by is not null;

comment on table public.balance_links is
  'D156: a payment link a staff member sent for what is left to pay on a completed or ready job (send_balance_link). Only the token''s sha256 is kept (token_hash, never granted). One live link per job (balance_links_one_live); withdrawn (withdrawn_at, withdrawn_reason) when another replaces it (replaced, replaced_by), or when the job is reopened or collected (work_orders_withdraw_balance_link). Never deleted; only the withdrawal moves, once (balance_links_guard, every role). Staff read every column but token_hash; customers and anon read nothing; no API role writes.';
comment on column public.balance_links.amount_at_send is
  'D156b: what was left to pay when the link was sent, for the staff record and the timeline only; the pay page and Pay compute the live balance every time.';
comment on column public.balance_links.expires_at is
  'D156c: sent time + valid_days (1..30, default 7); the page reads expired from then on (no scheduler).';

-- Never deleted; identity never changes; withdrawn_at, withdrawn_reason and
-- replaced_by each move once from null (for every writer, the owner
-- included). The CHECKs keep the three together.
create function private.balance_links_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array['withdrawn_at', 'withdrawn_reason', 'replaced_by'];
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_immutable',
      detail = 'A payment link is never deleted; send a new one to replace it.';
  end if;
  if (pg_catalog.to_jsonb(new) - movable) <> (pg_catalog.to_jsonb(old) - movable)
     or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at)
     or (old.withdrawn_reason is not null and new.withdrawn_reason is distinct from old.withdrawn_reason)
     or (old.replaced_by is not null and new.replaced_by is distinct from old.replaced_by) then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_immutable',
      detail = 'A payment link changes only once: when it is withdrawn.';
  end if;
  return new;
end;
$$;

comment on function private.balance_links_guard() is
  'D156c: BEFORE UPDATE OR DELETE on balance_links, for every role: a delete, a change to any column but withdrawn_at, withdrawn_reason and replaced_by, or a change to one of those once set, raises balance_link_immutable. Owner-only.';

create trigger balance_links_guard
  before update or delete on public.balance_links
  for each row execute function private.balance_links_guard();

-- ---------------------------------------------------------------------------
-- D156g: payments.balance_link_id and one pending linked balance per job
-- ---------------------------------------------------------------------------
alter table public.payments
  add column balance_link_id uuid null references public.balance_links (id) on delete restrict;

-- No backfill: every existing row is a deposit, or an owner-inserted
-- balance without a link.
alter table public.payments
  add constraint payments_balance_link_kind check (balance_link_id is null or kind = 'balance');

-- Only an insert by record_balance_checkout makes a pending linked balance
-- (Stripe's apply paths only move rows out of pending), so this never fires
-- inside a Stripe apply (D159b); record_balance_checkout answers 'existing'
-- under the job lock before it could.
create unique index payments_one_open_balance on public.payments (work_order_id)
  where kind = 'balance' and status = 'pending' and balance_link_id is not null;
create index payments_balance_link_idx on public.payments (balance_link_id)
  where balance_link_id is not null;

comment on column public.payments.balance_link_id is
  'D156g: the balance link a kind=balance payment was made from (record_balance_checkout); null for a deposit. Set on insert only (payments_guard keeps it, like every identity column).';

-- ---------------------------------------------------------------------------
-- D156d: a job leaving completed or ready withdraws its live link
-- ---------------------------------------------------------------------------

-- AFTER UPDATE OF status (a copy of 20261014000900's
-- work_orders_withdraw_open_quote); sorts after work_orders_record_history,
-- so the timeline reads "Reopened" (or "Collected") then "Payment link
-- withdrawn". Completed to ready keeps the link live; a re-completion does
-- not revive it (staff send a new link for the new bill). Cancelled cannot
-- be reached from completed or ready.
create function private.work_orders_withdraw_balance_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  withdrawn public.balance_links;
begin
  if old.status in ('completed', 'ready_for_collection')
     and new.status not in ('completed', 'ready_for_collection') then
    update public.balance_links l
    set withdrawn_at = pg_catalog.clock_timestamp(),
        withdrawn_reason = case when new.status = 'collected' then 'collected' else 'reopened' end
    where l.work_order_id = new.id and l.withdrawn_at is null
    returning l.* into withdrawn;
    if withdrawn.id is not null then
      perform private.record_work_order_event(
        new.id,
        'balance_link_withdrawn',
        pg_catalog.jsonb_build_object('link_id', withdrawn.id, 'reason', withdrawn.withdrawn_reason)
      );
    end if;
  end if;
  return null;
end;
$$;

comment on function private.work_orders_withdraw_balance_link() is
  'D156d: when a job leaves completed or ready_for_collection (a reopen, or Collected) its live balance link is withdrawn (reopened or collected) and balance_link_withdrawn {link_id, reason} written; the actor is the staff member who moved the job. Owner-only.';

create trigger work_orders_withdraw_balance_link
  after update of status on public.work_orders
  for each row
  when (old.status is distinct from new.status)
  execute function private.work_orders_withdraw_balance_link();

-- ---------------------------------------------------------------------------
-- D156h: send_balance_link (any active staff member)
-- ---------------------------------------------------------------------------
create function public.send_balance_link(
  p_link_id uuid,
  p_work_order_id uuid,
  p_channel public.quote_channel,
  p_valid_days integer default 7
)
returns table (
  link_id uuid,
  token text,
  amount public.money_amount,
  expires_at timestamptz,
  replaced_link_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
  owed numeric;
  replaced uuid;
  new_token text;
  stamp timestamptz;
  inserted public.balance_links;
begin
  if send_balance_link.p_link_id is null or send_balance_link.p_work_order_id is null
     or send_balance_link.p_channel is null or send_balance_link.p_valid_days is null then
    raise exception 'p_link_id, p_work_order_id, p_channel and p_valid_days are required'
      using errcode = '22004';
  end if;
  if send_balance_link.p_valid_days < 1 or send_balance_link.p_valid_days > 30 then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_validity_invalid',
      detail = 'A payment link is valid for 1 to 30 days.';
  end if;

  -- The job (P0002 when there is none), then a used id: no replay, since
  -- the token is shown only once.
  wo := private.lock_work_order(send_balance_link.p_work_order_id);
  if exists (select 1 from public.balance_links l where l.id = send_balance_link.p_link_id) then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_already_sent',
      detail = 'This payment link was already sent. Send a new one to get a new link.';
  end if;

  -- D156a: the bill is final.
  if wo.status not in ('completed', 'ready_for_collection') then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_not_ready',
      detail = 'A payment link can be sent once the job is completed or ready for collection.';
  end if;
  if wo.currency <> 'SGD' or wo.currency <> private.shop_currency() then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_currency',
      detail = 'Payment links are in SGD, the shop currency, only.';
  end if;
  -- D156b: the live balance.
  select greatest(t.job_total - t.net_paid, 0) into owed
  from public.work_order_payment_totals t
  where t.work_order_id = wo.id;
  if owed < 0.50 then
    raise exception using
      errcode = 'P0001',
      message = 'balance_too_small',
      detail = 'Less than S$0.50 is left to pay on this job; take it at the counter.';
  end if;
  if owed > 999999.99 then
    raise exception using
      errcode = 'P0001',
      message = 'balance_too_large',
      detail = 'Too large to pay online; take it at the counter.';
  end if;
  -- Money in flight is not asked for again.
  if exists (select 1 from public.payments p
             where p.work_order_id = wo.id and p.status = 'pending' and p.checkout_completed_at is not null) then
    raise exception using
      errcode = 'P0001',
      message = 'balance_payment_processing',
      detail = 'An online payment on this job is still being confirmed. Press Check with Stripe first.';
  end if;

  -- The live link, if any, is replaced (the deferred FK lets replaced_by
  -- name the row inserted next).
  update public.balance_links l
  set withdrawn_at = pg_catalog.clock_timestamp(), withdrawn_reason = 'replaced',
      replaced_by = send_balance_link.p_link_id
  where l.work_order_id = wo.id and l.withdrawn_at is null
  returning l.id into replaced;
  if replaced is not null then
    perform private.record_work_order_event(
      wo.id, 'balance_link_withdrawn', pg_catalog.jsonb_build_object('link_id', replaced, 'reason', 'replaced')
    );
  end if;

  -- 32 random bytes as base64url without padding: 43 characters.
  new_token := pg_catalog.rtrim(
    pg_catalog.translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
    '='
  );
  stamp := pg_catalog.clock_timestamp();
  insert into public.balance_links as l (
    id, work_order_id, token_hash, channel, valid_days, expires_at, amount_at_send, sent_by, created_at
  )
  values (
    send_balance_link.p_link_id, wo.id, private.quote_token_hash(new_token), send_balance_link.p_channel,
    send_balance_link.p_valid_days, stamp + pg_catalog.make_interval(days => send_balance_link.p_valid_days),
    owed, actor, stamp
  )
  on conflict (id) do nothing
  returning l.* into inserted;
  -- The same id inserted for another job meanwhile (the job lock does not
  -- serialise two jobs); this raise also undoes the withdrawal above.
  if inserted.id is null then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_already_sent',
      detail = 'This payment link was already sent. Send a new one to get a new link.';
  end if;

  perform private.record_work_order_event(
    wo.id,
    'balance_link_sent',
    pg_catalog.jsonb_build_object(
      'link_id', inserted.id, 'channel', inserted.channel::text, 'valid_days', inserted.valid_days,
      'amount', inserted.amount_at_send
    )
  );
  return query select inserted.id, new_token, inserted.amount_at_send, inserted.expires_at, replaced;
end;
$$;

comment on function public.send_balance_link(uuid, uuid, public.quote_channel, integer) is
  'D156: an active staff member (42501 otherwise) sends a payment link for what is left to pay. Refuses balance_link_validity_invalid (valid_days outside 1..30), a used id balance_link_already_sent (after the job lock; no replay, the token is shown once), balance_link_not_ready (job not completed or ready_for_collection), balance_link_currency (not SGD, the shop currency), balance_too_small (live balance under S$0.50, nothing left or paid ahead), balance_too_large (above S$999,999.99) and balance_payment_processing (a Stripe payment on the job is still being confirmed). Withdraws the live link (replaced; balance_link_withdrawn) and returns its id as replaced_link_id so the app can expire its open session. Returns the token once; writes balance_link_sent {link_id, channel, valid_days, amount}.';

-- ---------------------------------------------------------------------------
-- D156f: the pay page (anyone holding the link)
-- ---------------------------------------------------------------------------
create function public.balance_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hashed bytea := private.quote_token_hash(balance_by_token.p_token);
  link public.balance_links;
  wo public.work_orders;
  bike public.bikes;
  customer_first_name text;
  tot record;
  owed numeric;
  ahead numeric;
  state text;
begin
  if hashed is null then
    return null;
  end if;
  select l.* into link from public.balance_links l where l.token_hash = hashed;
  if not found then
    return null;
  end if;
  select w.* into wo from public.work_orders w where w.id = link.work_order_id;
  -- The link before the job; 'closed' is read from the job's status on
  -- every read (the status trigger withdraws the link first in practice).
  state := case
    when link.withdrawn_at is not null then 'withdrawn'
    when link.expires_at <= pg_catalog.clock_timestamp() then 'expired'
    when wo.status not in ('completed', 'ready_for_collection') then 'closed'
    else 'open'
  end;
  if state <> 'open' then
    return pg_catalog.jsonb_build_object('status', state, 'job_number', wo.job_number);
  end if;

  select b.* into bike from public.bikes b where b.id = wo.bike_id;
  select c.first_name into customer_first_name from public.customers c where c.id = wo.customer_id;
  select t.job_total, t.net_paid into tot from public.work_order_payment_totals t where t.work_order_id = wo.id;
  owed := greatest(tot.job_total - tot.net_paid, 0);
  ahead := greatest(tot.net_paid - tot.job_total, 0);
  return pg_catalog.jsonb_build_object(
    'status', 'open',
    -- The shop has no name setting; the Admin's own pages say BICII.
    'shop_name', 'BICII',
    'job_number', wo.job_number,
    -- D143: the bike as brand, model and variant; never its serial.
    'bike', pg_catalog.concat_ws(' ', bike.brand, bike.model, bike.variant),
    'first_name', customer_first_name,
    'currency', wo.currency,
    -- The live lines, sale side only, in my_work_order_lines' order. A
    -- stock or consigned unit's line reads "<product> · <unit short_id> ·
    -- S/N <serial>": the snapshot name is cut before ' · <short_id>', so a
    -- unit id or a serial never shows. Whenever the snapshot does not
    -- carry ' · <short_id>' after its first character (another format),
    -- the product's current name (or 'Part') is shown instead: it fails
    -- closed, never printing the rest of the description.
    'lines', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'description',
          case
            when u.id is null then li.description_snapshot
            when cut.pos > 1 then pg_catalog.left(li.description_snapshot, cut.pos - 1)
            else coalesce(p.name, 'Part')
          end,
          'quantity', li.quantity,
          'line_total', li.sale_total
        )
        order by li.created_at, li.id
      )
      from public.work_order_line_items li
      left join public.inventory_units u on u.id = li.source_inventory_unit_id
      left join public.products p on p.id = li.source_product_id
      cross join lateral (
        select pg_catalog.strpos(li.description_snapshot, ' · ' || u.short_id) as pos
      ) cut
      where li.work_order_id = wo.id and li.voided_at is null
    ), '[]'::jsonb),
    'job_total', tot.job_total,
    'paid', tot.net_paid,
    'paid_ahead', ahead::public.money_amount,
    'balance_due', owed::public.money_amount,
    'payment', case
      when exists (select 1 from public.payments x
                   where x.work_order_id = wo.id and x.status = 'pending'
                     and x.checkout_completed_at is not null) then 'processing'
      when owed = 0 then 'nothing_due'
      when owed < 0.50 then 'too_small'
      when owed > 999999.99 then 'too_large'
      else 'due'
    end
  );
end;
$$;

comment on function public.balance_by_token(text) is
  'D156f: what the pay page shows for a link token (anon and authenticated): null for an unknown token; {status, job_number} only when the link is withdrawn, expired or its job is not completed or ready (closed); otherwise 12 keys: status open, shop_name, job_number, bike (brand, model, variant), first_name, currency, lines (live lines in order: description with any unit short_id and serial cut, quantity, line_total), job_total, paid (net_paid: Stripe net and counter), paid_ahead, balance_due (live), payment (processing while a Stripe payment on the job is being confirmed, else nothing_due, too_small under S$0.50, too_large above S$999,999.99, or due). Never costs, notes, staff, contacts, other jobs, ids of any kind, unit ids, serial numbers (lines or bike), voided lines, Stripe ids or URLs.';

-- ---------------------------------------------------------------------------
-- D156h: Pay (service role only, src/lib/integrations/stripe/)
-- ---------------------------------------------------------------------------

-- Decides, without locks, what the pay page's Pay does, over every pending
-- Stripe payment on the job: processing (one is being confirmed: no Pay);
-- replace (a session that must go first: a live deposit session, another
-- link's or an unlinked balance session, a withdrawn link's pending row not
-- yet recorded as expired, or this link's live session at an old amount;
-- the app expires it and records Stripe's answer, then asks again); check
-- (this link's pending session, to re-read and reuse); nothing_due (under
-- S$0.50 left; this link's pending session, if any, for the app to expire);
-- or create (a fresh payment id, the live balance in money and cents, a
-- 60-minute expiry in whole seconds). Every amount is compared here, in
-- numeric.
create function public.prepare_balance_checkout(p_token text)
returns table (
  outcome text,
  payment_id uuid,
  work_order_id uuid,
  link_id uuid,
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
  hashed bytea := private.quote_token_hash(prepare_balance_checkout.p_token);
  link public.balance_links;
  wo public.work_orders;
  owed numeric;
  pay public.payments;
  now_at timestamptz := pg_catalog.clock_timestamp();
begin
  if hashed is null then
    raise exception using errcode = 'P0002', message = 'balance_link_not_found', detail = 'This link is not valid.';
  end if;
  select l.* into link from public.balance_links l where l.token_hash = hashed;
  if not found then
    raise exception using errcode = 'P0002', message = 'balance_link_not_found', detail = 'This link is not valid.';
  end if;
  select w.* into wo from public.work_orders w where w.id = link.work_order_id;
  if link.withdrawn_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_withdrawn',
      detail = 'This payment link was replaced or withdrawn. Ask the shop for a new one.';
  end if;
  if link.expires_at <= now_at then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_expired',
      detail = 'This payment link has expired. Ask the shop for a new one.';
  end if;
  if wo.status not in ('completed', 'ready_for_collection') then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_job_closed',
      detail = 'This job can no longer be paid online. Ask the shop.';
  end if;
  select greatest(t.job_total - t.net_paid, 0) into owed
  from public.work_order_payment_totals t
  where t.work_order_id = wo.id;
  if owed > 999999.99 then
    raise exception using
      errcode = 'P0001',
      message = 'balance_too_large',
      detail = 'Too large to pay online. Ask the shop.';
  end if;

  -- (i) Money in flight on the job: no Pay.
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.status = 'pending' and p.checkout_completed_at is not null
  order by p.created_at, p.id
  limit 1;
  if found then
    return query select 'processing'::text, pay.id, wo.id, link.id, wo.job_number::text, pay.amount,
      pay.amount_cents, pay.currency, pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;

  -- (ii) A session that must go before this link's (the soonest to expire
  -- first). A linked balance row past its expiry still holds
  -- payments_one_open_balance until Stripe's answer is recorded.
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.status = 'pending' and p.checkout_completed_at is null
    and ((p.kind = 'deposit' and p.stripe_session_expires_at > now_at)
         or (p.kind = 'balance' and p.balance_link_id is distinct from link.id
             and (p.stripe_session_expires_at > now_at or p.balance_link_id is not null))
         or (p.balance_link_id = link.id and p.stripe_session_expires_at > now_at and p.amount <> owed))
  order by p.stripe_session_expires_at, p.created_at, p.id
  limit 1;
  if found then
    return query select 'replace'::text, pay.id, wo.id, link.id, wo.job_number::text, pay.amount,
      pay.amount_cents, pay.currency, pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;

  -- This link's pending row (at most one: payments_one_open_balance): live
  -- at the current amount, or past its expiry and not yet recorded.
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.status = 'pending' and p.balance_link_id = link.id;

  -- (iv) Nothing to pay online.
  if owed < 0.50 then
    return query select 'nothing_due'::text, pay.id, wo.id, link.id, wo.job_number::text,
      owed::public.money_amount, (owed * 100)::bigint, 'SGD'::char(3), pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;
  -- (iii) Re-read it (the app reuses it when open and more than 120 s from
  -- its expiry, else expires and records it).
  if pay.id is not null then
    return query select 'check'::text, pay.id, wo.id, link.id, wo.job_number::text, pay.amount,
      pay.amount_cents, pay.currency, pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
  end if;

  -- (v) A new Checkout for the live balance.
  return query select 'create'::text, gen_random_uuid(), wo.id, link.id, wo.job_number::text,
    owed::public.money_amount, (owed * 100)::bigint, 'SGD'::char(3), null::text,
    extract(epoch from pg_catalog.date_trunc('second', now_at) + interval '60 minutes')::bigint;
end;
$$;

comment on function public.prepare_balance_checkout(text) is
  'service_role (src/lib/integrations/stripe/ only; D156h): for a balance link token, what Pay does, with no locks, over every pending Stripe payment on the job: processing (one has its Checkout completed); replace (a live deposit session, a live session of another link or none, a withdrawn link''s pending row not yet recorded, or this link''s live session at an amount other than the live balance; its id and session); check (this link''s pending session at the live amount, or past its expiry); nothing_due (live balance under S$0.50, with this link''s pending session if any; amount is the live balance); create (a fresh payment id, the live balance and its cents, SGD, a 60-minute expiry as a Unix time). Raises balance_link_not_found (P0002), balance_link_withdrawn, balance_link_expired, balance_link_job_closed or balance_too_large.';

-- Records the Checkout session the app has just created at Stripe for a
-- payment id prepare_balance_checkout gave it, with the cents it asked
-- (p_amount_cents, passed through unchanged). Validates Stripe's echo of
-- what was asked; only Stripe's data moves the row afterwards.
create function public.record_balance_checkout(
  p_payment_id uuid,
  p_link_id uuid,
  p_amount_cents bigint,
  p_session jsonb
)
returns table (outcome text, payment_id uuid, stripe_checkout_session_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s jsonb := record_balance_checkout.p_session;
  link public.balance_links;
  wo public.work_orders;
  pay public.payments;
  sid text;
  expires bigint;
  owed numeric;
  now_at timestamptz := pg_catalog.clock_timestamp();
begin
  if record_balance_checkout.p_payment_id is null or record_balance_checkout.p_link_id is null
     or record_balance_checkout.p_amount_cents is null or s is null then
    raise exception 'p_payment_id, p_link_id, p_amount_cents and p_session are required' using errcode = '22004';
  end if;
  if record_balance_checkout.p_amount_cents < 50 or record_balance_checkout.p_amount_cents > 99999999 then
    raise exception 'p_amount_cents must be 50 to 99999999' using errcode = '22023';
  end if;

  -- 1. Load and lock: the job, then the link.
  select l.* into link from public.balance_links l where l.id = record_balance_checkout.p_link_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'balance_link_not_found', detail = 'This link is not valid.';
  end if;
  wo := private.lock_work_order(link.work_order_id);
  select l.* into link from public.balance_links l where l.id = link.id for update;
  sid := case when pg_catalog.jsonb_typeof(s) = 'object' then s ->> 'id' end;

  -- 2. Replay of the same payment id.
  select p.* into pay from public.payments p where p.id = record_balance_checkout.p_payment_id;
  if found then
    if pay.stripe_checkout_session_id = sid and pay.kind = 'balance' and pay.balance_link_id = link.id
       and pay.amount_cents = record_balance_checkout.p_amount_cents then
      return query select 'existing'::text, pay.id, pay.stripe_checkout_session_id;
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_conflict',
      detail = 'That payment already has another Checkout session, link or amount.';
  end if;

  -- 3. The link is live and its job completed or ready, under the locks.
  if link.withdrawn_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_withdrawn',
      detail = 'This payment link was replaced or withdrawn. Ask the shop for a new one.';
  end if;
  if link.expires_at <= now_at then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_expired',
      detail = 'This payment link has expired. Ask the shop for a new one.';
  end if;
  if wo.status not in ('completed', 'ready_for_collection') then
    raise exception using
      errcode = 'P0001',
      message = 'balance_link_job_closed',
      detail = 'This job can no longer be paid online. Ask the shop.';
  end if;

  -- 4. Another Stripe payment on the job that is live or processing, or a
  -- linked balance row still pending: it won; the app expires its new
  -- session (insert nothing, so no two can be paid at once).
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.status = 'pending'
    and (p.checkout_completed_at is not null or p.stripe_session_expires_at > now_at
         or (p.kind = 'balance' and p.balance_link_id is not null))
  order by p.created_at, p.id
  limit 1;
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
     or private.stripe_int(s -> 'amount_total') is distinct from record_balance_checkout.p_amount_cents
     or pg_catalog.lower(s ->> 'currency') is distinct from 'sgd'
     or pg_catalog.jsonb_typeof(s -> 'metadata') is distinct from 'object'
     or (s -> 'metadata' ->> 'bicii_payment_id') is distinct from record_balance_checkout.p_payment_id::text
     or (s -> 'metadata' ->> 'bicii_kind') is distinct from 'balance'
     or (s -> 'metadata' ->> 'bicii_work_order_id') is distinct from wo.id::text
     or (s -> 'metadata') ? 'bicii_quote_id'
     or (s ->> 'client_reference_id') is distinct from record_balance_checkout.p_payment_id::text
     or pg_catalog.jsonb_typeof(s -> 'livemode') is distinct from 'boolean'
     or expires is null
     or pg_catalog.to_timestamp(expires) <= now_at
     -- prepare_balance_checkout asks 60 minutes ahead
     or pg_catalog.to_timestamp(expires) > now_at + interval '61 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_mismatch',
      detail = 'The Checkout session Stripe returned does not match the balance asked.';
  end if;

  -- 6. A session belongs to one payment.
  if exists (select 1 from public.payments p where p.stripe_checkout_session_id = sid) then
    raise exception using
      errcode = 'P0001',
      message = 'checkout_session_conflict',
      detail = 'That Checkout session is already recorded for another payment.';
  end if;

  -- 7. The live balance under the locks.
  select greatest(t.job_total - t.net_paid, 0) into owed
  from public.work_order_payment_totals t
  where t.work_order_id = wo.id;
  if owed < 0.50 then
    return query select 'nothing_due'::text, null::uuid, null::text;  -- the app expires its session
    return;
  end if;
  if (owed * 100)::bigint <> record_balance_checkout.p_amount_cents then
    return query select 'stale'::text, null::uuid, null::text;  -- the app expires it and asks again
    return;
  end if;

  -- 8. Insert (the FK KEY SHARE locks on the job and the link come after
  -- their FOR UPDATE). No timeline entry: anon can repeat this.
  insert into public.payments as p (
    id, work_order_id, quote_id, kind, amount, currency, stripe_checkout_session_id,
    stripe_session_expires_at, livemode, balance_link_id
  )
  values (
    record_balance_checkout.p_payment_id, wo.id, null, 'balance', owed, 'SGD', sid,
    pg_catalog.to_timestamp(expires), (s ->> 'livemode')::boolean, link.id
  );
  return query select 'created'::text, record_balance_checkout.p_payment_id, sid;
end;
$$;

comment on function public.record_balance_checkout(uuid, uuid, bigint, jsonb) is
  'service_role (src/lib/integrations/stripe/ only; D156g, D156h): record the Checkout session Stripe returned for a payment id and the cents prepare_balance_checkout gave, under the job lock, then the link''s: created (a pending kind=balance payment for the link at the live balance), existing (a replay of the same id, session, link and cents; or another Stripe payment on the job live or processing, or a linked balance still pending: its id and session, nothing inserted), stale (the live balance is no longer p_amount_cents) or nothing_due (under S$0.50 left). Raises 22004/22023 (p_amount_cents outside 50..99,999,999), balance_link_not_found (P0002), checkout_session_conflict (that payment id holds another session, link or amount, or that session another payment), balance_link_withdrawn, balance_link_expired, balance_link_job_closed, and checkout_session_mismatch when Stripe''s echo differs from what was asked (object, cs_ id, open, amount_total = p_amount_cents, sgd, metadata bicii_payment_id, bicii_kind balance, bicii_work_order_id and no bicii_quote_id, client_reference_id, boolean livemode, an expires_at in the next 61 minutes). Writes no timeline entry.';

-- ---------------------------------------------------------------------------
-- D156h, the reverse direction: the 20261014000500 deposit Checkout RPCs
-- (:439-532, :537-657) with a pending balance payment on the job first.
-- ---------------------------------------------------------------------------

-- Decides, without locks, what the quote page's Pay does: create a new
-- Checkout session, check the open one at Stripe, report the deposit paid,
-- refunded or still being confirmed, or (D156h) report a balance payment
-- on the job still being confirmed (job_payment_processing: try again
-- shortly), or replace a balance session still open on the job (a reopen
-- left it payable), which the app expires and records before it asks
-- again.
create or replace function public.prepare_deposit_checkout(token text)
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

  -- D156h: a balance payment on this job whose Checkout completed but which
  -- Stripe is still confirming (PayNow): no deposit session is created
  -- (record_deposit_checkout would answer existing). Its own outcome, not
  -- 'processing': the deposit itself is not being confirmed. The payment's
  -- id; no session or expiry.
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.kind = 'balance' and p.status = 'pending'
    and p.checkout_completed_at is not null
  order by p.created_at, p.id
  limit 1;
  if found then
    return query select 'job_payment_processing'::text, pay.id, wo.id, q.id, wo.job_number::text, pay.amount,
      pay.amount_cents, pay.currency, null::text, null::bigint;
    return;
  end if;

  -- D156h: a balance payment's Checkout still open on this job goes first
  -- (a live or processing balance payment never sits beside another live
  -- or processing Stripe payment).
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.kind = 'balance' and p.status = 'pending'
    and p.checkout_completed_at is null and p.stripe_session_expires_at > pg_catalog.clock_timestamp()
  order by p.stripe_session_expires_at, p.created_at, p.id
  limit 1;
  if found then
    return query select 'replace'::text, pay.id, wo.id, q.id, wo.job_number::text, pay.amount, pay.amount_cents,
      pay.currency, pay.stripe_checkout_session_id,
      extract(epoch from pay.stripe_session_expires_at)::bigint;
    return;
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
  'service_role (src/lib/integrations/stripe/ only; D151, D158, D156h): for a quote link, what Pay deposit does, with no locks: create (a fresh payment id, the amount and cents computed here, a 60-minute expiry as a Unix time), check (the pending Checkout to re-read at Stripe), paid, refunded or processing (the newest such payment), job_payment_processing (a balance payment on the job whose Checkout completed and Stripe is still confirming: its id, no session or expiry; nothing to create, try again shortly), or replace (a balance payment''s session still open on the job: its id and session, for the app to expire and record first). Raises quote_not_found (P0002), deposit_not_due, deposit_parts_cancelled or deposit_job_closed.';

-- Records the Checkout session the app has just created at Stripe for a
-- payment id prepare_deposit_checkout gave it. Validates Stripe's echo of
-- what was asked; only Stripe's data moves the row afterwards. The input
-- names carry p_ because the result has a payment_id column.
create or replace function public.record_deposit_checkout(p_payment_id uuid, p_quote_id uuid, session jsonb)
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

  -- 4b. D156h: a balance payment on the job still live or being confirmed
  -- won the same way (a live or processing balance payment never sits
  -- beside another live or processing Stripe payment).
  select p.* into pay
  from public.payments p
  where p.work_order_id = wo.id and p.kind = 'balance' and p.status = 'pending'
    and (p.checkout_completed_at is not null or p.stripe_session_expires_at > pg_catalog.clock_timestamp())
  order by p.created_at, p.id
  limit 1;
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
  'service_role (src/lib/integrations/stripe/ only; D153, D158d, D156h): record the Checkout session Stripe returned for a payment id from prepare_deposit_checkout, under the job and quote locks: created (a pending payment), existing (a replay of the same pair, or another pending attempt won, or a balance payment on the job is live or being confirmed; its id and session), or paid, refunded or processing (no row). Raises checkout_session_mismatch when Stripe''s echo differs from the deposit asked (object, id, open, amount_total in cents, sgd, metadata, client_reference_id, livemode, an expires_at in the next 61 minutes), checkout_session_conflict (that payment id already holds another session or quote, or that session another payment), deposit_not_due, deposit_parts_cancelled or deposit_job_closed. Writes no timeline entry.';

-- ---------------------------------------------------------------------------
-- Privileges and RLS (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  private.balance_links_guard(),
  private.work_orders_withdraw_balance_link(),
  public.send_balance_link(uuid, uuid, public.quote_channel, integer),
  public.balance_by_token(text),
  public.prepare_balance_checkout(text),
  public.record_balance_checkout(uuid, uuid, bigint, jsonb),
  public.prepare_deposit_checkout(text),
  public.record_deposit_checkout(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;

-- D156e: any active staff member (the role check is inside).
grant execute on function
  public.send_balance_link(uuid, uuid, public.quote_channel, integer)
to authenticated;

-- D156f: the pay page, for anyone holding a link (as quote_by_token).
grant execute on function
  public.balance_by_token(text)
to anon, authenticated;

-- Restated for the two replaced deposit RPCs (create or replace keeps it).
grant execute on function
  public.prepare_balance_checkout(text),
  public.record_balance_checkout(uuid, uuid, bigint, jsonb),
  public.prepare_deposit_checkout(text),
  public.record_deposit_checkout(uuid, uuid, jsonb)
to service_role;

alter table public.balance_links enable row level security;

revoke all on table public.balance_links from public, anon, authenticated, service_role;

-- Every column except the token hash; written only by the RPCs and the
-- status trigger.
grant select (
  id, work_order_id, channel, valid_days, expires_at, amount_at_send, sent_by, created_at, withdrawn_at,
  withdrawn_reason, replaced_by
) on table public.balance_links to authenticated;

create policy balance_links_select_staff on public.balance_links
  for select to authenticated
  using ((select private.is_staff()));
