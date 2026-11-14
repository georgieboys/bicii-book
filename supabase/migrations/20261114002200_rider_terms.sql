-- Adventures: the owner's sales terms (2026-11-14, D212-D218).
--
--   * D215: riders sign a waiver before paying. Waivers are published by an
--     admin as sealed versions (never edited); the sales terms version is a
--     published waiver. sign_my_adventure_waiver records the signature for
--     one checkout request (typed full name, emergency contact and five
--     declarations); a booking can only be created for a request its rider
--     signed for under the current version, and the signature is linked to
--     the booking for good.
--   * D212: a ticket is refundable until the ride is sent for review; after
--     that the rider can't ask to cancel, and an admin's cancellation is
--     recorded as not refundable.
--   * D213: a tracker brought back after its return day and the grace
--     (tracker_grace_days, default 1) owes tracker_late_fee_per_day
--     (default 20) for each further day, recorded when it comes back and
--     settled at the shop by an admin (paid or waived).
--   * D217: T-shirts S to XXL.
--   * D218: a rider shows on the finisher board under a name they choose,
--     or not at all.

-- ---------------------------------------------------------------------------
-- D215: waivers (sealed versions)
-- ---------------------------------------------------------------------------
create table public.adventure_waivers (
  version text primary key check (
    pg_catalog.char_length(version) between 1 and 40 and version ~ '^[A-Za-z0-9._-]+$'
  ),
  title text not null check (pg_catalog.btrim(title) <> '' and pg_catalog.char_length(title) <= 120),
  body text not null check (pg_catalog.char_length(body) between 200 and 40000),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null default pg_catalog.now(),
  published_by uuid null references public.staff (id) on delete restrict,
  constraint adventure_waivers_hash check (
    body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body, 'UTF8')), 'hex')
  )
);
comment on table public.adventure_waivers is
  'D215: the rider terms, release and waiver, by sealed version. Published by publish_adventure_waiver (admin); never updated or deleted.';

create function private.adventure_waivers_sealed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'adventure_waiver_sealed',
    detail = 'A published waiver never changes. Publish a new version instead.';
end;
$$;
revoke all on function private.adventure_waivers_sealed() from public, anon, authenticated, service_role;
create trigger adventure_waivers_sealed
  before update or delete on public.adventure_waivers
  for each row execute function private.adventure_waivers_sealed();

alter table public.adventure_waivers enable row level security;
revoke all on table public.adventure_waivers from public, anon, authenticated, service_role;
grant select on table public.adventure_waivers to authenticated;
create policy adventure_waivers_select_staff on public.adventure_waivers
  for select to authenticated using ((select private.is_staff()));

-- The terms version riders accept is a published waiver. Before this there
-- were no waivers, so a version already set (only on development and test
-- databases: production's is unset, with sales off) is cleared, with sales.
update public.adventure_settings s
set sales_enabled = false, terms_version = null
where s.terms_version is not null;
alter table public.adventure_settings
  add constraint adventure_settings_terms_waiver
  foreign key (terms_version) references public.adventure_waivers (version) on delete restrict;

create function public.publish_adventure_waiver(version text, title text, body text)
returns public.adventure_waivers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  clean_version text := pg_catalog.btrim(coalesce(publish_adventure_waiver.version, ''));
  clean_title text := pg_catalog.btrim(coalesce(publish_adventure_waiver.title, ''));
  clean_body text := pg_catalog.btrim(coalesce(publish_adventure_waiver.body, ''));
  result public.adventure_waivers;
begin
  if clean_version !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_version',
      detail = 'Give the version as letters, numbers, dots or dashes, like 2026-12.';
  end if;
  if clean_title = '' or pg_catalog.char_length(clean_title) > 120
     or pg_catalog.char_length(clean_body) not between 200 and 40000 then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_text',
      detail = 'Give the waiver a title and its full text (200 to 40,000 characters).';
  end if;
  if exists (select 1 from public.adventure_waivers w where w.version = clean_version) then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_exists',
      detail = 'That version is already published. Give the new text a new version.';
  end if;
  insert into public.adventure_waivers (version, title, body, body_sha256, published_by)
  values (clean_version, clean_title, clean_body,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(clean_body, 'UTF8')), 'hex'), actor)
  returning * into result;
  return result;
end;
$$;
revoke all on function public.publish_adventure_waiver(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.publish_adventure_waiver(text, text, text) to authenticated;

-- Public: a waiver's text, the current terms version's by default (the
-- site shows it before a rider signs; a ride page shows the version signed).
create function public.adventure_waiver(version text default null)
returns table (version text, title text, body text, body_sha256 text, published_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select w.version, w.title, w.body, w.body_sha256, w.published_at
  from public.adventure_waivers w
  where w.version = coalesce(
    adventure_waiver.version,
    (select s.terms_version from public.adventure_settings s where s.id = 1)
  );
$$;
revoke all on function public.adventure_waiver(text) from public, anon, authenticated, service_role;
grant execute on function public.adventure_waiver(text) to anon, authenticated;

-- Sales need the terms version to be a published waiver.
create or replace function public.set_adventure_sales(sales_enabled boolean, terms_version text)
returns public.adventure_settings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  clean text := nullif(pg_catalog.btrim(coalesce(set_adventure_sales.terms_version, '')), '');
  result public.adventure_settings;
begin
  if set_adventure_sales.sales_enabled and clean is null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_terms_required',
      detail = 'Choose the published waiver riders sign before selling.';
  end if;
  if clean is not null and not exists (select 1 from public.adventure_waivers w where w.version = clean) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_waiver_unknown',
      detail = 'No waiver is published with that version. Publish it first.';
  end if;
  update public.adventure_settings s
  set sales_enabled = set_adventure_sales.sales_enabled,
      terms_version = coalesce(clean, s.terms_version),
      updated_by = actor
  where s.id = 1
  returning s.* into result;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- D215: signatures
-- ---------------------------------------------------------------------------
create table public.adventure_waiver_signatures (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  -- The checkout request this signature is for (prepare_my_adventure_checkout's request_id).
  request_id uuid not null,
  waiver_version text not null references public.adventure_waivers (version) on delete restrict,
  waiver_sha256 text not null check (waiver_sha256 ~ '^[0-9a-f]{64}$'),
  signed_name text not null check (pg_catalog.char_length(signed_name) between 3 and 120),
  emergency_contact_name text not null check (pg_catalog.char_length(emergency_contact_name) between 2 and 120),
  emergency_contact_phone text not null check (
    pg_catalog.char_length(emergency_contact_phone) between 6 and 30 and emergency_contact_phone ~ '^\+?[0-9 ()-]+$'
  ),
  -- The declarations, each ticked by the rider (a row exists only if all were).
  of_age boolean not null check (of_age),
  accepts_risk boolean not null check (accepts_risk),
  no_ebike boolean not null check (no_ebike),
  accepts_terms boolean not null check (accepts_terms),
  electronic_signature boolean not null check (electronic_signature),
  signed_at timestamptz not null default pg_catalog.now(),
  -- Set once, when the booking for this request is created; never cleared.
  booking_id uuid null unique references public.adventure_bookings (id) on delete restrict,
  constraint adventure_waiver_signatures_request unique (customer_id, request_id)
);
comment on table public.adventure_waiver_signatures is
  'D215: a rider''s signed waiver for one checkout request, linked to its booking. Written by sign_my_adventure_waiver; immutable once linked.';

create function private.adventure_waiver_signatures_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.booking_id is not null then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_signed',
      detail = 'A signed waiver for a booking never changes.';
  end if;
  if new.customer_id <> old.customer_id or new.request_id <> old.request_id then
    raise exception 'signature owner and request are fixed' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_waiver_signatures_guard() from public, anon, authenticated, service_role;
create trigger adventure_waiver_signatures_guard
  before update or delete on public.adventure_waiver_signatures
  for each row execute function private.adventure_waiver_signatures_guard();

alter table public.adventure_waiver_signatures enable row level security;
revoke all on table public.adventure_waiver_signatures from public, anon, authenticated, service_role;
grant select on table public.adventure_waiver_signatures to authenticated;
-- The emergency contact is for the people who run and judge rides.
create policy adventure_waiver_signatures_select_staff on public.adventure_waiver_signatures
  for select to authenticated using (
    (select private.has_permission('manage_adventures'))
    or (select private.has_permission('verify_adventures'))
    or (select private.has_permission('facilitate_adventures'))
  );

create function public.sign_my_adventure_waiver(
  request_id uuid,
  terms_version text,
  signed_name text,
  emergency_contact_name text,
  emergency_contact_phone text,
  of_age boolean,
  accepts_risk boolean,
  no_ebike boolean,
  accepts_terms boolean,
  electronic_signature boolean
)
returns table (signature_id uuid, waiver_version text, signed_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  me uuid := private.require_customer();
  current_version text;
  waiver public.adventure_waivers;
  sig public.adventure_waiver_signatures;
  clean_name text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(sign_my_adventure_waiver.signed_name, '')), '\s+', ' ', 'g');
  clean_contact text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(sign_my_adventure_waiver.emergency_contact_name, '')), '\s+', ' ', 'g');
  clean_phone text := pg_catalog.btrim(coalesce(sign_my_adventure_waiver.emergency_contact_phone, ''));
begin
  if sign_my_adventure_waiver.request_id is null then
    raise exception 'request_id is required' using errcode = '22004';
  end if;
  -- A retry after the booking exists: the same signature.
  select s.* into sig from public.adventure_waiver_signatures s
  where s.customer_id = me and s.request_id = sign_my_adventure_waiver.request_id;
  if found and sig.booking_id is not null then
    return query select sig.id, sig.waiver_version, sig.signed_at;
    return;
  end if;

  select s.terms_version into current_version from public.adventure_settings s where s.id = 1;
  if current_version is null or sign_my_adventure_waiver.terms_version is distinct from current_version then
    raise exception using errcode = 'P0001', message = 'adventure_terms_changed',
      detail = 'The terms have changed. Read them again and confirm.';
  end if;
  select w.* into waiver from public.adventure_waivers w where w.version = current_version;
  if not (coalesce(sign_my_adventure_waiver.of_age, false) and coalesce(sign_my_adventure_waiver.accepts_risk, false)
          and coalesce(sign_my_adventure_waiver.no_ebike, false) and coalesce(sign_my_adventure_waiver.accepts_terms, false)
          and coalesce(sign_my_adventure_waiver.electronic_signature, false)) then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_incomplete',
      detail = 'Tick every box to sign the waiver.';
  end if;
  if pg_catalog.char_length(clean_name) not between 3 and 120 or clean_name !~ '\S\s+\S' then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_name',
      detail = 'Type your full name, first and last, to sign.';
  end if;
  if pg_catalog.char_length(clean_contact) not between 2 and 120
     or pg_catalog.char_length(clean_phone) not between 6 and 30 or clean_phone !~ '^\+?[0-9 ()-]+$' then
    raise exception using errcode = 'P0001', message = 'adventure_emergency_contact',
      detail = 'Give your emergency contact''s name and phone number.';
  end if;

  insert into public.adventure_waiver_signatures as s (
    customer_id, request_id, waiver_version, waiver_sha256, signed_name,
    emergency_contact_name, emergency_contact_phone,
    of_age, accepts_risk, no_ebike, accepts_terms, electronic_signature
  )
  values (
    me, sign_my_adventure_waiver.request_id, waiver.version, waiver.body_sha256, clean_name,
    clean_contact, clean_phone, true, true, true, true, true
  )
  on conflict (customer_id, request_id) do update
  set waiver_version = excluded.waiver_version, waiver_sha256 = excluded.waiver_sha256,
      signed_name = excluded.signed_name, emergency_contact_name = excluded.emergency_contact_name,
      emergency_contact_phone = excluded.emergency_contact_phone, signed_at = pg_catalog.now()
  returning s.* into sig;
  return query select sig.id, sig.waiver_version, sig.signed_at;
end;
$$;
revoke all on function public.sign_my_adventure_waiver(uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.sign_my_adventure_waiver(uuid, text, text, text, text, boolean, boolean, boolean, boolean, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Every new booking: signed, a size S to XXL, and on the board only by choice
-- ---------------------------------------------------------------------------
alter table public.adventure_bookings drop constraint adventure_bookings_tshirt_size_check;
alter table public.adventure_bookings
  add constraint adventure_bookings_tshirt_size_check check (tshirt_size ~ '^(S|M|L|XL|XXL)$');

-- D218: the name shown on the finisher board, or null (not on the board).
alter table public.adventure_bookings
  add column board_name text null check (
    pg_catalog.char_length(board_name) between 2 and 40
    and board_name = pg_catalog.btrim(board_name)
    and board_name !~ '[[:cntrl:]<>@]' and board_name !~* '(https?:|www\.|://)'
  ),
  add constraint adventure_bookings_board_name check ((finisher_name = 'preferred_name') = (board_name is not null));

-- What was bought still never changes; the board name is the rider's to change.
create or replace function private.adventure_bookings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array[
    'status', 'needs_attention', 'attention_reason', 'confirmed_at', 'expired_at', 'cancelled_at', 'updated_at',
    'finisher_name', 'board_name'
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

create function private.adventure_bookings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sig public.adventure_waiver_signatures;
begin
  select s.* into sig from public.adventure_waiver_signatures s
  where s.customer_id = new.customer_id and s.request_id = new.request_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'adventure_waiver_unsigned',
      detail = 'Sign the waiver before paying.';
  end if;
  if sig.waiver_version <> new.terms_version then
    raise exception using errcode = 'P0001', message = 'adventure_terms_changed',
      detail = 'The terms have changed. Read them again and confirm.';
  end if;
  if new.tshirt_size !~ '^(S|M|L|XL|XXL)$' then
    raise exception using errcode = 'P0001', message = 'adventure_size_invalid',
      detail = 'Choose a T-shirt size from S to XXL.';
  end if;
  -- The board name is set with set_my_board_name; until then, off the board.
  new.finisher_name := 'hidden';
  new.board_name := null;
  return new;
end;
$$;
revoke all on function private.adventure_bookings_before_insert() from public, anon, authenticated, service_role;
create trigger adventure_bookings_before_insert
  before insert on public.adventure_bookings
  for each row execute function private.adventure_bookings_before_insert();

create function private.adventure_bookings_link_waiver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.adventure_waiver_signatures s
  set booking_id = new.id
  where s.customer_id = new.customer_id and s.request_id = new.request_id and s.booking_id is null;
  return null;
end;
$$;
revoke all on function private.adventure_bookings_link_waiver() from public, anon, authenticated, service_role;
create trigger adventure_bookings_link_waiver
  after insert on public.adventure_bookings
  for each row execute function private.adventure_bookings_link_waiver();

-- ---------------------------------------------------------------------------
-- D218: the board name (the rider), and hiding one (staff)
-- ---------------------------------------------------------------------------
create function public.set_my_board_name(booking_id uuid, board_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  clean text := nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(set_my_board_name.board_name, '')), '\s+', ' ', 'g'), '');
begin
  select x.* into b from public.adventure_bookings x
  where x.id = set_my_board_name.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if b.status not in ('pending_payment', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'adventure_booking_closed',
      detail = 'This booking is cancelled or expired.';
  end if;
  if clean is not null and (
       pg_catalog.char_length(clean) not between 2 and 40
       or clean ~ '[[:cntrl:]<>@]' or clean ~* '(https?:|www\.|://)') then
    raise exception using errcode = 'P0001', message = 'adventure_board_name_invalid',
      detail = 'Use 2 to 40 letters, numbers or spaces for your board name, with no links or emails.';
  end if;
  if b.board_name is not distinct from clean then
    return;
  end if;
  update public.adventure_bookings x
  set board_name = clean,
      finisher_name = case when clean is null then 'hidden' else 'preferred_name' end::public.adventure_finisher_name
  where x.id = b.id;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'board_name_changed', pg_catalog.jsonb_build_object('shown', clean is not null));
end;
$$;
revoke all on function public.set_my_board_name(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_my_board_name(uuid, text) to authenticated;

create function public.hide_adventure_board_name(booking_id uuid, reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  clean text := nullif(pg_catalog.btrim(coalesce(hide_adventure_board_name.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the name comes off the board.';
  end if;
  perform 1 from public.adventure_bookings x where x.id = hide_adventure_board_name.booking_id for update;
  if not found then
    raise exception 'booking % not found', hide_adventure_board_name.booking_id using errcode = 'P0002';
  end if;
  update public.adventure_bookings x
  set board_name = null, finisher_name = 'hidden'
  where x.id = hide_adventure_board_name.booking_id and x.board_name is not null;
  if found then
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (hide_adventure_board_name.booking_id, 'board_name_changed', actor,
            pg_catalog.jsonb_build_object('shown', false, 'note', pg_catalog.left(clean, 500)));
  end if;
end;
$$;
revoke all on function public.hide_adventure_board_name(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.hide_adventure_board_name(uuid, text) to authenticated;

-- The board: only riders who chose a name, under that name.
create or replace function public.public_adventure_finishers(adventure_slug text, max_rows integer)
returns table (rider_name text, completed_on date, badge text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.board_name, cert.completed_on, ba.label
  from public.adventure_certificates cert
  join public.adventure_bookings b on b.id = cert.booking_id
  join public.adventures a on a.id = b.adventure_id
  join public.adventure_badge_awards ba on ba.certificate_id = cert.id
  where cert.status = 'active'
    and b.finisher_name = 'preferred_name' and b.board_name is not null
    and a.status = 'published'
    and a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(public_adventure_finishers.adventure_slug, '')))::extensions.citext
  order by cert.completed_on desc, cert.issued_at desc, cert.id
  limit greatest(1, least(coalesce(public_adventure_finishers.max_rows, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- D212: refundable until the ride is sent for review
-- ---------------------------------------------------------------------------
-- When the booking's ride was first sent for review, or null.
create function private.adventure_sent_for_review_at(booking uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.min(s.submitted_at)
  from public.adventure_attempts a
  join public.adventure_submissions s on s.attempt_id = a.id
  where a.booking_id = booking and s.submitted_at is not null;
$$;
revoke all on function private.adventure_sent_for_review_at(uuid) from public, anon, authenticated, service_role;

create or replace function public.request_my_adventure_cancellation(booking_id uuid, reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  clean text := nullif(pg_catalog.btrim(coalesce(request_my_adventure_cancellation.reason, '')), '');
begin
  select x.* into b from public.adventure_bookings x
  where x.id = request_my_adventure_cancellation.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if b.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'adventure_booking_closed',
      detail = 'Only a paid booking can be cancelled.';
  end if;
  if private.adventure_sent_for_review_at(b.id) is not null then
    raise exception using errcode = 'P0001', message = 'adventure_not_refundable',
      detail = 'Your ride has been sent for review, so the ticket can no longer be cancelled or refunded.';
  end if;
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Tell us why you want to cancel.';
  end if;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'cancellation_requested', pg_catalog.jsonb_build_object('note', pg_catalog.left(clean, 500)));
end;
$$;

-- An admin may still cancel after review starts (a broken rule, say); the
-- event says whether the ticket was refundable.
create or replace function public.cancel_adventure_booking(booking_id uuid, reason text)
returns public.adventure_bookings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  b public.adventure_bookings;
  clean text := nullif(pg_catalog.btrim(coalesce(cancel_adventure_booking.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the booking is cancelled.';
  end if;
  select x.* into b from public.adventure_bookings x where x.id = cancel_adventure_booking.booking_id for update;
  if not found then
    raise exception 'booking % not found', cancel_adventure_booking.booking_id using errcode = 'P0002';
  end if;
  if b.status not in ('confirmed', 'pending_payment') then
    raise exception using errcode = 'P0001', message = 'adventure_booking_closed',
      detail = 'This booking is already cancelled or expired.';
  end if;
  if exists (select 1 from public.adventure_certificates c where c.booking_id = b.id and c.status = 'active') then
    raise exception using errcode = 'P0001', message = 'adventure_booking_certified',
      detail = 'This ride is certified. Revoke the certificate first if it must go.';
  end if;
  if exists (select 1 from public.tracker_assignments x where x.booking_id = b.id and x.returned_at is null) then
    raise exception using errcode = 'P0001', message = 'tracker_still_out',
      detail = 'The rider still has a tracker. Record its return first.';
  end if;
  update public.adventure_bookings x
  set status = 'cancelled', cancelled_at = pg_catalog.now(), confirmed_at = null
  where x.id = b.id
  returning x.* into b;
  update public.adventure_departure_participants p
  set left_at = pg_catalog.now(), left_reason = 'Booking cancelled'
  where p.booking_id = b.id and p.left_at is null;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (b.id, 'booking_cancelled', actor, pg_catalog.jsonb_build_object(
    'note', pg_catalog.left(clean, 500),
    'refundable', private.adventure_sent_for_review_at(b.id) is null));
  return b;
end;
$$;

-- Staff: whether a booking is still refundable (the booking page).
create function public.adventure_booking_refund_state(booking_id uuid)
returns table (refundable boolean, sent_for_review_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select b.status = 'confirmed' and private.adventure_sent_for_review_at(b.id) is null,
         private.adventure_sent_for_review_at(b.id)
  from public.adventure_bookings b
  where b.id = adventure_booking_refund_state.booking_id and (select private.is_staff());
$$;
revoke all on function public.adventure_booking_refund_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.adventure_booking_refund_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- D213: tracker late fees
-- ---------------------------------------------------------------------------
alter table public.adventure_settings
  add column tracker_grace_days integer not null default 1 check (tracker_grace_days between 0 and 7),
  add column tracker_late_fee_per_day public.money_amount not null default 20 check (tracker_late_fee_per_day > 0);

create type public.tracker_late_fee_status as enum ('owed', 'paid', 'waived');

create table public.tracker_late_fees (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  assignment_id uuid not null unique references public.tracker_assignments (id) on delete restrict,
  -- The hire's return day plus the grace: the last day without a fee.
  free_until date not null,
  returned_on date not null check (returned_on > free_until),
  days_late integer not null check (days_late >= 1),
  per_day public.money_amount not null check (per_day > 0),
  amount public.money_amount not null,
  status public.tracker_late_fee_status not null default 'owed',
  settled_at timestamptz null,
  settled_by uuid null references public.staff (id) on delete restrict,
  settle_note text not null default '' check (pg_catalog.char_length(settle_note) <= 500),
  created_at timestamptz not null default pg_catalog.now(),
  constraint tracker_late_fees_amount check (amount = per_day * days_late and days_late = returned_on - free_until),
  constraint tracker_late_fees_settled check ((status = 'owed') = (settled_at is null) and (settled_at is null) = (settled_by is null))
);
create index tracker_late_fees_booking_idx on public.tracker_late_fees (booking_id);
create index tracker_late_fees_owed_idx on public.tracker_late_fees (created_at) where status = 'owed';
comment on table public.tracker_late_fees is
  'D213: a tracker brought back after its return day and the grace owes a fee per further day. Recorded by return_adventure_tracker; settled by settle_tracker_late_fee (admin).';

alter table public.tracker_late_fees enable row level security;
revoke all on table public.tracker_late_fees from public, anon, authenticated, service_role;
grant select on table public.tracker_late_fees to authenticated;
create policy tracker_late_fees_select_staff on public.tracker_late_fees
  for select to authenticated using ((select private.is_staff()));

-- The fee a tracker due back on return_on would owe if it came back today
-- (the Admin shows it on overdue hires).
create function public.tracker_late_fee_if_returned_today(return_on date)
returns public.money_amount
language sql
stable
security definer
set search_path = ''
as $$
  select (greatest(0, private.shop_today() - (tracker_late_fee_if_returned_today.return_on + s.tracker_grace_days))
          * s.tracker_late_fee_per_day)::public.money_amount
  from public.adventure_settings s
  where s.id = 1 and (select private.is_staff());
$$;
revoke all on function public.tracker_late_fee_if_returned_today(date) from public, anon, authenticated, service_role;
grant execute on function public.tracker_late_fee_if_returned_today(date) to authenticated;

create or replace function public.return_adventure_tracker(assignment_id uuid, condition public.tracker_return_condition, note text)
returns public.tracker_assignments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  a public.tracker_assignments;
  hire public.tracker_reservations;
  result public.tracker_assignments;
  settings public.adventure_settings;
  today date := private.shop_today();
  free_until date;
  late_days integer;
  fee public.money_amount;
begin
  if return_adventure_tracker.condition is null then
    raise exception 'condition is required' using errcode = '22004';
  end if;
  select x.* into a from public.tracker_assignments x where x.id = return_adventure_tracker.assignment_id;
  if not found then
    raise exception 'assignment % not found', return_adventure_tracker.assignment_id using errcode = 'P0002';
  end if;
  perform 1 from public.adventure_bookings b where b.id = a.booking_id for update;
  perform private.lock_tracker_pool();
  select x.* into a from public.tracker_assignments x where x.id = a.id for update;
  if a.returned_at is not null then
    raise exception using errcode = 'P0001', message = 'tracker_already_returned',
      detail = 'This tracker was already returned.';
  end if;
  select r.* into hire from public.tracker_reservations r where r.id = a.reservation_id for update;
  select s.* into settings from public.adventure_settings s where s.id = 1;
  update public.tracker_assignments x
  set returned_at = pg_catalog.now(), received_by = actor, return_condition = return_adventure_tracker.condition,
      return_note = pg_catalog.left(pg_catalog.btrim(coalesce(return_adventure_tracker.note, '')), 500)
  where x.id = a.id
  returning x.* into result;
  update public.tracking_devices d
  set service_state = case return_adventure_tracker.condition
        when 'good' then 'in_service' when 'lost' then 'lost' else 'maintenance' end::public.tracker_service_state
  where d.id = a.device_id;
  update public.tracker_reservations r set status = 'completed' where r.id = hire.id;
  free_until := hire.return_on + settings.tracker_grace_days;
  late_days := greatest(0, today - free_until);
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (hire.booking_id, 'tracker_returned', actor, pg_catalog.jsonb_build_object(
    'device', (select d.label from public.tracking_devices d where d.id = a.device_id),
    'status', return_adventure_tracker.condition,
    'note', case when return_adventure_tracker.condition = 'lost' then 'Lost: settle its cost with the rider' end));
  if late_days > 0 then
    fee := (settings.tracker_late_fee_per_day * late_days)::public.money_amount;
    insert into public.tracker_late_fees (booking_id, assignment_id, free_until, returned_on, days_late, per_day, amount)
    values (hire.booking_id, a.id, free_until, today, late_days, settings.tracker_late_fee_per_day, fee);
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (hire.booking_id, 'late_fee_recorded', actor, pg_catalog.jsonb_build_object(
      'amount', fee, 'days', late_days,
      'note', pg_catalog.format(
        'The tracker was due back on %s, with %s to spare, and came back %s %s later. The late fee is $%s (%s a day), payable at the shop.',
        pg_catalog.to_char(hire.return_on, 'FMDD Mon YYYY'),
        case settings.tracker_grace_days when 0 then 'no grace day' when 1 then 'a grace day' else settings.tracker_grace_days || ' grace days' end,
        late_days, case when late_days = 1 then 'day' else 'days' end,
        pg_catalog.to_char(fee, 'FM999999990.00'), '$' || pg_catalog.to_char(settings.tracker_late_fee_per_day, 'FM999999990.00'))));
  end if;
  return result;
end;
$$;

create function public.settle_tracker_late_fee(fee_id uuid, outcome public.tracker_late_fee_status, note text)
returns public.tracker_late_fees
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  f public.tracker_late_fees;
  clean text := pg_catalog.left(pg_catalog.btrim(coalesce(settle_tracker_late_fee.note, '')), 500);
begin
  if settle_tracker_late_fee.outcome is null or settle_tracker_late_fee.outcome = 'owed' then
    raise exception 'outcome must be paid or waived' using errcode = '22023';
  end if;
  if settle_tracker_late_fee.outcome = 'waived' and clean = '' then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the fee is waived.';
  end if;
  select x.* into f from public.tracker_late_fees x where x.id = settle_tracker_late_fee.fee_id;
  if not found then
    raise exception 'late fee % not found', settle_tracker_late_fee.fee_id using errcode = 'P0002';
  end if;
  perform 1 from public.adventure_bookings b where b.id = f.booking_id for update;
  select x.* into f from public.tracker_late_fees x where x.id = f.id for update;
  if f.status <> 'owed' then
    raise exception using errcode = 'P0001', message = 'late_fee_settled', detail = 'This late fee is already settled.';
  end if;
  update public.tracker_late_fees x
  set status = settle_tracker_late_fee.outcome, settled_at = pg_catalog.now(), settled_by = actor, settle_note = clean
  where x.id = f.id
  returning x.* into f;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (f.booking_id, 'late_fee_settled', actor, pg_catalog.jsonb_build_object(
    'status', f.status, 'amount', f.amount, 'note', nullif(clean, '')));
  return f;
end;
$$;
revoke all on function public.settle_tracker_late_fee(uuid, public.tracker_late_fee_status, text)
  from public, anon, authenticated, service_role;
grant execute on function public.settle_tracker_late_fee(uuid, public.tracker_late_fee_status, text) to authenticated;

-- The rider is emailed a late fee.
create or replace function private.adventure_booking_events_queue_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  notice public.adventure_notice_kind;
  to_shop boolean := false;
  settings public.shop_settings;
  rider_email text;
begin
  notice := case new.kind
    when 'confirmed' then 'ticket_paid'
    when 'changes_requested' then 'changes_requested'
    when 'certified' then 'certified'
    when 'not_certified' then 'not_certified'
    when 'evidence_submitted' then 'ride_submitted'
    when 'payment_attention' then 'payment_attention'
    when 'pack_updated' then case when new.detail ->> 'status' = 'ready' then 'pack_ready' end
    when 'departure_joined' then 'departure_joined'
    when 'departure_cancelled' then 'departure_cancelled'
    when 'cancellation_requested' then 'cancellation_requested'
    when 'booking_cancelled' then 'booking_cancelled'
    when 'late_fee_recorded' then 'tracker_late_fee'
  end::public.adventure_notice_kind;
  if notice is null then
    return null;
  end if;
  to_shop := notice in ('ride_submitted', 'payment_attention', 'cancellation_requested');

  if to_shop then
    select s.* into settings from public.shop_settings s where s.id = 1;
    insert into private.adventure_notices (booking_id, event_id, kind, audience, recipient)
    select new.booking_id, new.id, notice, 'shop'::public.appointment_notice_audience, r.address
    from (
      select pg_catalog.lower(st.email::text) as address
      from public.staff st
      where st.id = any(settings.booking_alert_staff_ids) and st.active and st.email is not null
      union
      select pg_catalog.lower(e) from pg_catalog.unnest(settings.booking_alert_emails) e
    ) r
    on conflict on constraint adventure_notices_once do nothing;
  else
    select c.email::text into rider_email
    from public.adventure_bookings b join public.customers c on c.id = b.customer_id
    where b.id = new.booking_id;
    if rider_email is not null then
      insert into private.adventure_notices (booking_id, event_id, kind, audience, recipient)
      values (new.booking_id, new.id, notice, 'customer', pg_catalog.lower(rider_email))
      on conflict on constraint adventure_notices_once do nothing;
    end if;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- The rider's view of their terms (the site's ride page)
-- ---------------------------------------------------------------------------
create function public.my_adventure_terms(booking_id uuid)
returns table (
  waiver_version text,
  signed_name text,
  signed_at timestamptz,
  refundable boolean,
  sent_for_review_at timestamptz,
  board_name text,
  late_fees_owed public.money_amount
)
language sql
stable
security definer
set search_path = ''
as $$
  select sig.waiver_version, sig.signed_name, sig.signed_at,
         b.status = 'confirmed' and private.adventure_sent_for_review_at(b.id) is null,
         private.adventure_sent_for_review_at(b.id),
         b.board_name,
         coalesce((select pg_catalog.sum(f.amount) from public.tracker_late_fees f
                   where f.booking_id = b.id and f.status = 'owed'), 0)::public.money_amount
  from public.adventure_bookings b
  left join public.adventure_waiver_signatures sig on sig.booking_id = b.id
  where b.id = my_adventure_terms.booking_id
    and b.customer_id = private.current_customer_id();
$$;
revoke all on function public.my_adventure_terms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.my_adventure_terms(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The first waiver (docs/adventures/waiver-2026-11-14.md, unchanged)
-- ---------------------------------------------------------------------------
insert into public.adventure_waivers (version, title, body, body_sha256)
select '2026-11-14', 'BICII rider terms, release and waiver', t.body,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(t.body, 'UTF8')), 'hex')
from (select $waiver$BICII RIDER TERMS, RELEASE AND WAIVER

Read this carefully. It affects your legal rights. By signing it you accept the risks of riding, you release BICII from claims, and you agree to these terms. Sign only if you agree to all of it.

In these terms, "BICII", "we" and "us" mean the business that runs BICII and the BICII shop, and its owners, staff, facilitators and volunteers. "You" means the rider named on this booking. "The ride" means your attempt at the route you booked, including getting to the start, every part of the route and getting home.

1. WHAT YOU ARE BUYING
1.1 You are paying for BICII to judge whether you completed the route under its rules. The price is for the judging only.
1.2 If your ride is certified, you receive a certificate, a badge and a finisher pack. The finisher pack is a gift for finishing. It is collected from the BICII shop; it is never posted or delivered. It is not part of what you pay for, and it has no cash value.
1.3 Each ticket is for one attempt by you. There are no retries: if your ride is not certified, you buy a new ticket to try again.
1.4 Your ticket belongs to you and cannot be given, sold or transferred to anyone else.
1.5 A supported ride also includes the facilitators BICII assigns to that date and a tracker. Facilitators help riders on the day. They are not a rescue service, a medical service or a guarantee of anyone's safety.

2. CANCELLATION AND REFUNDS
2.1 You may cancel and be refunded until you send your ride for review. Ask from your ride page; BICII refunds the card you paid with.
2.2 Once you have sent your ride for review, there are no refunds, whatever the result: certified, not certified, or withdrawn.
2.3 BICII may cancel a booking, for example if a date is cancelled or if you break these terms. If BICII cancels before you send your ride for review, you are refunded. If BICII cancels because you broke these terms, BICII decides whether any refund is due.

3. THE RULES
3.1 You must ride a bicycle powered only by you. Electric bicycles, e-bikes, power-assisted bicycles and every other motorised vehicle are not allowed, for any part of the route.
3.2 You must finish within the route's maximum time, pass its checkpoints and follow every other rule on the route's page, as published when you bought your ticket.
3.3 You must obey Singapore's road traffic laws, the rules for park connectors and paths, and the instructions of the police, park officers and other authorities. Public roads and paths stay open to traffic and other users during the ride.
3.4 You must wear a helmet, use front and rear lights when it is dark, and keep your bicycle roadworthy.
3.5 You must send only your own, honest records of your own ride. A false, altered or borrowed recording or photo ends your attempt without a refund, and BICII may refuse you future tickets.
3.6 BICII's reviewers decide whether a ride is certified. Their decision is final.

4. TRACKER HIRE
4.1 A hired tracker costs 20 dollars for each 24 hours of use, paid when you buy your ticket.
4.2 Bring the tracker back to the BICII shop on its return day. You have a grace period of 24 hours after that to bring it back without charge.
4.3 After the grace period, you pay a late fee of 20 dollars for each further day, or part of a day, until the tracker is back. BICII may charge you this fee, and you agree to pay it at the shop.
4.4 You must look after the tracker. If it is lost, stolen or damaged while you have it, you agree to settle its cost with BICII.
4.5 A tracker records your position at intervals and may stop working. It is not an emergency service. BICII does not watch your position continuously, and a missing or old position is not a call for help.

5. YOUR HEALTH AND FITNESS
5.1 You confirm that you are 18 years old or older.
5.2 You confirm that you are fit and healthy enough to ride the full route, that you have trained for it, and that no doctor has told you not to take part in strenuous exercise. If you are unsure, ask a doctor before you ride.
5.3 You will stop riding if you feel unwell, are injured, or are too tired to ride safely.
5.4 You are responsible for your own food, water, clothing, equipment, repairs and navigation, and for getting home, unless the route's page says otherwise.

6. THE RISKS
6.1 Long-distance cycling is dangerous. The risks include, among others: collisions with vehicles, other cyclists, pedestrians, animals or objects; falls; poor or changing road and path surfaces; weather, heat, rain and lightning; riding in the dark; mechanical failure; getting lost; exhaustion, dehydration, heat injury, cramps and other illness; the acts of other people; and delays in help reaching you.
6.2 These risks can cause damage to or loss of property, serious injury, permanent disability or death.
6.3 You understand these risks, and you choose to take part and accept them freely and voluntarily.

7. RELEASE, WAIVER AND INDEMNITY
7.1 To the fullest extent the law allows, you release BICII from, and waive, every claim you have or may have against BICII for any loss, damage, injury, illness or death arising from or connected with the ride, the route, a tracker, a facilitator or anything BICII does or fails to do in connection with them, including when it is caused by BICII's negligence.
7.2 To the fullest extent the law allows, BICII is not liable for any indirect or consequential loss, for loss of or damage to your property, or for anything outside its reasonable control.
7.3 You will indemnify BICII against any claim made against BICII by anyone else, and any cost BICII bears, that arises from your breach of these terms or your own act or omission on the ride.
7.4 Nothing in these terms excludes or limits any liability that cannot be excluded or limited under Singapore law, including liability for death or personal injury caused by negligence where the law does not allow it to be excluded. If any part of these terms cannot be enforced, the rest still applies.
7.5 This release binds you and your heirs, personal representatives and anyone who claims through you.

8. EMERGENCIES
8.1 In an emergency, call 995 for an ambulance or fire, or 999 for the police, before anything else.
8.2 You allow BICII to contact your emergency contact, and to give your details to the emergency services, if BICII believes you may be hurt, missing or in danger.
8.3 You allow first aid and medical treatment to be given to you if you cannot consent yourself, and you are responsible for its cost.

9. YOUR INFORMATION
9.1 BICII keeps the details you give, your ride recordings, photos, tracker positions and this signature to run the booking, judge your ride, contact you and your emergency contact, and keep a record of this agreement.
9.2 BICII staff and reviewers can see your ride's evidence and positions. The public sees only what you choose to show: your name on the finisher board and anything you choose to share.

10. GENERAL
10.1 These terms, the route's rules as published when you bought your ticket, and the details of your booking are the whole agreement between you and BICII about the ride.
10.2 These terms are governed by the laws of Singapore, and the courts of Singapore decide any dispute.

SIGNATURE
By typing your full name and signing, you confirm that you have read and understood these terms, that you agree to them, and that your typed name is your signature with the same effect as a signature by hand.$waiver$::text as body) t;
