-- Adventures Phase C, the hired tracker as evidence (D191; DATA-MODEL §20
-- "Tracking feed"; handoff §6.3, §13).
--
--   * A rider who hired a tracker may send their ride without uploading a
--     file once the ride is finished (Finish Ride, or a staff correction)
--     and at least two positions were attributed to it. Uploaded files are
--     still accepted alongside, or instead (a feed outage, a missed Start).
--   * The recorded ride interval takes the earliest and latest timed point
--     across files and the tracker.
--   * The review workspace reads the tracker's points like a file's: a
--     thinned outline, a summary (points, first and last, point-to-point
--     distance, the ride window), and checkpoint passes over both. All
--     security invoker: the evidence RLS decides who gets rows.

create or replace function public.submit_my_adventure_evidence(booking_id uuid, rider_statement text)
returns public.adventure_submissions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  draft public.adventure_submissions := private.my_adventure_draft(submit_my_adventure_evidence.booking_id);
  attempt public.adventure_attempts;
  has_file boolean;
  tracker_points integer;
  first_point timestamptz;
  last_point timestamptz;
begin
  if exists (
    select 1 from public.adventure_evidence_files f
    where f.submission_id = draft.id
      and (f.state in ('awaiting_upload', 'parsing') or (f.kind = 'activity' and f.state = 'uploaded'))
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_processing',
      detail = 'Your files are still being uploaded or read. Try again in a minute.';
  end if;
  select t.* into attempt from public.adventure_attempts t where t.id = draft.attempt_id;
  has_file := exists (
    select 1
    from public.adventure_evidence_files f
    join public.adventure_tracks k on k.file_id = f.id
    where f.submission_id = draft.id and f.state = 'parsed' and k.has_times and k.point_count > 1
  );
  select pg_catalog.count(*)::integer into tracker_points
  from public.tracking_messages m where m.attempt_id = attempt.id and m.latitude is not null;

  if not has_file then
    if tracker_points >= 2 and attempt.capture_finished_at is null then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_ride_still_open',
        detail = 'Press Finish Ride before sending your ride.';
    end if;
    if tracker_points < 2 then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_evidence_incomplete',
        detail = 'Add your ride''s recording (a GPX or FIT file with times) before requesting certification.';
    end if;
  end if;

  select pg_catalog.min(x.first_at), pg_catalog.max(x.last_at) into first_point, last_point
  from (
    select k.started_at as first_at, k.finished_at as last_at
    from public.adventure_evidence_files f
    join public.adventure_tracks k on k.file_id = f.id
    where f.submission_id = draft.id and f.state = 'parsed' and k.has_times
    union all
    select pg_catalog.min(m.recorded_at), pg_catalog.max(m.recorded_at)
    from public.tracking_messages m
    where m.attempt_id = attempt.id and m.latitude is not null
  ) x;

  update public.adventure_submissions s
  set state = 'submitted', submitted_at = pg_catalog.now(),
      rider_statement = coalesce(pg_catalog.left(pg_catalog.btrim(submit_my_adventure_evidence.rider_statement), 2000), '')
  where s.id = draft.id
  returning s.* into draft;
  update public.adventure_attempts t
  set state = 'finished', ride_started_at = first_point, ride_finished_at = last_point
  where t.id = draft.attempt_id;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (submit_my_adventure_evidence.booking_id, 'evidence_submitted',
          pg_catalog.jsonb_build_object('version', draft.version));
  return draft;
end;
$$;

-- The tracker's points on the submission's attempt, thinned for drawing.
create function public.adventure_tracker_outline(submission_id uuid, max_points integer)
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
  )
  select p.recorded_at, p.latitude::numeric, p.longitude::numeric
  from pts p
  where p.n % greatest(1, pg_catalog.ceil(p.total::numeric / greatest(2, least(adventure_tracker_outline.max_points, 1000))))::integer = 0
     or p.n = p.total - 1
  order by p.recorded_at;
$$;

-- Its figures: points, first and last, point-to-point distance, the window.
create function public.adventure_tracker_summary(submission_id uuid)
returns table (
  attempt_id uuid, points integer, first_at timestamptz, last_at timestamptz, distance_km numeric,
  capture_started_at timestamptz, capture_finished_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with a as (
    select t.id, t.capture_started_at, t.capture_finished_at
    from public.adventure_submissions s
    join public.adventure_attempts t on t.id = s.attempt_id
    where s.id = adventure_tracker_summary.submission_id
      and (select private.can_read_adventure_evidence())
  ),
  pts as (
    select m.recorded_at, m.latitude::double precision as lat, m.longitude::double precision as lon,
           pg_catalog.lag(m.latitude::double precision) over (order by m.recorded_at) as plat,
           pg_catalog.lag(m.longitude::double precision) over (order by m.recorded_at) as plon
    from public.tracking_messages m
    join a on m.attempt_id = a.id
    where m.latitude is not null
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
         a.capture_started_at, a.capture_finished_at
  from a;
$$;

-- Checkpoint passes now look at the tracker's points too.
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
    select b.revision_id, s.attempt_id
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
    where m.latitude is not null
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

revoke all on function public.adventure_tracker_outline(uuid, integer), public.adventure_tracker_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.adventure_tracker_outline(uuid, integer), public.adventure_tracker_summary(uuid)
  to authenticated;
