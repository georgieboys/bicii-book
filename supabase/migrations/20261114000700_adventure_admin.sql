-- Adventures Phase B, Admin screens (D181, D182): an admin clears a booking's
-- payment flag once the problem is handled (a refund in Stripe, a duplicate
-- explained), with a note kept in the booking's history. A flagged booking
-- cannot be certified (decide_adventure_review, adventure_booking_attention).

create function public.clear_adventure_booking_attention(booking_id uuid, note text)
returns public.adventure_bookings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  b public.adventure_bookings;
  clean text := nullif(pg_catalog.btrim(coalesce(clear_adventure_booking_attention.note, '')), '');
begin
  if clean is null then
    raise exception using errcode = 'P0001', message = 'reason_required',
      detail = 'Say how the payment problem was handled.';
  end if;
  if pg_catalog.char_length(clean) > 500 then
    raise exception using errcode = 'P0001', message = 'reason_too_long';
  end if;
  select * into b from public.adventure_bookings x where x.id = clear_adventure_booking_attention.booking_id for update;
  if not found then
    raise exception 'booking % not found', clear_adventure_booking_attention.booking_id using errcode = 'P0002';
  end if;
  if not b.needs_attention then
    return b;
  end if;
  update public.adventure_bookings x
  set needs_attention = false, attention_reason = null
  where x.id = b.id
  returning x.* into b;
  insert into public.adventure_booking_events (booking_id, kind, staff_id, detail)
  values (b.id, 'attention_cleared', actor, pg_catalog.jsonb_build_object('note', clean));
  return b;
end;
$$;

revoke all on function public.clear_adventure_booking_attention(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.clear_adventure_booking_attention(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The review workspace's reads (D182). Security invoker: the evidence RLS
-- (verify or manage adventures) applies, so anyone else gets no rows.
-- ---------------------------------------------------------------------------

-- A track thinned to at most max_points points, first and last kept, for
-- drawing it (PostgREST returns at most 1,000 rows a request).
create function public.adventure_track_outline(track_id uuid, max_points integer)
returns table (seq integer, recorded_at timestamptz, latitude numeric, longitude numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select k.point_count,
           greatest(1, pg_catalog.ceil(k.point_count::numeric / greatest(2, least(adventure_track_outline.max_points, 1000))))::integer as step
    from public.adventure_tracks k
    where k.id = adventure_track_outline.track_id
  )
  select p.seq, p.recorded_at, p.latitude, p.longitude
  from public.adventure_track_points p, t
  where p.track_id = adventure_track_outline.track_id
    and (p.seq % t.step = 0 or p.seq = t.point_count - 1)
  order by p.seq;
$$;

-- For each checkpoint of the bought revision: the recorded point nearest
-- to it across the version's parsed tracks, its distance in metres and its
-- time. A derived hint for the reviewer, never a decision.
create function public.adventure_checkpoint_passes(submission_id uuid)
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
    select b.revision_id
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

revoke all on function public.adventure_track_outline(uuid, integer), public.adventure_checkpoint_passes(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.adventure_track_outline(uuid, integer), public.adventure_checkpoint_passes(uuid)
  to authenticated;
