-- Adventures Phase D, group departures (D193-D195; DATA-MODEL §20
-- "Departures"; handoff §6.4).
--
--   * adventure_departures: dates BICII publishes for a route. Phase D has
--     peer groups (`self_supported_group`): riders who bought the
--     self-supported certification join one with that ticket, with no
--     second purchase. Each rider keeps their own booking, evidence and
--     outcome; a group neither passes nor fails as one. Phase E adds
--     supported departures to the same table.
--   * adventure_departure_participants: joins and leaves, kept. A booking is
--     in at most one departure at a time. Places are checked under the
--     departure's row lock (lock order: booking, departure, tracker pool,
--     device), and a join names the version the rider saw, so a changed
--     date or place count is never joined unawares.
--   * The public sees a departure's date, meeting point, places left and
--     the riders who agreed to show their name, as first name and initial.
--     Never contact details.
--   * Cancelling a departure emails its riders; their tickets stand.

create type public.adventure_departure_status as enum ('scheduled', 'cancelled', 'completed');

create table public.adventure_departures (
  id uuid primary key default gen_random_uuid(),
  adventure_id uuid not null references public.adventures (id) on delete restrict,
  kind public.adventure_participation not null check (kind in ('self_supported_group', 'supported')),
  starts_at timestamptz not null,
  expected_finish_at timestamptz null,
  meeting_point text not null check (pg_catalog.char_length(pg_catalog.btrim(meeting_point)) between 1 and 200),
  capacity integer not null check (capacity between 1 and 200),
  status public.adventure_departure_status not null default 'scheduled',
  note text not null default '' check (pg_catalog.char_length(note) <= 1000),
  staff_note text not null default '' check (pg_catalog.char_length(staff_note) <= 1000),
  cancel_reason text null check (pg_catalog.char_length(cancel_reason) <= 500),
  version integer not null default 1,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint adventure_departures_finish check (expected_finish_at is null or expected_finish_at > starts_at),
  constraint adventure_departures_cancelled check ((status = 'cancelled') = (cancel_reason is not null))
);
create index adventure_departures_upcoming on public.adventure_departures (adventure_id, starts_at)
  where status = 'scheduled';
create trigger adventure_departures_set_updated_at
  before update on public.adventure_departures
  for each row execute function private.set_updated_at();

create table public.adventure_departure_participants (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.adventure_departures (id) on delete restrict,
  booking_id uuid not null references public.adventure_bookings (id) on delete restrict,
  show_name boolean not null default false,
  joined_at timestamptz not null default pg_catalog.now(),
  left_at timestamptz null,
  left_reason text null check (pg_catalog.char_length(left_reason) <= 200),
  constraint adventure_departure_participants_left check ((left_at is null) = (left_reason is null))
);
create unique index adventure_departure_participants_one_open
  on public.adventure_departure_participants (booking_id) where left_at is null;
create index adventure_departure_participants_departure
  on public.adventure_departure_participants (departure_id) where left_at is null;

alter table public.adventure_departures enable row level security;
alter table public.adventure_departure_participants enable row level security;
revoke all on table public.adventure_departures, public.adventure_departure_participants
  from public, anon, authenticated, service_role;
grant select on table public.adventure_departures, public.adventure_departure_participants to authenticated;
create policy adventure_departures_select_staff on public.adventure_departures
  for select to authenticated using ((select private.is_staff()));
create policy adventure_departure_participants_select_staff on public.adventure_departure_participants
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Staff: create, change, cancel (manage_adventures)
-- ---------------------------------------------------------------------------
create function private.departure_taken(departure uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select pg_catalog.count(*)::integer from public.adventure_departure_participants p
  where p.departure_id = departure_taken.departure and p.left_at is null;
$$;
revoke all on function private.departure_taken(uuid) from public, anon, authenticated, service_role;

create function public.create_adventure_departure(
  adventure_id uuid, kind public.adventure_participation, starts_at timestamptz, expected_finish_at timestamptz,
  meeting_point text, capacity integer, note text, staff_note text
)
returns public.adventure_departures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  adv public.adventures;
  result public.adventure_departures;
begin
  select a.* into adv from public.adventures a where a.id = create_adventure_departure.adventure_id;
  if not found then
    raise exception 'adventure % not found', create_adventure_departure.adventure_id using errcode = 'P0002';
  end if;
  if adv.status <> 'published' then
    raise exception using errcode = 'P0001', message = 'departure_adventure_unpublished',
      detail = 'Publish the adventure before adding dates.';
  end if;
  if create_adventure_departure.kind = 'self_supported_group' and not exists (
    select 1 from public.adventure_offers o where o.revision_id = adv.current_revision_id and o.kind = 'self_supported'
  ) then
    raise exception using errcode = 'P0001', message = 'departure_needs_offer',
      detail = 'Riders join a group ride with a self-supported ticket: add that offer first.';
  end if;
  if create_adventure_departure.kind = 'supported' and not exists (
    select 1 from public.adventure_offers o where o.revision_id = adv.current_revision_id and o.kind = 'supported'
  ) then
    raise exception using errcode = 'P0001', message = 'departure_needs_offer',
      detail = 'Add a supported offer to the adventure first.';
  end if;
  if create_adventure_departure.starts_at is null or create_adventure_departure.starts_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'departure_in_past',
      detail = 'Choose a start in the future.';
  end if;
  insert into public.adventure_departures (adventure_id, kind, starts_at, expected_finish_at, meeting_point, capacity,
                                           note, staff_note, created_by)
  values (adv.id, create_adventure_departure.kind, create_adventure_departure.starts_at,
          create_adventure_departure.expected_finish_at, pg_catalog.btrim(create_adventure_departure.meeting_point),
          create_adventure_departure.capacity, pg_catalog.btrim(coalesce(create_adventure_departure.note, '')),
          pg_catalog.btrim(coalesce(create_adventure_departure.staff_note, '')), actor)
  returning * into result;
  return result;
end;
$$;

create function public.update_adventure_departure(
  departure_id uuid, expected_version integer, starts_at timestamptz, expected_finish_at timestamptz,
  meeting_point text, capacity integer, note text, staff_note text
)
returns public.adventure_departures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  d public.adventure_departures;
begin
  select x.* into d from public.adventure_departures x where x.id = update_adventure_departure.departure_id for update;
  if not found then
    raise exception 'departure % not found', update_adventure_departure.departure_id using errcode = 'P0002';
  end if;
  if d.version <> update_adventure_departure.expected_version then
    raise exception using errcode = 'P0001', message = 'departure_changed',
      detail = 'Someone changed this departure since you opened it. Reload and try again.';
  end if;
  if d.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'departure_not_scheduled',
      detail = 'This departure is cancelled or finished.';
  end if;
  if update_adventure_departure.capacity < private.departure_taken(d.id) then
    raise exception using errcode = 'P0001', message = 'departure_capacity_below_riders',
      detail = 'More riders have joined than that. Raise the places, or ask riders to leave first.';
  end if;
  update public.adventure_departures x
  set starts_at = update_adventure_departure.starts_at,
      expected_finish_at = update_adventure_departure.expected_finish_at,
      meeting_point = pg_catalog.btrim(update_adventure_departure.meeting_point),
      capacity = update_adventure_departure.capacity,
      note = pg_catalog.btrim(coalesce(update_adventure_departure.note, '')),
      staff_note = pg_catalog.btrim(coalesce(update_adventure_departure.staff_note, '')),
      version = x.version + 1
  where x.id = d.id
  returning x.* into d;
  return d;
end;
$$;

create function public.cancel_adventure_departure(departure_id uuid, reason text)
returns public.adventure_departures
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_adventures');
  d public.adventure_departures;
  clean text := nullif(pg_catalog.btrim(coalesce(cancel_adventure_departure.reason, '')), '');
  p record;
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why the departure is cancelled.';
  end if;
  -- Lock order: the riders' bookings, then the departure.
  perform 1 from public.adventure_bookings b
  join public.adventure_departure_participants x on x.booking_id = b.id
  where x.departure_id = cancel_adventure_departure.departure_id and x.left_at is null
  order by b.id
  for update of b;
  select x.* into d from public.adventure_departures x where x.id = cancel_adventure_departure.departure_id for update;
  if not found then
    raise exception 'departure % not found', cancel_adventure_departure.departure_id using errcode = 'P0002';
  end if;
  if d.status <> 'scheduled' then
    raise exception using errcode = 'P0001', message = 'departure_not_scheduled',
      detail = 'This departure is cancelled or finished.';
  end if;
  for p in
    update public.adventure_departure_participants x
    set left_at = pg_catalog.now(), left_reason = 'Departure cancelled'
    where x.departure_id = d.id and x.left_at is null
    returning x.booking_id
  loop
    insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
    values (p.booking_id, 'departure_cancelled', actor,
            pg_catalog.jsonb_build_object('departure_id', d.id, 'note', clean));
  end loop;
  update public.adventure_departures x
  set status = 'cancelled', cancel_reason = pg_catalog.left(clean, 500), version = x.version + 1
  where x.id = d.id
  returning x.* into d;
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Riders: join and leave a peer group with their ticket
-- ---------------------------------------------------------------------------
create function public.join_adventure_departure(booking_id uuid, departure_id uuid, expected_version integer, show_name boolean)
returns public.adventure_departure_participants
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  d public.adventure_departures;
  result public.adventure_departure_participants;
begin
  select x.* into b from public.adventure_bookings x
  where x.id = join_adventure_departure.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  select x.* into d from public.adventure_departures x where x.id = join_adventure_departure.departure_id for update;
  if not found or d.kind <> 'self_supported_group' or d.adventure_id <> b.adventure_id then
    raise exception using errcode = 'P0001', message = 'departure_unavailable',
      detail = 'That date is not for your ride.';
  end if;
  if b.status <> 'confirmed' or b.kind <> 'self_supported' then
    raise exception using errcode = 'P0001', message = 'departure_needs_ticket',
      detail = 'Join a group ride with a paid self-supported ticket for this route.';
  end if;
  if d.status <> 'scheduled' or d.starts_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'departure_unavailable',
      detail = 'That date is no longer open.';
  end if;
  if d.version <> join_adventure_departure.expected_version then
    raise exception using errcode = 'P0001', message = 'departure_changed',
      detail = 'This date has just changed. Check it and join again.';
  end if;
  if exists (select 1 from public.adventure_departure_participants x where x.booking_id = b.id and x.left_at is null) then
    raise exception using errcode = 'P0001', message = 'departure_already_joined',
      detail = 'You''ve already joined a date. Leave it first to change.';
  end if;
  if private.departure_taken(d.id) >= d.capacity then
    raise exception using errcode = 'P0001', message = 'departure_full',
      detail = 'That date is full. Choose another.';
  end if;
  insert into public.adventure_departure_participants (departure_id, booking_id, show_name)
  values (d.id, b.id, coalesce(join_adventure_departure.show_name, false))
  returning * into result;
  insert into public.adventure_booking_events (booking_id, kind, detail)
  values (b.id, 'departure_joined', pg_catalog.jsonb_build_object('departure_id', d.id));
  return result;
end;
$$;

-- Leaving keeps the ticket: the rider can ride solo or join another date.
create function public.leave_adventure_departure(booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b public.adventure_bookings;
  left_from uuid;
begin
  select x.* into b from public.adventure_bookings x
  where x.id = leave_adventure_departure.booking_id and x.customer_id = private.require_customer()
  for update;
  if not found then
    raise exception 'booking not owned' using errcode = '42501';
  end if;
  update public.adventure_departure_participants x
  set left_at = pg_catalog.now(), left_reason = 'Left by the rider'
  where x.booking_id = b.id and x.left_at is null
  returning x.departure_id into left_from;
  if left_from is not null then
    insert into public.adventure_booking_events (booking_id, kind, detail)
    values (b.id, 'departure_left', pg_catalog.jsonb_build_object('departure_id', left_from));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- A route's upcoming departures for anyone: date, place, places left, and
-- the riders who chose to show their name, as first name and initial.
create function public.public_adventure_departures(adventure_slug text)
returns table (
  id uuid, kind public.adventure_participation, starts_at timestamptz, expected_finish_at timestamptz,
  meeting_point text, note text, capacity integer, taken integer, version integer, riders text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.kind, d.starts_at, d.expected_finish_at, d.meeting_point, d.note, d.capacity,
         private.departure_taken(d.id), d.version,
         coalesce((
           select pg_catalog.array_agg(private.finisher_display_name(c, 'first_name_initial') order by p.joined_at)
           from public.adventure_departure_participants p
           join public.adventure_bookings b on b.id = p.booking_id
           join public.customers c on c.id = b.customer_id
           where p.departure_id = d.id and p.left_at is null and p.show_name
         ), '{}')
  from public.adventure_departures d
  join public.adventures a on a.id = d.adventure_id
  where a.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(public_adventure_departures.adventure_slug, '')))::extensions.citext
    and a.status = 'published'
    and d.status = 'scheduled'
    and d.starts_at > pg_catalog.now()
  order by d.starts_at;
$$;

-- The rider's current departure on their own booking.
create function public.my_adventure_departure(booking_id uuid)
returns table (
  departure_id uuid, starts_at timestamptz, expected_finish_at timestamptz, meeting_point text, note text,
  status public.adventure_departure_status, show_name boolean, joined_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.starts_at, d.expected_finish_at, d.meeting_point, d.note, d.status, p.show_name, p.joined_at
  from public.adventure_departure_participants p
  join public.adventure_departures d on d.id = p.departure_id
  join public.adventure_bookings b on b.id = p.booking_id
  where p.booking_id = my_adventure_departure.booking_id
    and b.customer_id = private.require_customer()
    and p.left_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Emails: joining and a cancelled departure reach the rider (D195).
-- ---------------------------------------------------------------------------
alter type public.adventure_notice add attribute departure_starts_at timestamptz;
alter type public.adventure_notice add attribute departure_meeting_point text;

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
    when 'departure_cancelled' then 'departure_cancelled'
  end::public.adventure_notice_kind;
  if notice is null then
    return null;
  end if;
  to_shop := notice in ('ride_submitted', 'payment_attention');

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
           (select v.message_to_rider
              from public.adventure_reviews v
              join public.adventure_submissions s on s.id = v.submission_id
              join public.adventure_attempts t on t.id = s.attempt_id
             where t.booking_id = b.id
             order by v.decided_at desc limit 1),
           cert.reference, cert.completed_on, cert.accepted_distance_km::numeric,
           (select f.items from public.adventure_fulfilments f where f.booking_id = b.id limit 1),
           b.attention_reason,
           s.public_site_url,
           dep.starts_at, dep.meeting_point
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_adventure_departure(uuid, public.adventure_participation, timestamptz, timestamptz, text, integer, text, text),
  public.update_adventure_departure(uuid, integer, timestamptz, timestamptz, text, integer, text, text),
  public.cancel_adventure_departure(uuid, text),
  public.join_adventure_departure(uuid, uuid, integer, boolean),
  public.leave_adventure_departure(uuid),
  public.public_adventure_departures(text),
  public.my_adventure_departure(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.create_adventure_departure(uuid, public.adventure_participation, timestamptz, timestamptz, text, integer, text, text),
  public.update_adventure_departure(uuid, integer, timestamptz, timestamptz, text, integer, text, text),
  public.cancel_adventure_departure(uuid, text),
  public.join_adventure_departure(uuid, uuid, integer, boolean),
  public.leave_adventure_departure(uuid),
  public.my_adventure_departure(uuid)
to authenticated;
grant execute on function public.public_adventure_departures(text) to anon, authenticated;
