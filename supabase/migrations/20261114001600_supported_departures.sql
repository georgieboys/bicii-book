-- Adventures Phase E, supported departures (D196-D199; DATA-MODEL §20
-- "Departures"; handoff §6.5).
--
--   * A supported ride is bought for one supported departure: the seat and
--     the included tracker are held together while the payment page is open
--     (lock order: booking, departure, tracker pool, device) and confirmed
--     when paid; an expired checkout releases both. The price is the
--     supported offer's, all-inclusive; declining the tracker earns no
--     discount (handoff §6.5).
--   * Supported sales have their own switch (`supported_sales_enabled`,
--     admin), off until the owner confirms insurance, the staffing ratio,
--     the emergency procedure and overrun terms (the plan's release gate).
--   * Staff are assigned to a departure as lead or facilitator. With
--     facilitate_adventures, an assigned facilitator checks riders in and
--     records observations (attendance, deviation, withdrawal, completion,
--     a note); manage_adventures may do so on any departure. Observations
--     are kept as written and help the reviewer: a departure's finish never
--     certifies anyone.
--   * A supported seat is paid for: the rider cannot leave it online.

alter table public.adventure_settings
  add column supported_sales_enabled boolean not null default false;

alter table public.adventure_departure_participants
  add column hold_until timestamptz null,
  add column checked_in_at timestamptz null,
  add column checked_in_by uuid null references public.staff (id) on delete restrict,
  add constraint adventure_departure_participants_check_in check ((checked_in_at is null) = (checked_in_by is null));

-- Places taken: open participations, a held seat only while its hold runs.
create or replace function private.departure_taken(departure uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select pg_catalog.count(*)::integer from public.adventure_departure_participants p
  where p.departure_id = departure_taken.departure and p.left_at is null
    and (p.hold_until is null or p.hold_until > pg_catalog.now());
$$;

create function private.departure_taken(departure uuid, except_participant uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select pg_catalog.count(*)::integer from public.adventure_departure_participants p
  where p.departure_id = departure_taken.departure and p.left_at is null
    and p.id is distinct from departure_taken.except_participant
    and (p.hold_until is null or p.hold_until > pg_catalog.now());
$$;
revoke all on function private.departure_taken(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Staff on a departure, and what they record
-- ---------------------------------------------------------------------------
create type public.departure_staff_role as enum ('lead', 'facilitator');
create type public.departure_observation_kind as enum ('attendance', 'deviation', 'withdrawal', 'completion', 'note');

create table public.adventure_departure_staff (
  departure_id uuid not null references public.adventure_departures (id) on delete restrict,
  staff_id uuid not null references public.staff (id) on delete restrict,
  role public.departure_staff_role not null default 'facilitator',
  assigned_at timestamptz not null default pg_catalog.now(),
  assigned_by uuid null references public.staff (id) on delete restrict,
  primary key (departure_id, staff_id)
);

create table public.adventure_departure_observations (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.adventure_departures (id) on delete restrict,
  booking_id uuid null references public.adventure_bookings (id) on delete restrict,
  staff_id uuid not null references public.staff (id) on delete restrict,
  kind public.departure_observation_kind not null,
  body text not null check (pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 2000),
  created_at timestamptz not null default pg_catalog.now()
);
create index adventure_departure_observations_departure on public.adventure_departure_observations (departure_id, created_at);

create function private.departure_observations_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'departure_observation_immutable',
    detail = 'Observations are kept as written. Add another to correct one.';
end;
$$;
revoke all on function private.departure_observations_append_only() from public, anon, authenticated, service_role;
create trigger adventure_departure_observations_append_only
  before update or delete on public.adventure_departure_observations
  for each row execute function private.departure_observations_append_only();

alter table public.adventure_departure_staff enable row level security;
alter table public.adventure_departure_observations enable row level security;
revoke all on table public.adventure_departure_staff, public.adventure_departure_observations
  from public, anon, authenticated, service_role;
grant select on table public.adventure_departure_staff, public.adventure_departure_observations to authenticated;
create policy adventure_departure_staff_select_staff on public.adventure_departure_staff
  for select to authenticated using ((select private.is_staff()));
create policy adventure_departure_observations_select_staff on public.adventure_departure_observations
  for select to authenticated using ((select private.is_staff()));

-- Whether this staff member may act on a departure's riders: manage
-- adventures, or facilitate adventures and be assigned to it.
create function private.can_facilitate(departure uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission('manage_adventures')
      or (private.has_permission('facilitate_adventures') and exists (
            select 1 from public.adventure_departure_staff s
            where s.departure_id = can_facilitate.departure and s.staff_id = private.current_staff_id()));
$$;
revoke all on function private.can_facilitate(uuid) from public, anon, authenticated, service_role;

create function public.assign_departure_staff(departure_id uuid, staff_id uuid, role public.departure_staff_role)
returns public.adventure_departure_staff
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  result public.adventure_departure_staff;
begin
  if not exists (select 1 from public.staff s where s.id = assign_departure_staff.staff_id and s.active) then
    raise exception using errcode = 'P0001', message = 'departure_staff_invalid', detail = 'Choose an active staff member.';
  end if;
  insert into public.adventure_departure_staff (departure_id, staff_id, role, assigned_by)
  values (assign_departure_staff.departure_id, assign_departure_staff.staff_id,
          coalesce(assign_departure_staff.role, 'facilitator'), actor)
  on conflict on constraint adventure_departure_staff_pkey
  do update set role = excluded.role, assigned_by = excluded.assigned_by, assigned_at = pg_catalog.now()
  returning * into result;
  return result;
end;
$$;

create function public.remove_departure_staff(departure_id uuid, staff_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('manage_adventures');
  delete from public.adventure_departure_staff s
  where s.departure_id = remove_departure_staff.departure_id and s.staff_id = remove_departure_staff.staff_id;
end;
$$;

create function public.check_in_departure_rider(departure_id uuid, booking_id uuid)
returns public.adventure_departure_participants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_staff_id();
  result public.adventure_departure_participants;
begin
  if actor is null or not private.can_facilitate(check_in_departure_rider.departure_id) then
    raise exception 'facilitate_adventures on this departure required' using errcode = '42501';
  end if;
  update public.adventure_departure_participants p
  set checked_in_at = coalesce(p.checked_in_at, pg_catalog.now()), checked_in_by = coalesce(p.checked_in_by, actor)
  where p.departure_id = check_in_departure_rider.departure_id and p.booking_id = check_in_departure_rider.booking_id
    and p.left_at is null and p.hold_until is null
  returning * into result;
  if not found then
    raise exception using errcode = 'P0001', message = 'departure_rider_unknown',
      detail = 'That rider is not on this departure.';
  end if;
  insert into public.adventure_departure_observations (departure_id, booking_id, staff_id, kind, body)
  values (check_in_departure_rider.departure_id, check_in_departure_rider.booking_id, actor, 'attendance', 'Checked in');
  return result;
end;
$$;

create function public.record_departure_observation(departure_id uuid, booking_id uuid,
                                                    kind public.departure_observation_kind, body text)
returns public.adventure_departure_observations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_staff_id();
  result public.adventure_departure_observations;
begin
  if actor is null or not private.can_facilitate(record_departure_observation.departure_id) then
    raise exception 'facilitate_adventures on this departure required' using errcode = '42501';
  end if;
  if nullif(pg_catalog.btrim(coalesce(record_departure_observation.body, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Write what you saw.';
  end if;
  if record_departure_observation.booking_id is not null and not exists (
    select 1 from public.adventure_departure_participants p
    where p.departure_id = record_departure_observation.departure_id
      and p.booking_id = record_departure_observation.booking_id
  ) then
    raise exception using errcode = 'P0001', message = 'departure_rider_unknown',
      detail = 'That rider is not on this departure.';
  end if;
  insert into public.adventure_departure_observations (departure_id, booking_id, staff_id, kind, body)
  values (record_departure_observation.departure_id, record_departure_observation.booking_id, actor,
          record_departure_observation.kind, pg_catalog.left(pg_catalog.btrim(record_departure_observation.body), 2000))
  returning * into result;
  return result;
end;
$$;

-- A paid supported seat cannot be left online (D198).
create or replace function public.leave_adventure_departure(booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  left_from uuid;
begin
  select x.* into b from public.adventure_bookings x
  where x.id = leave_adventure_departure.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if b.kind = 'supported' then
    raise exception using errcode = 'P0001', message = 'departure_supported_seat',
      detail = 'A supported ride''s place can''t be changed online. Message us.';
  end if;
  update public.adventure_departure_participants x
  set left_at = pg_catalog.now(), left_reason = 'Left by the rider'
  where x.booking_id = b.id and x.left_at is null
  returning x.departure_id into left_from;
  if left_from is not null then
    insert into public.adventure_booking_events (booking_id, kind, detail)
    values (b.id, 'departure_left', pg_catalog.jsonb_build_object('departure_id', left_from));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The booking's fate moves its seat (the hire trigger moves its tracker).
-- ---------------------------------------------------------------------------
create function private.adventure_bookings_move_seat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seat public.adventure_departure_participants;
  dep public.adventure_departures;
begin
  if new.status is not distinct from old.status or new.kind <> 'supported' then
    return null;
  end if;
  select p.* into seat from public.adventure_departure_participants p
  where p.booking_id = new.id and p.left_at is null for update;
  if not found then
    return null;
  end if;
  if new.status = 'confirmed' then
    select d.* into dep from public.adventure_departures d where d.id = seat.departure_id for update;
    update public.adventure_departure_participants p set hold_until = null where p.id = seat.id;
    if seat.hold_until < pg_catalog.now() and private.departure_taken(dep.id, seat.id) >= dep.capacity then
      perform private.flag_adventure_booking(
        new.id, 'Paid after its seat hold lapsed, and the date is now full', null, null);
    end if;
    insert into public.adventure_booking_events (booking_id, kind, detail)
    values (new.id, 'departure_joined', pg_catalog.jsonb_build_object('departure_id', seat.departure_id));
  elsif new.status in ('expired', 'cancelled') then
    update public.adventure_departure_participants p
    set left_at = pg_catalog.now(), hold_until = null,
        left_reason = case when new.status = 'expired' then 'Checkout expired' else 'Booking cancelled' end
    where p.id = seat.id;
  end if;
  return null;
end;
$$;
revoke all on function private.adventure_bookings_move_seat() from public, anon, authenticated, service_role;
create trigger adventure_bookings_move_seat
  after update of status on public.adventure_bookings
  for each row execute function private.adventure_bookings_move_seat();

create function public.set_adventure_supported_sales(enabled boolean)
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
  update public.adventure_settings s
  set supported_sales_enabled = coalesce(set_adventure_supported_sales.enabled, false), updated_by = actor
  where s.id = 1
  returning s.* into result;
  return result;
end;
$$;

create function public.adventure_supported_sales_state()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select s.supported_sales_enabled and s.sales_enabled from public.adventure_settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Checkout, now with supported departures (the extra argument has a
-- default, so earlier calls are unchanged).
-- ---------------------------------------------------------------------------
drop function public.prepare_my_adventure_checkout(
  uuid, text, public.adventure_participation, integer, text, public.adventure_finisher_name, text,
  public.adventure_recording_method, date, date
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
  hire_return_on date default null,
  departure_id uuid default null
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
  dep public.adventure_departures;
  seat public.adventure_departure_participants;
  collect_day date;
  return_day date;
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
         prepare_my_adventure_checkout.hire_collect_on, prepare_my_adventure_checkout.hire_return_on) else '' end
    || coalesce('|departure|' || prepare_my_adventure_checkout.departure_id::text, ''));

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
    -- Self-supported (Phase B) and supported departures (Phase E, D196);
    -- a peer group is joined with the self-supported ticket (D193).
    if not found or offer.kind = 'self_supported_group' then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_offer_unavailable',
        detail = 'That way to ride is not on sale for this adventure.';
    end if;
    if offer.kind = 'supported' then
      if not settings.supported_sales_enabled then
        raise exception using
          errcode = 'P0001',
          message = 'adventure_supported_closed',
          detail = 'Supported rides are not on sale yet.';
      end if;
      select d.* into dep from public.adventure_departures d
      where d.id = prepare_my_adventure_checkout.departure_id
        and d.adventure_id = adv.id and d.kind = 'supported' and d.status = 'scheduled'
        and d.starts_at > pg_catalog.now();
      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'departure_unavailable',
          detail = 'Choose one of the supported dates on sale.';
      end if;
      -- The included tracker goes out on the departure's day and comes back
      -- the day after it ends (D197).
      method := 'tracker_hire';
      collect_day := (dep.starts_at at time zone private.shop_timezone())::date;
      return_day := (coalesce(dep.expected_finish_at,
                              dep.starts_at + pg_catalog.make_interval(days => greatest(coalesce(offer.supported_days, 1), 1)))
                     at time zone private.shop_timezone())::date + 1;
    elsif prepare_my_adventure_checkout.departure_id is not null then
      raise exception 'departure without a supported ride' using errcode = '22023';
    end if;
    if method = 'tracker_hire' and offer.kind <> 'supported' then
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
      offer.price + case when method = 'tracker_hire' and offer.kind <> 'supported'
                         then offer.tracker_hire_price * hire_days else 0 end,
      prepare_my_adventure_checkout.request_id, fingerprint
    )
    on conflict (request_id) do nothing
    returning b.* into booking;
    inserted := found;
    if inserted then
      insert into public.adventure_booking_lines (booking_id, position, kind, description, quantity, unit_price)
      values (booking.id, 1, 'certification',
              case when offer.kind = 'supported'
                   then pg_catalog.format('%s supported ride, %s', rev.name,
                          pg_catalog.to_char(dep.starts_at at time zone private.shop_timezone(), 'FMDD Mon YYYY'))
                   else rev.name || ' certification' end,
              1, offer.price);
      if offer.kind = 'supported' then
        insert into public.adventure_departure_participants (departure_id, booking_id, show_name, hold_until)
        values (dep.id, booking.id, false, pg_catalog.now());
        insert into public.tracker_reservations (booking_id, collect_on, return_on, hold_until)
        values (booking.id, collect_day, return_day, pg_catalog.now());
      elsif method = 'tracker_hire' then
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

  -- A supported seat is held until the payment page expires, if the date
  -- has a place (lock order: booking, departure, pool).
  select p.* into seat from public.adventure_departure_participants p
  where p.booking_id = booking.id and p.left_at is null;
  if found then
    select d.* into dep from public.adventure_departures d where d.id = seat.departure_id for update;
    if dep.status <> 'scheduled' or dep.starts_at <= pg_catalog.now() then
      raise exception using
        errcode = 'P0001',
        message = 'departure_unavailable',
        detail = 'That date is no longer open.';
    end if;
    if private.departure_taken(dep.id, seat.id) >= dep.capacity then
      raise exception using
        errcode = 'P0001',
        message = 'departure_full',
        detail = 'That date is full. Choose another.';
    end if;
    update public.adventure_departure_participants p
    set hold_until = payment.stripe_session_expires_at
    where p.id = seat.id;
  end if;

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
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer, text,
    public.adventure_finisher_name, text, public.adventure_recording_method, date, date, uuid),
  public.assign_departure_staff(uuid, uuid, public.departure_staff_role),
  public.remove_departure_staff(uuid, uuid),
  public.check_in_departure_rider(uuid, uuid),
  public.record_departure_observation(uuid, uuid, public.departure_observation_kind, text),
  public.set_adventure_supported_sales(boolean),
  public.adventure_supported_sales_state()
from public, anon, authenticated, service_role;
grant execute on function
  public.prepare_my_adventure_checkout(uuid, text, public.adventure_participation, integer, text,
    public.adventure_finisher_name, text, public.adventure_recording_method, date, date, uuid),
  public.assign_departure_staff(uuid, uuid, public.departure_staff_role),
  public.remove_departure_staff(uuid, uuid),
  public.check_in_departure_rider(uuid, uuid),
  public.record_departure_observation(uuid, uuid, public.departure_observation_kind, text),
  public.set_adventure_supported_sales(boolean)
to authenticated;
grant execute on function public.adventure_supported_sales_state() to anon, authenticated;
