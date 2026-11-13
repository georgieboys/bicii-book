-- Adventures Phase B, slice 4: review, certificates, finisher board and
-- packs (docs/ADVENTURES.md, ADR-026, PLAN D178-D180; DATA-MODEL §20;
-- handoff §13.4, §14).
--
-- A reviewer (verify_adventures) claims a submitted version and decides:
-- approve, request changes, or reject, with a checklist and reasons. A
-- person decides; nothing else certifies. Approval, in one transaction,
-- records the decision, issues one certificate for the attempt, awards the
-- adventure's badge and opens one finisher pack (T-shirt, patch, pin,
-- sticker); a retry or a second reviewer can never make a second of any of
-- them (E07). Nobody reviews their own ride (E08). A booking flagged for a
-- payment problem cannot be approved until staff clear it.
--
-- The finisher board (public_adventure_finishers) lists active
-- certificates by completion date (the day the ride ended, not the day it
-- was approved), with the name each rider chose; never times, speeds or a
-- position (D164). An admin can revoke a certificate with a reason: it
-- leaves the board; the review, evidence and pack history stay (E13).

-- ---------------------------------------------------------------------------
-- Types and columns
-- ---------------------------------------------------------------------------
create type public.adventure_review_decision as enum ('approved', 'changes_requested', 'rejected');
create type public.adventure_certificate_status as enum ('active', 'revoked');
create type public.adventure_pack_status as enum ('awaiting_pack', 'ready', 'fulfilled', 'on_hold');

alter table public.adventure_submissions
  add column review_claimed_by uuid null references public.staff (id) on delete restrict,
  add column review_claimed_at timestamptz null,
  add constraint adventure_submissions_claim check ((review_claimed_by is null) = (review_claimed_at is null));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.adventure_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.adventure_submissions (id) on delete restrict,
  reviewer_id uuid not null references public.staff (id) on delete restrict,
  decision public.adventure_review_decision not null,
  -- identity, coverage, checkpoints, chronology, time_window, distance
  checklist jsonb not null check (pg_catalog.jsonb_typeof(checklist) = 'object'),
  -- Approval: the distance the evidence supports and the local day the ride ended.
  accepted_distance_km public.distance_km null check (accepted_distance_km > 0),
  completed_on date null,
  message_to_rider text not null default '' check (pg_catalog.char_length(message_to_rider) <= 2000),
  internal_note text not null default '' check (pg_catalog.char_length(internal_note) <= 2000),
  decided_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint adventure_reviews_one_per_submission unique (submission_id),
  constraint adventure_reviews_approval check (
    (decision = 'approved') = (accepted_distance_km is not null and completed_on is not null)
  ),
  constraint adventure_reviews_reason check (
    decision = 'approved' or pg_catalog.btrim(message_to_rider) <> ''
  )
);
comment on table public.adventure_reviews is
  'Handoff §13.4: one decision per submitted version, by a person, with a checklist and reasons. Append-only.';

create sequence private.seq_adventure_certificate minvalue 1 maxvalue 999999 no cycle;
revoke all on sequence private.seq_adventure_certificate from public, anon, authenticated, service_role;

create table public.adventure_certificates (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^BC-[0-9]{6}$'),
  -- One certificate per certified attempt (E07).
  attempt_id uuid not null unique references public.adventure_attempts (id) on delete restrict,
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  submission_id uuid not null references public.adventure_submissions (id) on delete restrict,
  review_id uuid not null references public.adventure_reviews (id) on delete restrict,
  completed_on date not null,
  accepted_distance_km public.distance_km not null,
  issued_at timestamptz not null default pg_catalog.now(),
  status public.adventure_certificate_status not null default 'active',
  revoked_at timestamptz null,
  revoked_by uuid null references public.staff (id) on delete restrict,
  revoke_reason text null check (pg_catalog.char_length(revoke_reason) <= 500),
  constraint adventure_certificates_revoked check (
    (status = 'revoked') = (revoked_at is not null and revoked_by is not null and revoke_reason is not null)
  )
);
create index adventure_certificates_board_idx on public.adventure_certificates (completed_on desc, issued_at desc)
  where status = 'active';
comment on table public.adventure_certificates is
  'Handoff §14.1: the certificate of an approved attempt. The completion date is the ride''s, not the approval''s. Revoked, never deleted.';

create table public.adventure_badge_awards (
  id uuid primary key default gen_random_uuid(),
  certificate_id uuid not null unique references public.adventure_certificates (id) on delete restrict,
  adventure_id uuid not null references public.adventures (id) on delete restrict,
  -- A snapshot: "BICII 125 · 125 km".
  label text not null check (pg_catalog.char_length(label) between 1 and 120),
  awarded_at timestamptz not null default pg_catalog.now()
);
comment on table public.adventure_badge_awards is
  'Handoff §14.2: the adventure''s badge, once per certificate (no unearned lower milestones).';

create table public.adventure_fulfilments (
  id uuid primary key default gen_random_uuid(),
  certificate_id uuid not null unique references public.adventure_certificates (id) on delete restrict,
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  tshirt_size text not null,
  items text[] not null default array['T-shirt', 'Patch', 'Pin', 'Sticker'],
  status public.adventure_pack_status not null default 'awaiting_pack',
  note text not null default '' check (pg_catalog.char_length(note) <= 500),
  ready_at timestamptz null,
  fulfilled_at timestamptz null,
  updated_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);
create index adventure_fulfilments_open_idx on public.adventure_fulfilments (created_at)
  where status <> 'fulfilled';
comment on table public.adventure_fulfilments is
  'Handoff §14.3: one finisher pack per certificate. A stock delay never undoes the certificate.';

create trigger adventure_fulfilments_set_updated_at
  before update on public.adventure_fulfilments
  for each row execute function private.set_updated_at();

create function private.adventure_reviews_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'reviews and badges are append-only' using errcode = '42501';
end;
$$;
revoke all on function private.adventure_reviews_append_only() from public, anon, authenticated, service_role;

create trigger adventure_reviews_append_only
  before update or delete on public.adventure_reviews
  for each row execute function private.adventure_reviews_append_only();
create trigger adventure_badge_awards_append_only
  before update or delete on public.adventure_badge_awards
  for each row execute function private.adventure_reviews_append_only();

-- A certificate only moves active -> revoked; everything else is fixed.
create function private.adventure_certificates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.status = 'revoked'
     or (pg_catalog.to_jsonb(new) - array['status', 'revoked_at', 'revoked_by', 'revoke_reason'])
        <> (pg_catalog.to_jsonb(old) - array['status', 'revoked_at', 'revoked_by', 'revoke_reason']) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_certificate_immutable',
      detail = 'A certificate is kept as issued; it can only be revoked, with a reason.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_certificates_guard() from public, anon, authenticated, service_role;

create trigger adventure_certificates_guard
  before update or delete on public.adventure_certificates
  for each row execute function private.adventure_certificates_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.adventure_reviews enable row level security;
alter table public.adventure_certificates enable row level security;
alter table public.adventure_badge_awards enable row level security;
alter table public.adventure_fulfilments enable row level security;

revoke all on table public.adventure_reviews, public.adventure_certificates, public.adventure_badge_awards,
  public.adventure_fulfilments
  from public, anon, authenticated, service_role;
grant select on table public.adventure_reviews, public.adventure_certificates, public.adventure_badge_awards,
  public.adventure_fulfilments
  to authenticated;

-- Reviews carry internal notes: verifying or managing staff only.
create policy adventure_reviews_select_staff on public.adventure_reviews
  for select to authenticated using ((select private.can_read_adventure_evidence()));
create policy adventure_certificates_select_staff on public.adventure_certificates
  for select to authenticated using ((select private.is_staff()));
create policy adventure_badge_awards_select_staff on public.adventure_badge_awards
  for select to authenticated using ((select private.is_staff()));
create policy adventure_fulfilments_select_staff on public.adventure_fulfilments
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Staff: review (verify_adventures)
-- ---------------------------------------------------------------------------

-- Locks a submission's booking, then the submission; the caller must be
-- allowed to review it. Returns the booking id.
create function private.lock_adventure_review(submission_id uuid, actor uuid)
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
  select x.* into s from public.adventure_submissions x where x.id = s.id for update;
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

create function public.claim_adventure_review(submission_id uuid)
returns public.adventure_submissions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('verify_adventures');
  s public.adventure_submissions;
  b public.adventure_bookings;
begin
  perform private.lock_adventure_review(claim_adventure_review.submission_id, actor);
  select x.* into s from public.adventure_submissions x where x.id = claim_adventure_review.submission_id;
  select bk.* into b from public.adventure_attempts t join public.adventure_bookings bk on bk.id = t.booking_id
  where t.id = s.attempt_id;
  if s.state not in ('submitted', 'in_review') then
    raise exception using
      errcode = 'P0001',
      message = 'submission_version_conflict',
      detail = 'This evidence was already decided. Reload.';
  end if;
  update public.adventure_submissions x
  set state = 'in_review', review_claimed_by = actor, review_claimed_at = pg_catalog.now()
  where x.id = s.id
  returning x.* into s;
  if not exists (
    select 1 from public.adventure_booking_events e where e.booking_id = b.id and e.kind = 'review_started'
      and (e.detail ->> 'version')::integer = s.version
  ) then
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (b.id, 'review_started', actor, pg_catalog.jsonb_build_object('version', s.version));
  end if;
  return s;
end;
$$;

-- The decision (D178). Approval issues the certificate, badge and pack in
-- this transaction, once.
create function public.decide_adventure_review(
  submission_id uuid,
  decision public.adventure_review_decision,
  checklist jsonb,
  accepted_distance_km numeric,
  completed_on date,
  message_to_rider text,
  internal_note text
)
returns public.adventure_reviews
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('verify_adventures');
  s public.adventure_submissions;
  b public.adventure_bookings;
  rev public.adventure_revisions;
  review public.adventure_reviews;
  cert public.adventure_certificates;
  attempt_id uuid;
  keys constant text[] := array['identity', 'coverage', 'checkpoints', 'chronology', 'time_window', 'distance'];
begin
  perform private.lock_adventure_review(decide_adventure_review.submission_id, actor);
  select x.* into s from public.adventure_submissions x where x.id = decide_adventure_review.submission_id;
  select bk.* into b from public.adventure_attempts t join public.adventure_bookings bk on bk.id = t.booking_id
  where t.id = s.attempt_id;
  if s.state not in ('submitted', 'in_review') then
    raise exception using
      errcode = 'P0001',
      message = 'submission_version_conflict',
      detail = 'This evidence was already decided. Reload.';
  end if;
  if decide_adventure_review.checklist is null
     or pg_catalog.jsonb_typeof(decide_adventure_review.checklist) <> 'object'
     or exists (
       select 1 from pg_catalog.unnest(keys) k
       where pg_catalog.jsonb_typeof(decide_adventure_review.checklist -> k) is distinct from 'boolean'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'review_checklist_incomplete',
      detail = 'Answer every item of the checklist.';
  end if;

  if decide_adventure_review.decision = 'approved' then
    if exists (
      select 1 from pg_catalog.unnest(keys) k where (decide_adventure_review.checklist ->> k)::boolean is not true
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'review_checklist_incomplete',
        detail = 'Every checklist item must hold to certify a ride.';
    end if;
    if b.needs_attention then
      raise exception using
        errcode = 'P0001',
        message = 'adventure_booking_attention',
        detail = 'Resolve this booking''s payment problem before certifying.';
    end if;
    select r.* into rev from public.adventure_revisions r where r.id = b.revision_id;
    if decide_adventure_review.accepted_distance_km is null or decide_adventure_review.completed_on is null then
      raise exception using
        errcode = 'P0001',
        message = 'review_approval_incomplete',
        detail = 'Give the distance the evidence supports and the day the ride ended.';
    end if;
    if decide_adventure_review.accepted_distance_km < rev.distance_km then
      raise exception using
        errcode = 'P0001',
        message = 'review_distance_short',
        detail = 'The accepted distance is shorter than the adventure''s. Request changes or reject instead.';
    end if;
  elsif nullif(pg_catalog.btrim(coalesce(decide_adventure_review.message_to_rider, '')), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Tell the rider what is missing or why.';
  end if;

  insert into public.adventure_reviews (
    submission_id, reviewer_id, decision, checklist, accepted_distance_km, completed_on, message_to_rider, internal_note
  )
  values (
    s.id, actor, decide_adventure_review.decision, decide_adventure_review.checklist,
    case when decide_adventure_review.decision = 'approved' then decide_adventure_review.accepted_distance_km end,
    case when decide_adventure_review.decision = 'approved' then decide_adventure_review.completed_on end,
    coalesce(pg_catalog.btrim(decide_adventure_review.message_to_rider), ''),
    coalesce(pg_catalog.btrim(decide_adventure_review.internal_note), '')
  )
  returning * into review;

  update public.adventure_submissions x set state = decide_adventure_review.decision::text::public.adventure_submission_state
  where x.id = s.id;
  attempt_id := s.attempt_id;

  if decide_adventure_review.decision = 'approved' then
    insert into public.adventure_certificates (
      reference, attempt_id, booking_id, submission_id, review_id, completed_on, accepted_distance_km
    )
    values (
      'BC-' || pg_catalog.lpad(pg_catalog.nextval('private.seq_adventure_certificate')::text, 6, '0'),
      attempt_id, b.id, s.id, review.id, review.completed_on, review.accepted_distance_km
    )
    returning * into cert;
    insert into public.adventure_badge_awards (certificate_id, adventure_id, label)
    values (cert.id, b.adventure_id, rev.name || ' · ' || pg_catalog.trim_scale(rev.distance_km)::text || ' km');
    insert into public.adventure_fulfilments (certificate_id, booking_id, tshirt_size)
    values (cert.id, b.id, b.tshirt_size);
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (b.id, 'certified', actor, pg_catalog.jsonb_build_object('certificate', cert.reference, 'version', s.version));
  else
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (b.id,
            case when decide_adventure_review.decision = 'changes_requested' then 'changes_requested' else 'not_certified' end
              ::public.adventure_booking_event_kind,
            actor, pg_catalog.jsonb_build_object('version', s.version));
  end if;
  return review;
end;
$$;

-- E13: an admin revokes with a reason; the history stays.
create function public.revoke_adventure_certificate(certificate_id uuid, reason text)
returns public.adventure_certificates
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  cert public.adventure_certificates;
begin
  if nullif(pg_catalog.btrim(coalesce(revoke_adventure_certificate.reason, '')), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why the certificate is revoked.';
  end if;
  select c.* into cert from public.adventure_certificates c where c.id = revoke_adventure_certificate.certificate_id for update;
  if not found then
    raise exception 'certificate % not found', revoke_adventure_certificate.certificate_id using errcode = 'P0002';
  end if;
  if cert.status = 'revoked' then
    return cert;
  end if;
  update public.adventure_certificates c
  set status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = actor,
      revoke_reason = pg_catalog.left(pg_catalog.btrim(revoke_adventure_certificate.reason), 500)
  where c.id = cert.id
  returning c.* into cert;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (cert.booking_id, 'certificate_revoked', actor, pg_catalog.jsonb_build_object('certificate', cert.reference));
  return cert;
end;
$$;

-- A pack's progress (manage_adventures).
create function public.set_adventure_pack_status(fulfilment_id uuid, status public.adventure_pack_status, note text)
returns public.adventure_fulfilments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  f public.adventure_fulfilments;
begin
  update public.adventure_fulfilments x
  set status = set_adventure_pack_status.status,
      note = coalesce(pg_catalog.left(pg_catalog.btrim(set_adventure_pack_status.note), 500), x.note),
      ready_at = case when set_adventure_pack_status.status = 'ready' then coalesce(x.ready_at, pg_catalog.now()) else x.ready_at end,
      fulfilled_at = case when set_adventure_pack_status.status = 'fulfilled' then coalesce(x.fulfilled_at, pg_catalog.now()) else null end,
      updated_by = actor
  where x.id = set_adventure_pack_status.fulfilment_id
  returning x.* into f;
  if not found then
    raise exception 'pack % not found', set_adventure_pack_status.fulfilment_id using errcode = 'P0002';
  end if;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (f.booking_id, 'pack_updated', actor, pg_catalog.jsonb_build_object('status', f.status));
  return f;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public: the finisher board (D164, D179)
-- ---------------------------------------------------------------------------
create function private.finisher_display_name(c public.customers, choice public.adventure_finisher_name)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when choice = 'hidden' then 'A BICII rider'
    when choice = 'full_name' and nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', c.first_name, c.last_name)), '') is not null
      then pg_catalog.btrim(pg_catalog.concat_ws(' ', c.first_name, c.last_name))
    when nullif(pg_catalog.btrim(coalesce(c.first_name, '')), '') is not null
      then pg_catalog.btrim(c.first_name)
           || coalesce(' ' || pg_catalog.upper(pg_catalog.left(nullif(pg_catalog.btrim(c.last_name), ''), 1)) || '.', '')
    else 'A BICII rider'
  end;
$$;
revoke all on function private.finisher_display_name(public.customers, public.adventure_finisher_name)
  from public, anon, authenticated, service_role;

create function public.public_adventure_finishers(adventure_slug text, max_rows integer)
returns table (rider_name text, completed_on date, badge text)
language sql
stable
security definer
set search_path = ''
as $$
  select private.finisher_display_name(c, b.finisher_name), cert.completed_on, ba.label
  from public.adventure_certificates cert
  join public.adventure_bookings b on b.id = cert.booking_id
  join public.adventures a on a.id = b.adventure_id
  join public.customers c on c.id = b.customer_id
  join public.adventure_badge_awards ba on ba.certificate_id = cert.id
  where cert.status = 'active'
    and a.status = 'published'
    and a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(public_adventure_finishers.adventure_slug, '')))::extensions.citext
  order by cert.completed_on desc, cert.issued_at desc, cert.id
  limit greatest(1, least(coalesce(public_adventure_finishers.max_rows, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- The rider's outcome
-- ---------------------------------------------------------------------------
create function public.my_adventure_outcome(booking_id uuid)
returns table (
  decision public.adventure_review_decision,
  message_to_rider text,
  decided_at timestamptz,
  certificate_reference text,
  certificate_status public.adventure_certificate_status,
  completed_on date,
  accepted_distance_km numeric,
  badge text,
  pack_status public.adventure_pack_status,
  pack_items text[],
  tshirt_size text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.decision, r.message_to_rider, r.decided_at, cert.reference, cert.status, cert.completed_on,
         cert.accepted_distance_km, ba.label, f.status, f.items, f.tshirt_size
  from public.adventure_bookings b
  join public.adventure_attempts t on t.booking_id = b.id
  join public.adventure_submissions s on s.attempt_id = t.id
  join public.adventure_reviews r on r.submission_id = s.id
  left join public.adventure_certificates cert on cert.attempt_id = t.id
  left join public.adventure_badge_awards ba on ba.certificate_id = cert.id
  left join public.adventure_fulfilments f on f.certificate_id = cert.id
  where b.id = my_adventure_outcome.booking_id
    and b.customer_id = private.require_customer()
  order by t.attempt_number desc, s.version desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.claim_adventure_review(uuid),
  public.decide_adventure_review(uuid, public.adventure_review_decision, jsonb, numeric, date, text, text),
  public.revoke_adventure_certificate(uuid, text),
  public.set_adventure_pack_status(uuid, public.adventure_pack_status, text),
  public.public_adventure_finishers(text, integer),
  public.my_adventure_outcome(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.claim_adventure_review(uuid),
  public.decide_adventure_review(uuid, public.adventure_review_decision, jsonb, numeric, date, text, text),
  public.revoke_adventure_certificate(uuid, text),
  public.set_adventure_pack_status(uuid, public.adventure_pack_status, text),
  public.my_adventure_outcome(uuid)
to authenticated;
grant execute on function public.public_adventure_finishers(text, integer) to anon, authenticated;
