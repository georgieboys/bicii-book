-- Adventures Phase F, closing the handoff's acceptance gaps (D208-D211;
-- handoff §20.3-§20.5):
--
--   * E09 (D208): a decided ride's tracker evidence is frozen. The tracker
--     summary, outline and checkpoint passes for a submission that has a
--     decision count only the points received before that decision. Points
--     that arrive later stay with the ride (T06) and are counted as
--     `late_points`, so staff can see them, but they never change what was
--     reviewed or certified.
--   * E03 (D208): the summary says when the tracker's points are sparse
--     (a median gap over two minutes, as SPOT's five-minute tracking is),
--     so the review shows the distance as approximate.
--   * E02 (D209): a recording that is byte-for-byte a file already read on
--     the same version is refused as a duplicate, so the same ride can't
--     be counted twice.
--   * S07 (D210): when a tracker leaves service (maintenance, lost,
--     retired), every hire whose days the remaining fleet can no longer
--     cover is flagged for staff, with the reason.
--   * A09 (D211): an admin can put failed adventure emails back in the
--     queue. Nothing about the booking or certificate changes.

-- ---------------------------------------------------------------------------
-- E09, E03: tracker evidence as it stood at the decision
-- ---------------------------------------------------------------------------
-- When the submission was decided, or infinity while it is not.
create function private.tracker_evidence_cutoff(submission uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.min(r.decided_at) from public.adventure_reviews r where r.submission_id = submission),
    'infinity'::timestamptz
  );
$$;
revoke all on function private.tracker_evidence_cutoff(uuid) from public, anon, authenticated, service_role;
grant execute on function private.tracker_evidence_cutoff(uuid) to authenticated;

drop function public.adventure_tracker_summary(uuid);
create function public.adventure_tracker_summary(submission_id uuid)
returns table (
  attempt_id uuid, points integer, first_at timestamptz, last_at timestamptz, distance_km numeric,
  capture_started_at timestamptz, capture_finished_at timestamptz, approximate boolean, late_points integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with a as (
    select t.id, t.capture_started_at, t.capture_finished_at,
           private.tracker_evidence_cutoff(s.id) as cutoff
    from public.adventure_submissions s
    join public.adventure_attempts t on t.id = s.attempt_id
    where s.id = adventure_tracker_summary.submission_id
      and (select private.can_read_adventure_evidence())
  ),
  pts as (
    select m.recorded_at, m.latitude::double precision as lat, m.longitude::double precision as lon,
           pg_catalog.lag(m.latitude::double precision) over (order by m.recorded_at) as plat,
           pg_catalog.lag(m.longitude::double precision) over (order by m.recorded_at) as plon,
           pg_catalog.lag(m.recorded_at) over (order by m.recorded_at) as pat
    from public.tracking_messages m
    join a on m.attempt_id = a.id
    where m.latitude is not null and m.received_at <= a.cutoff
  )
  select a.id,
         (select pg_catalog.count(*)::integer from pts),
         (select pg_catalog.min(recorded_at) from pts),
         (select pg_catalog.max(recorded_at) from pts),
         (select pg_catalog.round(coalesce(pg_catalog.sum(
            2 * 6371.0088 * pg_catalog.asin(least(1, pg_catalog.sqrt(
              pg_catalog.power(pg_catalog.sin(pg_catalog.radians(lat - plat) / 2), 2)
              + pg_catalog.cos(pg_catalog.radians(plat)) * pg_catalog.cos(pg_catalog.radians(lat))
                * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(lon - plon) / 2), 2))))
          ) filter (where plat is not null), 0)::numeric, 1) from pts),
         a.capture_started_at, a.capture_finished_at,
         coalesce((select pg_catalog.percentile_cont(0.5) within group (
                     order by pg_catalog.date_part('epoch', recorded_at - pat))
                   from pts where pat is not null) > 120, false),
         (select pg_catalog.count(*)::integer from public.tracking_messages m
           where m.attempt_id = a.id and m.latitude is not null and m.received_at > a.cutoff)
  from a;
$$;

create or replace function public.adventure_tracker_outline(submission_id uuid, max_points integer)
returns table (recorded_at timestamptz, latitude numeric, longitude numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with pts as (
    select m.recorded_at, m.latitude, m.longitude,
           pg_catalog.row_number() over (order by m.recorded_at) - 1 as n,
           pg_catalog.count(*) over () as total
    from public.adventure_submissions s
    join public.tracking_messages m on m.attempt_id = s.attempt_id
    where s.id = adventure_tracker_outline.submission_id and m.latitude is not null
      and m.received_at <= private.tracker_evidence_cutoff(s.id)
  )
  select p.recorded_at, p.latitude::numeric, p.longitude::numeric
  from pts p
  where p.n % greatest(1, pg_catalog.ceil(p.total::numeric / greatest(2, least(adventure_tracker_outline.max_points, 1000))))::integer = 0
     or p.n = p.total - 1
  order by p.recorded_at;
$$;

create or replace function public.adventure_checkpoint_passes(submission_id uuid)
returns table (
  checkpoint_position integer,
  label text,
  latitude numeric,
  longitude numeric,
  review_radius_m integer,
  mandatory boolean,
  photo_required boolean,
  nearest_m numeric,
  nearest_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with sub as (
    select b.revision_id, s.attempt_id, private.tracker_evidence_cutoff(s.id) as cutoff
    from public.adventure_submissions s
    join public.adventure_attempts a on a.id = s.attempt_id
    join public.adventure_bookings b on b.id = a.booking_id
    where s.id = adventure_checkpoint_passes.submission_id
      and (select private.can_read_adventure_evidence())
  ),
  pts as (
    select p.latitude, p.longitude, p.recorded_at
    from public.adventure_evidence_files f
    join public.adventure_tracks k on k.file_id = f.id
    join public.adventure_track_points p on p.track_id = k.id
    where f.submission_id = adventure_checkpoint_passes.submission_id
      and f.state = 'parsed'
    union all
    select m.latitude, m.longitude, m.recorded_at
    from public.tracking_messages m
    join sub on m.attempt_id = sub.attempt_id
    where m.latitude is not null and m.received_at <= sub.cutoff
  )
  select c.position, c.label, c.latitude, c.longitude, c.review_radius_m, c.mandatory, c.photo_required,
         n.metres, n.recorded_at
  from public.adventure_checkpoints c
  join sub on sub.revision_id = c.revision_id
  left join lateral (
    select pg_catalog.round((2 * 6371008.8 * pg_catalog.asin(least(1, pg_catalog.sqrt(
             pg_catalog.power(pg_catalog.sin(pg_catalog.radians((pts.latitude - c.latitude)::double precision) / 2), 2)
             + pg_catalog.cos(pg_catalog.radians(c.latitude::double precision))
               * pg_catalog.cos(pg_catalog.radians(pts.latitude::double precision))
               * pg_catalog.power(pg_catalog.sin(pg_catalog.radians((pts.longitude - c.longitude)::double precision) / 2), 2)
           ))))::numeric, 0) as metres,
           pts.recorded_at
    from pts
    where c.latitude is not null and c.longitude is not null
    order by 1
    limit 1
  ) n on true
  order by c.position;
$$;

revoke all on function public.adventure_tracker_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.adventure_tracker_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- E02: the same file twice on one version is refused
-- ---------------------------------------------------------------------------
create function private.adventure_evidence_files_no_duplicate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state = 'parsed' and new.sha256 is not null and exists (
    select 1 from public.adventure_evidence_files f
    where f.submission_id = new.submission_id and f.id <> new.id
      and f.state = 'parsed' and f.sha256 = new.sha256
  ) then
    new.state := 'failed';
    new.parse_error := 'This file is already added to this ride.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_evidence_files_no_duplicate() from public, anon, authenticated, service_role;
create trigger adventure_evidence_files_no_duplicate
  before update of state on public.adventure_evidence_files
  for each row execute function private.adventure_evidence_files_no_duplicate();

-- ---------------------------------------------------------------------------
-- S07: hires the fleet can no longer cover are flagged
-- ---------------------------------------------------------------------------
create function private.tracking_devices_flag_short_hires()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.service_state = 'in_service' and new.service_state <> 'in_service' then
    update public.adventure_bookings b
    set needs_attention = true,
        attention_reason = 'Not enough trackers in service for this hire''s days.'
    from public.tracker_reservations r
    where r.booking_id = b.id
      and r.status = 'confirmed'
      and r.return_on > private.shop_today()
      and not b.needs_attention
      and not exists (select 1 from public.tracker_assignments x where x.reservation_id = r.id)
      and private.trackers_free(greatest(r.collect_on, private.shop_today()), r.return_on) < 0;
  end if;
  return new;
end;
$$;
revoke all on function private.tracking_devices_flag_short_hires() from public, anon, authenticated, service_role;
create trigger tracking_devices_flag_short_hires
  after update of service_state on public.tracking_devices
  for each row execute function private.tracking_devices_flag_short_hires();

-- ---------------------------------------------------------------------------
-- A09: failed adventure emails back in the queue
-- ---------------------------------------------------------------------------
create function public.retry_failed_adventure_notices()
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
  where x.status = 'failed';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.retry_failed_adventure_notices() from public, anon, authenticated, service_role;
grant execute on function public.retry_failed_adventure_notices() to authenticated;
