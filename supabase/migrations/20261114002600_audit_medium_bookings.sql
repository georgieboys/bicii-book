-- Fixes from the 2026-11-14 audit, medium findings on bookings and money
-- (D223-D227):
--
--   * D223: cancelling a supported date releases each paid rider's tracker
--     hire, flags the booking ("move to another date or refund") and emails
--     the supported riders their own message; staff can move such a rider to
--     another date (a new hire is made); a payment that lands on a booking
--     whose supported date was cancelled is flagged.
--   * A payment on a cancelled booking is flagged as such (not "after the
--     checkout had expired"); the Admin also expires the Stripe page when it
--     cancels an unpaid booking.
--   * D224: a hired tracker stays out of the pool through the grace day.
--   * D225: a pending payment whose webhook never came is found: the
--     adventure-work cron reads stale sessions back from Stripe
--     (record_adventure_stripe_read), and a booking whose payment page was
--     never created expires; Health counts stale payments.
--   * D226: returning a tracker closes its ride window if the rider forgot
--     Finish Ride.
--   * D227: a decided ride's window can no longer be corrected, and the purge
--     keeps any position a device recorded while it was out with a rider.

-- ---------------------------------------------------------------------------
-- A payment on a cancelled booking says so
-- ---------------------------------------------------------------------------
create or replace function private.apply_adventure_stripe_session(ev public.stripe_events, obj jsonb)
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
          when booking.status = 'cancelled' then 'Paid after the booking was cancelled.'
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

-- ---------------------------------------------------------------------------
-- D223: cancelling a supported date
-- ---------------------------------------------------------------------------
create or replace function public.cancel_adventure_departure(departure_id uuid, reason text)
returns public.adventure_departures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  d public.adventure_departures;
  clean text := nullif(pg_catalog.btrim(coalesce(cancel_adventure_departure.reason, '')), '');
  p record;
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the departure is cancelled.';
  end if;
  -- Lock order: the riders' bookings, then the departure, then the pool.
  perform 1 from public.adventure_bookings b
  join public.adventure_departure_participants x on x.booking_id = b.id
  where x.departure_id = cancel_adventure_departure.departure_id and x.left_at is null
  order by b.id
  for update of b;
  select x.* into d from public.adventure_departures x where x.id = cancel_adventure_departure.departure_id for update;
  if not found then
    raise exception 'departure % not found', cancel_adventure_departure.departure_id using errcode = 'P0002';
  end if;
  if d.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'departure_not_scheduled',
      detail = 'This departure is cancelled or finished.';
  end if;
  if d.kind = 'supported' then
    if exists (
      select 1 from public.adventure_departure_participants x
      join public.tracker_reservations r on r.booking_id = x.booking_id
      join public.tracker_assignments t on t.reservation_id = r.id and t.returned_at is null
      where x.departure_id = d.id and x.left_at is null
    ) then
      raise exception using errcode = 'P0001', message = 'tracker_still_out',
        detail = 'A rider on this date already has their tracker. Record its return first.';
    end if;
    perform private.lock_tracker_pool();
  end if;
  for p in
    update public.adventure_departure_participants x
    set left_at = pg_catalog.now(), left_reason = 'Departure cancelled'
    where x.departure_id = d.id and x.left_at is null
    returning x.booking_id
  loop
    if d.kind = 'supported' then
      -- The included tracker is released; a paid rider is flagged for staff
      -- to move to another date or refund (D223).
      update public.tracker_reservations r
      set status = 'cancelled', hold_until = null, cancel_reason = 'Supported date cancelled'
      where r.booking_id = p.booking_id and r.status in ('held', 'confirmed');
      if exists (select 1 from public.adventure_bookings b where b.id = p.booking_id and b.status = 'confirmed') then
        perform private.flag_adventure_booking(
          p.booking_id, 'Supported date cancelled: move to another date or refund', null, null);
      end if;
    end if;
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (p.booking_id, 'departure_cancelled', actor,
            pg_catalog.jsonb_build_object('departure_id', d.id, 'note', clean, 'kind', d.kind));
  end loop;
  update public.adventure_departures x
  set status = 'cancelled', cancel_reason = pg_catalog.left(clean, 500), version = x.version + 1
  where x.id = d.id
  returning x.* into d;
  return d;
end;
$$;

-- A supported booking confirmed with no open seat (its date was cancelled
-- while the payment page was open) is flagged.
create or replace function private.adventure_bookings_move_seat()
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
    if new.status = 'confirmed' then
      perform private.flag_adventure_booking(
        new.id, 'Paid for a supported date that was cancelled: move to another date or refund', null, null);
    end if;
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
  if not found and b.status = 'confirmed' then
    -- D223: a paid rider whose date was cancelled moves from that date.
    select p.* into seat from public.adventure_departure_participants p
    join public.adventure_departures d on d.id = p.departure_id
    where p.booking_id = b.id and d.status = 'cancelled' and p.left_reason = 'Departure cancelled'
      and not exists (select 1 from public.adventure_departure_participants q
                      where q.booking_id = b.id and q.left_at is null)
    order by p.left_at desc
    limit 1;
  end if;
  if seat.id is null then
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
    else
      -- The hire was released with a cancelled date: it is made again for the new date.
      perform private.lock_tracker_pool();
      select h.collect_on, h.return_on into collect_day, return_day
      from private.supported_hire_days(
        to_dep.starts_at, to_dep.expected_finish_at,
        (select o.supported_days from public.adventure_offers o where o.id = b.offer_id)) h;
      if private.trackers_free(collect_day, return_day) < 1 then
        raise exception using errcode = 'P0001', message = 'adventure_trackers_unavailable',
          detail = 'No tracker is free for that date.';
      end if;
      -- One hire per booking: the released one is confirmed again for the new days.
      update public.tracker_reservations r
      set status = 'confirmed', hold_until = null, cancel_reason = null,
          collect_on = collect_day, return_on = return_day
      where r.booking_id = b.id and r.status = 'cancelled';
      if not found then
        insert into public.tracker_reservations (booking_id, collect_on, return_on, status)
        values (b.id, collect_day, return_day, 'confirmed');
      end if;
    end if;
  end if;
  update public.adventure_departure_participants p
  set left_at = pg_catalog.now(), left_reason = 'Moved to another date'
  where p.id = seat.id and p.left_at is null;
  insert into public.adventure_departure_participants (departure_id, booking_id, show_name)
  values (to_dep.id, b.id, seat.show_name)
  returning * into result;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (b.id, 'seat_moved', actor, pg_catalog.jsonb_build_object('departure_id', to_dep.id, 'note', pg_catalog.left(clean, 500)));
  return result;
end;
$$;

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
    when 'departure_cancelled' then case when new.detail ->> 'kind' = 'supported' then 'supported_cancelled'
                                         else 'departure_cancelled' end
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
-- D224: a hired tracker stays out of the pool through the grace day
-- ---------------------------------------------------------------------------
create or replace function private.trackers_free(from_day date, to_day date, except_reservation uuid default null)
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
           ) then 'infinity'::date
             -- D224: kept through the grace day too, so it is never promised to
             -- the next rider while the last one may still keep it.
             -- (A hire collected on day C and due back on day R holds days C to R
             -- plus the grace days; until_day is the first free day.)
             else r.return_on + (select s.tracker_grace_days from public.adventure_settings s where s.id = 1) + 1 end as until_day
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

-- ---------------------------------------------------------------------------
-- D225: payments whose webhook never came
-- ---------------------------------------------------------------------------
-- Reads a Checkout Session the server fetched from Stripe for an adventure
-- payment and applies it like a webhook (the dispatcher already routes
-- read.checkout.session by its metadata). Only the payment's own session.
create function public.record_adventure_stripe_read(payment_id uuid, object jsonb, correlation_id text)
returns table (event_id uuid, event_status public.stripe_event_status, outcome text, payment_status public.payment_status)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  o jsonb := record_adventure_stripe_read.object;
  pay public.adventure_payments;
  ev public.stripe_events;
  res record;
begin
  if record_adventure_stripe_read.payment_id is null or o is null then
    raise exception 'payment_id and object are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_typeof(o) is distinct from 'object' or (o ->> 'object') is distinct from 'checkout.session'
     or coalesce(o ->> 'id', '') !~ '^cs_(test|live)_[A-Za-z0-9_]{1,250}$' then
    raise exception 'object must be a Checkout Session read from Stripe' using errcode = '22023';
  end if;
  select p.* into pay from public.adventure_payments p where p.id = record_adventure_stripe_read.payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  insert into public.stripe_events as e (
    source, event_type, livemode, object_type, object_id, payload, headers, status, correlation_id
  )
  values (
    'api_read', 'read.checkout.session',
    case when pg_catalog.jsonb_typeof(o -> 'livemode') = 'boolean' then (o -> 'livemode')::boolean end,
    'checkout.session', pg_catalog.left(o ->> 'id', 255),
    pg_catalog.jsonb_build_object('data', pg_catalog.jsonb_build_object('object', private.stripe_object_projection(o))),
    '{}'::jsonb, 'received', pg_catalog.left(record_adventure_stripe_read.correlation_id, 128)
  )
  returning e.* into ev;
  if pay.stripe_checkout_session_id is distinct from (o ->> 'id')
     or (o -> 'metadata' ->> 'bicii_adventure_payment_id') is distinct from pay.id::text then
    update public.stripe_events e
    set status = 'needs_attention', outcome = 'read_mismatch', adventure_payment_id = pay.id,
        processed_at = pg_catalog.clock_timestamp()
    where e.id = ev.id;
    return query select ev.id, 'needs_attention'::public.stripe_event_status, 'read_mismatch'::text, pay.status;
    return;
  end if;
  select * into res from private.apply_stripe_object(ev);
  update public.stripe_events e
  set status = res.o_status, outcome = res.o_outcome, processed_at = pg_catalog.clock_timestamp()
  where e.id = ev.id;
  return query select ev.id, res.o_status, res.o_outcome,
    (select p.status from public.adventure_payments p where p.id = pay.id);
end;
$$;
revoke all on function public.record_adventure_stripe_read(uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.record_adventure_stripe_read(uuid, jsonb, text) to service_role;

-- Pending payments the cron should check with Stripe: a recorded session
-- that expired over an hour ago without an event moving it. Bookings whose
-- payment page was never created (no session) expire once their checkout
-- window has long passed, releasing any holds (the payment stays as it is:
-- it changes only through Stripe). Service role only.
create function public.stale_adventure_payments(max_rows integer)
returns table (payment_id uuid, session_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b record;
begin
  for b in
    select x.id
    from public.adventure_bookings x
    where x.status = 'pending_payment'
      and x.created_at < pg_catalog.now() - interval '1 day'
      and not exists (select 1 from public.adventure_payments p
                      where p.booking_id = x.id and p.stripe_checkout_session_id is not null)
    order by x.created_at
    limit 50
    for update skip locked
  loop
    update public.adventure_bookings x set status = 'expired', expired_at = pg_catalog.clock_timestamp()
    where x.id = b.id;
    insert into public.adventure_booking_events (booking_id, kind, detail)
    values (b.id, 'expired', pg_catalog.jsonb_build_object('note', 'No payment page was ever opened'));
  end loop;
  return query
    select p.id, p.stripe_checkout_session_id
    from public.adventure_payments p
    join public.adventure_bookings bk on bk.id = p.booking_id
    where p.status = 'pending' and p.stripe_checkout_session_id is not null
      and p.stripe_session_expires_at < pg_catalog.now() - interval '1 hour'
      and bk.status = 'pending_payment'
    order by p.stripe_session_expires_at
    limit greatest(1, least(coalesce(stale_adventure_payments.max_rows, 3), 20));
end;
$$;
revoke all on function public.stale_adventure_payments(integer) from public, anon, authenticated, service_role;
grant execute on function public.stale_adventure_payments(integer) to service_role;

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
    'payments_stale', (select pg_catalog.count(*) from public.adventure_payments p
                        join public.adventure_bookings b on b.id = p.booking_id
                        where p.status = 'pending' and b.status = 'pending_payment'
                          and coalesce(p.stripe_session_expires_at, p.created_at + interval '1 day')
                              < pg_catalog.now() - interval '1 hour'),
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
-- D226: returning a tracker closes a forgotten ride window
-- ---------------------------------------------------------------------------
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
  closed uuid;
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
  -- D226: a ride window still open when its tracker comes back is closed now,
  -- so the rider can send the ride and it leaves Live rides.
  if not exists (select 1 from public.tracker_assignments x
                 where x.reservation_id = hire.id and x.returned_at is null) then
    update public.adventure_attempts t
    set capture_finished_at = pg_catalog.now(), state = 'finished'
    where t.id = a.attempt_id and t.capture_started_at is not null and t.capture_finished_at is null
    returning t.id into closed;
    if closed is not null then
      perform private.reattribute_attempt(closed);
      insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
      values (hire.booking_id, 'ride_finished', actor,
              pg_catalog.jsonb_build_object('note', 'Finished when the tracker came back'));
    end if;
  end if;
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

-- ---------------------------------------------------------------------------
-- D227: a decided ride's window is fixed; recorded positions are kept
-- ---------------------------------------------------------------------------
create or replace function public.correct_adventure_capture(attempt_id uuid, started_at timestamptz, finished_at timestamptz, reason text)
returns public.adventure_attempts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid;
  a public.adventure_attempts;
  clean text := nullif(pg_catalog.btrim(coalesce(correct_adventure_capture.reason, '')), '');
begin
  if not (select private.can_read_adventure_evidence()) then
    raise exception 'verify_adventures or manage_adventures required' using errcode = '42501';
  end if;
  actor := private.current_staff_id();
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the ride window changes.';
  end if;
  if correct_adventure_capture.started_at is null
     or (correct_adventure_capture.finished_at is not null
         and correct_adventure_capture.finished_at < correct_adventure_capture.started_at)
     or correct_adventure_capture.started_at > pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'adventure_capture_invalid',
      detail = 'The start must be in the past and before the finish.';
  end if;
  select t.* into a from public.adventure_attempts t where t.id = correct_adventure_capture.attempt_id;
  if not found then
    raise exception 'attempt % not found', correct_adventure_capture.attempt_id using errcode = 'P0002';
  end if;
  perform 1 from public.adventure_bookings b where b.id = a.booking_id for update;
  if a.state = 'withdrawn' or exists (
    select 1 from public.adventure_submissions s join public.adventure_reviews v on v.submission_id = s.id
    where s.attempt_id = a.id
  ) then
    raise exception using errcode = 'P0001', message = 'adventure_capture_decided',
      detail = 'This ride has a decision, so its ride window no longer changes.';
  end if;
  update public.adventure_attempts t
  set capture_started_at = correct_adventure_capture.started_at,
      capture_finished_at = correct_adventure_capture.finished_at,
      state = case when correct_adventure_capture.finished_at is null then 'in_progress' else 'finished' end::public.adventure_attempt_state
  where t.id = a.id
  returning t.* into a;
  perform private.reattribute_attempt(a.id);
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (a.booking_id, 'capture_corrected', actor, pg_catalog.jsonb_build_object(
    'note', clean, 'from', a.capture_started_at, 'to', a.capture_finished_at));
  return a;
end;
$$;

create or replace function public.purge_unattributed_tracking(max_rows integer)
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
        -- Kept: anything a device recorded while it was out with a rider.
        and not exists (
          select 1 from public.tracker_assignments t
          where t.device_id = x.device_id and t.issued_at <= x.recorded_at
            and (t.returned_at is null or t.returned_at >= x.recorded_at)
        )
      order by x.received_at
      limit greatest(1, least(coalesce(purge_unattributed_tracking.max_rows, 1000), 5000))
    )
    returning 1
  )
  select pg_catalog.count(*)::integer from gone;
$$;
