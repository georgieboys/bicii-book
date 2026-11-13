-- Adventures Phase F, hardening (D200-D203; DATA-MODEL §20 "Cancelling,
-- moving and retention"; handoff §6.6, §15).
--
--   * A rider asks to cancel (with a reason): staff are emailed; nothing is
--     refunded or cancelled by the request (D200).
--   * An admin cancels a booking with a reason: its seat and tracker hire
--     are released by the existing triggers and the rider is emailed. A
--     certified booking, or one whose tracker is still out, cannot be
--     cancelled. Money is refunded by hand in Stripe, as today (D201).
--   * Staff with manage_adventures move a rider's seat to another date of
--     the same route and kind, within its places; a supported seat's
--     tracker dates move with it, within the fleet (D202).
--   * Tracker messages that belong to no ride are deleted after 30 days by
--     the adventure-work cron; ride-attributed points are kept with the ride
--     (D203).
--   * adventure_health(): the counts an admin needs to see that the
--     adventure machinery is working.

-- ---------------------------------------------------------------------------
-- Emails for the new events (the full mapping, replacing Phase D's).
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

-- The email type carries the event's note (a reason) for these emails.
alter type public.adventure_notice add attribute event_note text;

create or replace function public.claim_adventure_notices(max_count integer default 5)
returns setof public.adventure_notice
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer := greatest(1, least(coalesce(claim_adventure_notices.max_count, 5), 20));
begin
  update private.adventure_notices q
  set status = 'failed',
      last_error = coalesce(q.last_error, 'No result was recorded after 15 claims.')
  where q.status = 'pending' and q.claims >= 15 and q.claimed_until < pg_catalog.now();

  return query
    with due as (
      select q.id
      from private.adventure_notices q
      where q.status = 'pending'
        and q.claims < 15
        and q.next_attempt_at <= pg_catalog.now()
        and (q.claimed_until is null or q.claimed_until < pg_catalog.now())
      order by q.next_attempt_at, q.created_at
      limit n
      for update skip locked
    ),
    claimed as (
      update private.adventure_notices q
      set claims = q.claims + 1,
          claim_token = gen_random_uuid(),
          claimed_until = pg_catalog.now() + interval '5 minutes'
      from due
      where q.id = due.id
      returning q.*
    )
    select c.id, c.claim_token, c.kind, c.audience, c.recipient::text, c.attempts,
           b.id, b.reference, r.name, a.slug::text,
           private.customer_label(cu.first_name, cu.last_name, cu.display_name, cu.email::text, cu.phone),
           cu.first_name,
           (select v.message_to_rider
              from public.adventure_reviews v
              join public.adventure_submissions s on s.id = v.submission_id
              join public.adventure_attempts t on t.id = s.attempt_id
             where t.booking_id = b.id
             order by v.decided_at desc limit 1),
           cert.reference, cert.completed_on, cert.accepted_distance_km::numeric,
           (select f.items from public.adventure_fulfilments f where f.booking_id = b.id limit 1),
           b.attention_reason,
           s.public_site_url,
           dep.starts_at, dep.meeting_point,
           ev.detail ->> 'note'
    from claimed c
    join public.adventure_bookings b on b.id = c.booking_id
    join public.adventures a on a.id = b.adventure_id
    join public.adventure_revisions r on r.id = b.revision_id
    join public.customers cu on cu.id = b.customer_id
    join public.adventure_booking_events ev on ev.id = c.event_id
    left join public.adventure_departures dep on dep.id = (ev.detail ->> 'departure_id')::uuid
    left join public.adventure_certificates cert on cert.booking_id = b.id and cert.status = 'active'
    cross join public.shop_settings s
    where s.id = 1
    order by c.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Asking to cancel (the rider) and cancelling (an admin)
-- ---------------------------------------------------------------------------
create function public.request_my_adventure_cancellation(booking_id uuid, reason text)
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
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Tell us why you want to cancel.';
  end if;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'cancellation_requested', pg_catalog.jsonb_build_object('note', pg_catalog.left(clean, 500)));
end;
$$;

create function public.cancel_adventure_booking(booking_id uuid, reason text)
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
  -- A group date it joined is left too (a supported seat goes with the
  -- booking's status trigger).
  update public.adventure_departure_participants p
  set left_at = pg_catalog.now(), left_reason = 'Booking cancelled'
  where p.booking_id = b.id and p.left_at is null;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (b.id, 'booking_cancelled', actor, pg_catalog.jsonb_build_object('note', pg_catalog.left(clean, 500)));
  return b;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moving a seat to another date (manage_adventures)
-- ---------------------------------------------------------------------------
create function public.move_adventure_seat(booking_id uuid, departure_id uuid, reason text)
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
      collect_day := (to_dep.starts_at at time zone private.shop_timezone())::date;
      return_day := (coalesce(to_dep.expected_finish_at, to_dep.starts_at + interval '1 day')
                     at time zone private.shop_timezone())::date + 1;
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

-- ---------------------------------------------------------------------------
-- Retention (D203) and health
-- ---------------------------------------------------------------------------
-- Tracker messages that belong to no ride, older than 30 days. Returns how
-- many went. Ride-attributed points stay with the ride.
create function public.purge_unattributed_tracking(max_rows integer)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.tracking_messages m
    where m.id in (
      select x.id from public.tracking_messages x
      where x.attempt_id is null and x.received_at < pg_catalog.now() - interval '30 days'
      order by x.received_at
      limit greatest(1, least(coalesce(purge_unattributed_tracking.max_rows, 1000), 5000))
    )
    returning 1
  )
  select pg_catalog.count(*)::integer from gone;
$$;

-- What an admin needs to see that adventures are working (admin only).
create function public.adventure_health()
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
    'emails_pending', (select pg_catalog.count(*) from private.adventure_notices q where q.status = 'pending'),
    'emails_failed', (select pg_catalog.count(*) from private.adventure_notices q where q.status = 'failed'),
    'emails_oldest_pending', (select pg_catalog.min(q.created_at) from private.adventure_notices q where q.status = 'pending'),
    'files_waiting', (select pg_catalog.count(*) from public.adventure_evidence_files f where f.state in ('uploaded', 'parsing')),
    'files_failed_7d', (select pg_catalog.count(*) from public.adventure_evidence_files f
                         where f.state = 'failed' and f.updated_at > pg_catalog.now() - interval '7 days'),
    'reviews_waiting', (select pg_catalog.count(*) from public.adventure_submissions s where s.state in ('submitted', 'in_review')),
    'reviews_oldest', (select pg_catalog.min(s.submitted_at) from public.adventure_submissions s where s.state in ('submitted', 'in_review')),
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

revoke all on function
  public.request_my_adventure_cancellation(uuid, text),
  public.cancel_adventure_booking(uuid, text),
  public.move_adventure_seat(uuid, uuid, text),
  public.purge_unattributed_tracking(integer),
  public.adventure_health()
from public, anon, authenticated, service_role;
grant execute on function
  public.request_my_adventure_cancellation(uuid, text),
  public.cancel_adventure_booking(uuid, text),
  public.move_adventure_seat(uuid, uuid, text),
  public.adventure_health()
to authenticated;
grant execute on function public.purge_unattributed_tracking(integer) to service_role;
