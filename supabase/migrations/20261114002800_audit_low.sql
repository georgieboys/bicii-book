-- Fixes from the 2026-11-14 audit, low findings (D232-D238):
--
--   * D232: emails carry the message of the decision that queued them and
--     the rider's board name (so the certified email is true for riders who
--     chose no name); "retry failed emails" only re-sends the last 14 days.
--   * D233: positions stored before a device was registered are linked to it
--     when it is; a feed's access variable can't be a password variable.
--   * D234: lock order. A supported booking's confirmation locks its date
--     before the tracker pool; the short-fleet flag skips bookings another
--     transaction holds.
--   * D235: removing a ride file takes the booking lock first, so a file
--     can't vanish while its version is being sent.
--   * D236: signatures never linked to a booking are deleted after 7 days by
--     the cron, and a rider holds at most 20 unused ones.
--   * D237: a cancellation request flags the booking for an admin, and
--     Health counts requests still waiting.
--   * D238: only staff who can facilitate (or manage) adventures are put on a
--     date; editing checkpoints, offers and publishing check the draft's
--     version.
--   * D239: waiver version 2026-11-14.2, aligned with how the system works
--     (docs/adventures/waiver-2026-11-14.2.md), is published and becomes the
--     version riders sign while sales are off (the owner's request).

-- ---------------------------------------------------------------------------
-- D232: emails
-- ---------------------------------------------------------------------------
alter type public.adventure_notice add attribute board_name text;

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
           -- The message of the decision that queued this email (its version),
           -- not whichever decision is newest (audit A-70).
           (select v.message_to_rider
              from public.adventure_reviews v
              join public.adventure_submissions s on s.id = v.submission_id
              join public.adventure_attempts t on t.id = s.attempt_id
             where t.booking_id = b.id
               and (ev.detail ->> 'version' is null or s.version = (ev.detail ->> 'version')::integer)
             order by v.decided_at desc limit 1),
           cert.reference, cert.completed_on, cert.accepted_distance_km::numeric,
           (select f.items from public.adventure_fulfilments f where f.booking_id = b.id limit 1),
           b.attention_reason,
           s.public_site_url,
           dep.starts_at, dep.meeting_point,
           ev.detail ->> 'note',
           b.board_name
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

create or replace function public.retry_failed_adventure_notices()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  n integer;
begin
  update private.adventure_notices x
  set status = 'pending', attempts = 0, claims = 0, next_attempt_at = pg_catalog.now(),
      claimed_until = null, claim_token = null, last_error = null
  where x.status = 'failed' and x.created_at > pg_catalog.now() - interval '14 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- D233: devices and feeds
-- ---------------------------------------------------------------------------
create or replace function public.register_tracking_device(label text, provider public.tracking_provider, provider_device_id text, model text)
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
  -- Positions the feed stored before the device was registered are linked
  -- to it now, and attributed to the ride that held it (audit A-67).
  update public.tracking_messages m
  set device_id = result.id, attempt_id = private.tracking_attempt_for(result.id, m.recorded_at)
  where m.provider = result.provider and m.provider_device_id = result.provider_device_id and m.device_id is null;
  return result;
end;
$$;

alter table public.tracking_feeds
  add constraint tracking_feeds_config_not_password check (config_name !~ '_PASSWORD$');

-- ---------------------------------------------------------------------------
-- D234: lock order
-- ---------------------------------------------------------------------------
create or replace function private.adventure_bookings_move_hire()
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
    -- A supported seat's date is locked before the pool, the documented order
    -- (booking, date, pool), as a concurrent checkout takes them (A-66).
    if new.kind = 'supported' then
      perform 1 from public.adventure_departures d
      join public.adventure_departure_participants p on p.departure_id = d.id
      where p.booking_id = new.id and p.left_at is null
      for update of d;
    end if;
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

create or replace function private.tracking_devices_flag_short_hires()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.service_state = 'in_service' and new.service_state <> 'in_service' then
    -- Runs while the pool and the device are held, after the documented
    -- booking lock: bookings another transaction holds are skipped rather
    -- than waited for (no deadlock, A-66); Health still shows the shortfall.
    update public.adventure_bookings b
    set needs_attention = true,
        attention_reason = 'Not enough trackers in service for this hire''s days.'
    where b.id in (
      select bk.id
      from public.adventure_bookings bk
      join public.tracker_reservations r on r.booking_id = bk.id
      where r.status = 'confirmed'
        and r.return_on > private.shop_today()
        and not bk.needs_attention
        and not exists (select 1 from public.tracker_assignments x where x.reservation_id = r.id)
        and private.trackers_free(greatest(r.collect_on, private.shop_today()), r.return_on) < 0
      for update of bk skip locked
    );
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- D235: removing a file takes the booking lock first
-- ---------------------------------------------------------------------------
create or replace function public.remove_my_adventure_file(file_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  booking uuid;
  f public.adventure_evidence_files;
  sub_state public.adventure_submission_state;
begin
  select t.booking_id into booking
  from public.adventure_evidence_files ef
  join public.adventure_submissions s on s.id = ef.submission_id
  join public.adventure_attempts t on t.id = s.attempt_id
  join public.adventure_bookings b on b.id = t.booking_id
  where ef.id = remove_my_adventure_file.file_id and b.customer_id = me;
  if booking is null then
    raise exception 'file not owned' using errcode = '42501';
  end if;
  -- The same order as sending the ride: booking, then the file.
  perform 1 from public.adventure_bookings b where b.id = booking for update;
  select ef.* into f from public.adventure_evidence_files ef where ef.id = remove_my_adventure_file.file_id for update;
  select s.state into sub_state from public.adventure_submissions s where s.id = f.submission_id;
  if sub_state <> 'draft' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_immutable',
      detail = 'Submitted evidence cannot change. Wait for a correction request.';
  end if;
  update public.adventure_evidence_files ef set state = 'removed' where ef.id = f.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- D236: unused signatures
-- ---------------------------------------------------------------------------
create or replace function private.adventure_waiver_signatures_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- An unused signature (never linked to a booking) may be purged (A-71).
  if tg_op = 'DELETE' and old.booking_id is null then
    return old;
  end if;
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

create function private.adventure_waiver_signatures_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select pg_catalog.count(*) from public.adventure_waiver_signatures s
      where s.customer_id = new.customer_id and s.booking_id is null) >= 20 then
    raise exception using errcode = 'P0001', message = 'adventure_too_many_open',
      detail = 'You have several payment pages open. Finish paying there, or try again later.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_waiver_signatures_cap() from public, anon, authenticated, service_role;
create trigger adventure_waiver_signatures_cap
  before insert on public.adventure_waiver_signatures
  for each row execute function private.adventure_waiver_signatures_cap();

create function public.purge_unused_waiver_signatures(max_rows integer)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.adventure_waiver_signatures s
    where s.id in (
      select x.id from public.adventure_waiver_signatures x
      where x.booking_id is null and x.signed_at < pg_catalog.now() - interval '7 days'
      order by x.signed_at
      limit greatest(1, least(coalesce(purge_unused_waiver_signatures.max_rows, 500), 5000))
    )
    returning 1
  )
  select pg_catalog.count(*)::integer from gone;
$$;
revoke all on function public.purge_unused_waiver_signatures(integer) from public, anon, authenticated, service_role;
grant execute on function public.purge_unused_waiver_signatures(integer) to service_role;

-- ---------------------------------------------------------------------------
-- D237: cancellation requests wait in Needs attention
-- ---------------------------------------------------------------------------
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
  if not b.needs_attention then
    perform private.flag_adventure_booking(b.id, 'Cancellation asked: ' || pg_catalog.left(clean, 200), null, null);
  end if;
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
                        join public.adventure_bookings b on b.id = p.booking_id
                        where p.status = 'pending' and b.status = 'pending_payment'
                          and coalesce(p.stripe_session_expires_at, p.created_at + interval '1 day')
                              < pg_catalog.now() - interval '1 hour'),
    'bookings_attention', (select pg_catalog.count(*) from public.adventure_bookings b where b.needs_attention),
    -- Requests still waiting: the booking is flagged with one (A-73).
    'cancellations_requested_30d', (select pg_catalog.count(*) from public.adventure_bookings b
                                     where b.needs_attention and b.status = 'confirmed'
                                       and b.attention_reason like 'Cancellation asked:%'),
    'unattributed_messages_old', (select pg_catalog.count(*) from public.tracking_messages m
                                   where m.attempt_id is null and m.received_at < pg_catalog.now() - interval '30 days')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- D238: staff on dates; draft versions
-- ---------------------------------------------------------------------------
create or replace function public.assign_departure_staff(departure_id uuid, staff_id uuid, role public.departure_staff_role)
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
  -- Only someone who can check riders in and record observations (audit A-74).
  if not exists (
    select 1 from public.staff s
    where s.id = assign_departure_staff.staff_id
      and (private.role_implies(s.role, 'facilitate_adventures')
           or private.role_implies(s.role, 'manage_adventures')
           or exists (select 1 from public.staff_permissions sp
                      where sp.staff_id = s.id and sp.permission in ('facilitate_adventures', 'manage_adventures')))
  ) then
    raise exception using errcode = 'P0001', message = 'departure_staff_not_permitted',
      detail = 'Give them Facilitate adventures first (Settings, Staff), then put them on the date.';
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


-- Checkpoints, offers and publishing check the version of the draft the
-- editor opened (expected_version; null keeps the old behaviour), and each
-- edit moves the version on, so a stale editor is refused (audit A-75).

drop function public.set_adventure_checkpoints(uuid, jsonb);
create function private.set_adventure_checkpoints_unversioned(revision_id uuid, checkpoints jsonb)
returns setof public.adventure_checkpoints
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_checkpoints_unversioned.revision_id);
  item jsonb;
  pos integer := 0;
begin
  if set_adventure_checkpoints_unversioned.checkpoints is null
     or pg_catalog.jsonb_typeof(set_adventure_checkpoints_unversioned.checkpoints) <> 'array'
     or pg_catalog.jsonb_array_length(set_adventure_checkpoints_unversioned.checkpoints) > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_checkpoints_invalid',
      detail = 'Send a list of up to 100 checkpoints.';
  end if;

  delete from public.adventure_checkpoints c where c.revision_id = rev.id;
  for item in select value from pg_catalog.jsonb_array_elements(set_adventure_checkpoints_unversioned.checkpoints) loop
    if pg_catalog.jsonb_typeof(item) <> 'object' then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_checkpoints_invalid',
        detail = 'Each checkpoint needs a label.';
    end if;
    pos := pos + 1;
    insert into public.adventure_checkpoints (
      revision_id, position, label, instructions, latitude, longitude,
      review_radius_m, mandatory, photo_required
    ) values (
      rev.id,
      pos,
      pg_catalog.btrim(item ->> 'label'),
      coalesce(pg_catalog.btrim(item ->> 'instructions'), ''),
      (item ->> 'latitude')::numeric,
      (item ->> 'longitude')::numeric,
      (item ->> 'review_radius_m')::integer,
      coalesce((item ->> 'mandatory')::boolean, true),
      coalesce((item ->> 'photo_required')::boolean, true)
    );
  end loop;

  return query
    select c.* from public.adventure_checkpoints c where c.revision_id = rev.id order by c.position;
end;
$$;
revoke all on function private.set_adventure_checkpoints_unversioned(uuid, jsonb) from public, anon, authenticated, service_role;

create function public.set_adventure_checkpoints(revision_id uuid, checkpoints jsonb, expected_version integer default null)
returns setof public.adventure_checkpoints
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_checkpoints.revision_id);
begin
  if set_adventure_checkpoints.expected_version is not null and rev.version <> set_adventure_checkpoints.expected_version then
    raise exception using errcode = 'P0001', message = 'adventure_draft_changed',
      detail = 'Someone changed this draft since you opened it. Reload and try again.';
  end if;
  return query select * from private.set_adventure_checkpoints_unversioned(set_adventure_checkpoints.revision_id, set_adventure_checkpoints.checkpoints);
  update public.adventure_revisions r set version = r.version + 1 where r.id = set_adventure_checkpoints.revision_id;
end;
$$;
revoke all on function public.set_adventure_checkpoints(uuid, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_adventure_checkpoints(uuid, jsonb, integer) to authenticated;

drop function public.set_adventure_offer(uuid, public.adventure_participation, numeric, numeric, integer, text);
create function private.set_adventure_offer_unversioned(
  revision_id uuid,
  kind public.adventure_participation,
  price numeric,
  tracker_hire_price numeric,
  supported_days integer,
  inclusions text
)
returns public.adventure_offers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_offer_unversioned.revision_id);
  offer public.adventure_offers;
begin
  if rev.distance_km < 125 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_not_certifiable',
      detail = 'Certification starts at 125 km. Shorter routes stay free to ride.';
  end if;
  if rev.is_planned then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_planned',
      detail = 'A planned route cannot be sold. Untick "Still being planned" first.';
  end if;

  insert into public.adventure_offers as o (revision_id, kind, price, tracker_hire_price, supported_days, inclusions)
  values (
    rev.id,
    set_adventure_offer_unversioned.kind,
    set_adventure_offer_unversioned.price,
    case when set_adventure_offer_unversioned.kind = 'supported' then null else set_adventure_offer_unversioned.tracker_hire_price end,
    case when set_adventure_offer_unversioned.kind = 'supported' then set_adventure_offer_unversioned.supported_days end,
    coalesce(pg_catalog.btrim(set_adventure_offer_unversioned.inclusions), '')
  )
  on conflict on constraint adventure_offers_kind_unique do update
  set price = excluded.price,
      tracker_hire_price = excluded.tracker_hire_price,
      supported_days = excluded.supported_days,
      inclusions = excluded.inclusions
  returning o.* into offer;
  return offer;
end;
$$;
revoke all on function private.set_adventure_offer_unversioned(uuid, public.adventure_participation, numeric, numeric, integer, text) from public, anon, authenticated, service_role;

create function public.set_adventure_offer(revision_id uuid, kind public.adventure_participation, price numeric, tracker_hire_price numeric, supported_days integer, inclusions text, expected_version integer default null)
returns public.adventure_offers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_offer.revision_id);
  result public.adventure_offers;
begin
  if set_adventure_offer.expected_version is not null and rev.version <> set_adventure_offer.expected_version then
    raise exception using errcode = 'P0001', message = 'adventure_draft_changed',
      detail = 'Someone changed this draft since you opened it. Reload and try again.';
  end if;
  result := private.set_adventure_offer_unversioned(set_adventure_offer.revision_id, set_adventure_offer.kind, set_adventure_offer.price, set_adventure_offer.tracker_hire_price, set_adventure_offer.supported_days, set_adventure_offer.inclusions);
  update public.adventure_revisions r set version = r.version + 1 where r.id = set_adventure_offer.revision_id;
  return result;
end;
$$;
revoke all on function public.set_adventure_offer(uuid, public.adventure_participation, numeric, numeric, integer, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_adventure_offer(uuid, public.adventure_participation, numeric, numeric, integer, text, integer) to authenticated;

drop function public.remove_adventure_offer(uuid, public.adventure_participation);
create function private.remove_adventure_offer_unversioned(revision_id uuid, kind public.adventure_participation)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(remove_adventure_offer_unversioned.revision_id);
begin
  delete from public.adventure_offers o where o.revision_id = rev.id and o.kind = remove_adventure_offer_unversioned.kind;
end;
$$;
revoke all on function private.remove_adventure_offer_unversioned(uuid, public.adventure_participation) from public, anon, authenticated, service_role;

create function public.remove_adventure_offer(revision_id uuid, kind public.adventure_participation, expected_version integer default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(remove_adventure_offer.revision_id);
begin
  if remove_adventure_offer.expected_version is not null and rev.version <> remove_adventure_offer.expected_version then
    raise exception using errcode = 'P0001', message = 'adventure_draft_changed',
      detail = 'Someone changed this draft since you opened it. Reload and try again.';
  end if;
  perform private.remove_adventure_offer_unversioned(remove_adventure_offer.revision_id, remove_adventure_offer.kind);
  update public.adventure_revisions r set version = r.version + 1 where r.id = remove_adventure_offer.revision_id;
end;
$$;
revoke all on function public.remove_adventure_offer(uuid, public.adventure_participation, integer) from public, anon, authenticated, service_role;
grant execute on function public.remove_adventure_offer(uuid, public.adventure_participation, integer) to authenticated;

drop function public.publish_adventure_revision(uuid, text);
create function private.publish_adventure_revision_unversioned(revision_id uuid, change_summary text)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(publish_adventure_revision_unversioned.revision_id);
  adv public.adventures;
  has_offers boolean;
begin
  select a.* into adv from public.adventures a where a.id = rev.adventure_id;
  if adv.status = 'archived' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_archived',
      detail = 'Unarchive this adventure before publishing it.';
  end if;
  if not private.is_time_zone(rev.time_zone) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_time_zone_invalid',
      detail = 'Use a time zone name such as Asia/Singapore.';
  end if;

  has_offers := exists (select 1 from public.adventure_offers o where o.revision_id = rev.id);
  if has_offers then
    if rev.distance_km < 125 then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_not_certifiable',
        detail = 'Certification starts at 125 km. Remove the offers or change the distance.';
    end if;
    if rev.is_planned then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_planned',
        detail = 'A planned route cannot be sold. Remove the offers or untick "Still being planned".';
    end if;
    if rev.nominal_days is null or rev.max_elapsed_minutes is null then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_rules_incomplete',
        detail = 'A route with certification offers needs its nominal days and a maximum time.';
    end if;
  end if;

  update public.adventure_revisions r
  set sealed_at = pg_catalog.now(),
      sealed_by = actor,
      change_summary = nullif(pg_catalog.btrim(publish_adventure_revision_unversioned.change_summary), '')
  where r.id = rev.id
  returning r.* into rev;

  update public.adventures a
  set current_revision_id = rev.id, status = 'published'
  where a.id = rev.adventure_id;

  insert into public.adventure_events (adventure_id, revision_id, kind, staff_id, reason)
  values (rev.adventure_id, rev.id, 'published', actor, rev.change_summary);
  return rev;
end;
$$;
revoke all on function private.publish_adventure_revision_unversioned(uuid, text) from public, anon, authenticated, service_role;

create function public.publish_adventure_revision(revision_id uuid, change_summary text, expected_version integer default null)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(publish_adventure_revision.revision_id);
  result public.adventure_revisions;
begin
  if publish_adventure_revision.expected_version is not null and rev.version <> publish_adventure_revision.expected_version then
    raise exception using errcode = 'P0001', message = 'adventure_draft_changed',
      detail = 'Someone changed this draft since you opened it. Reload and try again.';
  end if;
  result := private.publish_adventure_revision_unversioned(publish_adventure_revision.revision_id, publish_adventure_revision.change_summary);
  return result;
end;
$$;
revoke all on function public.publish_adventure_revision(uuid, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.publish_adventure_revision(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- D239: the aligned waiver, published and chosen (sales stay as they are)
-- ---------------------------------------------------------------------------
insert into public.adventure_waivers (version, title, body, body_sha256)
select '2026-11-14.2', 'BICII rider terms, release and waiver', t.body,
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
2.1 You may cancel and be refunded until you send your ride for review. Ask from your ride page; BICII then cancels your booking and refunds the card you paid with.
2.2 Once you have sent your ride for review, there are no refunds, whatever the result: certified, not certified, or withdrawn.
2.3 BICII may cancel a booking, for example if you break these terms. If BICII cancels before you send your ride for review, you are refunded. If BICII cancels because you broke these terms, BICII decides whether any refund is due.
2.4 If BICII cancels a supported ride date, BICII moves you to another supported date or refunds you, as you prefer. If BICII cancels a group ride date, your ticket stands: ride on your own or join another date.

3. THE RULES
3.1 You must ride a bicycle powered only by you. Electric bicycles, e-bikes, power-assisted bicycles and every other motorised vehicle are not allowed, for any part of the route.
3.2 You must finish within the route's maximum time, pass its checkpoints and follow every other rule on the route's page, as published when you bought your ticket.
3.3 You must obey Singapore's road traffic laws, the rules for park connectors and paths, and the instructions of the police, park officers and other authorities. Public roads and paths stay open to traffic and other users during the ride.
3.4 You must wear a helmet, use front and rear lights when it is dark, and keep your bicycle roadworthy.
3.5 You must send only your own, honest records of your own ride. A false, altered or borrowed recording or photo ends your attempt without a refund, and BICII may refuse you future tickets.
3.6 BICII's reviewers decide whether a ride is certified. Their decision is final.

4. TRACKER HIRE
4.1 A hired tracker costs the hire price shown when you buy your ticket for each 24 hours of use, paid when you buy your ticket.
4.2 Bring the tracker back to the BICII shop on its return day. You have a grace period of 24 hours after that to bring it back without charge.
4.3 After the grace period, you pay a late fee for each further day, or part of a day, until the tracker is back, at the rate shown when you hire it (20 dollars a day unless shown otherwise). Days the shop is closed count. BICII may charge you this fee, and you agree to pay it at the shop.
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
9.3 If you sign these terms but don't complete your purchase, your signature and your emergency contact's details are deleted after 7 days.

10. GENERAL
10.1 These terms, the route's rules as published when you bought your ticket, and the details of your booking are the whole agreement between you and BICII about the ride.
10.2 These terms are governed by the laws of Singapore, and the courts of Singapore decide any dispute.

SIGNATURE
By typing your full name and signing, you confirm that you have read and understood these terms, that you agree to them, and that your typed name is your signature with the same effect as a signature by hand.$waiver$::text as body) t;

-- Only while sales are off, so nobody mid-purchase is asked to sign again.
update public.adventure_settings s
set terms_version = '2026-11-14.2'
where s.id = 1 and not s.sales_enabled;

