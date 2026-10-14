-- Phase 14 review follow-up (PLAN D159b, DATA-MODEL §19): list each Stripe
-- problem once on Exceptions and Today.
--
-- 20261014000500_indent_deposits.sql already ran on the hosted project, so
-- this change cannot be made there; it replaces private.integration_exceptions()
-- with the same signature (its privileges are kept: no API role may execute it).
--
-- What changes:
--   * stripe_attention leaves an event about a refund in another currency or
--     mode (outcome currency_mismatch or livemode_mismatch) to
--     payment_attention when payment_issues lists that refund as
--     refund_not_counted (linked to its payment, not failed or canceled,
--     another currency or a stored mode that is not the payment's), so it is
--     listed once. A failed or canceled mismatched refund, which
--     refund_not_counted leaves out, and an event whose own mode differs
--     while its stored refund row matches (and so counts) keep their
--     stripe_attention row.
--   * One stripe_attention row per Stripe object and outcome: several events
--     needing attention about the same object (a refund's created and
--     failed events, each Check with Stripe read of it) are listed once, as
--     the earliest in the 30-day window, so its days count from the first.
--     Events without an object id are each listed, as before.
--   * currency_mismatch gets its own sentence.
-- Everything else in the function is unchanged from 20261014000500.

create or replace function private.integration_exceptions()
returns table (
  kind text,
  severity text,
  entity_type text,
  entity_id uuid,
  entity_label text,
  subject_label text,
  days integer,
  quantity integer,
  since timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'integration_failed'::text,
         'danger'::text,
         'integration_job'::text,
         q.id,
         (case when q.kind = 'shopify_event' then coalesce(e.subject, e.topic) else p.short_id end)::text,
         pg_catalog.left(q.last_error, 300)::text,
         (private.shop_today() - private.shop_day(q.created_at))::integer,
         null::integer,
         q.created_at
  from public.integration_retry_queue q
  left join public.integration_events e on e.id = q.integration_event_id
  left join public.products p on p.id = q.product_id
  where q.status = 'needs_attention'
    and private.is_admin()

  union all

  -- D159b: payment conditions (public.payment_issues), admins and managers.
  select 'payment_attention'::text,
         iss.severity::text,
         'work_order'::text,
         iss.work_order_id,
         w.job_number::text,
         pg_catalog.left(iss.message, 300)::text,
         (private.shop_today() - private.shop_day(iss.since))::integer,
         null::integer,
         iss.since
  from public.payment_issues iss
  join public.work_orders w on w.id = iss.work_order_id
  where private.can_record_refunds()

  union all

  -- D159b, D86: Stripe deliveries BICII could not apply, or could not
  -- store, admins only. A not_recorded rejection clears once one of
  -- Stripe's retries of the same body is stored. An event about a refund
  -- in another currency or mode (currency_mismatch, livemode_mismatch)
  -- whose refund row payment_attention lists as refund_not_counted (linked
  -- to its payment, not failed or canceled, another currency or a stored
  -- mode that is not the payment's: the same test as payment_issues) is
  -- left to that row, so it is listed once. A failed or canceled one, which
  -- refund_not_counted leaves out, and an event whose own mode differs
  -- while its stored refund row matches (counted) keep this row. Several
  -- events about the same object with the same outcome are one row: the
  -- earliest in the window.
  select 'stripe_attention'::text,
         'danger'::text,
         (case when e.work_order_id is null then 'stripe_event' else 'work_order' end)::text,
         coalesce(e.work_order_id, e.id),
         coalesce(w.job_number, 'Stripe')::text,
         (case coalesce(e.outcome, e.rejection_reason::text)
            when 'payment_not_found' then 'Stripe reported a payment BICII has no record of. Check it in Stripe.'
            when 'session_mismatch' then 'A Stripe payment did not match its BICII record. Check it in Stripe.'
            when 'livemode_mismatch' then 'Stripe data from the other mode (test or live) was not applied. Check the Stripe keys.'
            when 'currency_mismatch' then 'Stripe reported a refund in another currency, and BICII did not count it. Check it in Stripe.'
            when 'object_invalid' then 'Stripe sent data BICII could not read. Check Settings → Customer payments.'
            when 'unexpected_payment_status' then 'Stripe reported an unexpected payment status. Check it in Stripe.'
            when 'read_mismatch' then 'A Stripe read did not match its payment. Ask engineering.'
            when 'not_recorded' then 'A Stripe delivery could not be recorded; Stripe is retrying it. Ask engineering if this stays.'
            else 'A Stripe event needs attention. Check it in Stripe.'
          end)::text,
         (private.shop_today() - private.shop_day(e.received_at))::integer,
         null::integer,
         e.received_at
  from public.stripe_events e
  left join public.work_orders w on w.id = e.work_order_id
  where private.is_admin()
    and ((e.status = 'needs_attention' and e.received_at > pg_catalog.now() - interval '30 days'
          and not exists (
            select 1
            from public.payment_refunds r
            join public.payments p on p.id = r.payment_id
            where e.outcome in ('currency_mismatch', 'livemode_mismatch')
              and e.object_type = 'refund'
              and r.stripe_refund_id = e.object_id
              and r.status not in ('failed', 'canceled')
              and (r.currency <> p.currency or (r.livemode is not null and r.livemode <> p.livemode)))
          and not exists (
            select 1
            from public.stripe_events o
            where e.object_id is not null
              and o.object_id = e.object_id
              and o.object_type is not distinct from e.object_type
              and o.outcome = e.outcome
              and o.status = 'needs_attention'
              and o.received_at > pg_catalog.now() - interval '30 days'
              and (o.received_at, o.id) < (e.received_at, e.id)))
      or (e.rejection_reason = 'not_recorded' and e.last_delivered_at > pg_catalog.now() - interval '3 days'
          and not exists (select 1 from public.stripe_events v
                          where v.body_sha256 = e.body_sha256 and v.rejection_reason is null)));
$$;

comment on function private.integration_exceptions() is
  'D86, D159b: the integration rows of reporting.operational_exceptions, Phase 10''s nine-column shape. integration_failed (danger): one per needs_attention Shopify job, admins only. payment_attention: one per public.payment_issues row (its severity; entity the job; subject the issue''s message), active admins and managers (private.can_record_refunds). stripe_attention (danger): a Stripe event left needs_attention in the last 30 days (except a currency_mismatch or livemode_mismatch about a refund that payment_attention lists as refund_not_counted: linked, not failed or canceled, in another currency or stored mode; a failed or canceled one stays here; one row per Stripe object and outcome, the earliest), or a not_recorded delivery in the last 3 days that no stored retry of the same body has cleared, admins only (entity the job, else the event). Computed live, never stored. Read only through reporting.operational_exceptions inside the definer RPCs; no API role may execute it.';
