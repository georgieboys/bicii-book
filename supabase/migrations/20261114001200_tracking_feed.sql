-- Adventures Phase C, the tracking feed (D189, D190; DATA-MODEL §20
-- "Tracking feed"; handoff §12).
--
--   * tracking_feeds: a provider feed the worker polls. Its access is never
--     stored here: `config_name` names the server variable that holds it
--     (for SPOT, the feed ID), and the worker reads that variable. Each feed
--     is worked under a lease, no sooner than its next allowed request (the
--     provider's rate limit), and keeps a safe watermark: every message
--     recorded before it has been stored. A bounded window cursor
--     (`window_end_at`) lets a full page be followed back in time without
--     moving the watermark.
--   * tracking_messages: every message once, by provider and message id
--     (overlapping feeds deliver the same message), with the time it was
--     recorded, the time BICII received it, its kind and a position only
--     when the provider gave a valid one.
--   * Attribution (handoff §12.4): a message belongs to the attempt whose
--     tracker assignment covered the device at its *recorded* time and whose
--     ride window (Start Ride to Finish Ride) covered that time too. Never
--     the device's current holder. A late delivery of a point recorded
--     inside the window still joins the ride; a point recorded after Finish
--     does not.
--   * Start Ride and Finish Ride (the rider) open and close the window; they
--     send nothing to the device. Staff with verify or manage adventures can
--     correct the window with a reason, and the ride's points are
--     attributed again.

-- ---------------------------------------------------------------------------
-- Feeds
-- ---------------------------------------------------------------------------
create type public.tracking_message_kind as enum ('position', 'check_in', 'help', 'stop', 'other');

create table public.tracking_feeds (
  id uuid primary key default gen_random_uuid(),
  provider public.tracking_provider not null,
  label text not null check (pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 60),
  -- The name of the server variable holding the feed's access (never the
  -- value). Only TRACKING_FEED_* names, so no other server secret can be
  -- named here and sent to a provider.
  config_name text not null check (config_name ~ '^TRACKING_FEED_[A-Z0-9_]{1,40}$'),
  enabled boolean not null default false,
  min_interval_seconds integer not null default 150 check (min_interval_seconds between 60 and 3600),
  watermark_at timestamptz not null default pg_catalog.now(),
  window_end_at timestamptz null,
  next_request_at timestamptz not null default pg_catalog.now(),
  lease_until timestamptz null,
  lease_token uuid null,
  last_success_at timestamptz null,
  last_error text null check (pg_catalog.char_length(last_error) <= 200),
  failures integer not null default 0 check (failures >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid null references public.staff (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint tracking_feeds_lease check ((lease_token is null) = (lease_until is null))
);
create unique index tracking_feeds_config_key on public.tracking_feeds (provider, config_name);
create trigger tracking_feeds_set_updated_at
  before update on public.tracking_feeds
  for each row execute function private.set_updated_at();

create table public.tracking_messages (
  id uuid primary key default gen_random_uuid(),
  provider public.tracking_provider not null,
  provider_message_id text not null check (pg_catalog.char_length(provider_message_id) between 1 and 120),
  provider_device_id text not null check (pg_catalog.char_length(provider_device_id) between 1 and 80),
  device_id uuid null references public.tracking_devices (id) on delete restrict,
  feed_id uuid null references public.tracking_feeds (id) on delete set null,
  recorded_at timestamptz not null,
  received_at timestamptz not null default pg_catalog.now(),
  kind public.tracking_message_kind not null,
  latitude public.geo_degrees null check (latitude between -90 and 90),
  longitude public.geo_degrees null check (longitude between -180 and 180),
  attempt_id uuid null references public.adventure_attempts (id) on delete restrict,
  constraint tracking_messages_once unique (provider, provider_message_id),
  constraint tracking_messages_position check ((latitude is null) = (longitude is null))
);
create index tracking_messages_device_time on public.tracking_messages (device_id, recorded_at);
create index tracking_messages_attempt_time on public.tracking_messages (attempt_id, recorded_at)
  where attempt_id is not null;

-- The ride window on the attempt.
alter table public.adventure_attempts
  add column capture_started_at timestamptz null,
  add column capture_finished_at timestamptz null,
  add constraint adventure_attempts_capture check (
    (capture_finished_at is null or capture_started_at is not null)
    and (capture_finished_at is null or capture_started_at <= capture_finished_at)
  );

alter table public.tracking_feeds enable row level security;
alter table public.tracking_messages enable row level security;
revoke all on table public.tracking_feeds, public.tracking_messages from public, anon, authenticated, service_role;
grant select on table public.tracking_feeds to authenticated;
grant select on table public.tracking_messages to authenticated;
-- Feed health for staff; messages (positions) for staff who verify or manage adventures.
create policy tracking_feeds_select_staff on public.tracking_feeds
  for select to authenticated using ((select private.is_staff()));
create policy tracking_messages_select_evidence on public.tracking_messages
  for select to authenticated using ((select private.can_read_adventure_evidence()));

-- ---------------------------------------------------------------------------
-- Attribution
-- ---------------------------------------------------------------------------
-- The attempt a device's message recorded at `at` belongs to, or null.
create function private.tracking_attempt_for(device uuid, at timestamptz)
returns uuid
language sql
stable
set search_path = ''
as $$
  select x.attempt_id
  from public.tracker_assignments x
  join public.adventure_attempts t on t.id = x.attempt_id
  where x.device_id = tracking_attempt_for.device
    and x.issued_at <= tracking_attempt_for.at
    and (x.returned_at is null or tracking_attempt_for.at < x.returned_at)
    and t.capture_started_at is not null
    and t.capture_started_at <= tracking_attempt_for.at
    and (t.capture_finished_at is null or tracking_attempt_for.at <= t.capture_finished_at)
  order by x.issued_at desc
  limit 1;
$$;
revoke all on function private.tracking_attempt_for(uuid, timestamptz) from public, anon, authenticated, service_role;

-- Attribute again every message of the devices an attempt used (after its
-- window changed). Only messages that are, or would be, the attempt's move.
create function private.reattribute_attempt(attempt uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update public.tracking_messages m
  set attempt_id = private.tracking_attempt_for(m.device_id, m.recorded_at)
  where m.device_id in (select x.device_id from public.tracker_assignments x where x.attempt_id = reattribute_attempt.attempt)
    and (m.attempt_id = reattribute_attempt.attempt or m.attempt_id is null)
    and m.attempt_id is distinct from private.tracking_attempt_for(m.device_id, m.recorded_at);
$$;
revoke all on function private.reattribute_attempt(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Feeds: setup (admin) and the worker (service role)
-- ---------------------------------------------------------------------------
create function public.save_tracking_feed(feed_id uuid, provider public.tracking_provider, label text,
                                          config_name text, enabled boolean)
returns public.tracking_feeds
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  result public.tracking_feeds;
begin
  if save_tracking_feed.feed_id is null then
    insert into public.tracking_feeds (provider, label, config_name, enabled, created_by, watermark_at)
    values (save_tracking_feed.provider, pg_catalog.btrim(save_tracking_feed.label),
            pg_catalog.upper(pg_catalog.btrim(save_tracking_feed.config_name)),
            coalesce(save_tracking_feed.enabled, false), actor,
            -- SPOT keeps seven days; start a new feed a day back.
            pg_catalog.now() - interval '1 day')
    returning * into result;
  else
    update public.tracking_feeds f
    set label = pg_catalog.btrim(save_tracking_feed.label),
        enabled = coalesce(save_tracking_feed.enabled, false)
    where f.id = save_tracking_feed.feed_id
    returning f.* into result;
    if not found then
      raise exception 'feed % not found', save_tracking_feed.feed_id using errcode = 'P0002';
    end if;
  end if;
  return result;
end;
$$;

-- One due feed under a new lease (5 minutes), or nothing. The lease and the
-- next allowed request keep every worker within the provider's rate limit.
create function public.claim_tracking_feed()
returns table (
  feed_id uuid, lease_token uuid, provider public.tracking_provider, config_name text,
  watermark_at timestamptz, window_end_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.tracking_feeds;
begin
  select x.* into f
  from public.tracking_feeds x
  where x.enabled
    and x.next_request_at <= pg_catalog.now()
    and (x.lease_until is null or x.lease_until < pg_catalog.now())
  order by x.next_request_at
  limit 1
  for update skip locked;
  if not found then
    return;
  end if;
  update public.tracking_feeds x
  set lease_token = gen_random_uuid(),
      lease_until = pg_catalog.now() + interval '5 minutes',
      -- Counted from the request, whatever its result.
      next_request_at = pg_catalog.now() + pg_catalog.make_interval(secs => f.min_interval_seconds)
  where x.id = f.id
  returning x.* into f;
  return query select f.id, f.lease_token, f.provider, f.config_name, f.watermark_at, f.window_end_at;
end;
$$;

-- Store a fetched batch under the lease and move the feed's cursor:
-- `complete` (the window held fewer than a full page) advances the
-- watermark to `window_to` and clears the window cursor; otherwise the
-- window cursor moves back to `next_window_end` and the watermark stays.
-- Messages are inserted once (by provider and message id), linked to the
-- device and attributed by their recorded time. Returns how many were new;
-- -1 when the lease is no longer this caller's (nothing is written).
create function public.store_tracking_messages(
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

  update public.tracking_feeds x
  set watermark_at = case when store_tracking_messages.complete
                          then greatest(x.watermark_at, store_tracking_messages.window_to) else x.watermark_at end,
      window_end_at = case when store_tracking_messages.complete then null else store_tracking_messages.next_window_end end,
      last_success_at = pg_catalog.now(), last_error = null, failures = 0,
      lease_token = null, lease_until = null
  where x.id = f.id;
  return added;
end;
$$;

-- A failed request: recorded (a rider-safe reason, never the URL), the
-- lease released, the next request backed off.
create function public.fail_tracking_feed(feed_id uuid, lease_token uuid, error text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.tracking_feeds x
  set last_error = pg_catalog.left(coalesce(nullif(pg_catalog.btrim(fail_tracking_feed.error), ''), 'Request failed'), 200),
      failures = x.failures + 1,
      next_request_at = greatest(x.next_request_at,
        pg_catalog.now() + pg_catalog.make_interval(secs => least(3600, x.min_interval_seconds * pg_catalog.power(2, least(x.failures, 5))::integer))),
      lease_token = null, lease_until = null
  where x.id = fail_tracking_feed.feed_id and x.lease_token = fail_tracking_feed.lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Start Ride, Finish Ride (the rider) and corrections (staff)
-- ---------------------------------------------------------------------------
create function private.my_hire_attempt(booking_id uuid)
returns public.adventure_attempts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  a public.adventure_attempts;
begin
  select x.* into b from public.adventure_bookings x
  where x.id = my_hire_attempt.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  select t.* into a from public.adventure_attempts t
  where t.booking_id = b.id
    and exists (select 1 from public.tracker_assignments x where x.attempt_id = t.id and x.returned_at is null)
  order by t.attempt_number desc limit 1
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'adventure_tracker_not_issued',
      detail = 'Collect your tracker from the shop first.';
  end if;
  return a;
end;
$$;
revoke all on function private.my_hire_attempt(uuid) from public, anon, authenticated, service_role;

create function public.start_my_adventure_ride(booking_id uuid)
returns public.adventure_attempts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.adventure_attempts := private.my_hire_attempt(start_my_adventure_ride.booking_id);
begin
  if a.capture_started_at is not null then
    raise exception using errcode = 'P0001', message = 'adventure_ride_already_started',
      detail = 'Your ride has already started.';
  end if;
  update public.adventure_attempts t
  set capture_started_at = pg_catalog.now(), state = 'in_progress'
  where t.id = a.id
  returning t.* into a;
  perform private.reattribute_attempt(a.id);
  insert into public.adventure_booking_events (booking_id, kind) values (a.booking_id, 'ride_started');
  return a;
end;
$$;

create function public.finish_my_adventure_ride(booking_id uuid)
returns public.adventure_attempts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a public.adventure_attempts := private.my_hire_attempt(finish_my_adventure_ride.booking_id);
begin
  if a.capture_started_at is null then
    raise exception using errcode = 'P0001', message = 'adventure_ride_not_started',
      detail = 'Start your ride first.';
  end if;
  if a.capture_finished_at is not null then
    raise exception using errcode = 'P0001', message = 'adventure_ride_already_finished',
      detail = 'Your ride has already finished.';
  end if;
  update public.adventure_attempts t
  set capture_finished_at = pg_catalog.now(), state = 'finished'
  where t.id = a.id
  returning t.* into a;
  perform private.reattribute_attempt(a.id);
  insert into public.adventure_booking_events (booking_id, kind) values (a.booking_id, 'ride_finished');
  return a;
end;
$$;

-- Staff fix a missed Start or Finish (or a wrong one), with a reason; the
-- ride's points are attributed again. Never certifies anything by itself.
create function public.correct_adventure_capture(attempt_id uuid, started_at timestamptz, finished_at timestamptz, reason text)
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

-- The rider's ride on their own booking: window, positions so far, latest.
create function public.my_adventure_ride(booking_id uuid)
returns table (
  capture_started_at timestamptz, capture_finished_at timestamptz, positions integer,
  first_at timestamptz, latest_at timestamptz, latest_received_at timestamptz,
  latest_latitude numeric, latest_longitude numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.capture_started_at, t.capture_finished_at,
         (select pg_catalog.count(*)::integer from public.tracking_messages m where m.attempt_id = t.id and m.latitude is not null),
         (select pg_catalog.min(m.recorded_at) from public.tracking_messages m where m.attempt_id = t.id and m.latitude is not null),
         l.recorded_at, l.received_at, l.latitude::numeric, l.longitude::numeric
  from public.adventure_attempts t
  join public.adventure_bookings b on b.id = t.booking_id
  left join lateral (
    select m.recorded_at, m.received_at, m.latitude, m.longitude
    from public.tracking_messages m
    where m.attempt_id = t.id and m.latitude is not null
    order by m.recorded_at desc limit 1
  ) l on true
  where t.booking_id = my_adventure_ride.booking_id
    and b.customer_id = private.require_customer()
  order by t.attempt_number desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.save_tracking_feed(uuid, public.tracking_provider, text, text, boolean),
  public.claim_tracking_feed(),
  public.store_tracking_messages(uuid, uuid, jsonb, boolean, timestamptz, timestamptz),
  public.fail_tracking_feed(uuid, uuid, text),
  public.start_my_adventure_ride(uuid),
  public.finish_my_adventure_ride(uuid),
  public.correct_adventure_capture(uuid, timestamptz, timestamptz, text),
  public.my_adventure_ride(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.save_tracking_feed(uuid, public.tracking_provider, text, text, boolean),
  public.start_my_adventure_ride(uuid),
  public.finish_my_adventure_ride(uuid),
  public.correct_adventure_capture(uuid, timestamptz, timestamptz, text),
  public.my_adventure_ride(uuid)
to authenticated;
grant execute on function
  public.claim_tracking_feed(),
  public.store_tracking_messages(uuid, uuid, jsonb, boolean, timestamptz, timestamptz),
  public.fail_tracking_feed(uuid, uuid, text)
to service_role;
