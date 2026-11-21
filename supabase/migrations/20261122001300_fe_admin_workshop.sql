set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Fixes from the 2026-11-22 front-end audit that need the database:
--
--   * rider emails know the booking's kind (claim_adventure_notices);
--   * the pay page of a collected or reopened job says so (balance_by_token).

-- ---------------------------------------------------------------------------
-- Rider emails know the booking's kind
-- ---------------------------------------------------------------------------
-- A supported booking's confirmation queues ticket_paid and, once its
-- date is held, departure_joined, but the claimed row did not say which
-- kind of booking it was, so a supported rider got the self-supported
-- words ("Ride it when you like, with a GPS device or phone recording the
-- whole ride") and the group-ride ones ("It's a peer group ... You can
-- leave the date from your ride's page"), though the date is fixed, a
-- tracker is included and a paid supported place can't be left online.
--
-- The claimed row now ends with the booking's kind (booking_kind), so the
-- sender words each email for it. The queue is unchanged. This copies the
-- latest claim_adventure_notices (20261114002800_audit_low.sql) and adds
-- b.kind as the last column, the composite type's new last attribute.

alter type public.adventure_notice add attribute booking_kind public.adventure_participation;

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
           -- The message of the decision that queued this email (its version),
           -- not whichever decision is newest (audit A-70).
           (select v.message_to_rider
              from public.adventure_reviews v
              join public.adventure_submissions s on s.id = v.submission_id
              join public.adventure_attempts t on t.id = s.attempt_id
             where t.booking_id = b.id
               and (ev.detail ->> 'version' is null or s.version = (ev.detail ->> 'version')::integer)
             order by v.decided_at desc limit 1),
           cert.reference, cert.completed_on, cert.accepted_distance_km::numeric,
           (select f.items from public.adventure_fulfilments f where f.booking_id = b.id limit 1),
           b.attention_reason,
           s.public_site_url,
           dep.starts_at, dep.meeting_point,
           ev.detail ->> 'note',
           b.board_name,
           b.kind
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
-- The pay page of a collected job (D156f)
-- ---------------------------------------------------------------------------
-- Marking a job Collected withdraws its payment link (reason 'collected'),
-- and the page then said "This payment link was replaced or stopped. Ask
-- the shop for a new one.", which the shop can't do: send_balance_link
-- takes only completed or ready jobs. balance_by_token now names two more
-- states, still with the job number only: 'collected' (the job is
-- collected, whatever stopped the link) and 'reopened' (the link stopped
-- when the job was reopened). 'withdrawn' is left for a link replaced by
-- a newer one. This copies the latest definition
-- (20261019000100_customer_refunded_amounts.sql) and changes only the
-- state.

create or replace function public.balance_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hashed bytea := private.quote_token_hash(balance_by_token.p_token);
  link public.balance_links;
  wo public.work_orders;
  bike public.bikes;
  customer_first_name text;
  tot record;
  owed numeric;
  ahead numeric;
  state text;
begin
  if hashed is null then
    return null;
  end if;
  select l.* into link from public.balance_links l where l.token_hash = hashed;
  if not found then
    return null;
  end if;
  select w.* into wo from public.work_orders w where w.id = link.work_order_id;
  -- A collected job first: the link stopped because the bike went home
  -- (whatever stopped it earlier), and no new link can be sent for it.
  -- Then the link before the job; 'closed' is read from the job's status
  -- on every read (the status trigger withdraws the link first in
  -- practice).
  state := case
    when wo.status = 'collected' then 'collected'
    when link.withdrawn_at is not null and link.withdrawn_reason = 'reopened' then 'reopened'
    when link.withdrawn_at is not null then 'withdrawn'
    when link.expires_at <= pg_catalog.clock_timestamp() then 'expired'
    when wo.status not in ('completed', 'ready_for_collection') then 'closed'
    else 'open'
  end;
  if state <> 'open' then
    return pg_catalog.jsonb_build_object('status', state, 'job_number', wo.job_number);
  end if;

  select b.* into bike from public.bikes b where b.id = wo.bike_id;
  select c.first_name into customer_first_name from public.customers c where c.id = wo.customer_id;
  select t.job_total, t.net_paid, t.refunded_online into tot
  from public.work_order_payment_totals t where t.work_order_id = wo.id;
  owed := greatest(tot.job_total - tot.net_paid, 0);
  ahead := greatest(tot.net_paid - tot.job_total, 0);
  return pg_catalog.jsonb_build_object(
    'status', 'open',
    -- The shop has no name setting; the Admin's own pages say BICII.
    'shop_name', 'BICII',
    'job_number', wo.job_number,
    -- D143: the bike as brand, model and variant; never its serial.
    'bike', pg_catalog.concat_ws(' ', bike.brand, bike.model, bike.variant),
    'first_name', customer_first_name,
    'currency', wo.currency,
    -- The live lines, sale side only, in my_work_order_lines' order. A
    -- stock or consigned unit's line reads "<product> · <unit short_id> ·
    -- S/N <serial>": the snapshot name is cut before ' · <short_id>', so a
    -- unit id or a serial never shows. Whenever the snapshot does not
    -- carry ' · <short_id>' after its first character (another format),
    -- the product's current name (or 'Part') is shown instead: it fails
    -- closed, never printing the rest of the description.
    'lines', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'description',
          case
            when u.id is null then li.description_snapshot
            when cut.pos > 1 then pg_catalog.left(li.description_snapshot, cut.pos - 1)
            else coalesce(p.name, 'Part')
          end,
          'quantity', li.quantity,
          'line_total', li.sale_total
        )
        order by li.created_at, li.id
      )
      from public.work_order_line_items li
      left join public.inventory_units u on u.id = li.source_inventory_unit_id
      left join public.products p on p.id = li.source_product_id
      cross join lateral (
        select pg_catalog.strpos(li.description_snapshot, ' · ' || u.short_id) as pos
      ) cut
      where li.work_order_id = wo.id and li.voided_at is null
    ), '[]'::jsonb),
    'job_total', tot.job_total,
    'paid', tot.net_paid,
    -- U2-11: what Stripe gave back on this job (succeeded refunds), which
    -- paid is already net of, so the page can say "after $X refunded".
    'refunded', tot.refunded_online,
    'paid_ahead', ahead::public.money_amount,
    'balance_due', owed::public.money_amount,
    'payment', case
      when exists (select 1 from public.payments x
                   where x.work_order_id = wo.id and x.status = 'pending'
                     and x.checkout_completed_at is not null) then 'processing'
      when owed = 0 then 'nothing_due'
      when owed < 0.50 then 'too_small'
      when owed > 999999.99 then 'too_large'
      else 'due'
    end
  );
end;
$$;

comment on function public.balance_by_token(text) is
  'D156f: what the pay page shows for a link token (anon and authenticated): null for an unknown token; {status, job_number} only when the job is collected (collected), the link was withdrawn by a reopen (reopened) or otherwise (withdrawn, replaced by a newer link), it expired (expired), or its job is not completed or ready (closed); otherwise 13 keys: status open, shop_name, job_number, bike (brand, model, variant), first_name, currency, lines (live lines in order: description with any unit short_id and serial cut, quantity, line_total), job_total, paid (net_paid: Stripe net and counter), refunded (U2-11: succeeded Stripe refunds on the job, which paid is already net of), paid_ahead, balance_due (live), payment (processing while a Stripe payment on the job is being confirmed, else nothing_due, too_small under S$0.50, too_large above S$999,999.99, or due). Never costs, notes, staff, contacts, other jobs, ids of any kind, unit ids, serial numbers (lines or bike), voided lines, Stripe ids or URLs.';

-- create or replace keeps the privileges; restated for the record.
revoke all on function public.balance_by_token(text) from public, anon, authenticated, service_role;
grant execute on function public.balance_by_token(text) to anon, authenticated;
