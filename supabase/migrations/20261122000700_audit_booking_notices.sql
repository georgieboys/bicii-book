-- Booking emails' outbox (D163), audit 2026-11-13 A-10 and A-20, RISKS
-- R-100: the booking emails move to the design the adventure emails use
-- (20261114000800_adventure_notices.sql, D184).
--
--   * An attempt is counted when a result is recorded, not when a row is
--     claimed. Claims are counted separately; a row claimed 15 times
--     without any result is given up (a poison guard).
--   * A claim lasts 5 minutes, longer than the sender's function, and
--     carries a token; only that claim's result is recorded.
--   * A row the sender did not get to is released without using an attempt.
--   * A success that arrives after the row was given up is still recorded.
--
-- finish_appointment_notice(uuid, boolean, text) is replaced by
-- finish_appointment_notice(notice_id, claim_token, result, error), and the
-- claimed row now carries its claim_token.

-- ---------------------------------------------------------------------------
-- The outbox: claims and the claim token.
-- ---------------------------------------------------------------------------
-- A claim made before this migration has no token; it is dropped, so the
-- row is due again (Resend's idempotency key covers a send in flight).
update private.appointment_notices set claimed_until = null where claimed_until is not null;

alter table private.appointment_notices
  add column claims integer not null default 0 check (claims between 0 and 15),
  add column claim_token uuid null,
  add constraint appointment_notices_claim check ((claim_token is null) = (claimed_until is null));

comment on column private.appointment_notices.claims is
  'R-100: how many times the row was claimed without a recorded result (released claims are given back); 15 is final.';
comment on column private.appointment_notices.claim_token is
  'R-100: the current claim''s token; finish_appointment_notice records a result only under it.';

-- ---------------------------------------------------------------------------
-- The claimed row: the claim token after the id, as adventure_notice has it.
-- ---------------------------------------------------------------------------
drop function public.claim_appointment_notices(integer);
drop function public.finish_appointment_notice(uuid, boolean, text);
drop type public.appointment_notice;

create type public.appointment_notice as (
  id uuid,
  claim_token uuid,
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

create function public.claim_appointment_notices(max_count integer default 5)
returns setof public.appointment_notice
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer := greatest(1, least(coalesce(claim_appointment_notices.max_count, 5), 20));
begin
  -- Claimed 15 times and never answered: give up. The claim stays on the
  -- row, so a send still in flight can record its success (R-100).
  update private.appointment_notices q
  set status = 'failed',
      last_error = coalesce(q.last_error, 'No result was recorded after 15 claims.')
  where q.status = 'pending' and q.claims >= 15 and q.claimed_until < pg_catalog.now();

  return query
    with due as (
      select q.id
      from private.appointment_notices q
      where q.status = 'pending'
        and q.claims < 15
        and q.next_attempt_at <= pg_catalog.now()
        and (q.claimed_until is null or q.claimed_until < pg_catalog.now())
      order by q.next_attempt_at, q.created_at
      limit n
      for update skip locked
    ),
    claimed as (
      update private.appointment_notices q
      set claims = q.claims + 1,
          claim_token = gen_random_uuid(),
          claimed_until = pg_catalog.now() + interval '5 minutes'
      from due
      where q.id = due.id
      returning q.*
    )
    select c.id, c.claim_token, c.kind, c.audience, c.recipient::text, c.attempts,
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
  'D163, service_role (the Admin''s sender): claim up to max_count (1..20) due booking emails, oldest first, each for 5 minutes under a new claim token, with what its email needs. Claiming uses no attempt; a row claimed 15 times without a result is given up (R-100).';

-- result: 'sent', 'failed' (a send was tried and refused or timed out), or
-- 'released' (the sender did not get to it: no attempt is used).
create function public.finish_appointment_notice(notice_id uuid, claim_token uuid, result text, error text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if finish_appointment_notice.result not in ('sent', 'failed', 'released') then
    raise exception 'unknown result %', finish_appointment_notice.result using errcode = '22023';
  end if;

  if finish_appointment_notice.result = 'sent' then
    -- Also a row given up while this send was in flight (R-100).
    update private.appointment_notices q
    set status = 'sent', sent_at = pg_catalog.now(), last_error = null,
        claim_token = null, claimed_until = null
    where q.id = finish_appointment_notice.notice_id
      and q.claim_token = finish_appointment_notice.claim_token
      and (q.status = 'pending' or (q.status = 'failed' and q.sent_at is null));
  elsif finish_appointment_notice.result = 'released' then
    update private.appointment_notices q
    set claim_token = null, claimed_until = null,
        claims = greatest(q.claims - 1, 0)
    where q.id = finish_appointment_notice.notice_id
      and q.claim_token = finish_appointment_notice.claim_token
      and q.status = 'pending';
  else
    update private.appointment_notices q
    set attempts = q.attempts + 1,
        status = case when q.attempts + 1 >= 5 then 'failed' else 'pending' end::public.appointment_notice_status,
        next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(mins => 5 * (q.attempts + 1)),
        claim_token = null, claimed_until = null,
        last_error = pg_catalog.left(coalesce(nullif(pg_catalog.btrim(finish_appointment_notice.error), ''), 'Email failed'), 200)
    where q.id = finish_appointment_notice.notice_id
      and q.claim_token = finish_appointment_notice.claim_token
      and q.status = 'pending';
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

comment on function public.finish_appointment_notice(uuid, uuid, text, text) is
  'D163, service_role (the Admin''s sender): record one booking email''s result under its claim token (another claim''s result is ignored). Sent is final, and is recorded even if the row was given up meanwhile; a failure waits attempts x 5 minutes and the fifth is final; released returns the row unused. True when the row changed.';

revoke all on function public.claim_appointment_notices(integer) from public, anon, authenticated, service_role;
revoke all on function public.finish_appointment_notice(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_appointment_notices(integer) to service_role;
grant execute on function public.finish_appointment_notice(uuid, uuid, text, text) to service_role;
