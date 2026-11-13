-- Adventures Phase B, emails (D183, D184; DATA-MODEL §20 "Emails").
--
-- A booking event queues, in its own transaction, one row per email in
-- private.adventure_notices:
--   to the rider (the customer's email)
--     confirmed            ticket_paid        their ticket and what to do next
--     changes_requested    changes_requested  the reviewer's message
--     certified            certified          the certificate
--     not_certified        not_certified      the reviewer's message
--     pack_updated, ready  pack_ready         collect it at the shop
--   to the shop (the booking alert recipients, D163b)
--     evidence_submitted   ride_submitted     a ride is waiting for review
--     payment_attention    payment_attention  a payment needs an admin
-- A revoked certificate sends nothing: staff speak to the rider.
--
-- The sender (the adventure-work cron, src/lib/integrations/adventures/)
-- works the outbox avoiding the booking emails' weaknesses (RISKS R-100):
-- an attempt is counted when a result is recorded, not when
-- a row is claimed; a claim lasts 5 minutes, longer than the function; each
-- claim has a token and only that claim's result is recorded; a row the
-- sender did not get to is released without using an attempt; and a late
-- success is recorded even if the row was given up meanwhile. A row claimed
-- 15 times without any result is given up (a poison guard).

create type public.adventure_notice_kind as enum (
  'ticket_paid', 'changes_requested', 'certified', 'not_certified', 'pack_ready',
  'ride_submitted', 'payment_attention'
);

create table private.adventure_notices (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.adventure_bookings (id) on delete cascade,
  event_id uuid not null references public.adventure_booking_events (id) on delete cascade,
  kind public.adventure_notice_kind not null,
  audience public.appointment_notice_audience not null,
  recipient extensions.citext not null check (
    pg_catalog.char_length(recipient::text) <= 320 and recipient::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  status public.appointment_notice_status not null default 'pending',
  attempts integer not null default 0 check (attempts between 0 and 5),
  claims integer not null default 0 check (claims between 0 and 15),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  claimed_until timestamptz null,
  claim_token uuid null,
  last_error text null check (pg_catalog.char_length(last_error) <= 200),
  sent_at timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint adventure_notices_once unique (event_id, audience, recipient),
  constraint adventure_notices_sent_at check ((status = 'sent') = (sent_at is not null)),
  constraint adventure_notices_claim check ((claim_token is null) = (claimed_until is null))
);
create index adventure_notices_due_idx on private.adventure_notices (next_attempt_at)
  where status = 'pending';

comment on table private.adventure_notices is
  'D183: adventure emails waiting to be sent, one row per recipient. Queued by adventure_booking_events_queue_notices; sent by the Admin through claim_adventure_notices and finish_adventure_notice (service_role). No API role reads it.';

alter table private.adventure_notices enable row level security;
revoke all on table private.adventure_notices from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Queueing
-- ---------------------------------------------------------------------------
create function private.adventure_booking_events_queue_notices()
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

create trigger adventure_booking_events_queue_notices
  after insert on public.adventure_booking_events
  for each row execute function private.adventure_booking_events_queue_notices();

-- ---------------------------------------------------------------------------
-- The sender's side (service_role only)
-- ---------------------------------------------------------------------------
create type public.adventure_notice as (
  id uuid,
  claim_token uuid,
  kind public.adventure_notice_kind,
  audience public.appointment_notice_audience,
  recipient text,
  attempts integer,
  booking_id uuid,
  reference text,
  adventure_name text,
  adventure_slug text,
  rider_name text,
  rider_first_name text,
  message_to_rider text,
  certificate_reference text,
  completed_on date,
  accepted_distance_km numeric,
  pack_items text[],
  attention_reason text,
  public_site_url text
);

create function public.claim_adventure_notices(max_count integer default 5)
returns setof public.adventure_notice
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer := greatest(1, least(coalesce(claim_adventure_notices.max_count, 5), 20));
begin
  -- Claimed 15 times and never answered: give up. The claim stays on the
  -- row, so a send still in flight can record its success (R-100).
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
           s.public_site_url
    from claimed c
    join public.adventure_bookings b on b.id = c.booking_id
    join public.adventures a on a.id = b.adventure_id
    join public.adventure_revisions r on r.id = b.revision_id
    join public.customers cu on cu.id = b.customer_id
    left join public.adventure_certificates cert on cert.booking_id = b.id and cert.status = 'active'
    cross join public.shop_settings s
    where s.id = 1
    order by c.created_at;
end;
$$;

comment on function public.claim_adventure_notices(integer) is
  'D184, service_role: claim up to max_count (1..20) due adventure emails, oldest first, each for 5 minutes under a new claim token, with what its email needs. Claiming uses no attempt.';

-- result: 'sent', 'failed' (a send was tried and refused or timed out), or
-- 'released' (the sender did not get to it: no attempt is used).
create function public.finish_adventure_notice(notice_id uuid, claim_token uuid, result text, error text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if finish_adventure_notice.result not in ('sent', 'failed', 'released') then
    raise exception 'unknown result %', finish_adventure_notice.result using errcode = '22023';
  end if;

  if finish_adventure_notice.result = 'sent' then
    -- Also a row given up while this send was in flight (R-100).
    update private.adventure_notices q
    set status = 'sent', sent_at = pg_catalog.now(), last_error = null,
        claim_token = null, claimed_until = null
    where q.id = finish_adventure_notice.notice_id
      and q.claim_token = finish_adventure_notice.claim_token
      and (q.status = 'pending' or (q.status = 'failed' and q.sent_at is null));
  elsif finish_adventure_notice.result = 'released' then
    update private.adventure_notices q
    set claim_token = null, claimed_until = null,
        claims = greatest(q.claims - 1, 0)
    where q.id = finish_adventure_notice.notice_id
      and q.claim_token = finish_adventure_notice.claim_token
      and q.status = 'pending';
  else
    update private.adventure_notices q
    set attempts = q.attempts + 1,
        status = case when q.attempts + 1 >= 5 then 'failed' else 'pending' end::public.appointment_notice_status,
        next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(mins => 5 * (q.attempts + 1)),
        claim_token = null, claimed_until = null,
        last_error = pg_catalog.left(coalesce(nullif(pg_catalog.btrim(finish_adventure_notice.error), ''), 'Email failed'), 200)
    where q.id = finish_adventure_notice.notice_id
      and q.claim_token = finish_adventure_notice.claim_token
      and q.status = 'pending';
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

comment on function public.finish_adventure_notice(uuid, uuid, text, text) is
  'D184, service_role: record one adventure email''s result under its claim token (another claim''s result is ignored). Sent is final; a failure waits attempts x 5 minutes and the fifth is final; released returns the row unused.';

revoke all on function private.adventure_booking_events_queue_notices() from public, anon, authenticated, service_role;
revoke all on function public.claim_adventure_notices(integer) from public, anon, authenticated, service_role;
revoke all on function public.finish_adventure_notice(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_adventure_notices(integer) to service_role;
grant execute on function public.finish_adventure_notice(uuid, uuid, text, text) to service_role;
