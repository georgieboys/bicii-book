-- Adventures, Phase A: the catalogue (docs/ADVENTURES.md, ADR-026,
-- PLAN D164-D171; DATA-MODEL §20).
--
-- An adventure is a route anyone may ride free with its route link. From
-- 125 km, a published revision may also carry certification offers
-- (self-supported, self-supported group, supported) at explicit final
-- prices (D165). Nothing here sells anything: bookings and payments come in
-- Phase B, behind their own switch.
--
-- Revisions (D166): every change is made on the adventure's one draft
-- revision. Publishing seals it (it, its checkpoints and its offers can no
-- longer change) and makes it the adventure's current revision; the next
-- edit starts a new draft copied from it. Bookings (Phase B) reference the
-- sealed revision they bought, so a later edit never changes sold terms.
--
-- Access: staff read every row (RLS, private.is_staff()); changes go
-- through the RPCs below, which require manage_adventures. Anonymous
-- visitors and customers read only public_adventures() and
-- public_adventure(slug): published adventures, the current sealed
-- revision, public columns only (never staff_notes, rider instructions or
-- the emergency procedure, which buyers see from Phase B).
--
-- Seeded at the end: the nine routes shown on the public site on
-- 2026-11-13, with only the facts the site states (no route links, no
-- checkpoints, no offers, no invented rules). 30/50/80/125 km are
-- published free routes; 250-3,000 km are published as planned routes
-- (shown as "coming", never bookable) so the public page keeps showing
-- them; an admin may archive any of them.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.adventure_status as enum ('draft', 'published', 'archived');
create type public.adventure_participation as enum ('self_supported', 'self_supported_group', 'supported');
create type public.adventure_checkpoint_order as enum ('any', 'sequence');
create type public.adventure_event_kind as enum (
  'created', 'draft_started', 'published', 'archived', 'unarchived', 'order_changed'
);

comment on type public.adventure_participation is
  'D164: the three certified ways to ride. Free riding ("free and easy") is not an offer: it needs no purchase.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.is_time_zone(tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select tz is not null and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = tz);
$$;
revoke all on function private.is_time_zone(text) from public, anon, authenticated, service_role;

comment on function private.is_time_zone(text) is
  'Whether a text is an IANA time zone name the server knows (adventure revisions store one).';

-- D165: the owner's price formulas, as a suggestion for the editor. The
-- published price is always the explicit value an admin saves on the offer.
create function private.adventure_suggested_price(
  kind public.adventure_participation,
  nominal_days integer,
  supported_days integer
)
returns public.money_amount
language sql
immutable
set search_path = ''
as $$
  select case
    when kind in ('self_supported', 'self_supported_group') and nominal_days >= 1
      then (49.00 + 10.00 * (nominal_days - 1))::public.money_amount
    when kind = 'supported' and supported_days >= 1
      then (49.00 + 100.00 * supported_days)::public.money_amount
  end;
$$;
revoke all on function private.adventure_suggested_price(public.adventure_participation, integer, integer)
  from public, anon, authenticated, service_role;

comment on function private.adventure_suggested_price(public.adventure_participation, integer, integer) is
  'D165: self-supported (solo or group) 49 + 10 x (nominal days - 1); supported 49 + 100 x supported days, tracker included. A suggestion; offers store explicit prices.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.adventures (
  id uuid primary key default gen_random_uuid(),
  slug extensions.citext not null unique check (
    pg_catalog.char_length(slug::text) between 2 and 60
    and slug::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  status public.adventure_status not null default 'draft',
  -- The sealed revision the public sees; set by publish_adventure_revision.
  current_revision_id uuid null,
  sort_order integer not null default 0 check (sort_order between -10000 and 10000),
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid null references public.staff (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventures_published_has_revision check (status <> 'published' or current_revision_id is not null)
);

comment on table public.adventures is
  'D164: a route. Stable identity and slug; its content lives in adventure_revisions. Archived instead of deleted. Changed only through the adventure RPCs (manage_adventures).';

create table public.adventure_revisions (
  id uuid primary key default gen_random_uuid(),
  adventure_id uuid not null references public.adventures (id) on delete restrict,
  revision_number integer not null check (revision_number >= 1),
  name text not null check (pg_catalog.btrim(name) <> '' and pg_catalog.char_length(name) <= 80),
  summary text not null default '' check (pg_catalog.char_length(summary) <= 400),
  description text not null default '' check (pg_catalog.char_length(description) <= 5000),
  -- Shown with the route: a caution or a tip (public).
  note text not null default '' check (pg_catalog.char_length(note) <= 1000),
  region text not null default '' check (pg_catalog.char_length(region) <= 80),
  terrain text not null default '' check (pg_catalog.char_length(terrain) <= 80),
  when_to_start text not null default '' check (pg_catalog.char_length(when_to_start) <= 120),
  start_finish text not null default '' check (pg_catalog.char_length(start_finish) <= 300),
  distance_km numeric(7, 1) not null check (distance_km > 0 and distance_km <= 10000),
  -- D165: the published duration certification prices are based on.
  nominal_days integer null check (nominal_days between 1 and 60),
  time_zone text not null default 'Asia/Singapore' check (pg_catalog.char_length(time_zone) <= 64),
  -- The verification window for a certified attempt; no invented minimum.
  min_elapsed_minutes integer null check (min_elapsed_minutes > 0),
  max_elapsed_minutes integer null check (max_elapsed_minutes > 0),
  checkpoint_order public.adventure_checkpoint_order not null default 'any',
  route_url text null check (
    pg_catalog.char_length(route_url) <= 500 and route_url ~ '^https://[^[:space:]]+$'
  ),
  rules text not null default '' check (pg_catalog.char_length(rules) <= 5000),
  equipment text not null default '' check (pg_catalog.char_length(equipment) <= 2000),
  -- For buyers (Phase B), never in the public projection.
  rider_instructions text not null default '' check (pg_catalog.char_length(rider_instructions) <= 5000),
  emergency_procedure text not null default '' check (pg_catalog.char_length(emergency_procedure) <= 2000),
  -- Staff only.
  staff_notes text not null default '' check (pg_catalog.char_length(staff_notes) <= 2000),
  -- A route still being planned: shown as coming, never offered for sale.
  is_planned boolean not null default false,
  change_summary text null check (pg_catalog.char_length(change_summary) <= 500),
  sealed_at timestamptz null,
  sealed_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  created_by uuid null references public.staff (id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_revisions_number_unique unique (adventure_id, revision_number),
  constraint adventure_revisions_window_order check (
    min_elapsed_minutes is null or max_elapsed_minutes is null or min_elapsed_minutes <= max_elapsed_minutes
  )
);
create unique index adventure_revisions_one_draft on public.adventure_revisions (adventure_id)
  where sealed_at is null;

comment on table public.adventure_revisions is
  'D166: an adventure''s content, rules and (through its offers) prices. At most one draft per adventure; sealed on publish and never changed after.';

alter table public.adventures
  add constraint adventures_current_revision_fk
  foreign key (current_revision_id) references public.adventure_revisions (id) on delete restrict;

create table public.adventure_checkpoints (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.adventure_revisions (id) on delete restrict,
  position integer not null check (position between 1 and 100),
  label text not null check (pg_catalog.btrim(label) <> '' and pg_catalog.char_length(label) <= 80),
  instructions text not null default '' check (pg_catalog.char_length(instructions) <= 1000),
  latitude numeric(9, 6) null check (latitude between -90 and 90),
  longitude numeric(9, 6) null check (longitude between -180 and 180),
  -- A review aid, not proof (handoff §5.1).
  review_radius_m integer null check (review_radius_m between 10 and 50000),
  mandatory boolean not null default true,
  photo_required boolean not null default true,
  constraint adventure_checkpoints_position_unique unique (revision_id, position),
  constraint adventure_checkpoints_coordinates check ((latitude is null) = (longitude is null))
);

comment on table public.adventure_checkpoints is
  'A revision''s checkpoints, in position order. Immutable once the revision is sealed.';

create table public.adventure_offers (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.adventure_revisions (id) on delete restrict,
  kind public.adventure_participation not null,
  -- D165: the final price, SGD, no GST (D89).
  price public.money_amount not null check (price > 0),
  -- Self-supported kinds: optional tracker hire per 24 hours (null = not
  -- offered). Supported: always null, the tracker is included.
  tracker_hire_price public.money_amount null check (tracker_hire_price > 0),
  -- Supported only: the package's service days.
  supported_days integer null check (supported_days between 1 and 60),
  inclusions text not null default '' check (pg_catalog.char_length(inclusions) <= 2000),
  constraint adventure_offers_kind_unique unique (revision_id, kind),
  constraint adventure_offers_supported_days check ((kind = 'supported') = (supported_days is not null)),
  constraint adventure_offers_supported_tracker check (kind <> 'supported' or tracker_hire_price is null)
);

comment on table public.adventure_offers is
  'D165: one offer per participation kind per revision, at an explicit final price. Immutable once the revision is sealed.';

create table public.adventure_events (
  id uuid primary key default gen_random_uuid(),
  adventure_id uuid not null references public.adventures (id) on delete restrict,
  revision_id uuid null references public.adventure_revisions (id) on delete restrict,
  kind public.adventure_event_kind not null,
  staff_id uuid null references public.staff (id) on delete restrict,
  reason text null check (pg_catalog.char_length(reason) <= 500),
  -- clock_timestamp: several events in one transaction keep their order.
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index adventure_events_adventure_idx on public.adventure_events (adventure_id, created_at, id);

comment on table public.adventure_events is
  'Append-only catalogue history: created, draft started, published, archived, unarchived, order changed. staff_id null for rows written by a migration.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger adventures_set_updated_at
  before update on public.adventures
  for each row execute function private.set_updated_at();
create trigger adventure_revisions_set_updated_at
  before update on public.adventure_revisions
  for each row execute function private.set_updated_at();

-- A sealed revision never changes, and is never deleted.
create function private.adventure_revisions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.sealed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_revision_sealed',
      detail = 'This version is published and cannot change. Start a new draft.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.adventure_id <> old.adventure_id or new.revision_number <> old.revision_number then
    raise exception 'an adventure revision keeps its adventure and number' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_revisions_guard() from public, anon, authenticated, service_role;

create trigger adventure_revisions_guard
  before update or delete on public.adventure_revisions
  for each row execute function private.adventure_revisions_guard();

-- Checkpoints and offers change only while their revision is a draft.
create function private.adventure_revision_children_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1 from public.adventure_revisions r where r.id = old.revision_id and r.sealed_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_revision_sealed',
      detail = 'This version is published and cannot change. Start a new draft.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if exists (
    select 1 from public.adventure_revisions r where r.id = new.revision_id and r.sealed_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_revision_sealed',
      detail = 'This version is published and cannot change. Start a new draft.';
  end if;
  return new;
end;
$$;
revoke all on function private.adventure_revision_children_guard() from public, anon, authenticated, service_role;

create trigger adventure_checkpoints_guard
  before insert or update or delete on public.adventure_checkpoints
  for each row execute function private.adventure_revision_children_guard();
create trigger adventure_offers_guard
  before insert or update or delete on public.adventure_offers
  for each row execute function private.adventure_revision_children_guard();

create function private.adventure_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'adventure_events is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.adventure_events_append_only() from public, anon, authenticated, service_role;

create trigger adventure_events_append_only
  before update or delete on public.adventure_events
  for each row execute function private.adventure_events_append_only();

-- ---------------------------------------------------------------------------
-- Row-level security and grants: staff read; nobody writes directly.
-- ---------------------------------------------------------------------------
alter table public.adventures enable row level security;
alter table public.adventure_revisions enable row level security;
alter table public.adventure_checkpoints enable row level security;
alter table public.adventure_offers enable row level security;
alter table public.adventure_events enable row level security;

revoke all on table public.adventures from public, anon, authenticated, service_role;
revoke all on table public.adventure_revisions from public, anon, authenticated, service_role;
revoke all on table public.adventure_checkpoints from public, anon, authenticated, service_role;
revoke all on table public.adventure_offers from public, anon, authenticated, service_role;
revoke all on table public.adventure_events from public, anon, authenticated, service_role;

grant select on table public.adventures to authenticated;
grant select on table public.adventure_revisions to authenticated;
grant select on table public.adventure_checkpoints to authenticated;
grant select on table public.adventure_offers to authenticated;
grant select on table public.adventure_events to authenticated;

create policy adventures_select_staff on public.adventures
  for select to authenticated using ((select private.is_staff()));
create policy adventure_revisions_select_staff on public.adventure_revisions
  for select to authenticated using ((select private.is_staff()));
create policy adventure_checkpoints_select_staff on public.adventure_checkpoints
  for select to authenticated using ((select private.is_staff()));
create policy adventure_offers_select_staff on public.adventure_offers
  for select to authenticated using ((select private.is_staff()));
create policy adventure_events_select_staff on public.adventure_events
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Staff RPCs (manage_adventures)
-- ---------------------------------------------------------------------------

-- The draft revision of an adventure, locked; refuses a sealed one.
create function private.lock_adventure_draft(revision_id uuid)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  rev public.adventure_revisions;
begin
  select r.* into rev from public.adventure_revisions r where r.id = lock_adventure_draft.revision_id;
  if not found then
    raise exception 'adventure revision % not found', lock_adventure_draft.revision_id using errcode = 'P0002';
  end if;
  -- Adventure first, then the revision: the order every RPC here takes.
  perform 1 from public.adventures a where a.id = rev.adventure_id for update;
  select r.* into rev from public.adventure_revisions r where r.id = lock_adventure_draft.revision_id for update;
  if rev.sealed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_revision_sealed',
      detail = 'This version is published and cannot change. Start a new draft.';
  end if;
  return rev;
end;
$$;
revoke all on function private.lock_adventure_draft(uuid) from public, anon, authenticated, service_role;

create function public.create_adventure(slug text, name text, distance_km numeric)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
  rev public.adventure_revisions;
  clean_slug text := pg_catalog.lower(pg_catalog.btrim(coalesce(create_adventure.slug, '')));
begin
  if clean_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(clean_slug) not between 2 and 60 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_slug_invalid',
      detail = 'Use 2 to 60 lowercase letters, digits and single hyphens, like bicii-125.';
  end if;
  if exists (select 1 from public.adventures a where a.slug = clean_slug::extensions.citext) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_slug_taken',
      detail = 'Another adventure already uses this web address.';
  end if;

  insert into public.adventures (slug, created_by)
  values (clean_slug, actor)
  returning * into adv;
  insert into public.adventure_revisions (adventure_id, revision_number, name, distance_km, created_by)
  values (adv.id, 1, pg_catalog.btrim(create_adventure.name), create_adventure.distance_km, actor)
  returning * into rev;
  insert into public.adventure_events (adventure_id, revision_id, kind, staff_id)
  values (adv.id, rev.id, 'created', actor);
  return rev;
end;
$$;

-- Replaces every field of a draft. expected_updated_at is the draft's
-- updated_at when the editor opened it: a save from a stale screen is
-- refused instead of silently reverting someone else's change.
create function public.update_adventure_draft(
  revision_id uuid,
  expected_updated_at timestamptz,
  name text,
  summary text,
  description text,
  note text,
  region text,
  terrain text,
  when_to_start text,
  start_finish text,
  distance_km numeric,
  nominal_days integer,
  time_zone text,
  min_elapsed_minutes integer,
  max_elapsed_minutes integer,
  checkpoint_order public.adventure_checkpoint_order,
  route_url text,
  rules text,
  equipment text,
  rider_instructions text,
  emergency_procedure text,
  staff_notes text,
  is_planned boolean
)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(update_adventure_draft.revision_id);
begin
  if rev.updated_at is distinct from update_adventure_draft.expected_updated_at then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_draft_changed',
      detail = 'Someone changed this draft since you opened it. Reload and try again.';
  end if;
  if not private.is_time_zone(update_adventure_draft.time_zone) then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_time_zone_invalid',
      detail = 'Use a time zone name such as Asia/Singapore.';
  end if;

  update public.adventure_revisions r
  set name = pg_catalog.btrim(update_adventure_draft.name),
      summary = coalesce(pg_catalog.btrim(update_adventure_draft.summary), ''),
      description = coalesce(pg_catalog.btrim(update_adventure_draft.description), ''),
      note = coalesce(pg_catalog.btrim(update_adventure_draft.note), ''),
      region = coalesce(pg_catalog.btrim(update_adventure_draft.region), ''),
      terrain = coalesce(pg_catalog.btrim(update_adventure_draft.terrain), ''),
      when_to_start = coalesce(pg_catalog.btrim(update_adventure_draft.when_to_start), ''),
      start_finish = coalesce(pg_catalog.btrim(update_adventure_draft.start_finish), ''),
      distance_km = update_adventure_draft.distance_km,
      nominal_days = update_adventure_draft.nominal_days,
      time_zone = update_adventure_draft.time_zone,
      min_elapsed_minutes = update_adventure_draft.min_elapsed_minutes,
      max_elapsed_minutes = update_adventure_draft.max_elapsed_minutes,
      checkpoint_order = coalesce(update_adventure_draft.checkpoint_order, 'any'),
      route_url = nullif(pg_catalog.btrim(update_adventure_draft.route_url), ''),
      rules = coalesce(pg_catalog.btrim(update_adventure_draft.rules), ''),
      equipment = coalesce(pg_catalog.btrim(update_adventure_draft.equipment), ''),
      rider_instructions = coalesce(pg_catalog.btrim(update_adventure_draft.rider_instructions), ''),
      emergency_procedure = coalesce(pg_catalog.btrim(update_adventure_draft.emergency_procedure), ''),
      staff_notes = coalesce(pg_catalog.btrim(update_adventure_draft.staff_notes), ''),
      is_planned = coalesce(update_adventure_draft.is_planned, false)
  where r.id = rev.id
  returning r.* into rev;
  return rev;
end;
$$;

-- Replaces a draft's checkpoints. checkpoints: a JSON array, in position
-- order, of {label, instructions?, latitude?, longitude?, review_radius_m?,
-- mandatory?, photo_required?}.
create function public.set_adventure_checkpoints(revision_id uuid, checkpoints jsonb)
returns setof public.adventure_checkpoints
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_checkpoints.revision_id);
  item jsonb;
  pos integer := 0;
begin
  if set_adventure_checkpoints.checkpoints is null
     or pg_catalog.jsonb_typeof(set_adventure_checkpoints.checkpoints) <> 'array'
     or pg_catalog.jsonb_array_length(set_adventure_checkpoints.checkpoints) > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'adventure_checkpoints_invalid',
      detail = 'Send a list of up to 100 checkpoints.';
  end if;

  delete from public.adventure_checkpoints c where c.revision_id = rev.id;
  for item in select value from pg_catalog.jsonb_array_elements(set_adventure_checkpoints.checkpoints) loop
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

-- Adds or replaces the draft's offer of one kind (D165).
create function public.set_adventure_offer(
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
  rev public.adventure_revisions := private.lock_adventure_draft(set_adventure_offer.revision_id);
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
    set_adventure_offer.kind,
    set_adventure_offer.price,
    case when set_adventure_offer.kind = 'supported' then null else set_adventure_offer.tracker_hire_price end,
    case when set_adventure_offer.kind = 'supported' then set_adventure_offer.supported_days end,
    coalesce(pg_catalog.btrim(set_adventure_offer.inclusions), '')
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

create function public.remove_adventure_offer(revision_id uuid, kind public.adventure_participation)
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
  delete from public.adventure_offers o where o.revision_id = rev.id and o.kind = remove_adventure_offer.kind;
end;
$$;

-- The adventure's draft, starting one from the current revision if there is
-- none (a copy with its checkpoints and offers). Calling it again returns
-- the same draft.
create function public.start_adventure_draft(adventure_id uuid)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
  source public.adventure_revisions;
  rev public.adventure_revisions;
begin
  select a.* into adv from public.adventures a where a.id = start_adventure_draft.adventure_id for update;
  if not found then
    raise exception 'adventure % not found', start_adventure_draft.adventure_id using errcode = 'P0002';
  end if;

  select r.* into rev from public.adventure_revisions r where r.adventure_id = adv.id and r.sealed_at is null;
  if found then
    return rev;
  end if;

  select r.* into source from public.adventure_revisions r
  where r.adventure_id = adv.id
  order by r.revision_number desc
  limit 1;

  insert into public.adventure_revisions (
    adventure_id, revision_number, name, summary, description, note, region, terrain,
    when_to_start, start_finish, distance_km, nominal_days, time_zone, min_elapsed_minutes,
    max_elapsed_minutes, checkpoint_order, route_url, rules, equipment, rider_instructions,
    emergency_procedure, staff_notes, is_planned, created_by
  )
  select adv.id, source.revision_number + 1, source.name, source.summary, source.description,
         source.note, source.region, source.terrain, source.when_to_start, source.start_finish,
         source.distance_km, source.nominal_days, source.time_zone, source.min_elapsed_minutes,
         source.max_elapsed_minutes, source.checkpoint_order, source.route_url, source.rules,
         source.equipment, source.rider_instructions, source.emergency_procedure,
         source.staff_notes, source.is_planned, actor
  returning * into rev;

  insert into public.adventure_checkpoints (
    revision_id, position, label, instructions, latitude, longitude, review_radius_m, mandatory, photo_required
  )
  select rev.id, c.position, c.label, c.instructions, c.latitude, c.longitude, c.review_radius_m,
         c.mandatory, c.photo_required
  from public.adventure_checkpoints c where c.revision_id = source.id;

  insert into public.adventure_offers (revision_id, kind, price, tracker_hire_price, supported_days, inclusions)
  select rev.id, o.kind, o.price, o.tracker_hire_price, o.supported_days, o.inclusions
  from public.adventure_offers o where o.revision_id = source.id;

  insert into public.adventure_events (adventure_id, revision_id, kind, staff_id)
  values (adv.id, rev.id, 'draft_started', actor);
  return rev;
end;
$$;

-- Seals the draft and makes it what the public sees. A revision with
-- offers must be certifiable (D164): at least 125 km, not planned, with
-- nominal days and a maximum time, and a supported offer needs its days.
create function public.publish_adventure_revision(revision_id uuid, change_summary text)
returns public.adventure_revisions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  rev public.adventure_revisions := private.lock_adventure_draft(publish_adventure_revision.revision_id);
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
      change_summary = nullif(pg_catalog.btrim(publish_adventure_revision.change_summary), '')
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

create function public.archive_adventure(adventure_id uuid, reason text)
returns public.adventures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
begin
  select a.* into adv from public.adventures a where a.id = archive_adventure.adventure_id for update;
  if not found then
    raise exception 'adventure % not found', archive_adventure.adventure_id using errcode = 'P0002';
  end if;
  if nullif(pg_catalog.btrim(coalesce(archive_adventure.reason, '')), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why this adventure is being archived.';
  end if;
  if adv.status = 'archived' then
    return adv;
  end if;

  update public.adventures a set status = 'archived' where a.id = adv.id returning a.* into adv;
  insert into public.adventure_events (adventure_id, kind, staff_id, reason)
  values (adv.id, 'archived', actor, pg_catalog.btrim(archive_adventure.reason));
  return adv;
end;
$$;

create function public.unarchive_adventure(adventure_id uuid)
returns public.adventures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
begin
  select a.* into adv from public.adventures a where a.id = unarchive_adventure.adventure_id for update;
  if not found then
    raise exception 'adventure % not found', unarchive_adventure.adventure_id using errcode = 'P0002';
  end if;
  if adv.status <> 'archived' then
    return adv;
  end if;

  update public.adventures a
  set status = case when a.current_revision_id is null then 'draft' else 'published' end::public.adventure_status
  where a.id = adv.id
  returning a.* into adv;
  insert into public.adventure_events (adventure_id, kind, staff_id)
  values (adv.id, 'unarchived', actor);
  return adv;
end;
$$;

create function public.set_adventure_order(adventure_id uuid, sort_order integer)
returns public.adventures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
begin
  update public.adventures a set sort_order = set_adventure_order.sort_order
  where a.id = set_adventure_order.adventure_id
  returning a.* into adv;
  if not found then
    raise exception 'adventure % not found', set_adventure_order.adventure_id using errcode = 'P0002';
  end if;
  insert into public.adventure_events (adventure_id, kind, staff_id)
  values (adv.id, 'order_changed', actor);
  return adv;
end;
$$;

-- D165: the formula's price for the editor's "suggested" hint.
create function public.suggested_adventure_price(
  kind public.adventure_participation,
  nominal_days integer,
  supported_days integer
)
returns public.money_amount
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
begin
  return private.adventure_suggested_price(
    suggested_adventure_price.kind,
    suggested_adventure_price.nominal_days,
    suggested_adventure_price.supported_days
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public reads (anon and signed-in): published adventures only, the
-- current sealed revision, public columns only.
-- ---------------------------------------------------------------------------
create function private.adventure_public_offers(revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', o.kind,
        'price', o.price,
        'tracker_hire_price', o.tracker_hire_price,
        'supported_days', o.supported_days,
        'inclusions', o.inclusions
      )
      order by o.kind
    ),
    '[]'::jsonb
  )
  from public.adventure_offers o
  where o.revision_id = adventure_public_offers.revision_id;
$$;
revoke all on function private.adventure_public_offers(uuid) from public, anon, authenticated, service_role;

create function public.public_adventures()
returns table (
  slug text,
  name text,
  summary text,
  note text,
  region text,
  terrain text,
  when_to_start text,
  start_finish text,
  distance_km numeric,
  nominal_days integer,
  route_url text,
  is_planned boolean,
  certifiable boolean,
  offers jsonb,
  sort_order integer,
  revision_number integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.slug::text, r.name, r.summary, r.note, r.region, r.terrain, r.when_to_start,
         r.start_finish, r.distance_km, r.nominal_days, r.route_url, r.is_planned,
         exists (select 1 from public.adventure_offers o where o.revision_id = r.id),
         private.adventure_public_offers(r.id), a.sort_order, r.revision_number
  from public.adventures a
  join public.adventure_revisions r on r.id = a.current_revision_id
  where a.status = 'published' and r.sealed_at is not null
  order by a.sort_order, r.distance_km, a.slug;
$$;

create function public.public_adventure(adventure_slug text)
returns table (
  slug text,
  name text,
  summary text,
  description text,
  note text,
  region text,
  terrain text,
  when_to_start text,
  start_finish text,
  distance_km numeric,
  nominal_days integer,
  time_zone text,
  min_elapsed_minutes integer,
  max_elapsed_minutes integer,
  checkpoint_order public.adventure_checkpoint_order,
  route_url text,
  rules text,
  equipment text,
  is_planned boolean,
  certifiable boolean,
  offers jsonb,
  checkpoints jsonb,
  revision_number integer,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.slug::text, r.name, r.summary, r.description, r.note, r.region, r.terrain,
         r.when_to_start, r.start_finish, r.distance_km, r.nominal_days, r.time_zone,
         r.min_elapsed_minutes, r.max_elapsed_minutes, r.checkpoint_order, r.route_url,
         r.rules, r.equipment, r.is_planned,
         exists (select 1 from public.adventure_offers o where o.revision_id = r.id),
         private.adventure_public_offers(r.id),
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'position', c.position,
               'label', c.label,
               'instructions', c.instructions,
               'latitude', c.latitude,
               'longitude', c.longitude,
               'mandatory', c.mandatory,
               'photo_required', c.photo_required
             )
             order by c.position
           )
           from public.adventure_checkpoints c
           where c.revision_id = r.id
         ), '[]'::jsonb),
         r.revision_number, r.sealed_at
  from public.adventures a
  join public.adventure_revisions r on r.id = a.current_revision_id
  where a.status = 'published'
    and r.sealed_at is not null
    and a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(public_adventure.adventure_slug, '')))::extensions.citext;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_adventure(text, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.update_adventure_draft(
  uuid, timestamptz, text, text, text, text, text, text, text, text, numeric, integer, text,
  integer, integer, public.adventure_checkpoint_order, text, text, text, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.set_adventure_checkpoints(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_adventure_offer(uuid, public.adventure_participation, numeric, numeric, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_adventure_offer(uuid, public.adventure_participation)
  from public, anon, authenticated, service_role;
revoke all on function public.start_adventure_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.publish_adventure_revision(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.archive_adventure(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.unarchive_adventure(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_adventure_order(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.suggested_adventure_price(public.adventure_participation, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.public_adventures() from public, anon, authenticated, service_role;
revoke all on function public.public_adventure(text) from public, anon, authenticated, service_role;

grant execute on function public.create_adventure(text, text, numeric) to authenticated;
grant execute on function public.update_adventure_draft(
  uuid, timestamptz, text, text, text, text, text, text, text, text, numeric, integer, text,
  integer, integer, public.adventure_checkpoint_order, text, text, text, text, text, text, boolean
) to authenticated;
grant execute on function public.set_adventure_checkpoints(uuid, jsonb) to authenticated;
grant execute on function public.set_adventure_offer(uuid, public.adventure_participation, numeric, numeric, integer, text)
  to authenticated;
grant execute on function public.remove_adventure_offer(uuid, public.adventure_participation) to authenticated;
grant execute on function public.start_adventure_draft(uuid) to authenticated;
grant execute on function public.publish_adventure_revision(uuid, text) to authenticated;
grant execute on function public.archive_adventure(uuid, text) to authenticated;
grant execute on function public.unarchive_adventure(uuid) to authenticated;
grant execute on function public.set_adventure_order(uuid, integer) to authenticated;
grant execute on function public.suggested_adventure_price(public.adventure_participation, integer, integer)
  to authenticated;
grant execute on function public.public_adventures() to anon, authenticated;
grant execute on function public.public_adventure(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed: the routes on the public site on 2026-11-13 (src/lib/content.ts in
-- georgieboys/BICII), facts only. Written by the migration (no staff).
-- ---------------------------------------------------------------------------
with routes (slug, name, km, terrain, when_to_start, summary, note, is_planned, sort_order) as (
  values
    ('30k-east-coast', '30k East Coast', 30, 'Paths', 'Any time of day',
     'The shortest BICII route, named for East Coast. It''s meant to stay on pavements and park connectors and suit beginners.',
     '', false, 10),
    ('50k-green-corridor', '50k Green Corridor', 50, 'Trail', 'In daylight',
     'Fifty kilometres built around the Green Corridor, the old KTM railway line that''s now the Rail Corridor trail.',
     'NParks sets a 10 km/h limit on the Rail Corridor, asks you to walk your bike over its bridges, and doesn''t light it at night, so be off it by dark. Part of the southern stretch (between the Henderson Road and Spooner Road accesses) is closed for works from March 2026, so check NParks before you go.',
     false, 20),
    ('80k-changi-village', '80k Changi Village', 80, 'Paths', 'Friday night',
     'Out to Changi Village and back, first ridden as a beginner-friendly Friday night ride in December 2024.',
     '', false, 30),
    ('bicii-125', 'BICII 125', 125, 'Road', 'Around 3pm',
     'The first BICII route. Beginner friendly despite the distance: most of it is park connector, and the road-only stretches in Lim Chu Kang and Seletar are usually light on traffic. Start around 3pm and you''ll finish in the wee hours.',
     'George rode it the week it went up: 140 km in the end (he forgot to track some of it), the last 60 soaking wet, with ten-plus storm-felled trees in the way. Check the weather.',
     false, 40),
    ('bicii-250', 'BICII 250', 250, '', '',
     'Twice the 125, in a day or with a night out. The route is still being drawn.', '', true, 50),
    ('bicii-500', 'BICII 500', 500, '', '',
     'A few days on the bike, across the Causeway and up the peninsula. Route to come.', '', true, 60),
    ('bicii-1000', 'BICII 1000', 1000, '', '',
     'A week or more on the road. Route to come.', '', true, 70),
    ('bicii-2000', 'BICII 2000', 2000, '', '',
     'Weeks, not days. Route to come.', '', true, 80),
    ('bicii-3000', 'BICII 3000', 3000, '', '',
     'The big one. Route to come.', '', true, 90)
),
seeded as (
  select r.*, gen_random_uuid() as adventure_id, gen_random_uuid() as revision_id from routes r
),
-- One statement, no read-after-write between CTEs: ids are made up front,
-- the revisions reference them, and the adventure rows are inserted already
-- published with their current revision (the foreign key is checked at the
-- end of the statement, both rows exist by then).
new_adventures as (
  insert into public.adventures (id, slug, status, current_revision_id, sort_order)
  select s.adventure_id, s.slug, 'published', s.revision_id, s.sort_order from seeded s
  returning id
),
new_revisions as (
  insert into public.adventure_revisions (
    id, adventure_id, revision_number, name, summary, note, terrain, when_to_start, start_finish,
    distance_km, is_planned, change_summary, sealed_at
  )
  select s.revision_id, s.adventure_id, 1, s.name, s.summary, s.note, s.terrain, s.when_to_start,
         '294 River Valley', s.km, s.is_planned, 'Imported from the public site''s route list',
         pg_catalog.now()
  from seeded s
  returning id
)
insert into public.adventure_events (adventure_id, revision_id, kind, reason)
select s.adventure_id, s.revision_id, 'published', 'Imported from the public site''s route list'
from seeded s;
