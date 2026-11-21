-- Audit fixes for Adventures (2026-11-22).
--
-- 1. trackers_free checks the hire being sold through its own return day
--    and grace days (D224), so an earlier hire sold after a later one can
--    no longer promise the same tracker twice.
-- 2. The D225 read-back also covers a pending payment on a replaced,
--    expired or cancelled booking (whose later payment is kept and
--    flagged), and Health counts those payments.
-- 3. A rider's cancellation request flags the booking without a
--    payment_attention event (no second, false email), and Health counts
--    waiting requests from the events, not the flag's text.

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
    -- The hire being sold holds its own return day and grace days too, so
    -- an earlier hire sold after a later one is checked the same way.
    from pg_catalog.generate_series(
      trackers_free.from_day,
      trackers_free.to_day + (select s.tracker_grace_days from public.adventure_settings s where s.id = 1),
      interval '1 day'
    ) d
  ) per_day;
$$;


create or replace function public.stale_adventure_payments(max_rows integer)
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
    where p.status = 'pending' and p.stripe_checkout_session_id is not null
      and p.stripe_session_expires_at < pg_catalog.now() - interval '1 hour'
    order by p.stripe_session_expires_at
    limit greatest(1, least(coalesce(stale_adventure_payments.max_rows, 3), 20));
end;
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
    'payments_stale', (select pg_catalog.count(*) from public.adventure_payments p
                        where p.status = 'pending'
                          and coalesce(p.stripe_session_expires_at, p.created_at + interval '1 day')
                              < pg_catalog.now() - interval '1 hour'),
    'bookings_attention', (select pg_catalog.count(*) from public.adventure_bookings b where b.needs_attention),
    -- Requests still waiting: a paid booking with a request in the last 30
    -- days that no admin has cleared since, whatever its flag now says.
    'cancellations_requested_30d', (select pg_catalog.count(*) from public.adventure_bookings b
                                     where b.status = 'confirmed'
                                       and exists (
                                         select 1 from public.adventure_booking_events e
                                         where e.booking_id = b.id and e.kind = 'cancellation_requested'
                                           and e.created_at > pg_catalog.now() - interval '30 days'
                                           and not exists (
                                             select 1 from public.adventure_booking_events c
                                             where c.booking_id = b.id and c.kind = 'attention_cleared'
                                               and c.created_at >= e.created_at
                                           )
                                       )),
    'unattributed_messages_old', (select pg_catalog.count(*) from public.tracking_messages m
                                   where m.attempt_id is null and m.received_at < pg_catalog.now() - interval '30 days')
  );
end;
$$;


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
  -- One request a day is enough: a repeat records nothing new (audit A-50).
  if exists (select 1 from public.adventure_booking_events e
             where e.booking_id = b.id and e.kind = 'cancellation_requested'
               and e.created_at > pg_catalog.now() - interval '24 hours') then
    return;
  end if;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'cancellation_requested', pg_catalog.jsonb_build_object('note', pg_catalog.left(clean, 500)));
  -- The request waits in Needs attention until an admin handles it (cancels,
  -- or clears the flag with a note) (audit A-73).
  -- Flagged directly: flag_adventure_booking also records a
  -- payment_attention event, which emailed the shop a second, false
  -- "Payment needs attention". An existing flag keeps its reason.
  update public.adventure_bookings x
  set needs_attention = true,
      attention_reason = case when x.needs_attention then x.attention_reason
                              else pg_catalog.left('Cancellation asked: ' || clean, 200) end
  where x.id = b.id;
end;
$$;

