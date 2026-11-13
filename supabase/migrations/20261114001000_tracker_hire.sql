-- Adventures Phase C, tracker hire: the database (D185-D188; DATA-MODEL §20
-- "Tracker hire"; handoff §6.3, §9.5, §11.3, §11.4).
--
--   * tracking_devices: BICII's trackers (label, provider and device id,
--     model, service state). Only devices in service count as the fleet.
--   * Hire is sold with the certification while an admin has it switched on
--     (adventure_settings.tracker_hire_enabled, off until real devices and a
--     feed exist, D186). The rider picks a collection day and a return day
--     (shop days the shop is open, at most tracker_hire_max_days apart); the
--     price is the offer's tracker hire price per day, added as a line.
--   * tracker_reservations: one per hiring booking. Held while its checkout
--     is open (until the payment's expiry), confirmed when paid, cancelled
--     when the checkout expires, completed when the tracker comes back.
--     Capacity: for every day of the hire, the reservations covering it
--     (confirmed, or held and unexpired; a tracker still out past its return
--     day keeps covering every later day) stay under the devices in
--     service. Checked under one pool lock (lock order: booking, pool,
--     device), so two riders cannot both take the last tracker.
--   * tracker_assignments: who physically holds which device, for which
--     hire and attempt. A device has at most one open assignment, a hire at
--     most one; a replacement ends one and starts another, both kept.
--   * No deposit; a late or lost tracker is settled with the rider by staff
--     (D185): the database records the return day and condition, and
--     charges nothing.

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
create type public.tracking_provider as enum ('spot', 'fake');
create type public.tracker_service_state as enum ('in_service', 'maintenance', 'lost', 'retired');
create type public.tracker_reservation_status as enum ('held', 'confirmed', 'completed', 'cancelled');
create type public.tracker_return_condition as enum ('good', 'needs_service', 'faulty', 'lost');

create table public.tracking_devices (
  id uuid primary key default gen_random_uuid(),
  label text not null check (label ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$'),
  provider public.tracking_provider not null,
  provider_device_id text not null check (pg_catalog.char_length(pg_catalog.btrim(provider_device_id)) between 1 and 80),
  model text not null default '' check (pg_catalog.char_length(model) <= 80),
  service_state public.tracker_service_state not null default 'maintenance',
  note text not null default '' check (pg_catalog.char_length(note) <= 500),
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid null references public.staff (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now()
);
create unique index tracking_devices_label_key on public.tracking_devices (pg_catalog.lower(label));
create unique index tracking_devices_provider_key on public.tracking_devices (provider, provider_device_id);
create trigger tracking_devices_set_updated_at
  before update on public.tracking_devices
  for each row execute function private.set_updated_at();

alter table public.adventure_settings
  add column tracker_hire_enabled boolean not null default false,
  add column tracker_hire_max_days integer not null default 7 check (tracker_hire_max_days between 1 and 30);

-- ---------------------------------------------------------------------------
-- Reservations and assignments
-- ---------------------------------------------------------------------------
create table public.tracker_reservations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.adventure_bookings (id) on delete restrict,
  collect_on date not null,
  return_on date not null,
  days integer generated always as (return_on - collect_on) stored,
  status public.tracker_reservation_status not null default 'held',
  hold_until timestamptz null,
  cancel_reason text null check (pg_catalog.char_length(cancel_reason) <= 500),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint tracker_reservations_dates check (return_on > collect_on),
  constraint tracker_reservations_hold check ((status = 'held') = (hold_until is not null))
);
create index tracker_reservations_active_idx on public.tracker_reservations (collect_on, return_on)
  where status in ('held', 'confirmed');
create trigger tracker_reservations_set_updated_at
  before update on public.tracker_reservations
  for each row execute function private.set_updated_at();

create table public.tracker_assignments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.tracker_reservations (id) on delete restrict,
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  attempt_id uuid not null references public.adventure_attempts (id) on delete restrict,
  device_id uuid not null references public.tracking_devices (id) on delete restrict,
  issued_at timestamptz not null default pg_catalog.now(),
  issued_by uuid not null references public.staff (id) on delete restrict,
  issue_note text not null default '' check (pg_catalog.char_length(issue_note) <= 500),
  returned_at timestamptz null,
  received_by uuid null references public.staff (id) on delete restrict,
  return_condition public.tracker_return_condition null,
  return_note text not null default '' check (pg_catalog.char_length(return_note) <= 500),
  constraint tracker_assignments_return check (
    (returned_at is null) = (received_by is null) and (returned_at is null) = (return_condition is null)
  ),
  constraint tracker_assignments_order check (returned_at is null or returned_at >= issued_at)
);
-- One person holds a device at a time; one device per hire at a time.
create unique index tracker_assignments_device_open on public.tracker_assignments (device_id) where returned_at is null;
create unique index tracker_assignments_reservation_open on public.tracker_assignments (reservation_id) where returned_at is null;
create index tracker_assignments_device_idx on public.tracker_assignments (device_id, issued_at);

-- Custody history is kept: only the return may be written, once.
create function private.tracker_assignments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     or old.returned_at is not null
     or (pg_catalog.to_jsonb(new) - array['returned_at', 'received_by', 'return_condition', 'return_note'])
        <> (pg_catalog.to_jsonb(old) - array['returned_at', 'received_by', 'return_condition', 'return_note']) then
    raise exception using
      errcode = 'P0001',
      message = 'tracker_assignment_immutable',
      detail = 'Who held a tracker and when is kept as it was.';
  end if;
  return new;
end;
$$;
revoke all on function private.tracker_assignments_guard() from public, anon, authenticated, service_role;
create trigger tracker_assignments_guard
  before update or delete on public.tracker_assignments
  for each row execute function private.tracker_assignments_guard();

-- ---------------------------------------------------------------------------
-- Access: staff read; riders use my_adventure_tracker; changes are RPCs.
-- ---------------------------------------------------------------------------
alter table public.tracking_devices enable row level security;
alter table public.tracker_reservations enable row level security;
alter table public.tracker_assignments enable row level security;
revoke all on table public.tracking_devices, public.tracker_reservations, public.tracker_assignments
  from public, anon, authenticated, service_role;
grant select on table public.tracking_devices, public.tracker_reservations, public.tracker_assignments to authenticated;
create policy tracking_devices_select_staff on public.tracking_devices
  for select to authenticated using ((select private.is_staff()));
create policy tracker_reservations_select_staff on public.tracker_reservations
  for select to authenticated using ((select private.is_staff()));
create policy tracker_assignments_select_staff on public.tracker_assignments
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Capacity
-- ---------------------------------------------------------------------------
-- Whether the shop is open at some time on a shop day.
create function private.shop_open_on(day date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not pg_catalog.isempty(
    private.shop_hours_ranges(shop_open_on.day)
    - private.closed_ranges(private.shop_day_start(shop_open_on.day), private.shop_day_start(shop_open_on.day + 1))
  );
$$;
revoke all on function private.shop_open_on(date) from public, anon, authenticated, service_role;

-- The fewest trackers free on any day of [from_day, to_day), leaving out one
-- reservation (the one being checked). Call under the pool lock to rely on it.
create function private.trackers_free(from_day date, to_day date, except_reservation uuid default null)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with fleet as (
    select pg_catalog.count(*)::integer as n from public.tracking_devices d where d.service_state = 'in_service'
  ),
  active as (
    select r.collect_on,
           -- A tracker still out after its return day keeps its place.
           case when exists (
             select 1 from public.tracker_assignments x where x.reservation_id = r.id and x.returned_at is null
           ) then 'infinity'::date else r.return_on end as until_day
    from public.tracker_reservations r
    where r.id is distinct from trackers_free.except_reservation
      and (r.status = 'confirmed' or (r.status = 'held' and r.hold_until > pg_catalog.now()))
  )
  select (select n from fleet) - coalesce(pg_catalog.max(used), 0)
  from (
    select d::date as day,
           (select pg_catalog.count(*) from active a where a.collect_on <= d::date and a.until_day > d::date) as used
    from pg_catalog.generate_series(trackers_free.from_day, trackers_free.to_day - 1, interval '1 day') d
  ) per_day;
$$;
revoke all on function private.trackers_free(date, date, uuid) from public, anon, authenticated, service_role;

create function private.lock_tracker_pool()
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bicii.tracker_pool'));
$$;
revoke all on function private.lock_tracker_pool() from public, anon, authenticated, service_role;

-- The rider's dates: refuses what cannot be hired (D187).
create function private.check_hire_dates(collect_on date, return_on date)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  settings public.adventure_settings;
  today date := private.shop_today();
begin
  select s.* into settings from public.adventure_settings s where s.id = 1;
  if check_hire_dates.collect_on is null or check_hire_dates.return_on is null
     or check_hire_dates.collect_on <= today
     or check_hire_dates.collect_on > today + 60
     or check_hire_dates.return_on <= check_hire_dates.collect_on
     or check_hire_dates.return_on - check_hire_dates.collect_on > settings.tracker_hire_max_days then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_hire_dates_invalid',
      detail = pg_catalog.format(
        'Collect from tomorrow up to 60 days ahead, and return within %s days.', settings.tracker_hire_max_days);
  end if;
  if not private.shop_open_on(check_hire_dates.collect_on) or not private.shop_open_on(check_hire_dates.return_on) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_hire_day_closed',
      detail = 'The shop is closed on one of those days. Choose days it is open.';
  end if;
end;
$$;
revoke all on function private.check_hire_dates(date, date) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Checkout, now with hire (replaces the Phase B function; the extra
-- arguments have defaults, so a call without them is unchanged).
-- ---------------------------------------------------------------------------
drop function public.prepare_my_adventure_checkout(
  uuid, text, public.adventure_participation, integer, text, public.adventure_finisher_name, text
);

create function public.prepare_my_adventure_checkout(
  request_id uuid,
  adventure_slug text,
  kind public.adventure_participation,
  revision_number integer,
  tshirt_size text,
  finisher_name public.adventure_finisher_name,
  terms_version text,
  recording_method public.adventure_recording_method default 'own_device',
  hire_collect_on date default null,
  hire_return_on date default null
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
  hire public.tracker_reservations;
  size text := pg_catalog.upper(pg_catalog.btrim(coalesce(prepare_my_adventure_checkout.tshirt_size, '')));
  method public.adventure_recording_method := coalesce(prepare_my_adventure_checkout.recording_method, 'own_device');
  hire_days integer;
  inserted boolean;
begin
  if prepare_my_adventure_checkout.request_id is null then
    raise exception 'request_id is required' using errcode = '22004';
  end if;
  fingerprint := pg_catalog.md5(pg_catalog.concat_ws('|',
    pg_catalog.lower(pg_catalog.btrim(prepare_my_adventure_checkout.adventure_slug)),
    prepare_my_adventure_checkout.kind, prepare_my_adventure_checkout.revision_number, size,
    prepare_my_adventure_checkout.finisher_name, prepare_my_adventure_checkout.terms_version)
    || case when method = 'tracker_hire' then pg_catalog.concat_ws('|', '|hire',
         prepare_my_adventure_checkout.hire_collect_on, prepare_my_adventure_checkout.hire_return_on) else '' end);

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
    if method = 'tracker_hire' then
      if not settings.tracker_hire_enabled or offer.tracker_hire_price is null then
        raise exception using
          errcode = 'P0001',
          message = 'adventure_tracker_hire_closed',
          detail = 'Tracker hire is not available. Ride with your own device.';
      end if;
      perform private.check_hire_dates(prepare_my_adventure_checkout.hire_collect_on, prepare_my_adventure_checkout.hire_return_on);
      hire_days := prepare_my_adventure_checkout.hire_return_on - prepare_my_adventure_checkout.hire_collect_on;
    elsif prepare_my_adventure_checkout.hire_collect_on is not null or prepare_my_adventure_checkout.hire_return_on is not null then
      raise exception 'hire dates without tracker hire' using errcode = '22023';
    end if;

    insert into public.adventure_bookings as b (
      reference, customer_id, adventure_id, revision_id, offer_id, kind, recording_method, tshirt_size,
      finisher_name, terms_version, total, request_id, request_fingerprint
    )
    values (
      private.next_adventure_reference(), me, adv.id, rev.id, offer.id, offer.kind, method, size,
      coalesce(prepare_my_adventure_checkout.finisher_name, 'first_name_initial'),
      settings.terms_version,
      offer.price + case when method = 'tracker_hire' then offer.tracker_hire_price * hire_days else 0 end,
      prepare_my_adventure_checkout.request_id, fingerprint
    )
    on conflict (request_id) do nothing
    returning b.* into booking;
    inserted := found;
    if inserted then
      insert into public.adventure_booking_lines (booking_id, position, kind, description, quantity, unit_price)
      values (booking.id, 1, 'certification', rev.name || ' certification', 1, offer.price);
      if method = 'tracker_hire' then
        insert into public.adventure_booking_lines (booking_id, position, kind, description, quantity, unit_price)
        values (booking.id, 2, 'tracker_hire',
                pg_catalog.format('Tracker hire, %s to %s',
                  pg_catalog.to_char(prepare_my_adventure_checkout.hire_collect_on, 'FMDD Mon YYYY'),
                  pg_catalog.to_char(prepare_my_adventure_checkout.hire_return_on, 'FMDD Mon YYYY')),
                hire_days, offer.tracker_hire_price);
        insert into public.tracker_reservations (booking_id, collect_on, return_on, hold_until)
        values (booking.id, prepare_my_adventure_checkout.hire_collect_on, prepare_my_adventure_checkout.hire_return_on,
                pg_catalog.now());
      end if;
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

  -- An open payment with time left is reused (its hold already runs to its expiry).
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

  -- A hire holds a tracker until the payment page expires, if one is free
  -- on every day (lock order: booking, then the pool).
  select r.* into hire from public.tracker_reservations r where r.booking_id = booking.id;
  if found then
    perform private.lock_tracker_pool();
    if private.trackers_free(hire.collect_on, hire.return_on, hire.id) < 1 then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_trackers_unavailable',
        detail = 'No tracker is free for those days. Choose other days or ride with your own device.';
    end if;
    update public.tracker_reservations r
    set status = 'held', hold_until = payment.stripe_session_expires_at
    where r.id = hire.id;
  end if;

  insert into public.adventure_booking_events (booking_id, kind, payment_id)
  values (booking.id, 'payment_started', payment.id);

  return query select booking.id, booking.reference, payment.id, payment.amount, payment.amount_cents,
    payment.currency::text, payment.stripe_session_expires_at,
    (select l.description from public.adventure_booking_lines l where l.booking_id = booking.id and l.position = 1),
    false;
end;
$$;

-- ---------------------------------------------------------------------------
-- The booking's fate moves its hire.
-- ---------------------------------------------------------------------------
create function private.adventure_bookings_move_hire()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hire public.tracker_reservations;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  select r.* into hire from public.tracker_reservations r where r.booking_id = new.id for update;
  if not found or hire.status not in ('held', 'confirmed') then
    return null;
  end if;
  if new.status = 'confirmed' then
    perform private.lock_tracker_pool();
    update public.tracker_reservations r set status = 'confirmed', hold_until = null where r.id = hire.id;
    -- Paid after the hold lapsed and the tracker went to someone else: the
    -- money is kept and staff are told; nothing is overbooked silently.
    if hire.hold_until < pg_catalog.now() and private.trackers_free(hire.collect_on, hire.return_on, hire.id) < 1 then
      perform private.flag_adventure_booking(
        new.id, 'Paid after its tracker hold lapsed, and no tracker is free for those days', null, null);
    end if;
  elsif new.status in ('expired', 'cancelled') then
    update public.tracker_reservations r
    set status = 'cancelled', hold_until = null,
        cancel_reason = case when new.status = 'expired' then 'Checkout expired' else 'Booking cancelled' end
    where r.id = hire.id;
  end if;
  return null;
end;
$$;
revoke all on function private.adventure_bookings_move_hire() from public, anon, authenticated, service_role;
create trigger adventure_bookings_move_hire
  after update of status on public.adventure_bookings
  for each row execute function private.adventure_bookings_move_hire();

-- ---------------------------------------------------------------------------
-- Settings and devices (staff)
-- ---------------------------------------------------------------------------
create function public.set_adventure_tracker_hire(enabled boolean, max_days integer)
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
  if set_adventure_tracker_hire.max_days is null or set_adventure_tracker_hire.max_days not between 1 and 30 then
    raise exception using errcode = 'P0001', message = 'tracker_hire_days_invalid',
      detail = 'Allow from 1 to 30 days of hire.';
  end if;
  update public.adventure_settings s
  set tracker_hire_enabled = coalesce(set_adventure_tracker_hire.enabled, false),
      tracker_hire_max_days = set_adventure_tracker_hire.max_days,
      updated_by = actor
  where s.id = 1
  returning s.* into result;
  return result;
end;
$$;

create function public.register_tracking_device(label text, provider public.tracking_provider, provider_device_id text, model text)
returns public.tracking_devices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  result public.tracking_devices;
begin
  insert into public.tracking_devices (label, provider, provider_device_id, model, created_by)
  values (pg_catalog.btrim(register_tracking_device.label), register_tracking_device.provider,
          pg_catalog.btrim(register_tracking_device.provider_device_id),
          pg_catalog.btrim(coalesce(register_tracking_device.model, '')), actor)
  returning * into result;
  return result;
end;
$$;

-- In service, maintenance, lost or retired; never while someone holds it.
create function public.set_tracking_device_state(device_id uuid, state public.tracker_service_state, note text)
returns public.tracking_devices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  result public.tracking_devices;
begin
  perform private.lock_tracker_pool();
  select d.* into result from public.tracking_devices d where d.id = set_tracking_device_state.device_id for update;
  if not found then
    raise exception 'device % not found', set_tracking_device_state.device_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.tracker_assignments x where x.device_id = result.id and x.returned_at is null) then
    raise exception using errcode = 'P0001', message = 'tracker_in_use',
      detail = 'Someone has this tracker. Record its return first.';
  end if;
  update public.tracking_devices d
  set service_state = set_tracking_device_state.state,
      note = pg_catalog.left(pg_catalog.btrim(coalesce(set_tracking_device_state.note, '')), 500)
  where d.id = result.id
  returning d.* into result;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Issue, replace, return, cancel (D188)
-- ---------------------------------------------------------------------------
create function private.open_assignment_for(reservation public.tracker_reservations, device uuid, actor uuid, note text)
returns public.tracker_assignments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  attempt public.adventure_attempts;
  dev public.tracking_devices;
  result public.tracker_assignments;
begin
  select d.* into dev from public.tracking_devices d where d.id = open_assignment_for.device for update;
  if not found then
    raise exception 'device % not found', open_assignment_for.device using errcode = 'P0002';
  end if;
  if dev.service_state <> 'in_service' then
    raise exception using errcode = 'P0001', message = 'tracker_not_in_service',
      detail = 'That tracker is not in service. Choose another.';
  end if;
  if exists (select 1 from public.tracker_assignments x where x.device_id = dev.id and x.returned_at is null) then
    raise exception using errcode = 'P0001', message = 'tracker_in_use',
      detail = 'Someone has this tracker. Record its return first.';
  end if;
  select a.* into attempt from public.adventure_attempts a
  where a.booking_id = reservation.booking_id order by a.attempt_number desc limit 1;
  if not found then
    insert into public.adventure_attempts (booking_id) values (reservation.booking_id) returning * into attempt;
  end if;
  insert into public.tracker_assignments (reservation_id, booking_id, attempt_id, device_id, issued_by, issue_note)
  values (reservation.id, reservation.booking_id, attempt.id, dev.id, open_assignment_for.actor,
          pg_catalog.left(pg_catalog.btrim(coalesce(open_assignment_for.note, '')), 500))
  returning * into result;
  return result;
end;
$$;
revoke all on function private.open_assignment_for(public.tracker_reservations, uuid, uuid, text)
  from public, anon, authenticated, service_role;

create function public.issue_adventure_tracker(reservation_id uuid, device_id uuid, note text)
returns public.tracker_assignments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  hire public.tracker_reservations;
  result public.tracker_assignments;
begin
  perform 1 from public.adventure_bookings b
  join public.tracker_reservations r on r.booking_id = b.id
  where r.id = issue_adventure_tracker.reservation_id
  for update of b;
  perform private.lock_tracker_pool();
  select r.* into hire from public.tracker_reservations r where r.id = issue_adventure_tracker.reservation_id for update;
  if not found then
    raise exception 'reservation % not found', issue_adventure_tracker.reservation_id using errcode = 'P0002';
  end if;
  if hire.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'tracker_hire_not_confirmed',
      detail = 'This hire is not paid, or is already finished.';
  end if;
  if exists (select 1 from public.tracker_assignments x where x.reservation_id = hire.id and x.returned_at is null) then
    raise exception using errcode = 'P0001', message = 'tracker_already_issued',
      detail = 'This rider already has a tracker. Replace it instead.';
  end if;
  result := private.open_assignment_for(hire, issue_adventure_tracker.device_id, actor, issue_adventure_tracker.note);
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (hire.booking_id, 'tracker_issued', actor,
          pg_catalog.jsonb_build_object('device', (select d.label from public.tracking_devices d where d.id = result.device_id)));
  return result;
end;
$$;

-- A failed tracker during a ride: the old one is ended (faulty, to
-- maintenance) and another begins; both stay with the same attempt.
create function public.replace_adventure_tracker(assignment_id uuid, device_id uuid, reason text)
returns public.tracker_assignments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  old_assignment public.tracker_assignments;
  hire public.tracker_reservations;
  result public.tracker_assignments;
  clean text := nullif(pg_catalog.btrim(coalesce(replace_adventure_tracker.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say what went wrong with the tracker.';
  end if;
  select x.* into old_assignment from public.tracker_assignments x where x.id = replace_adventure_tracker.assignment_id;
  if not found then
    raise exception 'assignment % not found', replace_adventure_tracker.assignment_id using errcode = 'P0002';
  end if;
  perform 1 from public.adventure_bookings b where b.id = old_assignment.booking_id for update;
  perform private.lock_tracker_pool();
  select x.* into old_assignment from public.tracker_assignments x where x.id = old_assignment.id for update;
  if old_assignment.returned_at is not null then
    raise exception using errcode = 'P0001', message = 'tracker_already_returned',
      detail = 'This tracker was already returned.';
  end if;
  select r.* into hire from public.tracker_reservations r where r.id = old_assignment.reservation_id for update;
  update public.tracker_assignments x
  set returned_at = pg_catalog.now(), received_by = actor, return_condition = 'faulty',
      return_note = pg_catalog.left(clean, 500)
  where x.id = old_assignment.id;
  update public.tracking_devices d set service_state = 'maintenance', note = pg_catalog.left(clean, 500)
  where d.id = old_assignment.device_id;
  result := private.open_assignment_for(hire, replace_adventure_tracker.device_id, actor, clean);
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (hire.booking_id, 'tracker_replaced', actor, pg_catalog.jsonb_build_object(
    'device', (select d.label from public.tracking_devices d where d.id = result.device_id), 'note', clean));
  return result;
end;
$$;

-- The physical return: receiver, time and condition. Good keeps the device
-- in service; needs service or faulty sends it to maintenance; lost marks it
-- lost. Late returns and losses are settled with the rider by staff (D185).
create function public.return_adventure_tracker(assignment_id uuid, condition public.tracker_return_condition, note text)
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
  late boolean;
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
  late := private.shop_today() > hire.return_on;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (hire.booking_id, 'tracker_returned', actor, pg_catalog.jsonb_build_object(
    'device', (select d.label from public.tracking_devices d where d.id = a.device_id),
    'status', return_adventure_tracker.condition,
    'note', case when late then 'Returned after its return day: settle with the rider' end));
  return result;
end;
$$;

-- An admin cancels a hire nobody has collected (the rider rides with their
-- own device, or staff refund it in Stripe): the tracker is free again.
create function public.cancel_tracker_hire(reservation_id uuid, reason text)
returns public.tracker_reservations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  hire public.tracker_reservations;
  clean text := nullif(pg_catalog.btrim(coalesce(cancel_tracker_hire.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the hire is cancelled.';
  end if;
  perform 1 from public.adventure_bookings b
  join public.tracker_reservations r on r.booking_id = b.id
  where r.id = cancel_tracker_hire.reservation_id
  for update of b;
  perform private.lock_tracker_pool();
  select r.* into hire from public.tracker_reservations r where r.id = cancel_tracker_hire.reservation_id for update;
  if not found then
    raise exception 'reservation % not found', cancel_tracker_hire.reservation_id using errcode = 'P0002';
  end if;
  if hire.status not in ('held', 'confirmed')
     or exists (select 1 from public.tracker_assignments x where x.reservation_id = hire.id and x.returned_at is null) then
    raise exception using errcode = 'P0001', message = 'tracker_hire_not_cancellable',
      detail = 'This hire is finished, or its tracker is still out.';
  end if;
  update public.tracker_reservations r
  set status = 'cancelled', hold_until = null, cancel_reason = pg_catalog.left(clean, 500)
  where r.id = hire.id
  returning r.* into hire;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (hire.booking_id, 'tracker_hire_cancelled', actor, pg_catalog.jsonb_build_object('note', clean));
  return hire;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public and rider reads
-- ---------------------------------------------------------------------------
-- Whether hire is on, its longest hire, and whether a tracker is free on
-- every day of [collect_on, return_on). A hint: checkout decides again.
create function public.adventure_tracker_hire_state(collect_on date default null, return_on date default null)
returns table (enabled boolean, max_days integer, available boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.tracker_hire_enabled, s.tracker_hire_max_days,
         case when adventure_tracker_hire_state.collect_on is null or adventure_tracker_hire_state.return_on is null
                   or adventure_tracker_hire_state.return_on <= adventure_tracker_hire_state.collect_on
                   or adventure_tracker_hire_state.return_on - adventure_tracker_hire_state.collect_on > s.tracker_hire_max_days
              then null
              else s.tracker_hire_enabled
                   and private.trackers_free(adventure_tracker_hire_state.collect_on, adventure_tracker_hire_state.return_on) > 0
         end
  from public.adventure_settings s where s.id = 1;
$$;

-- The rider's hire on their own booking: dates, state, the tracker they hold.
create function public.my_adventure_tracker(booking_id uuid)
returns table (
  collect_on date, return_on date, days integer, status public.tracker_reservation_status,
  device_label text, issued_at timestamptz, returned_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.collect_on, r.return_on, r.days, r.status, d.label, x.issued_at, x.returned_at
  from public.tracker_reservations r
  join public.adventure_bookings b on b.id = r.booking_id
  left join lateral (
    select y.* from public.tracker_assignments y where y.reservation_id = r.id order by y.issued_at desc limit 1
  ) x on true
  left join public.tracking_devices d on d.id = x.device_id
  where r.booking_id = my_adventure_tracker.booking_id
    and b.customer_id = private.require_customer();
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer, text,
    public.adventure_finisher_name, text, public.adventure_recording_method, date, date),
  public.set_adventure_tracker_hire(boolean, integer),
  public.register_tracking_device(text, public.tracking_provider, text, text),
  public.set_tracking_device_state(uuid, public.tracker_service_state, text),
  public.issue_adventure_tracker(uuid, uuid, text),
  public.replace_adventure_tracker(uuid, uuid, text),
  public.return_adventure_tracker(uuid, public.tracker_return_condition, text),
  public.cancel_tracker_hire(uuid, text),
  public.adventure_tracker_hire_state(date, date),
  public.my_adventure_tracker(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer, text,
    public.adventure_finisher_name, text, public.adventure_recording_method, date, date),
  public.set_adventure_tracker_hire(boolean, integer),
  public.register_tracking_device(text, public.tracking_provider, text, text),
  public.set_tracking_device_state(uuid, public.tracker_service_state, text),
  public.issue_adventure_tracker(uuid, uuid, text),
  public.replace_adventure_tracker(uuid, uuid, text),
  public.return_adventure_tracker(uuid, public.tracker_return_condition, text),
  public.cancel_tracker_hire(uuid, text),
  public.my_adventure_tracker(uuid)
to authenticated;
grant execute on function public.adventure_tracker_hire_state(date, date) to anon, authenticated;
