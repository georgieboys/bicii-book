-- Fixes from the 2026-11-14 audit, medium findings on evidence, emails and
-- names (D228-D231):
--
--   * D228: ride files are claimed one at a time and an attempt the worker
--     could not start (deadline, Storage or database trouble) is released,
--     so only a file that really fails to read uses up its three tries.
--     Staff can ask for a failed file in a rider's open version to be read
--     again. A file whose upload never finished stops blocking "send" after
--     15 minutes.
--   * D230: evidence limits hold on what arrives: finalise refuses an object
--     larger than declared, a version over 250 MB, or a checkpoint photo
--     that is not an image; a booking can add at most 300 different files over its life
--     (removed ones count); objects of removed or abandoned files are deleted
--     from Storage by the cron.
--   * D229: board names are normalised (NFKC) and refuse invisible and
--     direction characters and the words BICII, Official, Staff and Admin
--     (the owner's choice); a name staff take down stays locked until an
--     admin unlocks it.
--   * D231: a repeated cancellation request within a day records nothing
--     new, and joining the same date again within a day sends no new email.

-- ---------------------------------------------------------------------------
-- D228: one file at a time; unstarted attempts are released; requeue
-- ---------------------------------------------------------------------------
create or replace function public.claim_adventure_parse_jobs(max_jobs integer)
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

  -- The worker claims one file at a time (max_jobs 1) and starts it at once,
  -- so an attempt is never spent on waiting behind another file.
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

-- The worker could not start or finish a file for a reason that is not the
-- file's (Storage, the database, the deadline): the attempt is given back.
create function public.release_adventure_parse(file_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.adventure_evidence_files f
  set state = 'uploaded', parse_attempts = greatest(0, f.parse_attempts - 1), claimed_until = null
  where f.id = release_adventure_parse.file_id and f.state = 'parsing';
$$;
revoke all on function public.release_adventure_parse(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_adventure_parse(uuid) to service_role;

-- Staff who verify or manage adventures ask for a failed recording in a
-- rider's open version to be read again.
create function public.requeue_adventure_file(file_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.adventure_evidence_files;
begin
  if not (select private.can_read_adventure_evidence()) then
    raise exception 'verify_adventures or manage_adventures required' using errcode = '42501';
  end if;
  select x.* into f from public.adventure_evidence_files x where x.id = requeue_adventure_file.file_id for update;
  if not found then
    raise exception 'file % not found', requeue_adventure_file.file_id using errcode = 'P0002';
  end if;
  if f.kind <> 'activity' or f.state <> 'failed'
     or (select s.state from public.adventure_submissions s where s.id = f.submission_id) <> 'draft' then
    raise exception using errcode = 'P0001', message = 'adventure_file_not_requeueable',
      detail = 'Only a recording that could not be read, in a version not yet sent, can be read again.';
  end if;
  update public.adventure_evidence_files x
  set state = 'uploaded', parse_attempts = 0, parse_error = null, claimed_until = null
  where x.id = f.id;
end;
$$;
revoke all on function public.requeue_adventure_file(uuid) from public, anon, authenticated, service_role;
grant execute on function public.requeue_adventure_file(uuid) to authenticated;

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
  -- A file whose upload never finished (over 15 minutes ago) is dropped, so
  -- an abandoned upload never blocks sending the ride (audit A-56).
  update public.adventure_evidence_files f
  set state = 'removed'
  where f.submission_id = draft.id and f.state = 'awaiting_upload'
    and f.created_at < pg_catalog.now() - interval '15 minutes';
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

-- ---------------------------------------------------------------------------
-- D230: limits on what arrives, and objects deleted when unused
-- ---------------------------------------------------------------------------
alter table public.adventure_evidence_files add column object_deleted_at timestamptz null;

create or replace function private.adventure_evidence_files_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sub_state public.adventure_submission_state;
begin
  -- Recording that a removed file's object left Storage changes nothing else.
  if tg_op = 'UPDATE'
     and (pg_catalog.to_jsonb(new) - 'object_deleted_at' - 'updated_at')
       = (pg_catalog.to_jsonb(old) - 'object_deleted_at' - 'updated_at') then
    return new;
  end if;
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

create or replace function public.finalise_my_adventure_upload(file_id uuid)
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
  mimetype text;
  version_total bigint;
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
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into actual, mimetype
  from storage.objects o
  where o.bucket_id = 'adventure-evidence' and o.name = f.storage_path;
  if actual is null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_upload_missing',
      detail = 'The file did not arrive. Upload it again.';
  end if;
  if actual > private.adventure_evidence_limit(f.kind) or actual > f.declared_bytes then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_too_large',
      detail = 'The file is larger than allowed.';
  end if;
  -- A checkpoint photo must arrive as an image (staff open it in the
  -- review); a recording is checked by reading it.
  if f.kind = 'checkpoint_photo' and coalesce(pg_catalog.lower(mimetype), '') !~ '^image/' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_file_type',
      detail = 'A checkpoint photo must be an image. Upload it again.';
  end if;
  select coalesce(pg_catalog.sum(x.size_bytes), 0) into version_total
  from public.adventure_evidence_files x
  where x.submission_id = f.submission_id and x.state not in ('removed', 'awaiting_upload') and x.id <> f.id;
  if version_total + actual > 262144000 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_evidence_full',
      detail = 'This submission has reached its limit of 100 files or 250 MB. Ask BICII for help.';
  end if;
  update public.adventure_evidence_files ef
  set state = 'uploaded', size_bytes = actual, uploaded_at = pg_catalog.now()
  where ef.id = f.id
  returning ef.* into f;
  return f;
end;
$$;

-- A booking adds at most 300 different files over its life (a version's
-- carried-over files share their path and count once; removed ones count).
create function private.adventure_evidence_files_lifetime_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking uuid;
  paths integer;
begin
  select t.booking_id into booking
  from public.adventure_submissions s join public.adventure_attempts t on t.id = s.attempt_id
  where s.id = new.submission_id;
  select pg_catalog.count(distinct f.storage_path) into paths
  from public.adventure_evidence_files f
  join public.adventure_submissions s on s.id = f.submission_id
  join public.adventure_attempts t on t.id = s.attempt_id
  where t.booking_id = booking;
  if paths >= 300 and not exists (
    select 1 from public.adventure_evidence_files f
    join public.adventure_submissions s on s.id = f.submission_id
    join public.adventure_attempts t on t.id = s.attempt_id
    where t.booking_id = booking and f.storage_path = new.storage_path
  ) then
    raise exception using errcode = 'P0001', message = 'adventure_evidence_full',
      detail = 'This ride has reached its limit of files. Ask BICII for help.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_evidence_files_lifetime_cap() from public, anon, authenticated, service_role;
create trigger adventure_evidence_files_lifetime_cap
  before insert on public.adventure_evidence_files
  for each row execute function private.adventure_evidence_files_lifetime_cap();

-- Objects the cron deletes from Storage: removed files (and uploads abandoned
-- for a day in an open version, removed first) whose path no other file
-- still uses. Service role only; the cron marks each one deleted after.
create function public.adventure_evidence_objects_to_delete(max_rows integer)
returns table (file_id uuid, storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.adventure_evidence_files f
  set state = 'removed'
  from public.adventure_submissions s
  where s.id = f.submission_id and s.state = 'draft'
    and f.state = 'awaiting_upload' and f.created_at < pg_catalog.now() - interval '1 day';
  return query
    select f.id, f.storage_path
    from public.adventure_evidence_files f
    where f.state = 'removed' and f.object_deleted_at is null
      and not exists (select 1 from public.adventure_evidence_files o
                      where o.storage_path = f.storage_path and o.state <> 'removed')
    order by f.updated_at
    limit greatest(1, least(coalesce(adventure_evidence_objects_to_delete.max_rows, 50), 200));
end;
$$;
revoke all on function public.adventure_evidence_objects_to_delete(integer) from public, anon, authenticated, service_role;
grant execute on function public.adventure_evidence_objects_to_delete(integer) to service_role;

create function public.mark_adventure_objects_deleted(file_ids uuid[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.adventure_evidence_files f
    set object_deleted_at = pg_catalog.now()
    where f.id = any(mark_adventure_objects_deleted.file_ids) and f.state = 'removed' and f.object_deleted_at is null
    returning 1
  )
  select pg_catalog.count(*)::integer from done;
$$;
revoke all on function public.mark_adventure_objects_deleted(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.mark_adventure_objects_deleted(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- D229: board names
-- ---------------------------------------------------------------------------
alter table public.adventure_bookings
  add column board_name_locked_at timestamptz null,
  add column board_name_locked_by uuid null references public.staff (id) on delete restrict;

-- Whitespace collapsed and NFKC-normalised, or null for empty.
create function private.clean_board_name(name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.regexp_replace(pg_catalog.btrim(pg_catalog.normalize(coalesce(clean_board_name.name, ''), 'NFKC')),
                                          '\s+', ' ', 'g'), '');
$$;
revoke all on function private.clean_board_name(text) from public, anon, authenticated, service_role;

-- 2 to 40 characters; no markup, emails, links, control, invisible or
-- direction characters; not posing as the shop (the owner's list).
create function private.board_name_allowed(name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.char_length(board_name_allowed.name) between 2 and 40
     and board_name_allowed.name !~ '[[:cntrl:]<>@]'
     and board_name_allowed.name !~* '(https?:|www\.|://)'
     and board_name_allowed.name !~ '[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]'
     and board_name_allowed.name !~* '(bicii|official|staff|admin)';
$$;
revoke all on function private.board_name_allowed(text) from public, anon, authenticated, service_role;

alter table public.adventure_bookings drop constraint adventure_bookings_board_name_check;
alter table public.adventure_bookings
  add constraint adventure_bookings_board_name_check check (
    board_name is null or (board_name = private.clean_board_name(board_name) and private.board_name_allowed(board_name))
  );

create or replace function private.adventure_bookings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable constant text[] := array[
    'status', 'needs_attention', 'attention_reason', 'confirmed_at', 'expired_at', 'cancelled_at', 'updated_at',
    'finisher_name', 'board_name', 'board_name_locked_at', 'board_name_locked_by'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_immutable',
      detail = 'A booking is kept; it is never deleted.';
  end if;
  if (pg_catalog.to_jsonb(new) - movable) <> (pg_catalog.to_jsonb(old) - movable) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_booking_immutable',
      detail = 'What was bought, by whom and at what price never changes.';
  end if;
  return new;
end;
$$;

create or replace function public.set_my_board_name(booking_id uuid, board_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  clean text := private.clean_board_name(set_my_board_name.board_name);
begin
  select x.* into b from public.adventure_bookings x
  where x.id = set_my_board_name.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if b.status not in ('pending_payment', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'adventure_booking_closed',
      detail = 'This booking is cancelled or expired.';
  end if;
  if b.board_name_locked_at is not null then
    raise exception using errcode = 'P0001', message = 'adventure_board_name_locked',
      detail = 'BICII took your board name down. Message the shop to choose another.';
  end if;
  if clean is not null and not private.board_name_allowed(clean) then
    raise exception using errcode = 'P0001', message = 'adventure_board_name_invalid',
      detail = 'Use 2 to 40 letters, numbers or spaces for your board name, with no links or emails.';
  end if;
  if b.board_name is not distinct from clean then
    return;
  end if;
  update public.adventure_bookings x
  set board_name = clean,
      finisher_name = case when clean is null then 'hidden' else 'preferred_name' end::public.adventure_finisher_name
  where x.id = b.id;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'board_name_changed', pg_catalog.jsonb_build_object('shown', clean is not null));
end;
$$;

create or replace function public.hide_adventure_board_name(booking_id uuid, reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  clean text := nullif(pg_catalog.btrim(coalesce(hide_adventure_board_name.reason, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the name comes off the board.';
  end if;
  perform 1 from public.adventure_bookings x where x.id = hide_adventure_board_name.booking_id for update;
  if not found then
    raise exception 'booking % not found', hide_adventure_board_name.booking_id using errcode = 'P0002';
  end if;
  -- D229: the name stays down until an admin unlocks it.
  update public.adventure_bookings x
  set board_name = null, finisher_name = 'hidden',
      board_name_locked_at = pg_catalog.now(), board_name_locked_by = actor
  where x.id = hide_adventure_board_name.booking_id and x.board_name is not null;
  if found then
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (hide_adventure_board_name.booking_id, 'board_name_changed', actor,
            pg_catalog.jsonb_build_object('shown', false, 'note', pg_catalog.left(clean, 500)));
  end if;
end;
$$;

create function public.unlock_adventure_board_name(booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
begin
  update public.adventure_bookings x
  set board_name_locked_at = null, board_name_locked_by = null
  where x.id = unlock_adventure_board_name.booking_id and x.board_name_locked_at is not null;
  if found then
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (unlock_adventure_board_name.booking_id, 'board_name_changed', actor,
            pg_catalog.jsonb_build_object('note', 'Unlocked: the rider may choose a name again'));
  end if;
end;
$$;
revoke all on function public.unlock_adventure_board_name(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unlock_adventure_board_name(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- D231: no floods of repeated requests or joins
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
  -- Joining the same date again within a day sends no second email (A-50).
  if notice = 'departure_joined' and exists (
    select 1 from public.adventure_booking_events e
    where e.booking_id = new.booking_id and e.kind = 'departure_joined' and e.id <> new.id
      and e.detail ->> 'departure_id' = new.detail ->> 'departure_id'
      and e.created_at > pg_catalog.now() - interval '24 hours'
  ) then
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

