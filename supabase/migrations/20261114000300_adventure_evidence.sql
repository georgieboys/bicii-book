-- Adventures Phase B, slice 3: evidence (docs/ADVENTURES.md, ADR-026, PLAN
-- D175-D177; DATA-MODEL §20; handoff §13).
--
-- A confirmed booking gets one attempt (D172). The rider builds a draft
-- submission: activity files (GPX or FIT, their own recording) and
-- checkpoint photos, uploaded straight to the private bucket
-- adventure-evidence at a path the database allocated for their own draft
-- (prepare_my_adventure_upload), then confirmed (finalise_my_adventure_upload),
-- which reads the object's real size from Storage. The Admin's worker
-- (cron, service role) claims each uploaded activity file, parses it in
-- Node and stores the track (finish_adventure_parse). Request certification
-- (submit_my_adventure_evidence) freezes the submission: no file is added,
-- removed or replaced after that; a correction request (slice 4) opens a
-- new version that starts with the earlier files.
--
-- Access: riders reach only their own evidence through the my_* RPCs and
-- the bucket's policies; staff with verify_adventures or manage_adventures
-- read it (it holds where riders were). Nothing here certifies anyone.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.adventure_attempt_state as enum ('not_started', 'in_progress', 'finished', 'withdrawn');
create type public.adventure_submission_state as enum (
  'draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'rejected'
);
create type public.adventure_evidence_kind as enum ('activity', 'checkpoint_photo');
create type public.adventure_file_state as enum ('awaiting_upload', 'uploaded', 'parsing', 'parsed', 'failed', 'removed');

-- D175: protective limits, not eligibility rules (handoff §13.2).
create function private.adventure_evidence_limit(kind public.adventure_evidence_kind)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case kind when 'activity' then 26214400 else 15728640 end;  -- 25 MiB, 15 MiB
$$;
revoke all on function private.adventure_evidence_limit(public.adventure_evidence_kind)
  from public, anon, authenticated, service_role;

-- Who may read evidence: staff who verify or manage adventures.
create function private.can_read_adventure_evidence()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission('verify_adventures') or private.has_permission('manage_adventures');
$$;
revoke all on function private.can_read_adventure_evidence() from public, anon, authenticated, service_role;
grant execute on function private.can_read_adventure_evidence() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.adventure_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  attempt_number integer not null default 1 check (attempt_number between 1 and 20),
  state public.adventure_attempt_state not null default 'not_started',
  -- The recorded ride interval, from the submitted tracks' first and last
  -- timestamped points (handoff §4.2); never a click time.
  ride_started_at timestamptz null,
  ride_finished_at timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_attempts_number_unique unique (booking_id, attempt_number),
  constraint adventure_attempts_interval check (
    ride_started_at is null or ride_finished_at is null or ride_started_at <= ride_finished_at
  )
);
comment on table public.adventure_attempts is
  'D172: a rider''s attempt at the adventure under a confirmed booking (one at launch; retry policy is the owner''s).';

create trigger adventure_attempts_set_updated_at
  before update on public.adventure_attempts
  for each row execute function private.set_updated_at();

create table public.adventure_submissions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.adventure_attempts (id) on delete restrict,
  version integer not null check (version between 1 and 50),
  state public.adventure_submission_state not null default 'draft',
  rider_statement text not null default '' check (pg_catalog.char_length(rider_statement) <= 2000),
  submitted_at timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_submissions_version_unique unique (attempt_id, version),
  constraint adventure_submissions_submitted_at check ((state = 'draft') = (submitted_at is null))
);
create unique index adventure_submissions_one_draft on public.adventure_submissions (attempt_id)
  where state = 'draft';
create index adventure_submissions_queue_idx on public.adventure_submissions (state, submitted_at)
  where state in ('submitted', 'in_review');
comment on table public.adventure_submissions is
  'Handoff §13.4: one version of an attempt''s evidence. A draft until the rider requests certification; then frozen (its files never change).';

create trigger adventure_submissions_set_updated_at
  before update on public.adventure_submissions
  for each row execute function private.set_updated_at();

create table public.adventure_evidence_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.adventure_submissions (id) on delete restrict,
  kind public.adventure_evidence_kind not null,
  -- The checkpoint a photo is for (its position in the bought revision).
  checkpoint_position integer null check (checkpoint_position between 1 and 100),
  -- adventure-evidence/<booking id>/<file id>.<ext>; a later version that
  -- carries a file over keeps its path.
  storage_path text not null check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](gpx|fit|jpg|jpeg|png|webp|heic|heif)$'
  ),
  original_name text not null check (pg_catalog.char_length(original_name) between 1 and 200),
  content_type text not null check (pg_catalog.char_length(content_type) <= 100),
  declared_bytes bigint not null check (declared_bytes between 1 and 26214400),
  -- From Storage's own metadata at finalise, never the browser's word.
  size_bytes bigint null check (size_bytes between 1 and 26214400),
  sha256 text null check (sha256 ~ '^[0-9a-f]{64}$'),
  state public.adventure_file_state not null default 'awaiting_upload',
  parse_error text null check (pg_catalog.char_length(parse_error) <= 300),
  parser_version text null check (pg_catalog.char_length(parser_version) <= 40),
  parse_attempts integer not null default 0 check (parse_attempts between 0 and 10),
  claimed_until timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  uploaded_at timestamptz null,
  parsed_at timestamptz null,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_evidence_files_path_unique unique (submission_id, storage_path),
  constraint adventure_evidence_files_photo check ((kind = 'checkpoint_photo') = (checkpoint_position is not null))
);
create index adventure_evidence_files_submission_idx on public.adventure_evidence_files (submission_id, created_at);
create index adventure_evidence_files_path_idx on public.adventure_evidence_files (storage_path);
create index adventure_evidence_files_parse_idx on public.adventure_evidence_files (created_at)
  where kind = 'activity' and state in ('uploaded', 'parsing');
comment on table public.adventure_evidence_files is
  'Handoff §13.1-13.2: an uploaded activity file or checkpoint photo in the private bucket. Size and hash are server-verified; parsing is the worker''s.';

create trigger adventure_evidence_files_set_updated_at
  before update on public.adventure_evidence_files
  for each row execute function private.set_updated_at();

create table public.adventure_tracks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null unique references public.adventure_evidence_files (id) on delete restrict,
  point_count integer not null check (point_count between 0 and 200000),
  started_at timestamptz null,
  finished_at timestamptz null,
  -- Point to point, as recorded (handoff §13.3: a derived figure, labelled as such).
  distance_km public.distance_km not null check (distance_km >= 0),
  -- Every point has a time; a route-only file (no times) is not a ride.
  has_times boolean not null,
  source_format text not null check (source_format in ('gpx', 'fit')),
  created_at timestamptz not null default pg_catalog.now()
);
comment on table public.adventure_tracks is
  'A parsed activity file''s track: statistics and provenance; its points in adventure_track_points.';

create table public.adventure_track_points (
  track_id uuid not null references public.adventure_tracks (id) on delete restrict,
  seq integer not null check (seq >= 0),
  recorded_at timestamptz null,
  latitude public.geo_degrees not null check (latitude between -90 and 90),
  longitude public.geo_degrees not null check (longitude between -180 and 180),
  primary key (track_id, seq)
);
comment on table public.adventure_track_points is
  'Recorded positions of a track, in order; never interpolated (handoff §13.3).';

-- A submitted version never changes its files; tracks and points are written once.
create function private.adventure_evidence_files_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sub_state public.adventure_submission_state;
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_immutable',
      detail = 'Evidence is kept; it is never deleted.';
  end if;
  if new.submission_id <> old.submission_id or new.storage_path <> old.storage_path
     or new.kind <> old.kind or new.checkpoint_position is distinct from old.checkpoint_position then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_immutable',
      detail = 'A file''s place in the evidence never changes.';
  end if;
  select s.state into sub_state from public.adventure_submissions s where s.id = new.submission_id;
  -- After submission only the parse result of a file still being parsed may land.
  if sub_state <> 'draft' and (new.state = 'removed' or new.state = 'awaiting_upload'
       or (old.state in ('parsed', 'failed') and new.state <> old.state)) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_immutable',
      detail = 'Submitted evidence cannot change. Wait for a correction request.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_evidence_files_guard() from public, anon, authenticated, service_role;

create trigger adventure_evidence_files_guard
  before update or delete on public.adventure_evidence_files
  for each row execute function private.adventure_evidence_files_guard();

create function private.adventure_tracks_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'tracks and their points are written once' using errcode = '42501';
end;
$$;
revoke all on function private.adventure_tracks_append_only() from public, anon, authenticated, service_role;

create trigger adventure_tracks_append_only
  before update or delete on public.adventure_tracks
  for each row execute function private.adventure_tracks_append_only();
create trigger adventure_track_points_append_only
  before update or delete on public.adventure_track_points
  for each row execute function private.adventure_tracks_append_only();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.adventure_attempts enable row level security;
alter table public.adventure_submissions enable row level security;
alter table public.adventure_evidence_files enable row level security;
alter table public.adventure_tracks enable row level security;
alter table public.adventure_track_points enable row level security;

revoke all on table public.adventure_attempts, public.adventure_submissions, public.adventure_evidence_files,
  public.adventure_tracks, public.adventure_track_points
  from public, anon, authenticated, service_role;
grant select on table public.adventure_attempts, public.adventure_submissions, public.adventure_evidence_files,
  public.adventure_tracks, public.adventure_track_points
  to authenticated;

create policy adventure_attempts_select_staff on public.adventure_attempts
  for select to authenticated using ((select private.is_staff()));
create policy adventure_submissions_select_staff on public.adventure_submissions
  for select to authenticated using ((select private.is_staff()));
-- Where riders were: only staff who verify or manage adventures.
create policy adventure_evidence_files_select_staff on public.adventure_evidence_files
  for select to authenticated using ((select private.can_read_adventure_evidence()));
create policy adventure_tracks_select_staff on public.adventure_tracks
  for select to authenticated using ((select private.can_read_adventure_evidence()));
create policy adventure_track_points_select_staff on public.adventure_track_points
  for select to authenticated using ((select private.can_read_adventure_evidence()));

-- ---------------------------------------------------------------------------
-- The private bucket (D175)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'adventure-evidence', 'adventure-evidence', false, 26214400,
  array[
    'application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream', 'application/vnd.ant.fit',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  ]
)
on conflict (id) do nothing;

-- An upload is allowed only to a path allocated to the caller's own draft
-- and not yet uploaded (no overwrite: there is no UPDATE policy).
create function private.adventure_upload_allowed(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.adventure_evidence_files f
    join public.adventure_submissions s on s.id = f.submission_id
    join public.adventure_attempts t on t.id = s.attempt_id
    join public.adventure_bookings b on b.id = t.booking_id
    where f.storage_path = adventure_upload_allowed.object_name
      and f.state = 'awaiting_upload'
      and s.state = 'draft'
      and b.customer_id = private.current_customer_id()
  );
$$;

-- A rider reads their own evidence; verifying staff read all of it.
create function private.adventure_evidence_readable(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_read_adventure_evidence() or exists (
    select 1
    from public.adventure_evidence_files f
    join public.adventure_submissions s on s.id = f.submission_id
    join public.adventure_attempts t on t.id = s.attempt_id
    join public.adventure_bookings b on b.id = t.booking_id
    where f.storage_path = adventure_evidence_readable.object_name
      and b.customer_id = private.current_customer_id()
  );
$$;

revoke all on function private.adventure_upload_allowed(text), private.adventure_evidence_readable(text)
  from public, anon, authenticated, service_role;
grant execute on function private.adventure_upload_allowed(text), private.adventure_evidence_readable(text)
  to authenticated;

create policy adventure_evidence_insert_owner on storage.objects
  for insert to authenticated
  with check (bucket_id = 'adventure-evidence' and private.adventure_upload_allowed(name));
create policy adventure_evidence_select on storage.objects
  for select to authenticated
  using (bucket_id = 'adventure-evidence' and private.adventure_evidence_readable(name));

-- ---------------------------------------------------------------------------
-- The rider's evidence
-- ---------------------------------------------------------------------------

-- The caller's confirmed booking, locked, with its attempt and open draft
-- (created when missing). Refuses bookings that are not theirs or not paid.
create function private.my_adventure_draft(booking_id uuid)
returns public.adventure_submissions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  booking public.adventure_bookings;
  attempt public.adventure_attempts;
  latest public.adventure_submissions;
  draft public.adventure_submissions;
begin
  select b.* into booking from public.adventure_bookings b
  where b.id = my_adventure_draft.booking_id and b.customer_id = me
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if booking.status <> 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_not_paid',
      detail = 'Evidence can be added once the booking is paid.';
  end if;

  select a.* into attempt from public.adventure_attempts a
  where a.booking_id = booking.id order by a.attempt_number desc limit 1;
  if not found then
    insert into public.adventure_attempts (booking_id) values (booking.id) returning * into attempt;
  end if;

  select s.* into draft from public.adventure_submissions s where s.attempt_id = attempt.id and s.state = 'draft';
  if found then
    return draft;
  end if;
  select s.* into latest from public.adventure_submissions s
  where s.attempt_id = attempt.id order by s.version desc limit 1;
  if found and latest.state <> 'changes_requested' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_submission_locked',
      detail = case latest.state
        when 'approved' then 'This ride is certified.'
        when 'rejected' then 'This ride was not certified.'
        else 'Your evidence is with BICII for review.'
      end;
  end if;

  insert into public.adventure_submissions (attempt_id, version)
  values (attempt.id, coalesce(latest.version, 0) + 1)
  returning * into draft;
  -- A correction starts with the earlier files (the same stored objects).
  -- Activity files are read again for the new version (a track belongs to
  -- one file row); photos carry over as they are.
  if latest.id is not null then
    insert into public.adventure_evidence_files (
      submission_id, kind, checkpoint_position, storage_path, original_name, content_type, declared_bytes,
      size_bytes, state, uploaded_at
    )
    select draft.id, f.kind, f.checkpoint_position, f.storage_path, f.original_name, f.content_type, f.declared_bytes,
           f.size_bytes, 'uploaded', f.uploaded_at
    from public.adventure_evidence_files f
    where f.submission_id = latest.id and f.state in ('uploaded', 'parsed', 'failed');
  else
    insert into public.adventure_booking_events (booking_id, kind) values (booking.id, 'evidence_started');
  end if;
  return draft;
end;
$$;
revoke all on function private.my_adventure_draft(uuid) from public, anon, authenticated, service_role;

-- Allocates a private path for one file in the caller's draft.
create function public.prepare_my_adventure_upload(
  booking_id uuid,
  kind public.adventure_evidence_kind,
  checkpoint_position integer,
  original_name text,
  content_type text,
  declared_bytes bigint
)
returns table (file_id uuid, storage_path text, max_bytes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  draft public.adventure_submissions := private.my_adventure_draft(prepare_my_adventure_upload.booking_id);
  file_name text := pg_catalog.btrim(coalesce(prepare_my_adventure_upload.original_name, ''));
  ext text := pg_catalog.lower(pg_catalog.substring(file_name, '[.]([A-Za-z0-9]{2,5})$'));
  limit_bytes bigint := private.adventure_evidence_limit(prepare_my_adventure_upload.kind);
  new_id uuid := gen_random_uuid();
  path text;
  file_count integer;
  total_bytes bigint;
begin
  if prepare_my_adventure_upload.kind = 'activity' and coalesce(ext, '') not in ('gpx', 'fit') then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_type',
      detail = 'Upload your ride as a GPX or FIT file.';
  end if;
  if prepare_my_adventure_upload.kind = 'checkpoint_photo' and coalesce(ext, '') not in ('jpg', 'jpeg', 'png', 'webp', 'heic', 'heif') then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_type',
      detail = 'Upload a photo (JPEG, PNG, WebP or HEIC).';
  end if;
  if prepare_my_adventure_upload.declared_bytes is null or prepare_my_adventure_upload.declared_bytes < 1
     or prepare_my_adventure_upload.declared_bytes > limit_bytes then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_too_large',
      detail = case when prepare_my_adventure_upload.kind = 'activity'
        then 'Ride files can be up to 25 MB. Ask BICII if yours is bigger.'
        else 'Photos can be up to 15 MB.' end;
  end if;
  if prepare_my_adventure_upload.kind = 'checkpoint_photo' and not exists (
    select 1
    from public.adventure_attempts t
    join public.adventure_bookings b on b.id = t.booking_id
    join public.adventure_checkpoints c on c.revision_id = b.revision_id
    where t.id = draft.attempt_id and c.position = prepare_my_adventure_upload.checkpoint_position
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_checkpoint_unknown',
      detail = 'Choose which checkpoint the photo is for.';
  end if;
  select pg_catalog.count(*), coalesce(pg_catalog.sum(coalesce(f.size_bytes, f.declared_bytes)), 0)
  into file_count, total_bytes
  from public.adventure_evidence_files f
  where f.submission_id = draft.id and f.state <> 'removed';
  if file_count >= 100 or total_bytes + prepare_my_adventure_upload.declared_bytes > 262144000 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_full',
      detail = 'This submission has reached its limit of 100 files or 250 MB. Ask BICII for help.';
  end if;

  path := (select t.booking_id::text from public.adventure_attempts t where t.id = draft.attempt_id)
          || '/' || new_id::text || '.' || ext;
  insert into public.adventure_evidence_files (
    id, submission_id, kind, checkpoint_position, storage_path, original_name, content_type, declared_bytes
  )
  values (
    new_id, draft.id, prepare_my_adventure_upload.kind,
    case when prepare_my_adventure_upload.kind = 'checkpoint_photo' then prepare_my_adventure_upload.checkpoint_position end,
    path, pg_catalog.left(file_name, 200), pg_catalog.left(coalesce(prepare_my_adventure_upload.content_type, ''), 100),
    prepare_my_adventure_upload.declared_bytes
  );
  return query select new_id, path, limit_bytes;
end;
$$;

-- Confirms an upload: the object must exist; its size comes from Storage.
create function public.finalise_my_adventure_upload(file_id uuid)
returns public.adventure_evidence_files
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  f public.adventure_evidence_files;
  actual bigint;
begin
  select ef.* into f
  from public.adventure_evidence_files ef
  join public.adventure_submissions s on s.id = ef.submission_id
  join public.adventure_attempts t on t.id = s.attempt_id
  join public.adventure_bookings b on b.id = t.booking_id
  where ef.id = finalise_my_adventure_upload.file_id and b.customer_id = me
  for update of ef;
  if not found then
    raise exception 'file not owned' using errcode = '42501';
  end if;
  if f.state <> 'awaiting_upload' then
    return f;  -- already confirmed
  end if;
  select (o.metadata ->> 'size')::bigint into actual
  from storage.objects o
  where o.bucket_id = 'adventure-evidence' and o.name = f.storage_path;
  if actual is null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_upload_missing',
      detail = 'The file did not arrive. Upload it again.';
  end if;
  if actual > private.adventure_evidence_limit(f.kind) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_too_large',
      detail = 'The file is larger than allowed.';
  end if;
  update public.adventure_evidence_files ef
  set state = 'uploaded', size_bytes = actual, uploaded_at = pg_catalog.now()
  where ef.id = f.id
  returning ef.* into f;
  return f;
end;
$$;

create function public.remove_my_adventure_file(file_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  f public.adventure_evidence_files;
  sub_state public.adventure_submission_state;
begin
  select ef.* into f
  from public.adventure_evidence_files ef
  join public.adventure_submissions s on s.id = ef.submission_id
  join public.adventure_attempts t on t.id = s.attempt_id
  join public.adventure_bookings b on b.id = t.booking_id
  where ef.id = remove_my_adventure_file.file_id and b.customer_id = me
  for update of ef;
  if not found then
    raise exception 'file not owned' using errcode = '42501';
  end if;
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

-- Request certification: freezes the draft (handoff §13.4).
create function public.submit_my_adventure_evidence(booking_id uuid, rider_statement text)
returns public.adventure_submissions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  draft public.adventure_submissions := private.my_adventure_draft(submit_my_adventure_evidence.booking_id);
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
  if not exists (
    select 1
    from public.adventure_evidence_files f
    join public.adventure_tracks k on k.file_id = f.id
    where f.submission_id = draft.id and f.state = 'parsed' and k.has_times and k.point_count > 1
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_incomplete',
      detail = 'Add your ride''s recording (a GPX or FIT file with times) before requesting certification.';
  end if;

  select pg_catalog.min(k.started_at), pg_catalog.max(k.finished_at) into first_point, last_point
  from public.adventure_evidence_files f
  join public.adventure_tracks k on k.file_id = f.id
  where f.submission_id = draft.id and f.state = 'parsed' and k.has_times;

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

-- The caller's evidence for a booking: the latest submission and its files.
create function public.my_adventure_evidence(booking_id uuid)
returns table (
  submission_id uuid,
  version integer,
  state public.adventure_submission_state,
  rider_statement text,
  submitted_at timestamptz,
  files jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.version, s.state, s.rider_statement, s.submitted_at,
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', f.id, 'kind', f.kind, 'checkpoint_position', f.checkpoint_position,
             'name', f.original_name, 'state', f.state, 'size_bytes', f.size_bytes,
             'error', f.parse_error, 'storage_path', f.storage_path,
             'track', (select pg_catalog.jsonb_build_object(
                'distance_km', k.distance_km, 'started_at', k.started_at, 'finished_at', k.finished_at,
                'points', k.point_count, 'has_times', k.has_times)
               from public.adventure_tracks k where k.file_id = f.id)
           ) order by f.created_at, f.id)
           from public.adventure_evidence_files f
           where f.submission_id = s.id and f.state <> 'removed'
         ), '[]'::jsonb)
  from public.adventure_bookings b
  join public.adventure_attempts t on t.booking_id = b.id
  join public.adventure_submissions s on s.attempt_id = t.id
  where b.id = my_adventure_evidence.booking_id
    and b.customer_id = private.require_customer()
  order by t.attempt_number desc, s.version desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- The parse worker (service role)
-- ---------------------------------------------------------------------------
create function public.claim_adventure_parse_jobs(max_jobs integer)
returns table (file_id uuid, storage_path text, original_name text, attempts integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- Files whose three attempts ran out without a result fail visibly.
  update public.adventure_evidence_files f
  set state = 'failed', parse_error = 'This file could not be read. Try exporting it again.', claimed_until = null
  where f.kind = 'activity' and f.state = 'parsing' and f.claimed_until < pg_catalog.now() and f.parse_attempts >= 3;

  return query
    with picked as (
      select f.id
      from public.adventure_evidence_files f
      where f.kind = 'activity'
        and (f.state = 'uploaded' or (f.state = 'parsing' and f.claimed_until < pg_catalog.now()))
      order by f.created_at, f.id
      limit greatest(1, least(coalesce(claim_adventure_parse_jobs.max_jobs, 1), 10))
      for update skip locked
    )
    update public.adventure_evidence_files f
    set state = 'parsing', parse_attempts = f.parse_attempts + 1,
        claimed_until = pg_catalog.now() + interval '5 minutes'
    from picked
    where f.id = picked.id
    returning f.id, f.storage_path, f.original_name, f.parse_attempts;
end;
$$;

-- The worker's result. track: {format, started_at, finished_at, distance_km,
-- has_times, points: [[iso time or null, lat, lon], ...]} (at most 200,000).
create function public.finish_adventure_parse(
  file_id uuid,
  ok boolean,
  error text,
  sha256 text,
  parser_version text,
  track jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.adventure_evidence_files;
  new_track uuid;
  n integer;
begin
  select ef.* into f from public.adventure_evidence_files ef where ef.id = finish_adventure_parse.file_id for update;
  if not found or f.state <> 'parsing' then
    return;  -- a late or duplicate result
  end if;
  if not finish_adventure_parse.ok then
    update public.adventure_evidence_files ef
    set state = 'failed', claimed_until = null,
        parse_error = pg_catalog.left(coalesce(finish_adventure_parse.error, 'This file could not be read.'), 300),
        sha256 = coalesce(finish_adventure_parse.sha256, ef.sha256),
        parser_version = pg_catalog.left(finish_adventure_parse.parser_version, 40), parsed_at = pg_catalog.now()
    where ef.id = f.id;
    return;
  end if;

  n := pg_catalog.jsonb_array_length(coalesce(finish_adventure_parse.track -> 'points', '[]'::jsonb));
  if n > 200000 then
    raise exception 'too many points' using errcode = '22023';
  end if;
  insert into public.adventure_tracks (file_id, point_count, started_at, finished_at, distance_km, has_times, source_format)
  values (
    f.id, n,
    (finish_adventure_parse.track ->> 'started_at')::timestamptz,
    (finish_adventure_parse.track ->> 'finished_at')::timestamptz,
    (finish_adventure_parse.track ->> 'distance_km')::numeric,
    coalesce((finish_adventure_parse.track ->> 'has_times')::boolean, false),
    finish_adventure_parse.track ->> 'format'
  )
  returning id into new_track;
  insert into public.adventure_track_points (track_id, seq, recorded_at, latitude, longitude)
  select new_track, (p.ord - 1)::integer, nullif(p.value ->> 0, '')::timestamptz,
         (p.value ->> 1)::numeric, (p.value ->> 2)::numeric
  from pg_catalog.jsonb_array_elements(finish_adventure_parse.track -> 'points') with ordinality as p (value, ord);

  update public.adventure_evidence_files ef
  set state = 'parsed', claimed_until = null, parse_error = null,
      sha256 = finish_adventure_parse.sha256,
      parser_version = pg_catalog.left(finish_adventure_parse.parser_version, 40), parsed_at = pg_catalog.now()
  where ef.id = f.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.prepare_my_adventure_upload(uuid, public.adventure_evidence_kind, integer, text, text, bigint),
  public.finalise_my_adventure_upload(uuid),
  public.remove_my_adventure_file(uuid),
  public.submit_my_adventure_evidence(uuid, text),
  public.my_adventure_evidence(uuid),
  public.claim_adventure_parse_jobs(integer),
  public.finish_adventure_parse(uuid, boolean, text, text, text, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  public.prepare_my_adventure_upload(uuid, public.adventure_evidence_kind, integer, text, text, bigint),
  public.finalise_my_adventure_upload(uuid),
  public.remove_my_adventure_file(uuid),
  public.submit_my_adventure_evidence(uuid, text),
  public.my_adventure_evidence(uuid)
to authenticated;
grant execute on function
  public.claim_adventure_parse_jobs(integer),
  public.finish_adventure_parse(uuid, boolean, text, text, text, jsonb)
to service_role;
