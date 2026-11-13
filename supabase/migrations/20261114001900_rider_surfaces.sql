-- Adventures Phase F, the rider's optional surfaces (D204-D206; handoff
-- §6.6; ADVENTURES-PLAN §3 switches):
--
--   * GPX export (D204): a rider reads the positions their hired tracker
--     recorded inside their latest ride window, as points for a GPX file.
--     Only their own booking; at most 20,000 points.
--   * Live-share links (D205): a rider makes a link for their latest ride.
--     The token is shown once and stored only as its SHA-256. One link per
--     ride at a time (a new one revokes the old); it lasts at most 48 hours
--     and the rider can revoke it. While the ride is open, anyone with the
--     link sees the rider's first name and initial, the route and the
--     positions so far; once the ride is finished it shows only that it is
--     finished. Off until an admin turns on `live_sharing_enabled`.
--   * Public rider profiles (D206): a rider opts in and gets a random
--     public id; the profile shows their first name and initial and their
--     active certificates and badges, nothing else. Off until an admin turns
--     on `public_profiles_enabled`; opting out hides it at once.

alter table public.adventure_settings
  add column live_sharing_enabled boolean not null default false,
  add column public_profiles_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.adventure_ride_shares (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.adventure_attempts (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  token_hash bytea not null unique check (pg_catalog.octet_length(token_hash) = 32),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  constraint adventure_ride_shares_window check (expires_at > created_at and expires_at <= created_at + interval '48 hours')
);
create unique index adventure_ride_shares_one_live on public.adventure_ride_shares (attempt_id)
  where revoked_at is null;
comment on table public.adventure_ride_shares is
  'D205: a rider''s revocable live-share link for one ride. Only the token''s SHA-256 is stored.';

create table public.adventure_rider_profiles (
  customer_id uuid primary key references public.customers (id) on delete restrict,
  public_id uuid not null unique default gen_random_uuid(),
  visible boolean not null default false,
  updated_at timestamptz not null default pg_catalog.now()
);
comment on table public.adventure_rider_profiles is
  'D206: a rider''s opt-in public profile (first name and initial, certificates, badges).';

alter table public.adventure_ride_shares enable row level security;
alter table public.adventure_rider_profiles enable row level security;
revoke all on table public.adventure_ride_shares, public.adventure_rider_profiles
  from public, anon, authenticated, service_role;
grant select on table public.adventure_ride_shares, public.adventure_rider_profiles to authenticated;
-- Staff who verify or manage adventures can see that a link or profile
-- exists (never the token); riders read their own through the RPCs.
create policy adventure_ride_shares_select_staff on public.adventure_ride_shares
  for select to authenticated using ((select private.can_read_adventure_evidence()));
create policy adventure_rider_profiles_select_staff on public.adventure_rider_profiles
  for select to authenticated using ((select private.can_read_adventure_evidence()));

-- ---------------------------------------------------------------------------
-- Switches
-- ---------------------------------------------------------------------------
create function public.set_adventure_public_surfaces(live_sharing boolean, public_profiles boolean)
returns public.adventure_settings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  result public.adventure_settings;
begin
  update public.adventure_settings s
  set live_sharing_enabled = coalesce(set_adventure_public_surfaces.live_sharing, false),
      public_profiles_enabled = coalesce(set_adventure_public_surfaces.public_profiles, false),
      updated_by = actor
  where s.id = 1
  returning s.* into result;
  return result;
end;
$$;

create function public.adventure_public_surfaces()
returns table (live_sharing boolean, public_profiles boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.live_sharing_enabled, s.public_profiles_enabled from public.adventure_settings s where s.id = 1;
$$;

-- ---------------------------------------------------------------------------
-- GPX export (D204)
-- ---------------------------------------------------------------------------
-- The rider's latest ride on this booking with a ride window.
create function private.my_latest_ride(booking uuid)
returns public.adventure_attempts
language sql
stable
security definer
set search_path = ''
as $$
  select t.*
  from public.adventure_attempts t
  join public.adventure_bookings b on b.id = t.booking_id
  where t.booking_id = booking
    and b.customer_id = private.require_customer()
    and t.capture_started_at is not null
  order by t.attempt_number desc
  limit 1;
$$;
revoke all on function private.my_latest_ride(uuid) from public, anon, authenticated, service_role;

create function public.my_adventure_ride_points(booking_id uuid)
returns table (recorded_at timestamptz, latitude numeric, longitude numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.adventure_attempts;
begin
  if not exists (
    select 1 from public.adventure_bookings b
    where b.id = my_adventure_ride_points.booking_id and b.customer_id = private.require_customer()
  ) then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  t := private.my_latest_ride(my_adventure_ride_points.booking_id);
  if t.id is null then
    return;
  end if;
  return query
    select m.recorded_at, m.latitude::numeric, m.longitude::numeric
    from public.tracking_messages m
    where m.attempt_id = t.id and m.latitude is not null
    order by m.recorded_at, m.id
    limit 20000;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live-share links (D205)
-- ---------------------------------------------------------------------------
create function public.create_my_ride_share(booking_id uuid, hours integer)
returns table (token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t public.adventure_attempts;
  raw bytea := extensions.gen_random_bytes(24);
  until timestamptz := pg_catalog.now() + make_interval(hours => greatest(1, least(coalesce(create_my_ride_share.hours, 24), 48)));
begin
  if not exists (
    select 1 from public.adventure_bookings b
    where b.id = create_my_ride_share.booking_id and b.customer_id = private.require_customer()
  ) then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  if not coalesce((select s.live_sharing_enabled from public.adventure_settings s where s.id = 1), false) then
    raise exception using errcode = 'P0001', message = 'live_sharing_off',
      detail = 'Live sharing isn''t available yet.';
  end if;
  t := private.my_latest_ride(create_my_ride_share.booking_id);
  if t.id is null or t.capture_finished_at is not null then
    raise exception using errcode = 'P0001', message = 'ride_not_open',
      detail = 'Start your ride first; a finished ride can''t be shared live.';
  end if;
  -- One live link per ride: the attempt row is the lock.
  perform 1 from public.adventure_attempts x where x.id = t.id for update;
  update public.adventure_ride_shares s set revoked_at = pg_catalog.now()
  where s.attempt_id = t.id and s.revoked_at is null;
  insert into public.adventure_ride_shares (attempt_id, customer_id, token_hash, expires_at)
  values (t.id, private.require_customer(), extensions.digest(raw, 'sha256'), until);
  token := pg_catalog.translate(pg_catalog.encode(raw, 'base64'), '+/', '-_');
  expires_at := until;
  return next;
end;
$$;

create function public.revoke_my_ride_share(booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.adventure_bookings b
    where b.id = revoke_my_ride_share.booking_id and b.customer_id = private.require_customer()
  ) then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  update public.adventure_ride_shares s set revoked_at = pg_catalog.now()
  from public.adventure_attempts t
  where t.id = s.attempt_id and t.booking_id = revoke_my_ride_share.booking_id and s.revoked_at is null;
end;
$$;

-- The rider's current link, if any (never the token).
create function public.my_ride_share(booking_id uuid)
returns table (created_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.created_at, s.expires_at
  from public.adventure_ride_shares s
  join public.adventure_attempts t on t.id = s.attempt_id
  join public.adventure_bookings b on b.id = t.booking_id
  where t.booking_id = my_ride_share.booking_id
    and b.customer_id = private.require_customer()
    and s.revoked_at is null
    and s.expires_at > pg_catalog.now()
    and t.capture_finished_at is null
  order by s.created_at desc
  limit 1;
$$;

-- What a link shows. Null for an unknown, revoked or expired link, or when
-- live sharing is off. Positions only while the ride is open.
create function public.public_shared_ride(token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.adventure_ride_shares;
  t public.adventure_attempts;
  rider text;
  route text;
  pts jsonb;
  clean text := pg_catalog.btrim(coalesce(public_shared_ride.token, ''));
begin
  if clean !~ '^[A-Za-z0-9_-]{32}$' then
    return null;
  end if;
  if not coalesce((select x.live_sharing_enabled from public.adventure_settings x where x.id = 1), false) then
    return null;
  end if;
  select x.* into s from public.adventure_ride_shares x
  where x.token_hash = extensions.digest(pg_catalog.decode(pg_catalog.translate(clean, '-_', '+/'), 'base64'), 'sha256')
    and x.revoked_at is null and x.expires_at > pg_catalog.now();
  if not found then
    return null;
  end if;
  select x.* into t from public.adventure_attempts x where x.id = s.attempt_id;
  select private.finisher_display_name(c, 'first_name_initial'), ar.name
    into rider, route
  from public.adventure_bookings b
  join public.customers c on c.id = b.customer_id
  join public.adventures a on a.id = b.adventure_id
  left join public.adventure_revisions ar on ar.id = a.current_revision_id
  where b.id = t.booking_id;
  if t.capture_finished_at is not null then
    return pg_catalog.jsonb_build_object('rider', rider, 'route', route, 'status', 'finished',
      'started_at', t.capture_started_at, 'finished_at', t.capture_finished_at, 'expires_at', s.expires_at,
      'points', '[]'::jsonb);
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.recorded_at, p.latitude, p.longitude) order by p.recorded_at), '[]'::jsonb)
    into pts
  from (
    select m.recorded_at, m.latitude::numeric as latitude, m.longitude::numeric as longitude
    from public.tracking_messages m
    where m.attempt_id = t.id and m.latitude is not null
    order by m.recorded_at desc
    limit 2000
  ) p;
  return pg_catalog.jsonb_build_object('rider', rider, 'route', route, 'status', 'riding',
    'started_at', t.capture_started_at, 'finished_at', null, 'expires_at', s.expires_at, 'points', pts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public rider profiles (D206)
-- ---------------------------------------------------------------------------
create function public.set_my_rider_profile(shown boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  result uuid;
begin
  if coalesce(set_my_rider_profile.shown, false)
     and not coalesce((select s.public_profiles_enabled from public.adventure_settings s where s.id = 1), false) then
    raise exception using errcode = 'P0001', message = 'public_profiles_off',
      detail = 'Public rider profiles aren''t available yet.';
  end if;
  insert into public.adventure_rider_profiles as p (customer_id, visible)
  values (me, coalesce(set_my_rider_profile.shown, false))
  on conflict (customer_id) do update
    set visible = excluded.visible, updated_at = pg_catalog.now()
  returning p.public_id into result;
  return result;
end;
$$;

create function public.my_rider_profile()
returns table (public_id uuid, visible boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.public_id, p.visible from public.adventure_rider_profiles p
  where p.customer_id = private.require_customer();
$$;

-- Null unless profiles are on and the rider opted in.
create function public.public_rider_profile(public_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'rider', private.finisher_display_name(c, 'first_name_initial'),
    'certificates', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'badge', ba.label, 'completed_on', cert.completed_on, 'reference', cert.reference)
             order by cert.completed_on desc, cert.id)
      from public.adventure_certificates cert
      join public.adventure_bookings b on b.id = cert.booking_id
      join public.adventure_badge_awards ba on ba.certificate_id = cert.id
      where b.customer_id = p.customer_id and cert.status = 'active'
    ), '[]'::jsonb))
  from public.adventure_rider_profiles p
  join public.customers c on c.id = p.customer_id
  join public.adventure_settings s on s.id = 1
  where p.public_id = public_rider_profile.public_id
    and p.visible
    and s.public_profiles_enabled;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.set_adventure_public_surfaces(boolean, boolean),
  public.adventure_public_surfaces(),
  public.my_adventure_ride_points(uuid),
  public.create_my_ride_share(uuid, integer),
  public.revoke_my_ride_share(uuid),
  public.my_ride_share(uuid),
  public.public_shared_ride(text),
  public.set_my_rider_profile(boolean),
  public.my_rider_profile(),
  public.public_rider_profile(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.set_adventure_public_surfaces(boolean, boolean),
  public.my_adventure_ride_points(uuid),
  public.create_my_ride_share(uuid, integer),
  public.revoke_my_ride_share(uuid),
  public.my_ride_share(uuid),
  public.set_my_rider_profile(boolean),
  public.my_rider_profile()
to authenticated;

grant execute on function
  public.adventure_public_surfaces(),
  public.public_shared_ride(text),
  public.public_rider_profile(uuid)
to anon, authenticated;
