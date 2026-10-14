-- Phase 14 step 1: Stripe customer payments, recorded from Stripe's word only
-- (PLAN Phase 14, D150, D153, D155, D157-D159; ADR-025; DATA-MODEL §19,
-- §15, §16).
--
--   stripe_events     every webhook delivery (stored before it is applied,
--                     in the same transaction) and every read the server
--                     makes with the secret key. A verified delivery is
--                     deduplicated on its evt_ id; a rejected one is
--                     evidence only (D88: no body, no dedupe key, one row
--                     per bad body with a delivery count). The stored copy
--                     is an allow-listed projection: ids, statuses, amounts
--                     and bicii_* metadata, never customer details, emails
--                     or URLs (D159e). Admins only (D86).
--   payments          one row per Checkout session (step 2 creates it once
--                     Stripe has returned the session, D153). What was
--                     asked (amount, and amount_cents computed here), what
--                     Stripe confirmed (amount_received, from its integer
--                     cents) and what was refunded (refunded_amount, the
--                     sum of succeeded refunds, D155, D159c).
--   payment_refunds   one row per Stripe Refund, keyed by its id; a refund
--                     seen before its payment is kept unmatched and adopted
--                     when the payment completes.
--   RPCs (service_role only, called from src/lib/integrations/stripe/):
--                     record_stripe_event (store and apply one delivery)
--                     and record_stripe_read (store and apply an object the
--                     server read from Stripe). The owner-only
--                     private.purge_stripe_events removes old rejected
--                     deliveries by hand.
--
-- Rules encoded here, for every writer (RPC, seed, SQL editor, the owner):
--   * Provenance (D153, D159a): a Stripe-owned column of a payment or a
--     refund changes only while the stripe_events row being applied right
--     now (status 'received', which exists only inside the recording
--     transaction: a deferred constraint trigger refuses the commit of any
--     row still 'received') is cited in last_event_id. A payment starts
--     pending; it is never deleted; its job, amount and Checkout session
--     never change.
--   * Record reality, never refuse it (D159b): money Stripe confirms is
--     recorded as paid with Stripe's amount, even when the job or parts were
--     cancelled, it was already paid, or the amount or currency differs.
--     The apply raises only on bugs or infrastructure failures, which roll
--     the whole call back so Stripe retries. Problems are derived live
--     (step 2's payment_issues), never stored.
--   * Forward only and idempotent: each evt_ applies once; every transition
--     only moves forward (DATA-MODEL §19's table), so a second Event object
--     for the same change, an out-of-order event or a stale read is a no-op.
--     Refund statuses move only up in rank; a succeeded refund that later
--     fails (PayNow) puts its amount back.
--   * Money held, not revenue (D154): nothing here writes a job line, a
--     sale, a total, a job status or a completion stamp. The apply locks the
--     job and appends work_order_events only; payments are not a branch of
--     financial_lines, report_lines or daily_summary.
--
-- Lock order (DATA-MODEL §19 and the global order's "Stripe paths"):
--   1. the stripe_events row, inserted with no FK value set (no job lock);
--   2. private.lock_stripe_payment_intent(pi), a transaction advisory lock
--      taken only on the apply paths and always before the job;
--   3. private.lock_work_order(job);
--   4. the payments row FOR UPDATE;
--   5. payment_refunds rows, then work_order_events inserts, then the
--      stripe_events decision UPDATE (whose FK KEY SHARE locks come after
--      the FOR UPDATEs).
-- record_stripe_read takes the job lock without the advisory lock only on
-- its mismatch path. No non-Stripe path takes the advisory lock.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.payment_kind as enum ('deposit', 'balance');  -- balance: step 3 (D156)

create type public.payment_status as enum
  ('pending', 'paid', 'failed', 'expired', 'partially_refunded', 'refunded');

create type public.stripe_refund_status as enum
  ('pending', 'requires_action', 'succeeded', 'failed', 'canceled');

create type public.stripe_event_source as enum ('webhook', 'api_read');

-- 'received' exists only inside the recording transaction: the deferred
-- constraint trigger stripe_events_settled refuses to commit a row that
-- still has it (tested with a committed transaction).
create type public.stripe_event_status as enum
  ('received', 'applied', 'ignored', 'needs_attention', 'rejected');

create type public.stripe_rejection_reason as enum (
  'stripe_off',          -- Stripe not fully configured for this deployment (503)
  'signature_invalid',   -- no or malformed Stripe-Signature, or no v1 matched (400)
  'signature_expired',   -- a v1 matched but |now - t| > 300 s (400)
  'body_not_json',       -- verified, but not a UTF-8 JSON object (400)
  'event_shape_invalid', -- verified JSON without an evt_ id, a type or a boolean livemode (400)
  'livemode_mismatch',   -- verified, livemode differs from the configured key's mode (400)
  'not_recorded'         -- verified, but storing or applying it failed (500; Stripe retries)
);

comment on type public.payment_kind is
  'D150, D156: deposit (an indent quote''s deposit, step 2) or balance (step 3).';
comment on type public.payment_status is
  'D153, D155: pending until Stripe confirms; paid, partially_refunded and refunded form the paid group; failed and expired can still become paid (Stripe''s money wins).';
comment on type public.stripe_refund_status is
  'D159c: Stripe''s Refund statuses. Ranks: pending 0 < requires_action 1 < succeeded 2 < failed = canceled 3; a refund moves only up.';
comment on type public.stripe_rejection_reason is
  'D88, D157: why a Stripe delivery was not applied. Rejected deliveries keep no body and never take the dedupe key.';

-- ---------------------------------------------------------------------------
-- stripe_events (created first: the other tables reference it)
-- ---------------------------------------------------------------------------
create table public.stripe_events (
  id uuid primary key default gen_random_uuid(),
  source public.stripe_event_source not null,
  -- evt_… for a verified webhook only (the dedupe key); null for rejected
  -- deliveries and reads.
  stripe_event_id text null,
  -- Webhook: the event type; read: 'read.checkout.session' or 'read.refund';
  -- rejected: 'unknown'.
  event_type text not null,
  api_version text null,
  livemode boolean null,
  stripe_created_at timestamptz null,            -- the event's created (webhooks)
  object_type text null,                         -- data.object.object
  object_id text null,                           -- data.object.id (cs_, re_, …)
  -- private.stripe_event_projection(): ids, statuses, amounts and bicii_*
  -- metadata only; never customer details, emails or URLs (D159e). Null
  -- when rejected (D88).
  payload jsonb null,
  headers jsonb not null default '{}',           -- capped: 16 lower-cased keys, values <= 512
  body_sha256 text null,                         -- webhooks: SHA-256 hex of the raw bytes
  body_bytes integer null,
  rejection_reason public.stripe_rejection_reason null,
  status public.stripe_event_status not null,
  outcome text null,
  payment_id uuid null,                          -- FK added after payments exists
  work_order_id uuid null references public.work_orders (id) on delete restrict,
  received_at timestamptz not null default now(),
  delivery_count integer not null default 1,
  last_delivered_at timestamptz not null default now(),
  processed_at timestamptz null,
  correlation_id text null,
  constraint stripe_events_rejected_shape check (
    (status = 'rejected') = (rejection_reason is not null)
    and (rejection_reason is null or (
      source = 'webhook' and payload is null and stripe_event_id is null
      and outcome is null and payment_id is null and work_order_id is null))
  ),
  constraint stripe_events_event_id_shape check (
    (stripe_event_id is not null) = (source = 'webhook' and rejection_reason is null)
  ),
  constraint stripe_events_event_id_check check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  constraint stripe_events_payload_check check (
    (payload is not null) = (rejection_reason is null)
    and (payload is null or pg_catalog.jsonb_typeof(payload) = 'object')
  ),
  constraint stripe_events_headers_check check (pg_catalog.jsonb_typeof(headers) = 'object'),
  constraint stripe_events_evidence_check check (
    (source = 'webhook') = (body_sha256 is not null and body_bytes is not null)
  ),
  constraint stripe_events_body_sha256_check check (body_sha256 ~ '^[0-9a-f]{64}$'),
  constraint stripe_events_body_bytes_check check (body_bytes >= 0),
  constraint stripe_events_event_type_check check (pg_catalog.char_length(event_type) between 1 and 100),
  constraint stripe_events_api_version_check check (pg_catalog.char_length(api_version) <= 40),
  constraint stripe_events_object_check check (
    pg_catalog.char_length(object_type) <= 60 and pg_catalog.char_length(object_id) <= 255
  ),
  constraint stripe_events_delivery_count_check check (delivery_count >= 1),
  constraint stripe_events_decided_check check (
    (status in ('applied', 'ignored', 'needs_attention')) = (outcome is not null and processed_at is not null)
  ),
  constraint stripe_events_outcome_check check (outcome in (
    'payment_paid', 'paid_amount_mismatch', 'paid_after_failed', 'paid_after_expired',
    'payment_processing', 'payment_failed', 'payment_expired',
    'already_paid', 'already_processing', 'already_failed', 'already_expired', 'still_open', 'stale',
    'refund_recorded', 'refund_unchanged', 'refund_unmatched',
    'not_ours', 'type_not_handled', 'payment_not_found', 'session_mismatch', 'livemode_mismatch',
    'currency_mismatch', 'object_invalid', 'unexpected_payment_status', 'read_mismatch'
  )),
  constraint stripe_events_correlation_id_check check (pg_catalog.char_length(correlation_id) <= 128)
);

-- D88: an unauthenticated delivery never takes the dedupe key.
create unique index stripe_events_event_id_key on public.stripe_events (stripe_event_id)
  where stripe_event_id is not null;
-- D88: one bad body is one row with a delivery count (also bounds
-- not_recorded retries).
create unique index stripe_events_rejected_body_key on public.stripe_events (rejection_reason, body_sha256)
  where rejection_reason is not null;
create index stripe_events_status_received_idx on public.stripe_events (status, received_at desc);
create index stripe_events_payment_idx on public.stripe_events (payment_id);
create index stripe_events_work_order_idx on public.stripe_events (work_order_id);
create index stripe_events_object_idx on public.stripe_events (object_id);
create index stripe_events_body_sha256_idx on public.stripe_events (body_sha256);

comment on table public.stripe_events is
  'D153, D159: every Stripe webhook delivery (stored before it is applied, in the same transaction) and every server read with the secret key. Verified deliveries are deduplicated on stripe_event_id; rejected ones are evidence only (D88). Immutable except the delivery count and, inside the recording transaction, the decision. Admins only (D86). Written by record_stripe_event and record_stripe_read.';
comment on column public.stripe_events.payload is
  'An allow-listed projection; never customer details or URLs (D159e). NULL for a rejected delivery.';
comment on column public.stripe_events.status is
  'received (only inside the recording transaction; stripe_events_settled refuses to commit it), then applied, ignored or needs_attention; rejected for a delivery that was not verified or could not be stored.';

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table public.payments (
  -- Generated by step 2's prepare_deposit_checkout (gen_random_uuid) and
  -- inserted by record_deposit_checkout. Also Stripe's client_reference_id,
  -- metadata[bicii_payment_id] and the Idempotency-Key suffix.
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  quote_id uuid null references public.quotes (id) on delete restrict,   -- null for balance (step 3)
  kind public.payment_kind not null,
  -- What BICII asked (the quote's snapshot for a deposit), computed in Postgres.
  amount public.money_amount not null,
  -- The same in Stripe's minor units: Checkout's unit_amount and the exact
  -- match against amount_total.
  amount_cents bigint generated always as ((amount * 100)::bigint) stored,
  currency char(3) not null default 'SGD',
  status public.payment_status not null default 'pending',
  -- Stripe's amount_total / 100 when paid (null when Stripe's currency was not sgd).
  amount_received public.money_amount null,
  -- Sum of this payment's payment_refunds with status succeeded, in the
  -- payment's currency and mode (private.payment_refund_total; D155, D159c).
  refunded_amount public.money_amount not null default 0,
  stripe_checkout_session_id text not null,
  stripe_session_expires_at timestamptz not null,
  stripe_payment_intent_id text null,
  livemode boolean not null,
  -- Stripe reported the session complete (paid, or still being confirmed).
  checkout_completed_at timestamptz null,
  paid_at timestamptz null,                      -- Stripe's time (D159d)
  failed_at timestamptz null,
  expired_at timestamptz null,
  checked_at timestamptz null,                   -- last server read (customer Pay or return, staff Check)
  -- The stripe_events row whose application last changed a Stripe-owned
  -- column (provenance).
  last_event_id uuid null references public.stripe_events (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint payments_kind_quote check ((kind = 'deposit') = (quote_id is not null)),
  constraint payments_amount_check check (amount between 0.50 and 999999.99),
  constraint payments_currency_check check (currency = 'SGD'),
  constraint payments_amount_received_check check (amount_received >= 0),
  constraint payments_refunded_amount_check check (refunded_amount >= 0),
  constraint payments_paid_shape check (
    (status in ('paid', 'partially_refunded', 'refunded')) = (paid_at is not null)
  ),
  constraint payments_closed_shape check (
    (status <> 'failed' or failed_at is not null) and (status <> 'expired' or expired_at is not null)
  ),
  constraint payments_session_id_check check (
    stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$'
  ),
  constraint payments_payment_intent_id_check check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$')
);

create unique index payments_checkout_session_key on public.payments (stripe_checkout_session_id);
-- D158d: one open Checkout per quote. Paid rows are not limited: a second
-- paid deposit is recorded and flagged (D159b), never refused.
create unique index payments_one_open_deposit on public.payments (quote_id)
  where kind = 'deposit' and status = 'pending';
-- Lookup only: a unique index on a Stripe-supplied value could raise inside
-- the apply.
create index payments_payment_intent_idx on public.payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create index payments_work_order_idx on public.payments (work_order_id, created_at);
create index payments_quote_idx on public.payments (quote_id) where quote_id is not null;
create index payments_last_event_idx on public.payments (last_event_id);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function private.set_updated_at();

alter table public.stripe_events add constraint stripe_events_payment_fk
  foreign key (payment_id) references public.payments (id) on delete restrict;

comment on table public.payments is
  'D150, D153, D154, D155: one row per Stripe Checkout session. Money held, not revenue: never a job line, sale or total. Changes only while a verified Stripe event or read is applied (payments_guard); never deleted. Active staff read it; every write is an RPC.';
comment on column public.payments.amount_cents is
  'Computed in Postgres; Checkout''s unit_amount and the exact match against amount_total (D158).';
comment on column public.payments.amount_received is
  'Stripe''s amount_total / 100 when paid, from its integer cents; null when Stripe''s currency was not SGD or the amount was unreadable (D159b: recorded, flagged, never refused).';
comment on column public.payments.last_event_id is
  'Provenance (D153, D159a): the stripe_events row whose application last changed a Stripe-owned column.';

-- ---------------------------------------------------------------------------
-- payment_refunds
-- ---------------------------------------------------------------------------
create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  stripe_refund_id text not null,
  stripe_payment_intent_id text not null,
  -- Null while no payment carries this payment intent (a refund seen before
  -- the completion); adopted later.
  payment_id uuid null references public.payments (id) on delete restrict,
  amount public.money_amount not null,           -- Stripe's refund.amount / 100, fixed at first sight
  currency char(3) not null,
  -- The mode of the event that first recorded it (a Refund object carries
  -- none); null when a server read recorded it first.
  livemode boolean null,
  status public.stripe_refund_status not null,   -- moves only up in rank (private.stripe_refund_rank)
  reason text null,
  failure_reason text null,
  stripe_created_at timestamptz null,            -- refund.created (step 3 dates refunds by it)
  last_event_id uuid not null references public.stripe_events (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint payment_refunds_refund_id_check check (stripe_refund_id ~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$'),
  constraint payment_refunds_payment_intent_id_check check (
    stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$'
  ),
  constraint payment_refunds_amount_check check (amount > 0),
  constraint payment_refunds_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payment_refunds_text_check check (
    pg_catalog.char_length(reason) <= 60 and pg_catalog.char_length(failure_reason) <= 120
  )
);

create unique index payment_refunds_refund_key on public.payment_refunds (stripe_refund_id);
create index payment_refunds_payment_idx on public.payment_refunds (payment_id, stripe_created_at);
create index payment_refunds_unlinked_idx on public.payment_refunds (stripe_payment_intent_id)
  where payment_id is null;
create index payment_refunds_last_event_idx on public.payment_refunds (last_event_id);

create trigger payment_refunds_set_updated_at
  before update on public.payment_refunds
  for each row execute function private.set_updated_at();

comment on table public.payment_refunds is
  'D155, D159c: one row per Stripe Refund (made by hand in Stripe), dated by stripe_created_at. Only succeeded refunds in the payment''s currency and mode reduce the money held (private.payment_refund_total); another currency or mode is recorded, linked and flagged, never counted. Unmatched rows (no payment yet, or another sale of the Stripe account) are admins only; matched rows are read by active staff. Never deleted.';

-- ---------------------------------------------------------------------------
-- Guards (every role, including the owner)
-- ---------------------------------------------------------------------------

-- D153, D159a: a payment starts pending, is never deleted, keeps its
-- identity, and changes a Stripe-owned column only while citing the
-- stripe_events row being applied right now (status 'received').
create function private.payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  stripe_owned constant text[] := array[
    'status', 'amount_received', 'refunded_amount', 'paid_at', 'failed_at', 'expired_at',
    'checkout_completed_at', 'stripe_payment_intent_id'
  ];
  -- amount_cents is generated (not yet computed in a BEFORE trigger); amount
  -- itself is compared.
  free constant text[] := array['checked_at', 'updated_at', 'last_event_id', 'amount_cents'];
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'payment_immutable',
      detail = 'A customer payment is never deleted.';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.amount_received is not null or new.refunded_amount <> 0
       or new.paid_at is not null or new.failed_at is not null or new.expired_at is not null
       or new.checkout_completed_at is not null or new.stripe_payment_intent_id is not null
       or new.last_event_id is not null or new.checked_at is not null then
      raise exception using
        errcode = 'P0001',
        message = 'payment_immutable',
        detail = 'A payment starts pending; only Stripe moves it.';
    end if;
    return new;
  end if;
  -- Identity (job, quote, kind, amount, currency, session, expiry, mode,
  -- created_at) never changes.
  if (pg_catalog.to_jsonb(new) - stripe_owned - free) <> (pg_catalog.to_jsonb(old) - stripe_owned - free) then
    raise exception using
      errcode = 'P0001',
      message = 'payment_immutable',
      detail = 'A payment''s job, amount and Checkout session never change.';
  end if;
  -- Provenance: a Stripe-owned change cites the event being applied now.
  if (pg_catalog.to_jsonb(new) - free) <> (pg_catalog.to_jsonb(old) - free) then
    if new.last_event_id is not distinct from old.last_event_id or not exists (
      select 1 from public.stripe_events e where e.id = new.last_event_id and e.status = 'received'
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'payment_immutable',
        detail = 'A payment changes only while a verified Stripe event or read is applied.';
    end if;
  elsif new.last_event_id is distinct from old.last_event_id then
    raise exception using
      errcode = 'P0001',
      message = 'payment_immutable',
      detail = 'A payment changes only while a verified Stripe event or read is applied.';
  end if;
  if old.stripe_payment_intent_id is not null
     and new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id then
    raise exception using
      errcode = 'P0001',
      message = 'payment_immutable',
      detail = 'A payment''s Stripe payment never changes.';
  end if;
  -- pending moves anywhere; failed and expired only into the paid group
  -- (Stripe's money wins); the paid group only within itself.
  if new.status <> old.status and not (
       old.status = 'pending'
    or (old.status in ('failed', 'expired') and new.status in ('paid', 'partially_refunded', 'refunded'))
    or (old.status in ('paid', 'partially_refunded', 'refunded')
        and new.status in ('paid', 'partially_refunded', 'refunded'))
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'payment_immutable',
      detail = 'That change of payment status is not allowed.';
  end if;
  return new;
end;
$$;

create trigger payments_guard
  before insert or update or delete on public.payments
  for each row execute function private.payments_guard();

-- D159c: pending 0 < requires_action 1 < succeeded 2 < failed = canceled 3.
create function private.stripe_refund_rank(status public.stripe_refund_status)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case stripe_refund_rank.status
    when 'pending' then 0
    when 'requires_action' then 1
    when 'succeeded' then 2
    else 3
  end;
$$;

-- D155, D159c: a refund is never deleted; its identity, amount, currency,
-- mode, reason and dates never change; its status moves only up in rank;
-- it is linked to a payment once; and every change cites the event being
-- applied.
create function private.payment_refunds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array['status', 'failure_reason', 'payment_id', 'last_event_id', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A recorded refund is never deleted.';
  end if;
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.stripe_events e where e.id = new.last_event_id and e.status = 'received'
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'payment_refund_immutable',
        detail = 'A refund is recorded only while a verified Stripe event or read is applied.';
    end if;
    return new;
  end if;
  if (pg_catalog.to_jsonb(new) - movable) <> (pg_catalog.to_jsonb(old) - movable) then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A refund''s amount, currency and dates never change.';
  end if;
  if old.payment_id is not null and new.payment_id is distinct from old.payment_id then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A refund''s payment never changes.';
  end if;
  if new.status <> old.status
     and private.stripe_refund_rank(new.status) <= private.stripe_refund_rank(old.status) then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A refund''s status only moves forward.';
  end if;
  if (pg_catalog.to_jsonb(new) - 'updated_at'::text) <> (pg_catalog.to_jsonb(old) - 'updated_at'::text)
     and (new.last_event_id is not distinct from old.last_event_id or not exists (
       select 1 from public.stripe_events e where e.id = new.last_event_id and e.status = 'received'
     )) then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A refund changes only while a verified Stripe event or read is applied.';
  end if;
  return new;
end;
$$;

create trigger payment_refunds_guard
  before insert or update or delete on public.payment_refunds
  for each row execute function private.payment_refunds_guard();

-- D88, D159: evidence. Only the delivery count moves, and the decision is
-- written once, inside the recording transaction (while 'received'). A
-- rejected row may be deleted only by private.purge_stripe_events.
create function private.stripe_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mutable text[] := array['delivery_count', 'last_delivered_at'];
begin
  if tg_op = 'DELETE' then
    if coalesce(pg_catalog.current_setting('bicii.stripe_purge', true), '') = 'on' and old.status = 'rejected' then
      return old;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'stripe_event_immutable',
      detail = 'A Stripe event is kept as evidence; it is never deleted.';
  end if;
  if old.status = 'received' then
    mutable := mutable || array['status', 'outcome', 'payment_id', 'work_order_id', 'processed_at'];
  end if;
  if (pg_catalog.to_jsonb(new) - mutable) <> (pg_catalog.to_jsonb(old) - mutable) then
    raise exception using
      errcode = 'P0001',
      message = 'stripe_event_immutable',
      detail = 'A received Stripe event cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger stripe_events_guard
  before update or delete on public.stripe_events
  for each row execute function private.stripe_events_guard();

-- D159a: 'received' marks the one event being applied, so it must never
-- outlive the transaction that records it; otherwise a committed
-- 'received' row could be cited later as provenance by any writer. Checked
-- at commit (deferred), on the row as it is then: the recording RPCs insert
-- 'received' and write the decision before they return. Security definer:
-- at commit the trigger runs as the caller (service_role), which cannot
-- read the table.
create function private.stripe_events_settled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.stripe_events e where e.id = new.id and e.status = 'received') then
    raise exception using
      errcode = 'P0001',
      message = 'stripe_event_immutable',
      detail = 'A Stripe event is decided in the transaction that records it.';
  end if;
  return null;
end;
$$;

create constraint trigger stripe_events_settled
  after insert or update on public.stripe_events
  deferrable initially deferred
  for each row
  when (new.status = 'received')
  execute function private.stripe_events_settled();

-- ---------------------------------------------------------------------------
-- Private helpers (no API role may execute them)
-- ---------------------------------------------------------------------------

-- D88: the header cap of record_shopify_webhook (20261004003900): keys
-- lower-cased and de-duplicated, sorted, the first 16 kept, values cut to
-- 512 characters, and a marker when anything was dropped or cut.
create function private.stripe_capped_headers(headers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with h as (
    select pg_catalog.lower(e.key) as k, coalesce(e.value, '') as v,
           row_number() over (partition by pg_catalog.lower(e.key) order by e.key) as dup
    from pg_catalog.jsonb_each_text(
      case when pg_catalog.jsonb_typeof(stripe_capped_headers.headers) = 'object'
           then stripe_capped_headers.headers else '{}'::jsonb end
    ) e
  ),
  u as (
    select h.k, h.v, row_number() over (order by h.k) as n
    from h
    where h.dup = 1
  )
  select coalesce(pg_catalog.jsonb_object_agg(u.k, pg_catalog.left(u.v, 512)) filter (where u.n <= 16), '{}'::jsonb)
    || case
         when (select count(*) from h) > count(*) filter (where u.n <= 16)
           or coalesce(bool_or(pg_catalog.char_length(u.v) > 512) filter (where u.n <= 16), false)
         then '{"x-bicii-truncated": "true"}'::jsonb
         else '{}'::jsonb
       end
  from u;
$$;

-- A Stripe reference: the id string itself, or the id of an expanded object.
create function private.stripe_ref(value jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(stripe_ref.value)
    when 'string' then stripe_ref.value #>> '{}'
    when 'object' then
      case when pg_catalog.jsonb_typeof(stripe_ref.value -> 'id') = 'string' then stripe_ref.value ->> 'id' end
  end;
$$;

-- Stripe's integer minor units, or null: never a float, a string or a
-- negative number.
create function private.stripe_int(value jsonb)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(stripe_int.value) = 'number' and (stripe_int.value #>> '{}') ~ '^[0-9]{1,12}$'
    then (stripe_int.value #>> '{}')::bigint
  end;
$$;

-- D159e: the stored copy of a Stripe object. Scalars from an allow-list,
-- payment_intent and charge as ids, and bicii_* string metadata; nothing
-- else (no customer details, emails, addresses or URLs).
create function private.stripe_object_projection(o jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(stripe_object_projection.o) = 'object' then
    coalesce((
      select pg_catalog.jsonb_object_agg(k.key, stripe_object_projection.o -> k.key)
      from pg_catalog.unnest(array['id', 'object', 'livemode', 'status', 'payment_status', 'amount_total',
        'amount', 'currency', 'expires_at', 'created', 'client_reference_id', 'reason', 'failure_reason']) as k (key)
      where pg_catalog.jsonb_typeof(stripe_object_projection.o -> k.key) in ('string', 'number', 'boolean')
    ), '{}'::jsonb)
    || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'payment_intent', pg_catalog.to_jsonb(private.stripe_ref(stripe_object_projection.o -> 'payment_intent')),
      'charge', pg_catalog.to_jsonb(private.stripe_ref(stripe_object_projection.o -> 'charge')),
      'metadata', (
        select pg_catalog.jsonb_object_agg(m.key, m.value)
        from pg_catalog.jsonb_each(
          case when pg_catalog.jsonb_typeof(stripe_object_projection.o -> 'metadata') = 'object'
               then stripe_object_projection.o -> 'metadata' else '{}'::jsonb end
        ) as m
        where m.key ~ '^bicii_[a-z_]{1,32}$' and pg_catalog.jsonb_typeof(m.value) = 'string'
          and pg_catalog.char_length(m.value #>> '{}') <= 100)
    ))
  end;
$$;

-- D159e: the stored copy of a Stripe Event: its own scalars and the
-- projected data.object; data.previous_attributes and request are dropped.
create function private.stripe_event_projection(e jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(stripe_event_projection.e) = 'object' then
    coalesce((
      select pg_catalog.jsonb_object_agg(k.key, stripe_event_projection.e -> k.key)
      from pg_catalog.unnest(array['id', 'type', 'livemode', 'created', 'api_version']) as k (key)
      where pg_catalog.jsonb_typeof(stripe_event_projection.e -> k.key) in ('string', 'number', 'boolean')
    ), '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'object', 'event',
      'data', pg_catalog.jsonb_build_object(
        'object', private.stripe_object_projection(stripe_event_projection.e -> 'data' -> 'object')
      )
    )
  end;
$$;

-- Lock order 2: serialises a session's events and reads with the refund
-- events of the same payment intent; always taken before the job.
create function private.lock_stripe_payment_intent(payment_intent_id text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bicii.stripe.payment_intent:' || lock_stripe_payment_intent.payment_intent_id, 0)
  );
end;
$$;

-- D155, D159c: the money refunded from a payment: its succeeded refunds in
-- the payment's currency and mode. A refund in another currency or mode
-- (null mode: a server read, made with this deployment's key) is recorded
-- and flagged by apply_stripe_refund but never netted.
create function private.payment_refund_total(pay public.payments)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(r.amount), 0)
  from public.payment_refunds r
  where r.payment_id = payment_refund_total.pay.id
    and r.status = 'succeeded'
    and r.currency = payment_refund_total.pay.currency
    and (r.livemode is null or r.livemode = payment_refund_total.pay.livemode);
$$;

-- D155, D159c: the only place a paid payment moves within the paid group: a
-- pure function of its refund rows, so the order refund events arrive in
-- does not matter. The caller holds the job lock and the payment FOR
-- UPDATE. Returns whether it changed the payment.
create function private.settle_payment(pay public.payments, event_id uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  total numeric;
  base numeric;
  new_status public.payment_status;
begin
  if pay.status not in ('paid', 'partially_refunded', 'refunded') then
    return false;  -- a later paid transition sums the refunds itself
  end if;
  total := private.payment_refund_total(pay);
  base := coalesce(pay.amount_received, pay.amount);
  new_status := case when total = 0 then 'paid' when total < base then 'partially_refunded' else 'refunded' end;
  if total = pay.refunded_amount and new_status = pay.status then
    return false;
  end if;
  update public.payments p
  set refunded_amount = total, status = new_status, last_event_id = settle_payment.event_id
  where p.id = pay.id;
  if total > pay.refunded_amount then
    perform private.record_work_order_event(
      pay.work_order_id,
      'payment_refunded',
      pg_catalog.jsonb_build_object(
        'payment_id', pay.id, 'kind', pay.kind,
        'refunded', (total - pay.refunded_amount)::public.money_amount,
        'refunded_total', total::public.money_amount,
        'currency', pay.currency::text, 'full', new_status = 'refunded'
      )
    );
  elsif total < pay.refunded_amount then
    perform private.record_work_order_event(
      pay.work_order_id,
      'payment_refund_failed',
      pg_catalog.jsonb_build_object(
        'payment_id', pay.id, 'kind', pay.kind,
        'amount', (pay.refunded_amount - total)::public.money_amount,
        'refunded_total', total::public.money_amount,
        'currency', pay.currency::text
      )
    );
  end if;
  return true;
end;
$$;

-- D153, D159 (DATA-MODEL §19): apply a Checkout Session. Never raises for
-- Stripe data: every unexpected shape becomes an outcome. Every transition
-- is exactly one UPDATE of the payment citing the event; timeline entries
-- follow it.
create function private.apply_stripe_session(ev public.stripe_events, obj jsonb)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  o jsonb := apply_stripe_session.obj;
  sid text;
  ref text;
  pi text;
  pay public.payments;
  target text;
  paid_group boolean;
  cents bigint;
  received public.money_amount;
  refunds numeric;
  base numeric;
  new_status public.payment_status;
  result_outcome text;
begin
  -- 1. Shape.
  sid := o ->> 'id';
  if pg_catalog.jsonb_typeof(o) is distinct from 'object'
     or (o ->> 'object') is distinct from 'checkout.session'
     or coalesce(sid, '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$' then
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  -- 2. Ours? (sessions the owner creates in Stripe for other things are not)
  ref := coalesce(o -> 'metadata' ->> 'bicii_payment_id', o ->> 'client_reference_id');
  if ref is null or ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query select 'ignored'::public.stripe_event_status, 'not_ours'::text, null::uuid, null::uuid;
    return;
  end if;
  -- 3. Payment intent: serialise with its refund events (lock order 2).
  pi := private.stripe_ref(o -> 'payment_intent');
  if pi is not null and pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  if pi is not null then
    perform private.lock_stripe_payment_intent(pi);
  end if;
  -- 4. Find (unlocked). An unpaid orphan is an attempt step 2 refused.
  select p.* into pay from public.payments p where p.id = ref::uuid;
  if not found then
    return query select
      (case when o ->> 'payment_status' = 'paid' then 'needs_attention' else 'ignored' end)::public.stripe_event_status,
      'payment_not_found'::text, null::uuid, null::uuid;
    return;
  end if;
  -- 5. Lock the job, then the payment.
  perform private.lock_work_order(pay.work_order_id);
  select p.* into pay from public.payments p where p.id = pay.id for update;
  -- 6. Identity, in this order: the session, the mode, the payment intent.
  -- Attention, nothing changed.
  if sid <> pay.stripe_checkout_session_id then
    return query select 'needs_attention'::public.stripe_event_status, 'session_mismatch'::text, pay.id, pay.work_order_id;
    return;
  end if;
  if pg_catalog.jsonb_typeof(o -> 'livemode') = 'boolean' and (o -> 'livemode')::boolean <> pay.livemode then
    return query select 'needs_attention'::public.stripe_event_status, 'livemode_mismatch'::text, pay.id, pay.work_order_id;
    return;
  end if;
  if pay.stripe_payment_intent_id is not null and pi is not null and pi <> pay.stripe_payment_intent_id then
    return query select 'needs_attention'::public.stripe_event_status, 'session_mismatch'::text, pay.id, pay.work_order_id;
    return;
  end if;
  -- 7. Target.
  if ev.event_type = 'checkout.session.async_payment_failed' then
    target := 'failed';
  elsif o ->> 'payment_status' = 'paid' then
    target := 'paid';
  elsif o ->> 'payment_status' = 'no_payment_required' then
    return query select 'needs_attention'::public.stripe_event_status, 'unexpected_payment_status'::text,
      pay.id, pay.work_order_id;
    return;
  elsif o ->> 'status' = 'expired' then
    target := 'expired';
  elsif o ->> 'status' = 'complete' then
    target := 'processing';  -- completed, unpaid: an asynchronous method still confirming
  elsif o ->> 'status' = 'open' then
    target := 'open';
  else
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, pay.id, pay.work_order_id;
    return;
  end if;

  -- 8. Transition.
  paid_group := pay.status in ('paid', 'partially_refunded', 'refunded');
  if target = 'paid' then
    if paid_group then
      return query select 'ignored'::public.stripe_event_status, 'already_paid'::text, pay.id, pay.work_order_id;
      return;
    end if;
    -- pending (open or processing), failed or expired -> paid: one UPDATE.
    cents := private.stripe_int(o -> 'amount_total');
    received := case when pg_catalog.lower(o ->> 'currency') = 'sgd' and cents is not null
                     then (cents::numeric / 100)::public.money_amount end;
    if pi is not null then  -- adopt refunds that arrived first (same advisory lock held)
      update public.payment_refunds r set payment_id = pay.id, last_event_id = ev.id
      where r.stripe_payment_intent_id = pi and r.payment_id is null;
    end if;
    refunds := private.payment_refund_total(pay);
    base := coalesce(received, pay.amount);
    new_status := case when refunds = 0 then 'paid' when refunds < base then 'partially_refunded' else 'refunded' end;
    update public.payments p
    set status = new_status,
        paid_at = coalesce(ev.stripe_created_at, pg_catalog.clock_timestamp()),  -- D159d
        amount_received = received,
        refunded_amount = refunds,
        stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi),
        checkout_completed_at = coalesce(p.checkout_completed_at, pg_catalog.clock_timestamp()),
        last_event_id = ev.id
    where p.id = pay.id;
    perform private.record_work_order_event(
      pay.work_order_id,
      'payment_received',
      pg_catalog.jsonb_build_object(
        'payment_id', pay.id, 'kind', pay.kind, 'quote_id', pay.quote_id, 'amount', received,
        'asked', pay.amount, 'currency', pay.currency::text
      )
    );
    if refunds > 0 then
      perform private.record_work_order_event(
        pay.work_order_id,
        'payment_refunded',
        pg_catalog.jsonb_build_object(
          'payment_id', pay.id, 'kind', pay.kind, 'refunded', refunds::public.money_amount,
          'refunded_total', refunds::public.money_amount, 'currency', pay.currency::text,
          'full', new_status = 'refunded'
        )
      );
    end if;
    result_outcome := case
      when pay.status = 'failed' then 'paid_after_failed'
      when pay.status = 'expired' then 'paid_after_expired'
      when received is distinct from pay.amount then 'paid_amount_mismatch'
      else 'payment_paid'
    end;
    return query select 'applied'::public.stripe_event_status, result_outcome, pay.id, pay.work_order_id;
    return;
  end if;

  if paid_group then
    return query select 'ignored'::public.stripe_event_status, 'stale'::text, pay.id, pay.work_order_id;
    return;
  end if;
  if pay.status = 'failed' then
    return query select 'ignored'::public.stripe_event_status,
      (case when target = 'failed' then 'already_failed' else 'stale' end)::text, pay.id, pay.work_order_id;
    return;
  end if;
  if pay.status = 'expired' then
    return query select 'ignored'::public.stripe_event_status,
      (case when target = 'expired' then 'already_expired' else 'stale' end)::text, pay.id, pay.work_order_id;
    return;
  end if;

  -- pending
  if target = 'failed' then
    update public.payments p
    set status = 'failed', failed_at = pg_catalog.clock_timestamp(),
        stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi), last_event_id = ev.id
    where p.id = pay.id;
    return query select 'applied'::public.stripe_event_status, 'payment_failed'::text, pay.id, pay.work_order_id;
    return;
  end if;
  if pay.checkout_completed_at is null then
    if target = 'processing' then
      update public.payments p
      set checkout_completed_at = pg_catalog.clock_timestamp(),
          stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi), last_event_id = ev.id
      where p.id = pay.id;
      return query select 'applied'::public.stripe_event_status, 'payment_processing'::text, pay.id, pay.work_order_id;
      return;
    elsif target = 'expired' then
      update public.payments p
      set status = 'expired', expired_at = pg_catalog.clock_timestamp(), last_event_id = ev.id
      where p.id = pay.id;
      return query select 'applied'::public.stripe_event_status, 'payment_expired'::text, pay.id, pay.work_order_id;
      return;
    end if;
    return query select 'ignored'::public.stripe_event_status, 'still_open'::text, pay.id, pay.work_order_id;
    return;
  end if;
  -- pending and completed (processing): a completed session cannot expire
  -- or reopen.
  return query select 'ignored'::public.stripe_event_status,
    (case when target = 'processing' then 'already_processing' else 'stale' end)::text, pay.id, pay.work_order_id;
end;
$$;

-- D155, D159c (DATA-MODEL §19): apply a Refund. Refund rows move only up in
-- rank; the payment is settled from its rows. A refund of a payment intent
-- no payment carries yet is kept unmatched and adopted by the completion.
-- A refund whose event is in another mode than the payment, or whose
-- currency is not the payment's, is recorded and linked but never netted
-- (private.payment_refund_total): needs_attention / livemode_mismatch or
-- currency_mismatch, like a mismatched session.
create function private.apply_stripe_refund(ev public.stripe_events, obj jsonb)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  o jsonb := apply_stripe_refund.obj;
  rid text;
  new_status public.stripe_refund_status;
  cents bigint;
  pi text;
  pay public.payments;
  found_pay boolean;
  old_r public.payment_refunds;
  row_changed boolean := false;
  settled boolean := false;
  mismatch text;
begin
  -- 1. Shape.
  rid := o ->> 'id';
  cents := private.stripe_int(o -> 'amount');
  if pg_catalog.jsonb_typeof(o) is distinct from 'object'
     or (o ->> 'object') is distinct from 'refund'
     or coalesce(rid, '') !~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$'
     or coalesce(o ->> 'status', '') not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
     or cents is null or cents < 1 or cents > 99999999999
     or coalesce(o ->> 'currency', '') !~ '^[a-z]{3}$' then
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  new_status := (o ->> 'status')::public.stripe_refund_status;
  -- 2. Payment intent: a refund of a charge without one is not BICII's Checkout.
  pi := private.stripe_ref(o -> 'payment_intent');
  if pi is null or pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then
    return query select 'ignored'::public.stripe_event_status, 'not_ours'::text, null::uuid, null::uuid;
    return;
  end if;
  perform private.lock_stripe_payment_intent(pi);
  -- 3. The payment (unlocked), then the job, then the payment FOR UPDATE.
  select p.* into pay from public.payments p
  where p.stripe_payment_intent_id = pi
  order by p.created_at, p.id
  limit 1;
  found_pay := found;
  if found_pay then
    perform private.lock_work_order(pay.work_order_id);
    select p.* into pay from public.payments p where p.id = pay.id for update;
  end if;
  -- 4. Upsert the refund row (amount, currency and date fixed at first sight).
  select r.* into old_r from public.payment_refunds r where r.stripe_refund_id = rid for update;
  if not found then
    insert into public.payment_refunds (
      stripe_refund_id, stripe_payment_intent_id, payment_id, amount, currency, livemode, status, reason,
      failure_reason, stripe_created_at, last_event_id
    )
    values (
      rid, pi, case when found_pay then pay.id end, (cents::numeric / 100)::public.money_amount,
      pg_catalog.upper(o ->> 'currency'), ev.livemode, new_status,
      case when pg_catalog.jsonb_typeof(o -> 'reason') = 'string' then pg_catalog.left(o ->> 'reason', 60) end,
      case when pg_catalog.jsonb_typeof(o -> 'failure_reason') = 'string'
           then pg_catalog.left(o ->> 'failure_reason', 120) end,
      pg_catalog.to_timestamp(private.stripe_int(o -> 'created')),
      ev.id
    );
    row_changed := true;
  elsif private.stripe_refund_rank(new_status) > private.stripe_refund_rank(old_r.status) then
    update public.payment_refunds r
    set status = new_status,
        failure_reason = case when pg_catalog.jsonb_typeof(o -> 'failure_reason') = 'string'
                              then pg_catalog.left(o ->> 'failure_reason', 120) else r.failure_reason end,
        payment_id = coalesce(r.payment_id, case when found_pay then pay.id end),
        last_event_id = ev.id
    where r.id = old_r.id;
    row_changed := true;
  elsif old_r.payment_id is null and found_pay then
    update public.payment_refunds r set payment_id = pay.id, last_event_id = ev.id where r.id = old_r.id;
    row_changed := true;
  end if;
  -- 5. No payment yet: the orphan waits for the completion.
  if not found_pay then
    return query select 'ignored'::public.stripe_event_status, 'refund_unmatched'::text, null::uuid, null::uuid;
    return;
  end if;
  -- 6. Settle (a pure function of the rows that count).
  settled := private.settle_payment(pay, ev.id);
  -- 7. Mode and currency: this event's mode, and the stored row's mode and
  -- currency (what payment_refund_total counts by). A mismatched row is
  -- kept and linked, never netted.
  select r.* into old_r from public.payment_refunds r where r.stripe_refund_id = rid;
  mismatch := case
    when (ev.livemode is not null and ev.livemode <> pay.livemode)
      or (old_r.livemode is not null and old_r.livemode <> pay.livemode) then 'livemode_mismatch'
    when old_r.currency <> pay.currency then 'currency_mismatch'
  end;
  if mismatch is not null then
    return query select 'needs_attention'::public.stripe_event_status, mismatch, pay.id, pay.work_order_id;
    return;
  end if;
  return query select
    (case when row_changed or settled then 'applied' else 'ignored' end)::public.stripe_event_status,
    (case when row_changed or settled then 'refund_recorded' else 'refund_unchanged' end)::text,
    pay.id, pay.work_order_id;
end;
$$;

-- The dispatcher. It applies the stored projection, so what is stored is
-- exactly what was applied. charge.refunded is not used: it carries only a
-- running total, while Refund objects carry the id, amount and status.
create function private.apply_stripe_object(ev public.stripe_events)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  obj jsonb := apply_stripe_object.ev.payload -> 'data' -> 'object';
begin
  if apply_stripe_object.ev.event_type in (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired', 'read.checkout.session'
  ) then
    return query select * from private.apply_stripe_session(apply_stripe_object.ev, obj);
  elsif apply_stripe_object.ev.event_type in ('refund.created', 'refund.updated', 'refund.failed', 'read.refund') then
    return query select * from private.apply_stripe_refund(apply_stripe_object.ev, obj);
  else
    return query select 'ignored'::public.stripe_event_status, 'type_not_handled'::text, null::uuid, null::uuid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_stripe_event (service_role): store one webhook delivery and apply
-- it, in one transaction.
-- ---------------------------------------------------------------------------
create function public.record_stripe_event(
  payload jsonb,
  headers jsonb,
  body_sha256 text,
  body_bytes integer,
  rejection_reason public.stripe_rejection_reason,
  correlation_id text
)
returns table (
  event_id uuid,
  duplicate boolean,
  event_status public.stripe_event_status,
  outcome text,
  payment_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- Arguments are always written qualified (record_stripe_event.x); a bare
-- name in the ON CONFLICT clauses is the column.
#variable_conflict use_column
declare
  capped jsonb;
  projected jsonb;
  ev_id uuid;
  inserted boolean;
  ev public.stripe_events;
  res record;
begin
  -- 1. Arguments.
  if record_stripe_event.body_sha256 is null or record_stripe_event.body_bytes is null then
    raise exception 'body_sha256 and body_bytes are required' using errcode = '22004';
  end if;
  if record_stripe_event.body_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'body_sha256 must be 64 lower-case hex characters' using errcode = '22023';
  end if;
  if record_stripe_event.body_bytes < 0 then
    raise exception 'body_bytes must be >= 0' using errcode = '22023';
  end if;
  if record_stripe_event.headers is not null and pg_catalog.jsonb_typeof(record_stripe_event.headers) <> 'object' then
    raise exception 'headers must be a JSON object' using errcode = '22023';
  end if;
  capped := private.stripe_capped_headers(record_stripe_event.headers);

  -- 2. Rejected: evidence only, never the body, never the dedupe key (D88).
  if record_stripe_event.rejection_reason is not null then
    insert into public.stripe_events as e
      (source, event_type, headers, body_sha256, body_bytes, rejection_reason, status, correlation_id)
    values (
      'webhook', 'unknown', capped, record_stripe_event.body_sha256, record_stripe_event.body_bytes,
      record_stripe_event.rejection_reason, 'rejected', pg_catalog.left(record_stripe_event.correlation_id, 128)
    )
    on conflict (rejection_reason, body_sha256) where rejection_reason is not null
    do update set delivery_count = e.delivery_count + 1, last_delivered_at = pg_catalog.now()
    returning e.id, (e.xmax = 0) into ev_id, inserted;
    return query select ev_id, not inserted, 'rejected'::public.stripe_event_status, null::text, null::uuid;
    return;
  end if;

  -- 3. Verified: the shape backstop (the handler refuses bad shapes first).
  if pg_catalog.jsonb_typeof(record_stripe_event.payload) is distinct from 'object'
     or coalesce(record_stripe_event.payload ->> 'id', '') !~ '^evt_[A-Za-z0-9_]{1,250}$'
     or coalesce(record_stripe_event.payload ->> 'type', '') !~ '^[a-z0-9_.]{1,100}$'
     or pg_catalog.jsonb_typeof(record_stripe_event.payload -> 'livemode') is distinct from 'boolean' then
    raise exception 'a verified Stripe event needs an evt_ id, a type and a boolean livemode' using errcode = '22023';
  end if;

  -- 4. Insert (no FK value set: no job lock), or count a duplicate.
  projected := private.stripe_event_projection(record_stripe_event.payload);
  insert into public.stripe_events as e (
    source, stripe_event_id, event_type, api_version, livemode, stripe_created_at, object_type, object_id,
    payload, headers, body_sha256, body_bytes, status, correlation_id
  )
  values (
    'webhook',
    record_stripe_event.payload ->> 'id',
    record_stripe_event.payload ->> 'type',
    case when pg_catalog.jsonb_typeof(record_stripe_event.payload -> 'api_version') = 'string'
         then pg_catalog.left(record_stripe_event.payload ->> 'api_version', 40) end,
    (record_stripe_event.payload -> 'livemode')::boolean,
    pg_catalog.to_timestamp(private.stripe_int(record_stripe_event.payload -> 'created')),
    pg_catalog.left(projected -> 'data' -> 'object' ->> 'object', 60),
    pg_catalog.left(projected -> 'data' -> 'object' ->> 'id', 255),
    projected, capped, record_stripe_event.body_sha256, record_stripe_event.body_bytes, 'received',
    pg_catalog.left(record_stripe_event.correlation_id, 128)
  )
  on conflict (stripe_event_id) where stripe_event_id is not null
  do update set delivery_count = e.delivery_count + 1, last_delivered_at = pg_catalog.now()
  returning e.id, (e.xmax = 0) into ev_id, inserted;
  select e.* into ev from public.stripe_events e where e.id = ev_id;
  if not inserted then
    -- A duplicate: nothing is applied again.
    return query select ev.id, true, ev.status, ev.outcome, ev.payment_id;
    return;
  end if;

  -- 5. Apply, then write the decision once (allowed while 'received').
  select * into res from private.apply_stripe_object(ev);
  update public.stripe_events e
  set status = res.o_status, outcome = res.o_outcome, payment_id = res.o_payment_id,
      work_order_id = res.o_work_order_id, processed_at = pg_catalog.clock_timestamp()
  where e.id = ev.id;
  return query select ev.id, false, res.o_status, res.o_outcome, res.o_payment_id;
end;
$$;

comment on function public.record_stripe_event(jsonb, jsonb, text, integer, public.stripe_rejection_reason, text) is
  'service_role (the webhook route, src/lib/integrations/stripe/): store one delivery and apply it in the same transaction (D153, D159). A rejected delivery (rejection_reason set) keeps only capped headers, its size and SHA-256 (D88). A verified one is deduplicated on its evt_ id (a repeat only counts the delivery) and applied from its allow-listed projection (D159e). Business problems are recorded, never refused; an error rolls everything back so Stripe retries (D155, D159b).';

-- ---------------------------------------------------------------------------
-- record_stripe_read (service_role): store and apply an object the server
-- read from Stripe with the secret key (D159a). Staff and customers only
-- trigger the read; they never supply the data.
-- ---------------------------------------------------------------------------
create function public.record_stripe_read(payment_id uuid, object jsonb, correlation_id text)
returns table (
  event_id uuid,
  event_status public.stripe_event_status,
  outcome text,
  payment_status public.payment_status
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  o jsonb := record_stripe_read.object;
  kind text;
  pay public.payments;
  ev public.stripe_events;
  matches boolean;
  res record;
begin
  -- 1. Arguments (a failure here is an app bug).
  if record_stripe_read.payment_id is null or o is null then
    raise exception 'payment_id and object are required' using errcode = '22004';
  end if;
  kind := case when pg_catalog.jsonb_typeof(o) = 'object' then o ->> 'object' end;
  if kind is null or kind not in ('checkout.session', 'refund')
     or (kind = 'checkout.session' and coalesce(o ->> 'id', '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$')
     or (kind = 'refund' and coalesce(o ->> 'id', '') !~ '^(re|pyr)_[A-Za-z0-9_]{1,250}$') then
    raise exception 'object must be a Checkout Session or a Refund read from Stripe' using errcode = '22023';
  end if;
  -- 2. The payment (unlocked).
  select p.* into pay from public.payments p where p.id = record_stripe_read.payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  -- 3. Insert the evidence (no FK value set: no lock).
  insert into public.stripe_events as e (
    source, event_type, livemode, object_type, object_id, payload, headers, status, correlation_id
  )
  values (
    'api_read', 'read.' || kind,
    case when pg_catalog.jsonb_typeof(o -> 'livemode') = 'boolean' then (o -> 'livemode')::boolean end,
    kind, pg_catalog.left(o ->> 'id', 255),
    pg_catalog.jsonb_build_object('data', pg_catalog.jsonb_build_object('object', private.stripe_object_projection(o))),
    '{}'::jsonb, 'received', pg_catalog.left(record_stripe_read.correlation_id, 128)
  )
  returning e.* into ev;
  -- 4. Identity: only ids stored on the payment are ever read.
  matches := (
    case when kind = 'checkout.session' then (o ->> 'id') = pay.stripe_checkout_session_id
         else pay.stripe_payment_intent_id is not null
              and private.stripe_ref(o -> 'payment_intent') is not distinct from pay.stripe_payment_intent_id
    end
  ) and (pg_catalog.jsonb_typeof(o -> 'livemode') is distinct from 'boolean' or (o -> 'livemode')::boolean = pay.livemode);
  if not matches then
    -- The job lock first, so the event's FK KEY SHARE comes after FOR UPDATE.
    perform private.lock_work_order(pay.work_order_id);
    update public.stripe_events e
    set status = 'needs_attention', outcome = 'read_mismatch', payment_id = pay.id,
        work_order_id = pay.work_order_id, processed_at = pg_catalog.clock_timestamp()
    where e.id = ev.id;
    update public.payments p set checked_at = pg_catalog.clock_timestamp() where p.id = pay.id;
    return query select ev.id, 'needs_attention'::public.stripe_event_status, 'read_mismatch'::text,
      (select p.status from public.payments p where p.id = pay.id);
    return;
  end if;
  -- 5. Apply (advisory lock, then the job, then the payment).
  select * into res from private.apply_stripe_object(ev);
  -- 6. Stamp. The job lock is a no-op re-lock when the apply holds it; when
  -- the apply returned before locking, no advisory lock follows.
  perform private.lock_work_order(pay.work_order_id);
  update public.stripe_events e
  set status = res.o_status, outcome = res.o_outcome, payment_id = res.o_payment_id,
      work_order_id = res.o_work_order_id, processed_at = pg_catalog.clock_timestamp()
  where e.id = ev.id;
  update public.payments p set checked_at = pg_catalog.clock_timestamp() where p.id = pay.id;
  -- 7.
  return query select ev.id, res.o_status, res.o_outcome,
    (select p.status from public.payments p where p.id = pay.id);
end;
$$;

comment on function public.record_stripe_read(uuid, jsonb, text) is
  'service_role (src/lib/integrations/stripe/ only): record a Checkout Session or Refund the server read from Stripe with the secret key, for the given payment, and apply it like a webhook (D153, D159a); stamps checked_at. Reads are not deduplicated, so a repair read always applies. A read of an id the payment does not carry is kept as read_mismatch (needs attention).';

-- ---------------------------------------------------------------------------
-- private.purge_stripe_events (D88): OWNER ONLY, run by hand (no API role
-- can execute it; no cron). Verified rows hold no personal data and are kept.
-- ---------------------------------------------------------------------------
create function private.purge_stripe_events(older_than interval)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  deleted integer;
begin
  if purge_stripe_events.older_than is null or purge_stripe_events.older_than < interval '30 days' then
    raise exception 'Stripe events are kept at least 30 days' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('bicii.stripe_purge', 'on', true);
  delete from public.stripe_events e
  where e.status = 'rejected' and e.last_delivered_at < pg_catalog.now() - purge_stripe_events.older_than;
  get diagnostics deleted = row_count;
  perform pg_catalog.set_config('bicii.stripe_purge', 'off', true);
  return deleted;
end;
$$;

comment on function private.purge_stripe_events(interval) is
  'D88, owner only, by hand: delete rejected Stripe deliveries last delivered more than older_than ago (>= 30 days). Verified events and reads are kept. No API role may execute it; no cron.';
comment on function private.payments_guard() is
  'D153, D159a: a payment starts pending, is never deleted and keeps its identity; a Stripe-owned change must cite the stripe_events row being applied (status received). Every role, including the owner.';
comment on function private.payment_refunds_guard() is
  'D155, D159c: a refund is never deleted, keeps its amount, currency and dates, moves only up in rank, is linked once, and changes only while a Stripe event or read is applied.';
comment on function private.stripe_events_guard() is
  'D88, D159: Stripe events are evidence; only the delivery count moves, and the decision is written once while received. Rejected rows are deleted only by purge_stripe_events.';
comment on function private.stripe_capped_headers(jsonb) is
  'D88: the header cap shared with record_shopify_webhook (16 lower-cased keys, values <= 512, a truncation marker).';
comment on function private.stripe_ref(jsonb) is
  'A Stripe reference: the id string, or the id of an expanded object.';
comment on function private.stripe_int(jsonb) is
  'Stripe''s integer minor units, or null (never a float, string or negative number).';
comment on function private.stripe_object_projection(jsonb) is
  'D159e: the allow-listed copy of a Stripe object (ids, statuses, amounts, bicii_* metadata); never customer details or URLs.';
comment on function private.stripe_event_projection(jsonb) is
  'D159e: the allow-listed copy of a Stripe Event and its data.object.';
comment on function private.lock_stripe_payment_intent(text) is
  'Lock order 2 (DATA-MODEL §19): a transaction advisory lock per payment intent, taken before the job.';
comment on function private.stripe_refund_rank(public.stripe_refund_status) is
  'D159c: the order a refund''s status may move in.';
comment on function private.settle_payment(public.payments, uuid) is
  'D155, D159c: refunded_amount and the paid-group status as a pure function of the payment''s counted refunds (payment_refund_total), with the timeline entry; the caller holds the job lock and the payment.';
comment on function private.apply_stripe_session(public.stripe_events, jsonb) is
  'D153, D159: apply a Checkout Session to its payment (DATA-MODEL §19''s transition table); never raises for Stripe data.';
comment on function private.apply_stripe_refund(public.stripe_events, jsonb) is
  'D155, D159c: apply a Stripe Refund; unmatched refunds wait for the completion; a refund in another mode or currency than its payment is recorded and needs attention (livemode_mismatch, currency_mismatch), never netted.';
comment on function private.payment_refund_total(public.payments) is
  'D155, D159c: the payment''s succeeded refunds in its own currency and mode (a null mode, from a server read, counts); the only definition of refunded_amount.';
comment on function private.stripe_events_settled() is
  'D159a: deferred constraint trigger; refuses to commit a Stripe event still received (stripe_event_immutable), so a received row is never a reusable provenance token.';
comment on function private.apply_stripe_object(public.stripe_events) is
  'D153: dispatch a stored Stripe event or read to its apply function.';

-- ---------------------------------------------------------------------------
-- Privileges and RLS (DATA-MODEL §15; D86)
-- ---------------------------------------------------------------------------
revoke all on function
  private.stripe_capped_headers(jsonb),
  private.stripe_ref(jsonb),
  private.stripe_int(jsonb),
  private.stripe_object_projection(jsonb),
  private.stripe_event_projection(jsonb),
  private.lock_stripe_payment_intent(text),
  private.stripe_refund_rank(public.stripe_refund_status),
  private.payment_refund_total(public.payments),
  private.settle_payment(public.payments, uuid),
  private.apply_stripe_session(public.stripe_events, jsonb),
  private.apply_stripe_refund(public.stripe_events, jsonb),
  private.apply_stripe_object(public.stripe_events),
  private.payments_guard(),
  private.payment_refunds_guard(),
  private.stripe_events_guard(),
  private.stripe_events_settled(),
  private.purge_stripe_events(interval)
from public, anon, authenticated, service_role;

revoke all on function
  public.record_stripe_event(jsonb, jsonb, text, integer, public.stripe_rejection_reason, text),
  public.record_stripe_read(uuid, jsonb, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.record_stripe_event(jsonb, jsonb, text, integer, public.stripe_rejection_reason, text),
  public.record_stripe_read(uuid, jsonb, text)
to service_role;

alter table public.stripe_events enable row level security;
alter table public.payments enable row level security;
alter table public.payment_refunds enable row level security;

revoke all on table public.stripe_events, public.payments, public.payment_refunds
  from public, anon, authenticated, service_role;

-- Read-only for the API; every write is an RPC.
grant select on table public.stripe_events, public.payments, public.payment_refunds to authenticated;
-- The Checkout code re-reads the payment it refreshes (service-role table
-- grants are not pinned).
grant select on table public.payments to service_role;

-- D154: every active staff member sees what was paid on a job.
create policy payments_select_staff on public.payments
  for select to authenticated
  using ((select private.is_staff()));

-- An unmatched refund may belong to another Stripe sale of the account:
-- admins only.
create policy payment_refunds_select_staff on public.payment_refunds
  for select to authenticated
  using ((select private.is_admin()) or (payment_id is not null and (select private.is_staff())));

-- D86: delivery evidence is admins only.
create policy stripe_events_select_admin on public.stripe_events
  for select to authenticated
  using ((select private.is_admin()));
