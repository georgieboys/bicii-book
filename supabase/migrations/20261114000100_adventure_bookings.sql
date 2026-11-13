-- Adventures, Phase B, slice 1: bookings and payments (docs/ADVENTURES.md,
-- ADR-026, PLAN D164-D167, D172-D174; DATA-MODEL §20).
--
-- A signed-in customer buys a certification: prepare_my_adventure_checkout
-- freezes the price from the sealed offer (never from the browser) into a
-- booking and its lines, and prepares one adventure payment. The Admin's
-- server (service role) creates the Stripe Checkout Session for that
-- payment and records it with record_adventure_checkout. Stripe's verified
-- webhook goes through the existing record_stripe_event; its dispatcher now
-- routes a session whose metadata says bicii_subject=adventure, and a
-- refund of an adventure payment's PaymentIntent, to the adventure apply
-- functions here. Workshop payments, their table and their apply functions
-- are unchanged (D167).
--
-- Sales are switched off by default (D170): adventure_settings.sales_enabled
-- and a terms version, set by an admin, are both required to prepare a
-- checkout. Turning sales off never stops events for payments already made.
--
-- Lock order (every function here): the PaymentIntent advisory lock (as the
-- workshop), then the booking, then its payment.

-- ---------------------------------------------------------------------------
-- Settings (D170)
-- ---------------------------------------------------------------------------
create table public.adventure_settings (
  id smallint primary key default 1 check (id = 1),
  sales_enabled boolean not null default false,
  -- The sales terms riders accept (cancellation, refunds, retries), by
  -- version; null until the owner has published them. Sales need one.
  terms_version text null check (
    pg_catalog.char_length(terms_version) between 1 and 40 and terms_version ~ '^[A-Za-z0-9._-]+$'
  ),
  -- How long a Checkout Session stays open. Stripe allows 30 minutes to 24
  -- hours from when it creates the session, which is a few seconds after
  -- the payment is prepared, so at least 35 (the workshop uses 60).
  checkout_minutes integer not null default 35 check (checkout_minutes between 35 and 1440),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid null references public.staff (id) on delete restrict,
  constraint adventure_settings_sales_need_terms check (not sales_enabled or terms_version is not null)
);
insert into public.adventure_settings (id) values (1);

comment on table public.adventure_settings is
  'D170: whether adventures are on sale and which terms riders accept. One row; set by set_adventure_sales (admin).';

create trigger adventure_settings_set_updated_at
  before update on public.adventure_settings
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.adventure_booking_status as enum ('pending_payment', 'confirmed', 'cancelled', 'expired');
create type public.adventure_recording_method as enum ('own_device', 'tracker_hire');
create type public.adventure_finisher_name as enum ('first_name_initial', 'full_name', 'hidden');
create type public.adventure_booking_event_kind as enum (
  'created', 'payment_started', 'confirmed', 'expired', 'payment_failed',
  'payment_processing', 'payment_attention', 'refund_recorded'
);

-- ---------------------------------------------------------------------------
-- Bookings (D172): one named rider, one certification entitlement.
-- ---------------------------------------------------------------------------
create sequence private.seq_adventure_reference minvalue 1 maxvalue 999999 no cycle;
revoke all on sequence private.seq_adventure_reference from public, anon, authenticated, service_role;

create function private.next_adventure_reference()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'AV-' || pg_catalog.lpad(pg_catalog.nextval('private.seq_adventure_reference')::text, 6, '0');
$$;
revoke all on function private.next_adventure_reference() from public, anon, authenticated, service_role;

create table public.adventure_bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^AV-[0-9]{6}$'),
  customer_id uuid not null references public.customers (id) on delete restrict,
  adventure_id uuid not null references public.adventures (id) on delete restrict,
  -- The sealed revision and offer bought: their rules and price are the terms.
  revision_id uuid not null references public.adventure_revisions (id) on delete restrict,
  offer_id uuid not null references public.adventure_offers (id) on delete restrict,
  kind public.adventure_participation not null,
  status public.adventure_booking_status not null default 'pending_payment',
  recording_method public.adventure_recording_method not null default 'own_device',
  tshirt_size text not null check (tshirt_size ~ '^(XS|S|M|L|XL|XXL|XXXL)$'),
  finisher_name public.adventure_finisher_name not null default 'first_name_initial',
  terms_version text not null check (pg_catalog.char_length(terms_version) between 1 and 40),
  -- The frozen price: the sum of the lines.
  total public.money_amount not null check (total > 0),
  currency char(3) not null default 'SGD' check (currency = 'SGD'),
  -- The browser's request id (retries reuse it) and what was asked with it.
  request_id uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  -- A paid booking that could not simply be confirmed (late, wrong amount):
  -- staff decide; never a false confirmation (handoff §6.6).
  needs_attention boolean not null default false,
  attention_reason text null check (pg_catalog.char_length(attention_reason) <= 200),
  confirmed_at timestamptz null,
  expired_at timestamptz null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_bookings_confirmed_at check ((status = 'confirmed') = (confirmed_at is not null)),
  constraint adventure_bookings_attention check (needs_attention = (attention_reason is not null))
);
create index adventure_bookings_customer_idx on public.adventure_bookings (customer_id, created_at desc);
create index adventure_bookings_adventure_idx on public.adventure_bookings (adventure_id, status);
create index adventure_bookings_attention_idx on public.adventure_bookings (created_at) where needs_attention;

comment on table public.adventure_bookings is
  'D172: one rider''s purchase of one certification. Price and terms frozen from the sealed revision and offer. Confirmed only by a verified, matching Stripe payment.';

create trigger adventure_bookings_set_updated_at
  before update on public.adventure_bookings
  for each row execute function private.set_updated_at();

-- What was bought never changes after the booking is made.
create function private.adventure_bookings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array[
    'status', 'needs_attention', 'attention_reason', 'confirmed_at', 'expired_at', 'cancelled_at', 'updated_at'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_immutable',
      detail = 'A booking is kept; it is never deleted.';
  end if;
  if (pg_catalog.to_jsonb(new) - movable) <> (pg_catalog.to_jsonb(old) - movable) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_immutable',
      detail = 'What was bought, by whom and at what price never changes.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_bookings_guard() from public, anon, authenticated, service_role;

create trigger adventure_bookings_guard
  before update or delete on public.adventure_bookings
  for each row execute function private.adventure_bookings_guard();

create table public.adventure_booking_lines (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  position integer not null check (position between 1 and 20),
  kind text not null check (kind in ('certification', 'tracker_hire')),
  description text not null check (pg_catalog.btrim(description) <> '' and pg_catalog.char_length(description) <= 200),
  quantity integer not null check (quantity between 1 and 60),
  unit_price public.money_amount not null check (unit_price >= 0),
  total public.money_amount generated always as (pg_catalog.round(quantity * unit_price, 2)) stored,
  constraint adventure_booking_lines_position_unique unique (booking_id, position)
);

comment on table public.adventure_booking_lines is
  'D172: the frozen lines of a booking (certification; tracker hire from Phase C). Append-only.';

create function private.adventure_booking_lines_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'adventure_booking_immutable',
    detail = 'What was bought, by whom and at what price never changes.';
end;
$$;
revoke all on function private.adventure_booking_lines_append_only() from public, anon, authenticated, service_role;

create trigger adventure_booking_lines_append_only
  before update or delete on public.adventure_booking_lines
  for each row execute function private.adventure_booking_lines_append_only();

-- ---------------------------------------------------------------------------
-- Payments (D167): the adventure's own table, never a workshop payment.
-- ---------------------------------------------------------------------------
create table public.adventure_payments (
  -- Made by prepare_my_adventure_checkout before Stripe is called; Stripe's
  -- metadata bicii_adventure_payment_id and the Idempotency-Key suffix.
  id uuid primary key,
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  amount public.money_amount not null check (amount > 0),
  amount_cents bigint generated always as ((amount * 100)::bigint) stored,
  currency char(3) not null default 'SGD' check (currency = 'SGD'),
  status public.payment_status not null default 'pending',
  amount_received public.money_amount null,
  refunded_amount public.money_amount not null default 0 check (refunded_amount >= 0),
  -- Set by record_adventure_checkout, or adopted from a verified webhook
  -- that arrived first (handoff C03).
  stripe_checkout_session_id text null check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$'),
  stripe_session_expires_at timestamptz not null,
  stripe_payment_intent_id text null check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$'),
  livemode boolean null,
  checkout_completed_at timestamptz null,
  paid_at timestamptz null,
  failed_at timestamptz null,
  expired_at timestamptz null,
  last_event_id uuid null references public.stripe_events (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_payments_paid_at check (
    (status in ('paid', 'partially_refunded', 'refunded')) = (paid_at is not null)
  )
);
create unique index adventure_payments_session_key on public.adventure_payments (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
create unique index adventure_payments_payment_intent_key on public.adventure_payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
-- One open payment per booking at a time.
create unique index adventure_payments_one_open on public.adventure_payments (booking_id)
  where status = 'pending';
create index adventure_payments_booking_idx on public.adventure_payments (booking_id, created_at);

comment on table public.adventure_payments is
  'D167: a Stripe Checkout payment for an adventure booking. Status moves only through verified Stripe events and reads (record_stripe_event).';

create trigger adventure_payments_set_updated_at
  before update on public.adventure_payments
  for each row execute function private.set_updated_at();

-- Only a Stripe event being applied, or record_adventure_checkout (which
-- sets the session), changes a payment; its amount and booking never change.
create function private.adventure_payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_immutable',
      detail = 'A payment is kept; it is never deleted.';
  end if;
  if new.booking_id <> old.booking_id or new.amount <> old.amount or new.currency <> old.currency
     or new.id <> old.id or new.created_at <> old.created_at then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_immutable',
      detail = 'A payment''s booking and amount never change.';
  end if;
  if old.stripe_checkout_session_id is not null
     and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_immutable',
      detail = 'A payment''s Checkout Session never changes.';
  end if;
  if old.stripe_payment_intent_id is not null
     and new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_immutable',
      detail = 'A payment''s PaymentIntent never changes.';
  end if;
  if new.status <> old.status and (new.last_event_id is not distinct from old.last_event_id or not exists (
       select 1 from public.stripe_events e where e.id = new.last_event_id and e.status = 'received'
     )) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_immutable',
      detail = 'A payment''s status changes only while a verified Stripe event is applied.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_payments_guard() from public, anon, authenticated, service_role;

create trigger adventure_payments_guard
  before update or delete on public.adventure_payments
  for each row execute function private.adventure_payments_guard();

-- ---------------------------------------------------------------------------
-- Booking history (append-only)
-- ---------------------------------------------------------------------------
create table public.adventure_booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  kind public.adventure_booking_event_kind not null,
  payment_id uuid null references public.adventure_payments (id) on delete restrict,
  stripe_event_id uuid null references public.stripe_events (id) on delete restrict,
  staff_id uuid null references public.staff (id) on delete restrict,
  detail jsonb not null default '{}' check (pg_catalog.jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index adventure_booking_events_booking_idx on public.adventure_booking_events (booking_id, created_at, id);

comment on table public.adventure_booking_events is
  'Append-only booking history: created, payment started, confirmed, expired, payment failed or processing, payment needing attention, refund recorded.';

create function private.adventure_booking_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'adventure_booking_events is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.adventure_booking_events_append_only() from public, anon, authenticated, service_role;

create trigger adventure_booking_events_append_only
  before update or delete on public.adventure_booking_events
  for each row execute function private.adventure_booking_events_append_only();

-- ---------------------------------------------------------------------------
-- Stripe events and refunds learn the adventure subject (D167).
-- ---------------------------------------------------------------------------
alter table public.stripe_events
  add column adventure_payment_id uuid null references public.adventure_payments (id) on delete restrict;
create index stripe_events_adventure_payment_idx on public.stripe_events (adventure_payment_id)
  where adventure_payment_id is not null;
comment on column public.stripe_events.adventure_payment_id is
  'D167: the adventure payment an applied event concerns (workshop events use payment_id). Written by the adventure apply functions while the event is received.';

-- Same as 20261014000400, plus adventure_payment_id writable while received.
create or replace function private.stripe_events_guard()
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
    mutable := mutable || array['status', 'outcome', 'payment_id', 'work_order_id', 'processed_at', 'adventure_payment_id'];
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

alter table public.payment_refunds
  add column adventure_payment_id uuid null references public.adventure_payments (id) on delete restrict,
  add constraint payment_refunds_one_subject check (payment_id is null or adventure_payment_id is null);
create index payment_refunds_adventure_payment_idx on public.payment_refunds (adventure_payment_id, stripe_created_at)
  where adventure_payment_id is not null;
comment on column public.payment_refunds.adventure_payment_id is
  'D167: the adventure payment a refund belongs to (workshop refunds use payment_id; never both). Workshop reports join payment_id only.';

-- Same as 20261014000400, plus adventure_payment_id movable once (like payment_id).
create or replace function private.payment_refunds_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array[
    'status', 'status_changed_at', 'failure_reason', 'payment_id', 'adventure_payment_id', 'last_event_id', 'updated_at'
  ];
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
  if (old.payment_id is not null and new.payment_id is distinct from old.payment_id)
     or (old.adventure_payment_id is not null and new.adventure_payment_id is distinct from old.adventure_payment_id) then
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
  if new.status_changed_at is distinct from old.status_changed_at and new.status = old.status then
    raise exception using
      errcode = 'P0001',
      message = 'payment_refund_immutable',
      detail = 'A refund''s decision time moves only with its status.';
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

-- ---------------------------------------------------------------------------
-- Row-level security and grants: staff read; customers use the my_* RPCs.
-- ---------------------------------------------------------------------------
alter table public.adventure_settings enable row level security;
alter table public.adventure_bookings enable row level security;
alter table public.adventure_booking_lines enable row level security;
alter table public.adventure_payments enable row level security;
alter table public.adventure_booking_events enable row level security;

revoke all on table public.adventure_settings, public.adventure_bookings, public.adventure_booking_lines,
  public.adventure_payments, public.adventure_booking_events
  from public, anon, authenticated, service_role;
grant select on table public.adventure_settings, public.adventure_bookings, public.adventure_booking_lines,
  public.adventure_payments, public.adventure_booking_events
  to authenticated;
-- The Checkout code re-reads the payment it prepares (as for workshop payments).
grant select on table public.adventure_payments to service_role;

create policy adventure_settings_select_staff on public.adventure_settings
  for select to authenticated using ((select private.is_staff()));
create policy adventure_bookings_select_staff on public.adventure_bookings
  for select to authenticated using ((select private.is_staff()));
create policy adventure_booking_lines_select_staff on public.adventure_booking_lines
  for select to authenticated using ((select private.is_staff()));
create policy adventure_payments_select_staff on public.adventure_payments
  for select to authenticated using ((select private.is_staff()));
create policy adventure_booking_events_select_staff on public.adventure_booking_events
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Sales switch (admin) and its public read
-- ---------------------------------------------------------------------------
create function public.set_adventure_sales(sales_enabled boolean, terms_version text)
returns public.adventure_settings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  result public.adventure_settings;
begin
  if set_adventure_sales.sales_enabled and nullif(pg_catalog.btrim(coalesce(set_adventure_sales.terms_version, '')), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_terms_required',
      detail = 'Publish the sales terms (cancellation, refunds, retries) and give their version before selling.';
  end if;
  update public.adventure_settings s
  set sales_enabled = set_adventure_sales.sales_enabled,
      terms_version = coalesce(nullif(pg_catalog.btrim(set_adventure_sales.terms_version), ''), s.terms_version),
      updated_by = actor
  where s.id = 1
  returning s.* into result;
  return result;
end;
$$;

create function public.adventure_sales_state()
returns table (sales_enabled boolean, terms_version text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.sales_enabled, s.terms_version from public.adventure_settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Checkout preparation (D172, handoff §10.3)
-- ---------------------------------------------------------------------------
create function public.prepare_my_adventure_checkout(
  request_id uuid,
  adventure_slug text,
  kind public.adventure_participation,
  revision_number integer,
  tshirt_size text,
  finisher_name public.adventure_finisher_name,
  terms_version text
)
returns table (
  booking_id uuid,
  reference text,
  payment_id uuid,
  amount public.money_amount,
  amount_cents bigint,
  currency text,
  expires_at timestamptz,
  description text,
  reused boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- Arguments are always written qualified; a bare name is the column.
#variable_conflict use_column
declare
  me uuid := private.require_customer();
  settings public.adventure_settings;
  fingerprint text;
  adv public.adventures;
  rev public.adventure_revisions;
  offer public.adventure_offers;
  booking public.adventure_bookings;
  payment public.adventure_payments;
  size text := pg_catalog.upper(pg_catalog.btrim(coalesce(prepare_my_adventure_checkout.tshirt_size, '')));
  inserted boolean;
begin
  if prepare_my_adventure_checkout.request_id is null then
    raise exception 'request_id is required' using errcode = '22004';
  end if;
  fingerprint := pg_catalog.md5(pg_catalog.concat_ws('|',
    pg_catalog.lower(pg_catalog.btrim(prepare_my_adventure_checkout.adventure_slug)),
    prepare_my_adventure_checkout.kind, prepare_my_adventure_checkout.revision_number, size,
    prepare_my_adventure_checkout.finisher_name, prepare_my_adventure_checkout.terms_version));

  -- A retry of an earlier request: the same booking, never a second one.
  select b.* into booking from public.adventure_bookings b where b.request_id = prepare_my_adventure_checkout.request_id;
  if not found then
    select s.* into settings from public.adventure_settings s where s.id = 1;
    if not settings.sales_enabled then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_sales_closed',
        detail = 'Certified rides are not on sale yet.';
    end if;
    if prepare_my_adventure_checkout.terms_version is distinct from settings.terms_version then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_terms_changed',
        detail = 'The terms have changed. Read them again and confirm.';
    end if;
    if size !~ '^(XS|S|M|L|XL|XXL|XXXL)$' then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_size_invalid',
        detail = 'Choose a T-shirt size.';
    end if;
    select a.* into adv from public.adventures a
    where a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(prepare_my_adventure_checkout.adventure_slug, '')))::extensions.citext
      and a.status = 'published';
    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_unavailable',
        detail = 'This adventure is not on sale.';
    end if;
    select r.* into rev from public.adventure_revisions r where r.id = adv.current_revision_id;
    if rev.revision_number <> prepare_my_adventure_checkout.revision_number then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_quote_changed',
        detail = 'This adventure''s details or price changed. Check them and try again.';
    end if;
    select o.* into offer from public.adventure_offers o
    where o.revision_id = rev.id and o.kind = prepare_my_adventure_checkout.kind;
    -- Phase B sells the self-supported certification only (D173).
    if not found or offer.kind <> 'self_supported' then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_offer_unavailable',
        detail = 'That way to ride is not on sale for this adventure.';
    end if;

    insert into public.adventure_bookings as b (
      reference, customer_id, adventure_id, revision_id, offer_id, kind, recording_method, tshirt_size,
      finisher_name, terms_version, total, request_id, request_fingerprint
    )
    values (
      private.next_adventure_reference(), me, adv.id, rev.id, offer.id, offer.kind, 'own_device', size,
      coalesce(prepare_my_adventure_checkout.finisher_name, 'first_name_initial'),
      settings.terms_version, offer.price, prepare_my_adventure_checkout.request_id, fingerprint
    )
    on conflict (request_id) do nothing
    returning b.* into booking;
    inserted := found;
    if inserted then
      insert into public.adventure_booking_lines (booking_id, position, kind, description, quantity, unit_price)
      values (booking.id, 1, 'certification', rev.name || ' certification', 1, offer.price);
      insert into public.adventure_booking_events (booking_id, kind, detail)
      values (booking.id, 'created', pg_catalog.jsonb_build_object('revision_number', rev.revision_number));
    else
      -- A concurrent first call with the same request id won; use its booking.
      select b.* into booking from public.adventure_bookings b where b.request_id = prepare_my_adventure_checkout.request_id;
    end if;
  end if;

  -- Same request id: the same caller and the same inputs, or a conflict.
  if booking.customer_id <> me then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if booking.request_fingerprint <> fingerprint then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_request_conflict',
      detail = 'This purchase was already started with other details. Start again.';
  end if;

  perform 1 from public.adventure_bookings b where b.id = booking.id for update;
  select b.* into booking from public.adventure_bookings b where b.id = booking.id;
  if booking.status = 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_already_paid',
      detail = 'This booking is already paid.';
  end if;
  if booking.status <> 'pending_payment' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_closed',
      detail = 'This checkout has expired. Start again.';
  end if;

  -- An open payment with time left is reused; otherwise a new one.
  select p.* into payment from public.adventure_payments p
  where p.booking_id = booking.id and p.status = 'pending'
  for update;
  if found and payment.checkout_completed_at is null
     and payment.stripe_session_expires_at > pg_catalog.now() + interval '2 minutes' then
    return query select booking.id, booking.reference, payment.id, payment.amount, payment.amount_cents,
      payment.currency::text, payment.stripe_session_expires_at,
      (select l.description from public.adventure_booking_lines l where l.booking_id = booking.id and l.position = 1),
      true;
    return;
  end if;
  if found then
    -- Still confirming at Stripe (completed, unpaid): never start another.
    raise exception using
      errcode = 'P0001',
      message = 'adventure_payment_processing',
      detail = 'Your payment is still being confirmed. Check back in a few minutes.';
  end if;

  select s.* into settings from public.adventure_settings s where s.id = 1;
  insert into public.adventure_payments (id, booking_id, amount, stripe_session_expires_at)
  values (
    gen_random_uuid(), booking.id, booking.total,
    pg_catalog.now() + pg_catalog.make_interval(mins => settings.checkout_minutes)
  )
  returning * into payment;
  insert into public.adventure_booking_events (booking_id, kind, payment_id)
  values (booking.id, 'payment_started', payment.id);

  return query select booking.id, booking.reference, payment.id, payment.amount, payment.amount_cents,
    payment.currency::text, payment.stripe_session_expires_at,
    (select l.description from public.adventure_booking_lines l where l.booking_id = booking.id and l.position = 1),
    false;
end;
$$;

-- The Admin's server records the Checkout Session it created (service role).
create function public.record_adventure_checkout(payment_id uuid, session jsonb)
returns public.adventure_payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pay public.adventure_payments;
  o jsonb := record_adventure_checkout.session;
  sid text := o ->> 'id';
  cents bigint := private.stripe_int(o -> 'amount_total');
begin
  select p.* into pay from public.adventure_payments p where p.id = record_adventure_checkout.payment_id;
  if not found then
    raise exception 'adventure payment % not found', record_adventure_checkout.payment_id using errcode = 'P0002';
  end if;
  perform 1 from public.adventure_bookings b where b.id = pay.booking_id for update;
  select p.* into pay from public.adventure_payments p where p.id = pay.id for update;

  if pg_catalog.jsonb_typeof(o) is distinct from 'object'
     or (o ->> 'object') is distinct from 'checkout.session'
     or coalesce(sid, '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$'
     or (o -> 'metadata' ->> 'bicii_subject') is distinct from 'adventure'
     or (o -> 'metadata' ->> 'bicii_adventure_payment_id') is distinct from pay.id::text
     or pg_catalog.lower(coalesce(o ->> 'currency', '')) <> 'sgd'
     or cents is distinct from pay.amount_cents
     or pg_catalog.jsonb_typeof(o -> 'livemode') is distinct from 'boolean' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_session_mismatch',
      detail = 'The Checkout Session does not match this payment.';
  end if;
  if pay.stripe_checkout_session_id is not null then
    if pay.stripe_checkout_session_id <> sid then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_session_mismatch',
        detail = 'This payment already has another Checkout Session.';
    end if;
    return pay;  -- already recorded (or adopted from an earlier webhook)
  end if;
  update public.adventure_payments p
  set stripe_checkout_session_id = sid,
      livemode = coalesce(p.livemode, (o -> 'livemode')::boolean),
      stripe_session_expires_at = coalesce(
        pg_catalog.to_timestamp(private.stripe_int(o -> 'expires_at')), p.stripe_session_expires_at)
  where p.id = pay.id
  returning p.* into pay;
  return pay;
end;
$$;

-- ---------------------------------------------------------------------------
-- Applying Stripe events to adventure payments (D167)
-- ---------------------------------------------------------------------------
create function private.adventure_payment_refund_total(pay public.adventure_payments)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(r.amount), 0)
  from public.payment_refunds r
  where r.adventure_payment_id = adventure_payment_refund_total.pay.id
    and r.status = 'succeeded'
    and r.currency = adventure_payment_refund_total.pay.currency
    and (r.livemode is null or adventure_payment_refund_total.pay.livemode is null
         or r.livemode = adventure_payment_refund_total.pay.livemode);
$$;

-- Marks a paid booking for staff instead of confirming it.
create function private.flag_adventure_booking(booking_id uuid, reason text, payment_id uuid, event_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  update public.adventure_bookings b
  set needs_attention = true, attention_reason = pg_catalog.left(flag_adventure_booking.reason, 200)
  where b.id = flag_adventure_booking.booking_id;
  insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id, detail)
  values (flag_adventure_booking.booking_id, 'payment_attention', flag_adventure_booking.payment_id,
          flag_adventure_booking.event_id, pg_catalog.jsonb_build_object('reason', flag_adventure_booking.reason));
end;
$$;

create function private.apply_adventure_stripe_session(ev public.stripe_events, obj jsonb)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  o jsonb := apply_adventure_stripe_session.obj;
  sid text := o ->> 'id';
  ref text := o -> 'metadata' ->> 'bicii_adventure_payment_id';
  pi text;
  pay public.adventure_payments;
  booking public.adventure_bookings;
  target text;
  paid_group boolean;
  cents bigint;
  received public.money_amount;
  refunds numeric;
  base numeric;
  new_status public.payment_status;
  result_outcome text;
  ev_livemode boolean := case when pg_catalog.jsonb_typeof(o -> 'livemode') = 'boolean'
                              then (o -> 'livemode')::boolean end;
begin
  -- 1. Shape.
  if pg_catalog.jsonb_typeof(o) is distinct from 'object'
     or (o ->> 'object') is distinct from 'checkout.session'
     or coalesce(sid, '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$'
     or ref is null or ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  pi := private.stripe_ref(o -> 'payment_intent');
  if pi is not null and pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;
  if pi is not null then
    perform private.lock_stripe_payment_intent(pi);
  end if;
  -- 2. Find, then lock the booking and the payment.
  select p.* into pay from public.adventure_payments p where p.id = ref::uuid;
  if not found then
    return query select
      (case when o ->> 'payment_status' = 'paid' then 'needs_attention' else 'ignored' end)::public.stripe_event_status,
      'payment_not_found'::text, null::uuid, null::uuid;
    return;
  end if;
  select b.* into booking from public.adventure_bookings b where b.id = pay.booking_id for update;
  select p.* into pay from public.adventure_payments p where p.id = pay.id for update;
  update public.stripe_events e set adventure_payment_id = pay.id where e.id = ev.id;

  -- 3. Identity: the session (adopted when the webhook came first), mode, PaymentIntent.
  if pay.stripe_checkout_session_id is not null and sid <> pay.stripe_checkout_session_id then
    return query select 'needs_attention'::public.stripe_event_status, 'session_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  if ev_livemode is not null and pay.livemode is not null and ev_livemode <> pay.livemode then
    return query select 'needs_attention'::public.stripe_event_status, 'livemode_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  if pay.stripe_payment_intent_id is not null and pi is not null and pi <> pay.stripe_payment_intent_id then
    return query select 'needs_attention'::public.stripe_event_status, 'session_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;

  -- 4. Target.
  if ev.event_type = 'checkout.session.async_payment_failed' then
    target := 'failed';
  elsif o ->> 'payment_status' = 'paid' then
    target := 'paid';
  elsif o ->> 'payment_status' = 'no_payment_required' then
    return query select 'needs_attention'::public.stripe_event_status, 'unexpected_payment_status'::text, null::uuid, null::uuid;
    return;
  elsif o ->> 'status' = 'expired' then
    target := 'expired';
  elsif o ->> 'status' = 'complete' then
    target := 'processing';
  elsif o ->> 'status' = 'open' then
    target := 'open';
  else
    return query select 'needs_attention'::public.stripe_event_status, 'object_invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  paid_group := pay.status in ('paid', 'partially_refunded', 'refunded');
  if target = 'paid' then
    if paid_group then
      return query select 'ignored'::public.stripe_event_status, 'already_paid'::text, null::uuid, null::uuid;
      return;
    end if;
    cents := private.stripe_int(o -> 'amount_total');
    received := case when pg_catalog.lower(o ->> 'currency') = 'sgd' and cents is not null
                     then (cents::numeric / 100)::public.money_amount end;
    if pi is not null then  -- refunds that arrived first (same advisory lock held)
      update public.payment_refunds r set adventure_payment_id = pay.id, last_event_id = ev.id
      where r.stripe_payment_intent_id = pi and r.payment_id is null and r.adventure_payment_id is null;
    end if;
    refunds := private.adventure_payment_refund_total(pay);
    base := coalesce(received, pay.amount);
    new_status := case when refunds = 0 then 'paid' when refunds < base then 'partially_refunded' else 'refunded' end;
    update public.adventure_payments p
    set status = new_status,
        paid_at = coalesce(ev.stripe_created_at, pg_catalog.clock_timestamp()),
        amount_received = received,
        refunded_amount = refunds,
        stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, sid),
        livemode = coalesce(p.livemode, ev_livemode),
        stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi),
        checkout_completed_at = coalesce(p.checkout_completed_at, pg_catalog.clock_timestamp()),
        last_event_id = ev.id
    where p.id = pay.id;
    result_outcome := case
      when pay.status = 'failed' then 'paid_after_failed'
      when pay.status = 'expired' then 'paid_after_expired'
      when received is distinct from pay.amount then 'paid_amount_mismatch'
      else 'payment_paid'
    end;
    -- 5. The booking: confirmed only by the exact amount on a booking still
    -- waiting for it; anything else is recorded money for staff to resolve.
    if result_outcome = 'payment_paid' and booking.status = 'pending_payment' then
      update public.adventure_bookings b set status = 'confirmed', confirmed_at = pg_catalog.clock_timestamp()
      where b.id = booking.id;
      insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id, detail)
      values (booking.id, 'confirmed', pay.id, ev.id,
              pg_catalog.jsonb_build_object('amount', received, 'currency', pay.currency::text));
    else
      perform private.flag_adventure_booking(
        booking.id,
        case
          when result_outcome = 'paid_amount_mismatch' then 'Paid an amount other than the price asked.'
          when booking.status = 'confirmed' then 'Paid again for a booking already paid.'
          else 'Paid after the checkout had ' || (case when pay.status = 'failed' then 'failed' else 'expired' end) || '.'
        end,
        pay.id, ev.id
      );
    end if;
    return query select 'applied'::public.stripe_event_status, result_outcome, null::uuid, null::uuid;
    return;
  end if;

  if paid_group then
    return query select 'ignored'::public.stripe_event_status, 'stale'::text, null::uuid, null::uuid;
    return;
  end if;
  if pay.status = 'failed' then
    return query select 'ignored'::public.stripe_event_status,
      (case when target = 'failed' then 'already_failed' else 'stale' end)::text, null::uuid, null::uuid;
    return;
  end if;
  if pay.status = 'expired' then
    return query select 'ignored'::public.stripe_event_status,
      (case when target = 'expired' then 'already_expired' else 'stale' end)::text, null::uuid, null::uuid;
    return;
  end if;

  -- pending
  if target = 'failed' then
    update public.adventure_payments p
    set status = 'failed', failed_at = pg_catalog.clock_timestamp(),
        stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, sid),
        stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi), last_event_id = ev.id
    where p.id = pay.id;
    insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id)
    values (booking.id, 'payment_failed', pay.id, ev.id);
    return query select 'applied'::public.stripe_event_status, 'payment_failed'::text, null::uuid, null::uuid;
    return;
  end if;
  if pay.checkout_completed_at is null then
    if target = 'processing' then
      update public.adventure_payments p
      set checkout_completed_at = pg_catalog.clock_timestamp(),
          stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, sid),
          stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, pi), last_event_id = ev.id
      where p.id = pay.id;
      insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id)
      values (booking.id, 'payment_processing', pay.id, ev.id);
      return query select 'applied'::public.stripe_event_status, 'payment_processing'::text, null::uuid, null::uuid;
      return;
    elsif target = 'expired' then
      update public.adventure_payments p
      set status = 'expired', expired_at = pg_catalog.clock_timestamp(),
          stripe_checkout_session_id = coalesce(p.stripe_checkout_session_id, sid), last_event_id = ev.id
      where p.id = pay.id;
      -- An abandoned checkout ends its booking; a new purchase starts afresh.
      if booking.status = 'pending_payment' then
        update public.adventure_bookings b set status = 'expired', expired_at = pg_catalog.clock_timestamp()
        where b.id = booking.id;
        insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id)
        values (booking.id, 'expired', pay.id, ev.id);
      end if;
      return query select 'applied'::public.stripe_event_status, 'payment_expired'::text, null::uuid, null::uuid;
      return;
    end if;
    return query select 'ignored'::public.stripe_event_status, 'still_open'::text, null::uuid, null::uuid;
    return;
  end if;
  return query select 'ignored'::public.stripe_event_status,
    (case when target = 'processing' then 'already_processing' else 'stale' end)::text, null::uuid, null::uuid;
end;
$$;

-- A refund of an adventure payment's PaymentIntent: the refund row (shared
-- table, adventure_payment_id), then the payment settled from its rows.
-- Never changes the booking: a refund is not a cancellation (handoff C14).
create function private.apply_adventure_stripe_refund(ev public.stripe_events, obj jsonb, payment_intent text)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  o jsonb := apply_adventure_stripe_refund.obj;
  rid text := o ->> 'id';
  cents bigint := private.stripe_int(o -> 'amount');
  new_status public.stripe_refund_status;
  pay public.adventure_payments;
  old_r public.payment_refunds;
  row_changed boolean := false;
  total numeric;
  base numeric;
  pay_status public.payment_status;
begin
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
  perform private.lock_stripe_payment_intent(apply_adventure_stripe_refund.payment_intent);
  select p.* into pay from public.adventure_payments p
  where p.stripe_payment_intent_id = apply_adventure_stripe_refund.payment_intent;
  perform 1 from public.adventure_bookings b where b.id = pay.booking_id for update;
  select p.* into pay from public.adventure_payments p where p.id = pay.id for update;
  update public.stripe_events e set adventure_payment_id = pay.id where e.id = ev.id;

  select r.* into old_r from public.payment_refunds r where r.stripe_refund_id = rid for update;
  if not found then
    insert into public.payment_refunds (
      stripe_refund_id, stripe_payment_intent_id, adventure_payment_id, amount, currency, livemode, status,
      reason, failure_reason, stripe_created_at, last_event_id
    )
    values (
      rid, apply_adventure_stripe_refund.payment_intent, pay.id, (cents::numeric / 100)::public.money_amount,
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
        status_changed_at = pg_catalog.clock_timestamp(),
        failure_reason = case when pg_catalog.jsonb_typeof(o -> 'failure_reason') = 'string'
                              then pg_catalog.left(o ->> 'failure_reason', 120) else r.failure_reason end,
        adventure_payment_id = coalesce(r.adventure_payment_id, pay.id),
        last_event_id = ev.id
    where r.id = old_r.id;
    row_changed := true;
  elsif old_r.adventure_payment_id is null and old_r.payment_id is null then
    update public.payment_refunds r set adventure_payment_id = pay.id, last_event_id = ev.id where r.id = old_r.id;
    row_changed := true;
  end if;

  if pay.status in ('paid', 'partially_refunded', 'refunded') then
    total := private.adventure_payment_refund_total(pay);
    base := coalesce(pay.amount_received, pay.amount);
    pay_status := case when total = 0 then 'paid' when total < base then 'partially_refunded' else 'refunded' end;
    if total <> pay.refunded_amount or pay_status <> pay.status then
      update public.adventure_payments p
      set refunded_amount = total, status = pay_status, last_event_id = ev.id
      where p.id = pay.id;
      insert into public.adventure_booking_events (booking_id, kind, payment_id, stripe_event_id, detail)
      values (pay.booking_id, 'refund_recorded', pay.id, ev.id,
              pg_catalog.jsonb_build_object('refunded_total', total::public.money_amount, 'currency', pay.currency::text));
      row_changed := true;
    end if;
  end if;

  select r.* into old_r from public.payment_refunds r where r.stripe_refund_id = rid;
  if (ev.livemode is not null and pay.livemode is not null and ev.livemode <> pay.livemode) then
    return query select 'needs_attention'::public.stripe_event_status, 'livemode_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  if old_r.currency <> pay.currency then
    return query select 'needs_attention'::public.stripe_event_status, 'currency_mismatch'::text, null::uuid, null::uuid;
    return;
  end if;
  return query select
    (case when row_changed then 'applied' else 'ignored' end)::public.stripe_event_status,
    (case when row_changed then 'refund_recorded' else 'refund_unchanged' end)::text,
    null::uuid, null::uuid;
end;
$$;

-- The dispatcher (same signature as 20261014000400): adventure sessions and
-- refunds go to the adventure functions; everything else exactly as before.
create or replace function private.apply_stripe_object(ev public.stripe_events)
returns table (o_status public.stripe_event_status, o_outcome text, o_payment_id uuid, o_work_order_id uuid)
language plpgsql
volatile
set search_path = ''
as $$
declare
  obj jsonb := apply_stripe_object.ev.payload -> 'data' -> 'object';
  pi text;
begin
  if apply_stripe_object.ev.event_type in (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired', 'read.checkout.session'
  ) then
    if (obj -> 'metadata' ->> 'bicii_subject') is not distinct from 'adventure' then
      return query select * from private.apply_adventure_stripe_session(apply_stripe_object.ev, obj);
    else
      return query select * from private.apply_stripe_session(apply_stripe_object.ev, obj);
    end if;
  elsif apply_stripe_object.ev.event_type in ('refund.created', 'refund.updated', 'refund.failed', 'read.refund') then
    pi := private.stripe_ref(obj -> 'payment_intent');
    if pi is not null and exists (select 1 from public.adventure_payments p where p.stripe_payment_intent_id = pi) then
      return query select * from private.apply_adventure_stripe_refund(apply_stripe_object.ev, obj, pi);
    else
      return query select * from private.apply_stripe_refund(apply_stripe_object.ev, obj);
    end if;
  elsif apply_stripe_object.ev.event_type = 'read.payment_intent' then
    return query select * from private.apply_stripe_payment_intent(apply_stripe_object.ev, obj);
  else
    return query select 'ignored'::public.stripe_event_status, 'type_not_handled'::text, null::uuid, null::uuid;
  end if;
end;
$$;
comment on function private.apply_stripe_object(public.stripe_events) is
  'D153, D167: dispatch a stored Stripe event or read: adventure sessions (metadata bicii_subject=adventure) and refunds of an adventure payment''s PaymentIntent to the adventure apply functions, everything else as before.';

-- ---------------------------------------------------------------------------
-- The customer's own bookings (handoff §17.1)
-- ---------------------------------------------------------------------------
create function public.my_adventure_bookings()
returns table (
  id uuid,
  reference text,
  adventure_slug text,
  adventure_name text,
  kind public.adventure_participation,
  status public.adventure_booking_status,
  payment_status public.payment_status,
  checking_payment boolean,
  total public.money_amount,
  currency text,
  tshirt_size text,
  finisher_name public.adventure_finisher_name,
  created_at timestamptz,
  confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.reference, a.slug::text, r.name, b.kind, b.status,
         (select p.status from public.adventure_payments p where p.booking_id = b.id order by p.created_at desc, p.id limit 1),
         b.needs_attention, b.total, b.currency::text, b.tshirt_size, b.finisher_name, b.created_at, b.confirmed_at
  from public.adventure_bookings b
  join public.adventures a on a.id = b.adventure_id
  join public.adventure_revisions r on r.id = b.revision_id
  where b.customer_id = private.require_customer()
  order by b.created_at desc, b.id;
$$;

create function public.my_adventure_booking(booking_id uuid)
returns table (
  id uuid,
  reference text,
  adventure_slug text,
  adventure_name text,
  kind public.adventure_participation,
  status public.adventure_booking_status,
  payment_status public.payment_status,
  checking_payment boolean,
  total public.money_amount,
  currency text,
  tshirt_size text,
  finisher_name public.adventure_finisher_name,
  terms_version text,
  created_at timestamptz,
  confirmed_at timestamptz,
  lines jsonb,
  -- The bought revision's rules and buyer-only instructions (D166).
  distance_km numeric,
  max_elapsed_minutes integer,
  rules text,
  rider_instructions text,
  emergency_procedure text,
  checkpoints jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.reference, a.slug::text, r.name, b.kind, b.status,
         (select p.status from public.adventure_payments p where p.booking_id = b.id order by p.created_at desc, p.id limit 1),
         b.needs_attention, b.total, b.currency::text, b.tshirt_size, b.finisher_name, b.terms_version,
         b.created_at, b.confirmed_at,
         (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', l.kind, 'description', l.description, 'quantity', l.quantity,
            'unit_price', l.unit_price, 'total', l.total) order by l.position)
          from public.adventure_booking_lines l where l.booking_id = b.id),
         r.distance_km, r.max_elapsed_minutes, r.rules,
         case when b.status = 'confirmed' then r.rider_instructions else '' end,
         case when b.status = 'confirmed' then r.emergency_procedure else '' end,
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'position', c.position, 'label', c.label, 'instructions', c.instructions,
            'mandatory', c.mandatory, 'photo_required', c.photo_required) order by c.position)
          from public.adventure_checkpoints c where c.revision_id = r.id), '[]'::jsonb)
  from public.adventure_bookings b
  join public.adventures a on a.id = b.adventure_id
  join public.adventure_revisions r on r.id = b.revision_id
  where b.id = my_adventure_booking.booking_id
    and b.customer_id = private.require_customer();
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
revoke all on function
  private.adventure_payment_refund_total(public.adventure_payments),
  private.flag_adventure_booking(uuid, text, uuid, uuid),
  private.apply_adventure_stripe_session(public.stripe_events, jsonb),
  private.apply_adventure_stripe_refund(public.stripe_events, jsonb, text)
from public, anon, authenticated, service_role;

revoke all on function
  public.set_adventure_sales(boolean, text),
  public.adventure_sales_state(),
  public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer, text,
    public.adventure_finisher_name, text),
  public.record_adventure_checkout(uuid, jsonb),
  public.my_adventure_bookings(),
  public.my_adventure_booking(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.set_adventure_sales(boolean, text) to authenticated;
grant execute on function public.adventure_sales_state() to anon, authenticated;
grant execute on function public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer,
  text, public.adventure_finisher_name, text) to authenticated;
grant execute on function public.my_adventure_bookings() to authenticated;
grant execute on function public.my_adventure_booking(uuid) to authenticated;
grant execute on function public.record_adventure_checkout(uuid, jsonb) to service_role;
