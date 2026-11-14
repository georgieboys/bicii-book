-- Fixes from the 2026-11-14 audit, the high findings (D220-D222):
--
--   * A cancelled booking can never be certified: claiming or deciding a
--     review needs the booking to be paid and not cancelled; the review queue
--     counts (Health) and the public board only see paid bookings.
--   * D220: unpaid checkouts are capped per customer: a new checkout for a
--     route replaces the customer's older open one there (it expires and its
--     holds go), and at most three are open across routes, so nobody can hold
--     a date's seats or the tracker pool without paying.
--   * D221: a supported date's included tracker follows the date. One helper
--     computes the hire days (the checkout's formula); moving a seat uses it,
--     and changing a supported date's times re-dates every rider's hire
--     within the fleet, refuses a start in the past, and emails the riders.
--   * The tracker feed's watermark moves to the top of a window it paged
--     back through, so a backlog never stalls it; Health counts feeds more
--     than an hour behind.
--   * Health counts only ride recordings as files waiting to be read
--     (photos are never read, so they no longer count for ever).

-- ---------------------------------------------------------------------------
-- A cancelled booking cannot be reviewed
-- ---------------------------------------------------------------------------
create or replace function private.lock_adventure_review(submission_id uuid, actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.adventure_submissions;
  b public.adventure_bookings;
begin
  select x.* into s from public.adventure_submissions x where x.id = lock_adventure_review.submission_id;
  if not found then
    raise exception 'submission % not found', lock_adventure_review.submission_id using errcode = 'P0002';
  end if;
  select bk.* into b
  from public.adventure_attempts t join public.adventure_bookings bk on bk.id = t.booking_id
  where t.id = s.attempt_id;
  perform 1 from public.adventure_bookings bk where bk.id = b.id for update;
  select bk.* into b from public.adventure_bookings bk where bk.id = b.id;
  select x.* into s from public.adventure_submissions x where x.id = s.id for update;
  if b.status <> 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'review_booking_cancelled',
      detail = 'This booking is cancelled, so its ride cannot be reviewed.';
  end if;
  -- E08: nobody reviews their own ride.
  if exists (
    select 1 from public.customers c join public.staff st on st.auth_user_id = c.auth_user_id
    where c.id = b.customer_id and st.id = lock_adventure_review.actor
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'review_not_permitted',
      detail = 'Someone else must review your own ride.';
  end if;
  return b.id;
end;
$$;
revoke all on function private.lock_adventure_review(uuid, uuid) from public, anon, authenticated, service_role;

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
    and b.status = 'confirmed'
    and b.finisher_name = 'preferred_name' and b.board_name is not null
    and a.status = 'published'
    and a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(public_adventure_finishers.adventure_slug, '')))::extensions.citext
  order by cert.completed_on desc, cert.issued_at desc, cert.id
  limit greatest(1, least(coalesce(public_adventure_finishers.max_rows, 50), 200));
$$;

create or replace function public.adventure_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return pg_catalog.jsonb_build_object(
    'feeds_failing', (select pg_catalog.count(*) from public.tracking_feeds f where f.enabled and f.last_error is not null),
    'feeds_enabled', (select pg_catalog.count(*) from public.tracking_feeds f where f.enabled),
    'feed_last_read', (select pg_catalog.max(f.last_success_at) from public.tracking_feeds f where f.enabled),
    'feeds_behind', (select pg_catalog.count(*) from public.tracking_feeds f
                      where f.enabled and f.watermark_at < pg_catalog.now() - interval '1 hour'),
    'emails_pending', (select pg_catalog.count(*) from private.adventure_notices q where q.status = 'pending'),
    'emails_failed', (select pg_catalog.count(*) from private.adventure_notices q where q.status = 'failed'),
    'emails_oldest_pending', (select pg_catalog.min(q.created_at) from private.adventure_notices q where q.status = 'pending'),
    'files_waiting', (select pg_catalog.count(*) from public.adventure_evidence_files f
                       where f.kind = 'activity' and f.state in ('uploaded', 'parsing')),
    'files_failed_7d', (select pg_catalog.count(*) from public.adventure_evidence_files f
                         where f.kind = 'activity' and f.state = 'failed' and f.updated_at > pg_catalog.now() - interval '7 days'),
    'reviews_waiting', (select pg_catalog.count(*) from public.adventure_submissions s
                         join public.adventure_attempts t on t.id = s.attempt_id
                         join public.adventure_bookings b on b.id = t.booking_id
                         where s.state in ('submitted', 'in_review') and b.status = 'confirmed'),
    'reviews_oldest', (select pg_catalog.min(s.submitted_at) from public.adventure_submissions s
                        join public.adventure_attempts t on t.id = s.attempt_id
                        join public.adventure_bookings b on b.id = t.booking_id
                        where s.state in ('submitted', 'in_review') and b.status = 'confirmed'),
    'trackers_overdue', (select pg_catalog.count(*) from public.tracker_assignments x
                          join public.tracker_reservations r on r.id = x.reservation_id
                          where x.returned_at is null and r.return_on < private.shop_today()),
    'bookings_attention', (select pg_catalog.count(*) from public.adventure_bookings b where b.needs_attention),
    'cancellations_requested_30d', (select pg_catalog.count(*) from public.adventure_booking_events e
                                     where e.kind = 'cancellation_requested' and e.created_at > pg_catalog.now() - interval '30 days'
                                       and not exists (select 1 from public.adventure_bookings b
                                                       where b.id = e.booking_id and b.status = 'cancelled')),
    'unattributed_messages_old', (select pg_catalog.count(*) from public.tracking_messages m
                                   where m.attempt_id is null and m.received_at < pg_catalog.now() - interval '30 days')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- D220: unpaid checkouts are capped per customer
-- ---------------------------------------------------------------------------
create or replace function private.adventure_bookings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sig public.adventure_waiver_signatures;
  window_minutes integer;
  older record;
  open_all integer;
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
  -- D220: unpaid checkouts are capped per customer, so nobody can hold a
  -- route's seats or trackers without paying. A new checkout for a route
  -- replaces the customer's older open one there: that booking expires and
  -- its seat and tracker holds go. Its payment changes only through Stripe
  -- (D172), so paying the old page later is kept and flagged, as any payment
  -- after expiry. At most three open across routes. Retries of the same
  -- request never count (they reuse the first booking and never insert).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('adventure-checkout:' || new.customer_id::text));
  select s.checkout_minutes into window_minutes from public.adventure_settings s where s.id = 1;
  for older in
    select x.id from public.adventure_bookings x
    where x.customer_id = new.customer_id and x.status = 'pending_payment'
      and x.adventure_id = new.adventure_id and x.request_id <> new.request_id
    order by x.id
    for update
  loop
    update public.adventure_bookings b
    set status = 'expired', expired_at = pg_catalog.clock_timestamp()
    where b.id = older.id;
    insert into public.adventure_booking_events (booking_id, kind, detail)
    values (older.id, 'expired', pg_catalog.jsonb_build_object('note', 'Replaced by a newer checkout'));
  end loop;
  select pg_catalog.count(*) into open_all
  from public.adventure_bookings x
  where x.customer_id = new.customer_id and x.status = 'pending_payment'
    and x.request_id <> new.request_id
    and x.created_at > pg_catalog.now() - pg_catalog.make_interval(mins => window_minutes);
  if open_all >= 3 then
    raise exception using errcode = 'P0001', message = 'adventure_too_many_open',
      detail = 'You have several payment pages open. Finish paying there, or try again later.';
  end if;
  -- The board name is set with set_my_board_name; until then, off the board.
  new.finisher_name := 'hidden';
  new.board_name := null;
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- D221: a supported date's tracker hire follows the date
-- ---------------------------------------------------------------------------
-- The included tracker goes out on the date's day and comes back the day
-- after it ends: its expected finish, or its start plus the offer's supported
-- days (the same formula prepare_my_adventure_checkout uses, D197).
create function private.supported_hire_days(
  starts_at timestamptz, expected_finish_at timestamptz, supported_days integer,
  out collect_on date, out return_on date
)
language sql
stable
set search_path = ''
as $$
  select (supported_hire_days.starts_at at time zone private.shop_timezone())::date,
         (coalesce(supported_hire_days.expected_finish_at,
                   supported_hire_days.starts_at
                     + pg_catalog.make_interval(days => greatest(coalesce(supported_hire_days.supported_days, 1), 1)))
          at time zone private.shop_timezone())::date + 1;
$$;
revoke all on function private.supported_hire_days(timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;

create or replace function public.move_adventure_seat(booking_id uuid, departure_id uuid, reason text)
returns public.adventure_departure_participants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  b public.adventure_bookings;
  seat public.adventure_departure_participants;
  from_dep public.adventure_departures;
  to_dep public.adventure_departures;
  hire public.tracker_reservations;
  collect_day date;
  return_day date;
  result public.adventure_departure_participants;
  clean text := nullif(pg_catalog.btrim(coalesce(move_adventure_seat.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the seat moves.';
  end if;
  select x.* into b from public.adventure_bookings x where x.id = move_adventure_seat.booking_id for update;
  if not found then
    raise exception 'booking % not found', move_adventure_seat.booking_id using errcode = 'P0002';
  end if;
  select p.* into seat from public.adventure_departure_participants p
  where p.booking_id = b.id and p.left_at is null and p.hold_until is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'departure_rider_unknown',
      detail = 'This rider is not on a date.';
  end if;
  -- Lock order: booking, then the departures (in id order), then the pool.
  perform 1 from public.adventure_departures d
  where d.id in (seat.departure_id, move_adventure_seat.departure_id) order by d.id for update;
  select d.* into from_dep from public.adventure_departures d where d.id = seat.departure_id;
  select d.* into to_dep from public.adventure_departures d where d.id = move_adventure_seat.departure_id;
  if not found or to_dep.id = from_dep.id or to_dep.adventure_id <> from_dep.adventure_id
     or to_dep.kind <> from_dep.kind or to_dep.status <> 'scheduled' or to_dep.starts_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'departure_unavailable',
      detail = 'Choose another upcoming date of the same route and kind.';
  end if;
  if private.departure_taken(to_dep.id) >= to_dep.capacity then
    raise exception using errcode = 'P0001', message = 'departure_full', detail = 'That date is full.';
  end if;
  if to_dep.kind = 'supported' then
    select r.* into hire from public.tracker_reservations r
    where r.booking_id = b.id and r.status in ('held', 'confirmed') for update;
    if found then
      if exists (select 1 from public.tracker_assignments x where x.reservation_id = hire.id and x.returned_at is null) then
        raise exception using errcode = 'P0001', message = 'tracker_still_out',
          detail = 'The rider still has a tracker. Record its return first.';
      end if;
      perform private.lock_tracker_pool();
      select h.collect_on, h.return_on into collect_day, return_day
      from private.supported_hire_days(
        to_dep.starts_at, to_dep.expected_finish_at,
        (select o.supported_days from public.adventure_offers o where o.id = b.offer_id)) h;
      if private.trackers_free(collect_day, return_day, hire.id) < 1 then
        raise exception using errcode = 'P0001', message = 'adventure_trackers_unavailable',
          detail = 'No tracker is free for that date.';
      end if;
      update public.tracker_reservations r set collect_on = collect_day, return_on = return_day where r.id = hire.id;
    end if;
  end if;
  update public.adventure_departure_participants p
  set left_at = pg_catalog.now(), left_reason = 'Moved to another date'
  where p.id = seat.id;
  insert into public.adventure_departure_participants (departure_id, booking_id, show_name)
  values (to_dep.id, b.id, seat.show_name)
  returning * into result;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (b.id, 'seat_moved', actor, pg_catalog.jsonb_build_object('departure_id', to_dep.id, 'note', pg_catalog.left(clean, 500)));
  return result;
end;
$$;

revoke all on function public.move_adventure_seat(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.move_adventure_seat(uuid, uuid, text) to authenticated;

create or replace function public.update_adventure_departure(
  departure_id uuid, expected_version integer, starts_at timestamptz, expected_finish_at timestamptz,
  meeting_point text, capacity integer, note text, staff_note text
)
returns public.adventure_departures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  d public.adventure_departures;
  before_row public.adventure_departures;
  hire record;
  days record;
  supported integer;
  moved boolean;
begin
  -- Lock order: the riders' bookings (in id order), then the date, then the pool.
  perform 1 from public.adventure_bookings b
  where b.id in (select p.booking_id from public.adventure_departure_participants p
                 where p.departure_id = update_adventure_departure.departure_id and p.left_at is null)
  order by b.id
  for update;
  select x.* into d from public.adventure_departures x where x.id = update_adventure_departure.departure_id for update;
  if not found then
    raise exception 'departure % not found', update_adventure_departure.departure_id using errcode = 'P0002';
  end if;
  if d.version <> update_adventure_departure.expected_version then
    raise exception using errcode = 'P0001', message = 'departure_changed',
      detail = 'Someone changed this departure since you opened it. Reload and try again.';
  end if;
  if d.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'departure_not_scheduled',
      detail = 'This departure is cancelled or finished.';
  end if;
  if update_adventure_departure.capacity < private.departure_taken(d.id) then
    raise exception using errcode = 'P0001', message = 'departure_capacity_below_riders',
      detail = 'More riders have joined than that. Raise the places, or ask riders to leave first.';
  end if;
  moved := update_adventure_departure.starts_at is distinct from d.starts_at
           or update_adventure_departure.expected_finish_at is distinct from d.expected_finish_at;
  if moved and update_adventure_departure.starts_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'departure_in_past',
      detail = 'Choose a start in the future.';
  end if;
  before_row := d;
  update public.adventure_departures x
  set starts_at = update_adventure_departure.starts_at,
      expected_finish_at = update_adventure_departure.expected_finish_at,
      meeting_point = pg_catalog.btrim(update_adventure_departure.meeting_point),
      capacity = update_adventure_departure.capacity,
      note = pg_catalog.btrim(coalesce(update_adventure_departure.note, '')),
      staff_note = pg_catalog.btrim(coalesce(update_adventure_departure.staff_note, '')),
      version = x.version + 1
  where x.id = d.id
  returning x.* into d;

  -- A supported date's included trackers move with it, within the fleet.
  if moved and d.kind = 'supported' then
    perform private.lock_tracker_pool();
    for hire in
      select r.id, r.booking_id, o.supported_days
      from public.adventure_departure_participants p
      join public.adventure_bookings b on b.id = p.booking_id
      join public.adventure_offers o on o.id = b.offer_id
      join public.tracker_reservations r on r.booking_id = b.id and r.status in ('held', 'confirmed')
      where p.departure_id = d.id and p.left_at is null
      order by r.id
      for update of r
    loop
      if exists (select 1 from public.tracker_assignments x where x.reservation_id = hire.id and x.returned_at is null) then
        raise exception using errcode = 'P0001', message = 'tracker_still_out',
          detail = 'A rider on this date already has their tracker. Record its return before moving the date.';
      end if;
      select h.collect_on, h.return_on into days
      from private.supported_hire_days(d.starts_at, d.expected_finish_at, hire.supported_days) h;
      if private.trackers_free(days.collect_on, days.return_on, hire.id) < 1 then
        raise exception using errcode = 'P0001', message = 'adventure_trackers_unavailable',
          detail = 'Not enough trackers are free for the new days. Choose other days, or free a tracker first.';
      end if;
      update public.tracker_reservations r
      set collect_on = days.collect_on, return_on = days.return_on
      where r.id = hire.id;
    end loop;
  end if;

  -- Riders are told when the time or the meeting point changes.
  if moved or d.meeting_point is distinct from before_row.meeting_point then
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    select p.booking_id, 'departure_changed', actor, pg_catalog.jsonb_build_object('departure_id', d.id)
    from public.adventure_departure_participants p
    join public.adventure_bookings b on b.id = p.booking_id
    where p.departure_id = d.id and p.left_at is null and b.status = 'confirmed';
  end if;
  return d;
end;
$$;
revoke all on function public.update_adventure_departure(uuid, integer, timestamptz, timestamptz, text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_adventure_departure(uuid, integer, timestamptz, timestamptz, text, integer, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- A changed date emails its riders
-- ---------------------------------------------------------------------------
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
    when 'departure_changed' then 'departure_changed'
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
-- The tracker feed's watermark keeps advancing after a backlog
-- ---------------------------------------------------------------------------
-- The top of the window being paged back through; null when not paging.
alter table public.tracking_feeds add column window_top_at timestamptz null;

create or replace function public.store_tracking_messages(
  feed_id uuid, lease_token uuid, messages jsonb, complete boolean, window_to timestamptz, next_window_end timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.tracking_feeds;
  added integer;
begin
  select x.* into f from public.tracking_feeds x
  where x.id = store_tracking_messages.feed_id and x.lease_token = store_tracking_messages.lease_token
  for update;
  if not found then
    return -1;
  end if;
  if pg_catalog.jsonb_typeof(coalesce(store_tracking_messages.messages, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(store_tracking_messages.messages, '[]'::jsonb)) > 500 then
    raise exception 'messages must be an array of at most 500' using errcode = '22023';
  end if;

  with incoming as (
    select pg_catalog.btrim(m ->> 'providerMessageId') as message_id,
           pg_catalog.btrim(m ->> 'providerDeviceId') as device_ref,
           (m ->> 'recordedAt')::timestamptz as recorded_at,
           coalesce(nullif(m ->> 'kind', ''), 'other')::public.tracking_message_kind as kind,
           case when (m ->> 'latitude') is not null and (m ->> 'longitude') is not null
                     and (m ->> 'latitude')::numeric between -90 and 90
                     and (m ->> 'longitude')::numeric between -180 and 180
                then pg_catalog.round((m ->> 'latitude')::numeric, 6) end as lat,
           case when (m ->> 'latitude') is not null and (m ->> 'longitude') is not null
                     and (m ->> 'latitude')::numeric between -90 and 90
                     and (m ->> 'longitude')::numeric between -180 and 180
                then pg_catalog.round((m ->> 'longitude')::numeric, 6) end as lon
    from pg_catalog.jsonb_array_elements(coalesce(store_tracking_messages.messages, '[]'::jsonb)) m
  ),
  inserted as (
    insert into public.tracking_messages (provider, provider_message_id, provider_device_id, device_id, feed_id,
                                          recorded_at, kind, latitude, longitude, attempt_id)
    select f.provider, i.message_id, i.device_ref, d.id, f.id, i.recorded_at, i.kind, i.lat, i.lon,
           case when d.id is not null then private.tracking_attempt_for(d.id, i.recorded_at) end
    from incoming i
    left join public.tracking_devices d on d.provider = f.provider and d.provider_device_id = i.device_ref
    where i.message_id <> '' and i.device_ref <> '' and i.recorded_at is not null
    on conflict on constraint tracking_messages_once do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer into added from inserted;

  -- Paging back through a full window ends at its oldest part; the
  -- watermark then moves to the top of the whole window (window_top_at,
  -- kept from the first page), never to the end of the last part read.
  update public.tracking_feeds x
  set watermark_at = case when store_tracking_messages.complete
                          then greatest(x.watermark_at, coalesce(x.window_top_at, store_tracking_messages.window_to))
                          else x.watermark_at end,
      window_top_at = case when store_tracking_messages.complete then null
                           else coalesce(x.window_top_at, store_tracking_messages.window_to) end,
      window_end_at = case when store_tracking_messages.complete then null else store_tracking_messages.next_window_end end,
      last_success_at = pg_catalog.now(), last_error = null, failures = 0,
      lease_token = null, lease_until = null
  where x.id = f.id;
  return added;
end;
$$;

revoke all on function public.store_tracking_messages(uuid, uuid, jsonb, boolean, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.store_tracking_messages(uuid, uuid, jsonb, boolean, timestamptz, timestamptz)
  to service_role;
