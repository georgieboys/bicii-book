-- Booking emails (PLAN D163; the owner's request of 2026-11-12 SGT: alerts
-- to the shop for online bookings and cancellations, confirmations to the
-- customer; DATA-MODEL §3 "Booking emails", §16).
--
-- An appointment booked online (source 'customer') queues, in the booking's
-- own transaction, one row per email in private.appointment_notices:
--   booked     a shop alert to each chosen recipient, and a confirmation
--              to the customer's email;
--   cancelled  by the customer: a shop alert (with the customer's reason)
--              and a confirmation to them; by staff: the customer's email
--              only (staff already know, and the staff reason stays
--              internal).
-- Staff bookings queue nothing (staff tell the customer themselves).
-- Recipients are resolved when the row is queued: the active staff members
-- named in shop_settings.booking_alert_staff_ids (their login's email) and
-- the addresses in shop_settings.booking_alert_emails, set by an admin
-- with set_booking_alert_recipients.
--
-- The Admin's sender (a Vercel cron every minute, src/lib/integrations/
-- notifications/) claims due rows with claim_appointment_notices, sends
-- each through Resend and records the result with
-- finish_appointment_notice; both are service_role only. A failure waits
-- (attempts × 5 minutes) and is retried; the fifth failure is final. No API
-- role reads the outbox.

-- ---------------------------------------------------------------------------
-- Recipients (D163b), on the settings row (its history trigger records
-- every change).
-- ---------------------------------------------------------------------------
alter table public.shop_settings
  add column booking_alert_staff_ids uuid[] not null default '{}',
  add column booking_alert_emails text[] not null default '{}',
  add constraint shop_settings_booking_alert_staff_ids_check
    check (pg_catalog.cardinality(booking_alert_staff_ids) <= 10),
  add constraint shop_settings_booking_alert_emails_check
    check (pg_catalog.cardinality(booking_alert_emails) <= 10);

comment on column public.shop_settings.booking_alert_staff_ids is
  'D163b: staff members whose login email gets a booking alert (active ones only, resolved when an alert is queued). Set by set_booking_alert_recipients (admin).';
comment on column public.shop_settings.booking_alert_emails is
  'D163b: other addresses that get booking alerts (lowercase, distinct). Set by set_booking_alert_recipients (admin).';

-- ---------------------------------------------------------------------------
-- The outbox.
-- ---------------------------------------------------------------------------
create type public.appointment_notice_kind as enum ('booked', 'cancelled');
create type public.appointment_notice_audience as enum ('shop', 'customer');
create type public.appointment_notice_status as enum ('pending', 'sent', 'failed');

create table private.appointment_notices (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  kind public.appointment_notice_kind not null,
  audience public.appointment_notice_audience not null,
  recipient extensions.citext not null check (
    pg_catalog.char_length(recipient::text) <= 320 and recipient::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  -- Who cancelled (kind 'cancelled' only).
  cancelled_by public.appointment_source null,
  -- The customer's own cancellation reason, for the shop alert only.
  reason text null check (pg_catalog.char_length(reason) <= 500),
  status public.appointment_notice_status not null default 'pending',
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  claimed_until timestamptz null,
  last_error text null check (pg_catalog.char_length(last_error) <= 200),
  sent_at timestamptz null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint appointment_notices_once unique (appointment_id, kind, audience, recipient),
  constraint appointment_notices_cancelled_by check ((kind = 'cancelled') = (cancelled_by is not null)),
  constraint appointment_notices_reason_shop_only check (reason is null or (audience = 'shop' and kind = 'cancelled')),
  constraint appointment_notices_sent_at check ((status = 'sent') = (sent_at is not null))
);
create index appointment_notices_due_idx on private.appointment_notices (next_attempt_at)
  where status = 'pending';

comment on table private.appointment_notices is
  'D163: booking emails waiting to be sent, one row per recipient. Queued by appointments_queue_notices; sent by the Admin through claim_appointment_notices and finish_appointment_notice (service_role). No API role reads it.';

alter table private.appointment_notices enable row level security;
revoke all on table private.appointment_notices from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Queueing (D163a).
-- ---------------------------------------------------------------------------
create function private.queue_appointment_notices(
  appt public.appointments,
  notice_kind public.appointment_notice_kind,
  customer_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.shop_settings;
  customer_email text;
begin
  -- The shop: every online booking, and a cancellation the customer made.
  if notice_kind = 'booked' or appt.cancelled_via = 'customer' then
    select s.* into settings from public.shop_settings s where s.id = 1;
    insert into private.appointment_notices (appointment_id, kind, audience, recipient, cancelled_by, reason)
    select appt.id, notice_kind, 'shop'::public.appointment_notice_audience, r.address,
           case when notice_kind = 'cancelled' then appt.cancelled_via end,
           case when notice_kind = 'cancelled' then customer_reason end
    from (
      select pg_catalog.lower(st.email::text) as address
      from public.staff st
      where st.id = any(settings.booking_alert_staff_ids) and st.active
      union
      select pg_catalog.lower(e) from pg_catalog.unnest(settings.booking_alert_emails) e
    ) r
    on conflict on constraint appointment_notices_once do nothing;
  end if;

  -- The customer: every booking email, if they have an address.
  select c.email::text into customer_email from public.customers c where c.id = appt.customer_id;
  if customer_email is not null then
    insert into private.appointment_notices (appointment_id, kind, audience, recipient, cancelled_by)
    values (
      appt.id, notice_kind, 'customer'::public.appointment_notice_audience, pg_catalog.lower(customer_email),
      case when notice_kind = 'cancelled' then appt.cancelled_via end
    )
    on conflict on constraint appointment_notices_once do nothing;
  end if;
end;
$$;

create function private.appointments_queue_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reason text;
begin
  -- D163a: only appointments booked online.
  if new.source <> 'customer' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.queue_appointment_notices(new, 'booked', null);
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- cancel_my_appointment sets the customer's reason as the change
    -- reason, or this default when they gave none.
    reason := nullif(private.change_reason(), 'Cancelled by the customer');
    perform private.queue_appointment_notices(
      new, 'cancelled',
      case when new.cancelled_via = 'customer' then pg_catalog.left(reason, 500) end
    );
  end if;
  return null;
end;
$$;

create trigger appointments_queue_notices
  after insert or update of status on public.appointments
  for each row execute function private.appointments_queue_notices();

-- ---------------------------------------------------------------------------
-- set_booking_alert_recipients (D163b): admin only.
-- ---------------------------------------------------------------------------
create function public.set_booking_alert_recipients(staff_ids uuid[], emails text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids uuid[];
  addresses text[];
begin
  perform private.require_admin();

  select coalesce(pg_catalog.array_agg(distinct x), '{}') into ids
  from pg_catalog.unnest(coalesce(set_booking_alert_recipients.staff_ids, '{}'::uuid[])) x
  where x is not null;
  if exists (
    select 1 from pg_catalog.unnest(ids) x
    where not exists (select 1 from public.staff st where st.id = x and st.active)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'booking_alert_staff_invalid',
      detail = 'Choose active staff members only.';
  end if;

  select coalesce(pg_catalog.array_agg(a order by first_seen), '{}') into addresses
  from (
    select pg_catalog.lower(pg_catalog.btrim(e)) as a, pg_catalog.min(ord) as first_seen
    from pg_catalog.unnest(coalesce(set_booking_alert_recipients.emails, '{}'::text[])) with ordinality as t(e, ord)
    where pg_catalog.btrim(coalesce(e, '')) <> ''
    group by 1
  ) d;
  if exists (
    select 1 from pg_catalog.unnest(addresses) a
    where pg_catalog.char_length(a) > 320 or a !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'booking_alert_email_invalid',
      detail = 'Enter each address in full, like team@example.com.';
  end if;
  if pg_catalog.cardinality(ids) > 10 or pg_catalog.cardinality(addresses) > 10 then
    raise exception using
      errcode = 'P0001',
      message = 'booking_alert_too_many',
      detail = 'Choose at most 10 staff members and 10 other addresses.';
  end if;

  perform private.set_change_reason('Booking alert recipients changed');
  update public.shop_settings s
  set booking_alert_staff_ids = ids, booking_alert_emails = addresses
  where s.id = 1;
  perform private.set_change_reason(null);
end;
$$;

comment on function public.set_booking_alert_recipients(uuid[], text[]) is
  'D163b, admin only: the staff members (active) and other addresses that get booking alerts. Blank and repeated addresses are dropped; at most 10 of each.';

-- ---------------------------------------------------------------------------
-- The sender's side (service_role only).
-- ---------------------------------------------------------------------------
create type public.appointment_notice as (
  id uuid,
  kind public.appointment_notice_kind,
  audience public.appointment_notice_audience,
  recipient text,
  attempts integer,
  appointment_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  appointment_type text,
  customer_name text,
  customer_first_name text,
  customer_email text,
  customer_phone text,
  bike text,
  customer_note text,
  cancelled_by public.appointment_source,
  reason text,
  public_site_url text,
  timezone text
);

create function public.claim_appointment_notices(max_count integer default 10)
returns setof public.appointment_notice
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer := greatest(1, least(coalesce(claim_appointment_notices.max_count, 10), 50));
begin
  -- A row whose last attempt never recorded a result (the sender stopped
  -- mid-send) and that has no attempts left is final.
  update private.appointment_notices q
  set status = 'failed', claimed_until = null,
      last_error = coalesce(q.last_error, 'No result was recorded for the last attempt.')
  where q.status = 'pending' and q.attempts >= 5 and q.claimed_until < pg_catalog.now();

  return query
    with due as (
      select q.id
      from private.appointment_notices q
      where q.status = 'pending'
        and q.attempts < 5
        and q.next_attempt_at <= pg_catalog.now()
        and (q.claimed_until is null or q.claimed_until < pg_catalog.now())
      order by q.next_attempt_at, q.created_at
      limit n
      for update skip locked
    ),
    claimed as (
      update private.appointment_notices q
      set attempts = q.attempts + 1,
          claimed_until = pg_catalog.now() + interval '2 minutes'
      from due
      where q.id = due.id
      returning q.*
    )
    select c.id, c.kind, c.audience, c.recipient::text, c.attempts,
           a.id, a.starts_at, a.ends_at, t.name,
           private.customer_label(cu.first_name, cu.last_name, cu.display_name, cu.email::text, cu.phone),
           cu.first_name, cu.email::text, cu.phone,
           case when b.id is not null then
             pg_catalog.concat_ws(' ', b.brand, b.model, nullif(pg_catalog.btrim(b.variant), ''))
           end,
           a.customer_note, c.cancelled_by, c.reason,
           s.public_site_url, private.shop_timezone()
    from claimed c
    join public.appointments a on a.id = c.appointment_id
    join public.appointment_types t on t.id = a.appointment_type_id
    join public.customers cu on cu.id = a.customer_id
    left join public.bikes b on b.id = a.bike_id
    cross join public.shop_settings s
    where s.id = 1
    order by c.created_at;
end;
$$;

comment on function public.claim_appointment_notices(integer) is
  'D163, service_role (the Admin''s sender): claim up to max_count (1..50) due booking emails, oldest first; each is held for 2 minutes with attempts + 1 and returned with what its email needs.';

create function public.finish_appointment_notice(notice_id uuid, ok boolean, error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.appointment_notices q
  set status = case
        when finish_appointment_notice.ok then 'sent'::public.appointment_notice_status
        when q.attempts >= 5 then 'failed'::public.appointment_notice_status
        else 'pending'::public.appointment_notice_status
      end,
      sent_at = case when finish_appointment_notice.ok then pg_catalog.now() end,
      next_attempt_at = case
        when finish_appointment_notice.ok then q.next_attempt_at
        else pg_catalog.now() + pg_catalog.make_interval(mins => 5 * q.attempts)
      end,
      claimed_until = null,
      last_error = case
        when finish_appointment_notice.ok then null
        else pg_catalog.left(nullif(pg_catalog.btrim(finish_appointment_notice.error), ''), 200)
      end
  where q.id = finish_appointment_notice.notice_id
    and q.status = 'pending';
end;
$$;

comment on function public.finish_appointment_notice(uuid, boolean, text) is
  'D163, service_role (the Admin''s sender): record one booking email''s result. Sent is final; a failure is retried after attempts x 5 minutes, and the fifth failure is final. A row already sent or failed is left as it is.';

revoke all on function private.queue_appointment_notices(public.appointments, public.appointment_notice_kind, text)
  from public, anon, authenticated, service_role;
revoke all on function private.appointments_queue_notices() from public, anon, authenticated, service_role;
revoke all on function public.set_booking_alert_recipients(uuid[], text[])
  from public, anon, authenticated, service_role;
revoke all on function public.claim_appointment_notices(integer) from public, anon, authenticated, service_role;
revoke all on function public.finish_appointment_notice(uuid, boolean, text)
  from public, anon, authenticated, service_role;

grant execute on function public.set_booking_alert_recipients(uuid[], text[]) to authenticated;
grant execute on function public.claim_appointment_notices(integer) to service_role;
grant execute on function public.finish_appointment_notice(uuid, boolean, text) to service_role;
