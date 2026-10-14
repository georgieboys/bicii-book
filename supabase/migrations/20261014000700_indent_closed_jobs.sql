-- Indent parts on completed and closed jobs (PLAN D149 INDENT-CLOSE, D140,
-- D151, D152, D154, D159b; ADR-024 amendment 2026-10-15; DATA-MODEL §5,
-- §14, §15, §19; RISKS R-082).
--
-- The owner's live test of 2026-10-15 (production, J-000002): an indent
-- part was proposed, quoted, approved and its deposit paid through Stripe,
-- then the job was completed and collected without the part ever being
-- ordered or fitted. By design (D140) a request reaches the bill only when
-- it is fitted, so the bill and yield were right; but nothing said the
-- money was held for a part that never went on the job, and on the
-- collected job the request could be neither fitted (work_order_locked)
-- nor cancelled (work_order_closed). This file changes no total, line,
-- stock, yield or Cult Commons figure:
--
--   cancel_part_request   D149: on a collected or cancelled job an active
--                         admin or manager (private.can_record_refunds())
--                         may cancel a request that is not fitted, with the
--                         same required reason and the same
--                         part_request_cancelled event; one still on the
--                         job's open quote withdraws that quote first
--                         (nobody can answer or withdraw it there). Anyone
--                         else still gets work_order_closed. Behaviour on
--                         open, completed and ready jobs is unchanged, and
--                         fit_part_request still refuses every job that is
--                         not open.
--   withdraw_quote        refuses a collected or cancelled job
--                         (work_order_closed) after its replay.
--   order_part_requests   refuses a job that is not open
--                         (work_order_locked) after its replay.
--   payment_issues        a ninth kind, paid_parts_not_fitted (danger): a
--                         deposit paid or partly refunded whose quote's
--                         approved parts are still approved or ordered on a
--                         completed, ready or collected job, naming the
--                         share of what is held that the fitted parts do
--                         not account for. It reaches Exceptions through
--                         payment_attention unchanged.
--   work_order_payment_totals  appends held_over_total (net paid online
--                         above the live-lines total, in every status), so a
--                         closed job still reconciles paid against billed;
--                         balance_due and paid_ahead keep their meaning.
--   work_order_unfitted_requests  new, security invoker: per job and
--                         currency, the count and quoted total of live
--                         requests approved or ordered (not fitted, not
--                         cancelled). No cost.
--   private.quote_view    the answered deposit object gains job_closed
--                         (the job is completed, ready, collected or
--                         cancelled), so the page stops saying the shop
--                         will order the parts.
--
-- 20261014000200 and 20261014000500 already ran on the hosted project, so
-- they are not edited: every function here is replaced with the same
-- signature (create or replace keeps its privileges, restated at the end),
-- and the two views are replaced with the same columns (one appended).
-- No enum value is added (payment_issues.issue is text), so one file.
--
-- Lock order (DATA-MODEL §5, §19): unchanged. Each RPC takes the job
-- (private.lock_work_order) before its requests and quotes;
-- order_part_requests still locks every job in id order before its
-- requests, then checks each job is open before it touches a purchase
-- order. private.can_record_refunds() reads staff and takes no lock.

-- ---------------------------------------------------------------------------
-- cancel_part_request (D140, D149)
-- ---------------------------------------------------------------------------

-- Active staff (any) on an open, completed or ready job: a request that is
-- not on an open quote and not fitted, with a reason. On a collected or
-- cancelled job an active admin or manager only (D149): any request that
-- is not fitted; one still on the job's open quote (which nobody can
-- answer or withdraw there) withdraws that quote first, as withdraw_quote
-- would, so its other items go back to proposed. An ordered part stays on
-- its purchase order (staff change the order themselves). Replay: a
-- cancelled request is returned as is, on any job.
create or replace function public.cancel_part_request(request_id uuid, reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  cleaned text := nullif(pg_catalog.btrim(cancel_part_request.reason), '');
  req public.job_part_requests;
  wo public.work_orders;
  was public.part_request_status;
begin
  if cancel_part_request.request_id is null then
    raise exception 'request_id is required' using errcode = '22004';
  end if;
  select r.* into req from public.job_part_requests r where r.id = cancel_part_request.request_id;
  if not found then
    raise exception 'part request % not found', cancel_part_request.request_id using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(req.work_order_id);
  select r.* into req from public.job_part_requests r where r.id = cancel_part_request.request_id for update;
  if req.status = 'cancelled' then
    return req.id;
  end if;
  was := req.status;
  -- D149 INDENT-CLOSE: collected and cancelled stay final for everyone
  -- else (work_order_closed); an active admin or manager may still cancel
  -- a request that never went on the job, so its deposit can be refunded
  -- or settled (the role check of D94, D152: no permission grants it).
  if private.work_order_status_is_closed(wo.status) then
    if not private.can_record_refunds() then
      perform private.require_unclosed_work_order(wo);
    end if;
    -- A request on the open quote: the customer can no longer answer it
    -- (answer_quote needs an open job) and withdraw_quote refuses a closed
    -- job, so the cancel withdraws it (quote_withdrawn on the timeline;
    -- its quoted items go back to proposed). The job is locked above; an
    -- error below rolls the withdrawal back with everything else.
    if req.status = 'quoted' then
      perform private.withdraw_open_quote(wo.id, actor);
      select r.* into req from public.job_part_requests r where r.id = cancel_part_request.request_id for update;
    end if;
  end if;
  if req.status = 'quoted' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_quoted',
      detail = 'It is on the quote the customer has. Withdraw the quote first.';
  end if;
  if req.status = 'fitted' then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_fitted',
      detail = 'It is already on the job. Void the line instead.';
  end if;
  if cleaned is null then
    raise exception using errcode = 'P0001', message = 'reason_required', detail = 'Say why it is cancelled.';
  end if;
  if pg_catalog.char_length(cleaned) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;
  update public.job_part_requests r
  set status = 'cancelled', cancel_reason = cleaned, cancelled_at = pg_catalog.clock_timestamp(),
      cancelled_by = actor
  where r.id = req.id;
  perform private.record_work_order_event(
    wo.id,
    'part_request_cancelled',
    pg_catalog.jsonb_build_object(
      'request_id', req.id, 'description', req.description, 'reason', cleaned,
      'was', was::text
    )
  );
  return req.id;
end;
$$;

comment on function public.cancel_part_request(uuid, text) is
  'D140, D149: active staff cancel a request not on an open quote and not fitted, with a reason; on a collected or cancelled job only an active admin or manager (private.can_record_refunds(); anyone else work_order_closed), who may also cancel a request on the open quote: that quote is withdrawn first (quote_withdrawn; its other items back to proposed). Records part_request_cancelled {request_id, description, reason, was}; replay-safe.';

-- ---------------------------------------------------------------------------
-- withdraw_quote (D141): not on a closed job
-- ---------------------------------------------------------------------------

-- Active staff (any). Withdraws an open quote of a job that is not
-- collected or cancelled: its link stops working and its items go back to
-- proposed. Replay: a withdrawn quote is returned, on any job.
create or replace function public.withdraw_quote(quote_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  q public.quotes;
  wo public.work_orders;
begin
  if withdraw_quote.quote_id is null then
    raise exception 'quote_id is required' using errcode = '22004';
  end if;
  select x.* into q from public.quotes x where x.id = withdraw_quote.quote_id;
  if not found then
    raise exception 'quote % not found', withdraw_quote.quote_id using errcode = 'P0002';
  end if;
  wo := private.lock_work_order(q.work_order_id);
  select x.* into q from public.quotes x where x.id = withdraw_quote.quote_id for update;
  if q.status = 'withdrawn' then
    return q.id;
  end if;
  if q.status = 'answered' then
    raise exception using
      errcode = 'P0001',
      message = 'quote_answered',
      detail = 'The customer has already answered this quote.';
  end if;
  perform private.require_unclosed_work_order(wo);
  perform private.withdraw_open_quote(q.work_order_id, actor);
  return q.id;
end;
$$;

comment on function public.withdraw_quote(uuid) is
  'D141: active staff withdraw an open quote of a job that is not collected or cancelled (work_order_closed); its items go back to proposed; replay-safe.';

-- ---------------------------------------------------------------------------
-- order_part_requests: the 20261014000500 body (:679-870) with one check,
-- every job open, after the replay.
-- ---------------------------------------------------------------------------

-- manage_purchasing. Orders approved indent parts from one supplier: they
-- go on the supplier's newest draft purchase order, or on a new draft with
-- purchase_order_id when the supplier has none; each product's line rises
-- by the requests' quantities (cost: the line's, else the requests'
-- expected cost, else purchase_cost_defaults), and each request is linked
-- to its line. move_to_waiting moves each open job not already waiting on
-- parts to Waiting on parts when its status allows it. Replay: when every
-- request is already ordered, their purchase order is returned, whatever
-- the jobs' status now. Otherwise every job must be open (completed,
-- ready, collected and cancelled jobs: work_order_locked). D152: a part
-- whose answered quote asked a deposit that is not paid needs an active
-- admin or manager and override_reason, recorded on the job's part_ordered
-- entry. Returns the purchase order id.
create or replace function public.order_part_requests(
  request_ids uuid[],
  supplier_id uuid,
  purchase_order_id uuid,
  move_to_waiting boolean default true,
  override_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_permission('manage_purchasing');
  wanted integer;
  job record;
  po_id uuid;
  po public.purchase_orders;
  prod record;
  line public.purchase_order_lines;
  line_id uuid;
  cost public.money_amount;
  ordered_po uuid;
  ordered_count integer;
  unpaid_quotes uuid[];
  unpaid_jobs uuid[];
  override text;
begin
  if order_part_requests.request_ids is null or order_part_requests.supplier_id is null
     or order_part_requests.purchase_order_id is null or order_part_requests.move_to_waiting is null then
    raise exception 'request_ids, supplier_id, purchase_order_id and move_to_waiting are required'
      using errcode = '22004';
  end if;
  wanted := pg_catalog.cardinality(order_part_requests.request_ids);
  if wanted is null or wanted < 1 or wanted > 50
     or wanted <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(order_part_requests.request_ids) as x) then
    raise exception using
      errcode = 'P0001',
      message = 'order_items_invalid',
      detail = 'Choose 1 to 50 different parts.';
  end if;

  -- The jobs first, in id order (lock order), then the requests.
  for job in
    select distinct r.work_order_id as id
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    order by r.work_order_id
  loop
    perform private.lock_work_order(job.id);
  end loop;
  perform 1 from public.job_part_requests r where r.id = any (order_part_requests.request_ids) for update;

  -- Replay: everything already ordered, on one purchase order.
  select pg_catalog.count(*), pg_catalog.min(l.purchase_order_id::text)::uuid
  into ordered_count, ordered_po
  from public.job_part_requests r
  join public.purchase_order_lines l on l.id = r.purchase_order_line_id
  where r.id = any (order_part_requests.request_ids) and r.status = 'ordered';
  if ordered_count = wanted then
    return ordered_po;
  end if;

  -- A job that is not open buys nothing more (D15, R-082), as Fit needs an
  -- open job: a completed or ready job is reopened first (Change status),
  -- and a collected or cancelled one can no longer use the part. The jobs
  -- are locked above, so this re-lock waits for nothing.
  for job in
    select distinct r.work_order_id as id
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    order by r.work_order_id
  loop
    perform private.require_open_work_order(job.id);
  end loop;

  if (select pg_catalog.count(*) from public.job_part_requests r
      where r.id = any (order_part_requests.request_ids) and r.kind = 'part' and r.status = 'approved') <> wanted then
    raise exception using
      errcode = 'P0001',
      message = 'part_request_not_approved',
      detail = 'Only approved parts that are not ordered yet can be ordered.';
  end if;

  -- D152/D158e: an approved part whose answered quote asked a deposit that
  -- is not paid (paid or partly refunded) is ordered only by an active
  -- admin or manager with a reason (a role check, D94's: no permission or
  -- exception grants it).
  select pg_catalog.array_agg(distinct d.quote_id), pg_catalog.array_agg(distinct d.work_order_id)
    into unpaid_quotes, unpaid_jobs
  from public.job_part_requests r
  join public.quote_items i on i.part_request_id = r.id and i.kind = 'part' and i.decision = 'approved'
  join public.quote_deposits d on d.quote_id = i.quote_id
  where r.id = any (order_part_requests.request_ids) and d.state <> 'paid';
  if unpaid_quotes is not null then
    override := nullif(pg_catalog.btrim(coalesce(order_part_requests.override_reason, '')), '');
    if override is null then
      raise exception using
        errcode = 'P0001',
        message = 'deposit_unpaid',
        detail = 'The customer has not paid the deposit for these parts. An admin or manager can order them anyway with a reason.';
    end if;
    if not private.can_record_refunds() then
      raise exception 'only an active admin or manager can order parts before their deposit is paid'
        using errcode = '42501';
    end if;
    override := private.require_reason(override);  -- reason_too_long over 500
  end if;

  if not exists (
    select 1 from public.suppliers s where s.id = order_part_requests.supplier_id and s.archived_at is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'supplier_unavailable',
      detail = 'That supplier does not exist or is archived.';
  end if;

  select o.id into po_id
  from public.purchase_orders o
  where o.supplier_id = order_part_requests.supplier_id and o.status = 'draft'
  order by o.created_at desc, o.id
  limit 1;
  if po_id is null then
    po := public.create_purchase_order(order_part_requests.purchase_order_id, order_part_requests.supplier_id);
    po_id := po.id;
  end if;

  for prod in
    select r.product_id, sum(r.quantity)::integer as quantity,
           (pg_catalog.array_agg(r.expected_unit_cost order by r.created_at)
              filter (where r.expected_unit_cost is not null))[1] as expected_cost,
           pg_catalog.string_agg(distinct w.job_number, ', ') as jobs
    from public.job_part_requests r
    join public.work_orders w on w.id = r.work_order_id
    where r.id = any (order_part_requests.request_ids)
    group by r.product_id
    order by r.product_id
  loop
    select l.* into line
    from public.purchase_order_lines l
    where l.purchase_order_id = po_id and l.product_id = prod.product_id;
    if found then
      line_id := line.id;
      cost := line.unit_cost;
      perform public.set_purchase_order_line(
        line.id, po_id, prod.product_id, line.quantity_ordered + prod.quantity, cost,
        line.expected_at, line.notes, null
      );
    else
      line_id := gen_random_uuid();
      cost := coalesce(
        prod.expected_cost,
        (select d.unit_cost
         from public.purchase_cost_defaults(order_part_requests.supplier_id, array[prod.product_id]) d
         where d.product_id = prod.product_id),
        0
      );
      perform public.set_purchase_order_line(
        line_id, po_id, prod.product_id, prod.quantity, cost, null,
        pg_catalog.left('For ' || prod.jobs, 500), null
      );
    end if;
    update public.job_part_requests r
    set status = 'ordered', purchase_order_line_id = line_id, ordered_at = pg_catalog.clock_timestamp(),
        ordered_by = actor
    where r.id = any (order_part_requests.request_ids) and r.product_id = prod.product_id;
  end loop;

  select o.* into po from public.purchase_orders o where o.id = po_id;
  for job in
    select r.work_order_id as id, pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('request_id', r.id, 'description', r.description, 'quantity', r.quantity)
             order by r.created_at
           ) as items
    from public.job_part_requests r
    where r.id = any (order_part_requests.request_ids)
    group by r.work_order_id
    order by r.work_order_id
  loop
    perform private.record_work_order_event(
      job.id,
      'part_ordered',
      pg_catalog.jsonb_build_object('purchase_order', po.po_number, 'items', job.items)
      || case when override is not null and job.id = any (unpaid_jobs) then
           pg_catalog.jsonb_build_object('deposit_override', pg_catalog.jsonb_build_object(
             'reason', override,
             'quote_ids', (select pg_catalog.to_jsonb(pg_catalog.array_agg(x.id order by x.id))
                           from public.quotes x
                           where x.id = any (unpaid_quotes) and x.work_order_id = job.id)))
         else '{}'::jsonb end
    );
    if order_part_requests.move_to_waiting then
      perform public.set_work_order_status(job.id, 'awaiting_parts', 'Indent parts ordered: ' || po.po_number)
      from public.work_orders w
      where w.id = job.id
        and w.status <> 'awaiting_parts'
        and private.work_order_status_is_open(w.status)
        and private.work_order_transition_rule(w.status, 'awaiting_parts') = 'allowed';
    end if;
  end loop;
  return po_id;
end;
$$;

comment on function public.order_part_requests(uuid[], uuid, uuid, boolean, text) is
  'D145/D152: manage_purchasing orders approved indent parts of open jobs (work_order_locked otherwise, R-082) on the supplier''s draft purchase order (or a new one), linking each request to its line; a part whose quote''s deposit is not paid needs an active admin or manager and override_reason (deposit_unpaid without one; recorded on part_ordered as deposit_override); replay-safe whatever the jobs'' status.';

-- ---------------------------------------------------------------------------
-- payment_issues: the 20261014000500 view (:226-305) with a ninth kind,
-- paid_parts_not_fitted, before pending_unconfirmed.
-- ---------------------------------------------------------------------------
create or replace view public.payment_issues
with (security_invoker = on)
as
select p.id as payment_id, p.work_order_id, p.quote_id, x.issue, x.severity, x.since, x.message
from public.payments p
join public.work_orders w on w.id = p.work_order_id
cross join lateral (
  -- Money as the screens print it (formatMoney, en-SG: $1,234.50);
  -- payments are SGD only (payments_currency_check).
  select '$' || pg_catalog.to_char(coalesce(p.amount_received, p.amount) - p.refunded_amount,
                                   'FM999,999,990.00') as held,
         '$' || pg_catalog.to_char(p.amount, 'FM999,999,990.00') as asked,
         '$' || pg_catalog.to_char(p.amount_received, 'FM999,999,990.00') as received,
         '$' || pg_catalog.to_char(p.refunded_amount, 'FM999,999,990.00') as refunded,
         -- D159c: the counted refund (succeeded or failed, in the payment's
         -- currency and mode) whose outcome Stripe reported last, by when
         -- the apply recorded that status (status_changed_at; linking an
         -- unmatched refund leaves it alone). Its failure stands until a
         -- later refund succeeds ("Refund again in Stripe").
         (select case when lr.status = 'failed' then lr.status_changed_at end
          from public.payment_refunds lr
          where lr.payment_id = p.id and lr.status in ('succeeded', 'failed')
            and lr.currency = p.currency and (lr.livemode is null or lr.livemode = p.livemode)
          order by lr.status_changed_at desc, lr.created_at desc, lr.id
          limit 1) as refund_failed_at,
         -- Linked refunds that payment_refund_total never counts: another
         -- currency or mode (DATA-MODEL §19, step 1's apply_stripe_refund;
         -- one adopted by the completion is flagged on no event).
         (select pg_catalog.max(r.updated_at) from public.payment_refunds r
          where r.payment_id = p.id and r.status not in ('failed', 'canceled')
            and (r.currency <> p.currency or (r.livemode is not null and r.livemode <> p.livemode)))
           as uncounted_refund_at,
         -- R-082: what this deposit holds that its fitted parts do not
         -- account for: the net held (no more than was asked) less the
         -- fitted approved parts' share at the quote's percent, rounded as
         -- the deposit was (20261014000500 quotes_deposit_snapshot); never
         -- negative. A refund is taken from the unfitted share first.
         (select greatest(
                   least(coalesce(p.amount_received, p.amount) - p.refunded_amount, p.amount)
                   - coalesce(pg_catalog.round(
                       sum(i.line_total) filter (where r.status = 'fitted')
                       * pg_catalog.max(q.deposit_percent) / 100, 2), 0),
                   0)
          from public.quotes q
          join public.quote_items i on i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
          join public.job_part_requests r on r.id = i.part_request_id
          where q.id = p.quote_id) as unfitted_amount,
         coalesce(p.amount_received, p.amount) - p.refunded_amount as held_amount
) h
cross join lateral (
  select '$' || pg_catalog.to_char(h.unfitted_amount, 'FM999,999,990.00') as unfitted,
         h.unfitted_amount >= h.held_amount as all_unfitted
) u
cross join lateral (values
  ('paid_job_cancelled', 'danger', p.paid_at,
   pg_catalog.format('%s is held but this job is cancelled. Refund it in Stripe if it is due back.', h.held),
   p.status in ('paid', 'partially_refunded') and w.status = 'cancelled'),
  ('paid_parts_cancelled', 'danger', p.paid_at,
   pg_catalog.format('%s is held but every part it was for is cancelled. Refund it in Stripe, or agree with the customer that it counts towards the job.',
                     h.held),
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded') and w.status <> 'cancelled'
     and not exists (select 1 from public.quote_items i
                     join public.job_part_requests r on r.id = i.part_request_id
                     where i.quote_id = p.quote_id and i.kind = 'part' and i.decision = 'approved'
                       and r.status in ('approved', 'ordered', 'fitted'))),
  -- R-082, D149: the job was completed (or collected) while a part this
  -- deposit was for is still approved or ordered, so the part is not on the
  -- bill (D140) and money is held for nothing on it: the whole deposit, or
  -- (some of its parts fitted, or more received than asked) the share
  -- named second (u.unfitted). Clears when the part is fitted after a
  -- reopen, or cancelled (then paid_parts_cancelled asks for the refund
  -- when no approved part is left), or once refunds leave nothing held
  -- beyond the fitted parts' share. Since: the later of the completion and
  -- the payment. A fitted request whose line was voided counts as fitted
  -- here (R-083).
  ('paid_parts_not_fitted', 'danger', greatest(w.completed_at, p.paid_at),
   case
     when w.status = 'collected' and u.all_unfitted
       then pg_catalog.format('%s is held for parts that never went on this job. Cancel them and refund in Stripe, or agree with the customer how it counts.',
                              h.held)
     when w.status = 'collected'
       then pg_catalog.format('%s is held; %s of it is for parts that never went on this job. Cancel them and refund that share in Stripe, or agree with the customer how it counts.',
                              h.held, u.unfitted)
     when u.all_unfitted
       then pg_catalog.format('%s is held for parts that are not on this job. Reopen the job to fit them, or cancel them and refund in Stripe.',
                              h.held)
     else pg_catalog.format('%s is held; %s of it is for parts that are not on this job. Reopen the job to fit them, or cancel them and refund that share in Stripe.',
                            h.held, u.unfitted) end,
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded')
     and w.status in ('completed', 'ready_for_collection', 'collected')
     and h.unfitted_amount > 0
     and exists (select 1 from public.quote_items i
                 join public.job_part_requests r on r.id = i.part_request_id
                 where i.quote_id = p.quote_id and i.kind = 'part' and i.decision = 'approved'
                   and r.status in ('approved', 'ordered'))),
  ('paid_twice', 'danger', p.paid_at,
   pg_catalog.format('This deposit was paid twice (%s again). Refund one payment in Stripe.', h.held),
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded') and exists (
     select 1 from public.payments o
     where o.quote_id = p.quote_id and o.kind = 'deposit' and o.id <> p.id
       and o.status in ('paid', 'partially_refunded') and (o.paid_at, o.id) < (p.paid_at, p.id))),
  ('amount_mismatch', 'danger', p.paid_at,
   case when p.amount_received is null
     then pg_catalog.format('Stripe took this payment in another currency, not the %s asked. Check it in Stripe.',
                            h.asked)
     else pg_catalog.format('Stripe received %s, not the %s asked. Check the payment in Stripe.',
                            h.received, h.asked) end,
   p.status in ('paid', 'partially_refunded') and p.amount_received is distinct from p.amount),
  ('refund_failed', 'danger', h.refund_failed_at,
   'A refund failed in Stripe and the money went back to the Stripe balance. Refund again in Stripe.',
   p.status <> 'refunded' and h.refund_failed_at is not null),
  ('refund_not_counted', 'danger', h.uncounted_refund_at,
   'Stripe reported a refund of this payment in another currency or mode (test or live), and BICII did not count it. Check it in Stripe.',
   h.uncounted_refund_at is not null),
  ('refund_exceeds_payment', 'danger', p.updated_at,
   pg_catalog.format('Stripe refunded %s, more than BICII recorded as paid. Check the payment in Stripe.',
                     h.refunded),
   p.refunded_amount > coalesce(p.amount_received, p.amount)),
  -- R-086: before Checkout completed, a read settles it (expired or
  -- paid); after it, Check with Stripe also reads the PaymentIntent, and a
  -- payment Stripe still has not decided is checked in the Dashboard.
  ('pending_unconfirmed', 'warning', p.stripe_session_expires_at,
   case when p.checkout_completed_at is null
     then pg_catalog.format('Stripe has not confirmed a payment of %s. Press Check with Stripe on the job.',
                            h.asked)
     else pg_catalog.format('The customer completed Checkout for %s, but Stripe has not confirmed the payment. Press Check with Stripe on the job; if it stays, look the payment up in the Stripe Dashboard.',
                            h.asked) end,
   p.status = 'pending' and p.stripe_session_expires_at < pg_catalog.now() - interval '15 minutes')
) as x (issue, severity, since, message, hit)
where x.hit;

comment on view public.payment_issues is
  'D159b: payment conditions needing an admin or manager, derived live (clear when their cause clears). The message is the sentence shown on the job card and in Exceptions (money as the screens print it: $1,234.50). Issues: paid_job_cancelled, paid_parts_cancelled, paid_parts_not_fitted (R-082, D149: a deposit paid or partly refunded whose approved parts are still approved or ordered on a completed, ready or collected job, while what it holds is more than its fitted parts'' share; the message names that unfitted share when it is less than what is held; since the later of completion and payment), paid_twice, amount_mismatch, refund_failed, refund_not_counted (a linked refund in another currency or mode), refund_exceeds_payment (danger); pending_unconfirmed (warning, 15 minutes after the session expired). Security invoker: staff through RLS.';

-- ---------------------------------------------------------------------------
-- work_order_payment_totals: the 20261014000500 view (:313-336) with
-- held_over_total appended.
-- ---------------------------------------------------------------------------
create or replace view public.work_order_payment_totals
with (security_invoker = on)
as
select w.id as work_order_id,
       w.currency,
       x.paid_online::public.money_amount as paid_online,
       x.refunded_online::public.money_amount as refunded_online,
       (x.paid_online - x.refunded_online)::public.money_amount as net_paid_online,
       coalesce(t.sale_total, 0)::public.money_amount as job_total,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest(coalesce(t.sale_total, 0) - (x.paid_online - x.refunded_online), 0)
        end)::public.money_amount as balance_due,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest((x.paid_online - x.refunded_online) - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as paid_ahead,
       -- R-082: what is held above the live-lines total, in every status
       -- (a collected or cancelled job still reconciles paid against
       -- billed); never negative; SGD only, like the two above.
       (case when w.currency = 'SGD'
             then greatest((x.paid_online - x.refunded_online) - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as held_over_total
from public.work_orders w
cross join lateral (
  select coalesce(sum(coalesce(p.amount_received, p.amount)), 0) as paid_online,
         coalesce(sum(p.refunded_amount), 0) as refunded_online
  from public.payments p
  where p.work_order_id = w.id and p.status in ('paid', 'partially_refunded', 'refunded')
) x
left join public.work_order_totals t on t.work_order_id = w.id
where exists (select 1 from public.payments p where p.work_order_id = w.id);

comment on view public.work_order_payment_totals is
  'D154: per job with a payment: what Stripe confirmed (paid_online), what was refunded, the net, the live-lines sale total (job_total, as work_order_totals) and, while the job is open (not collected or cancelled) and in SGD, balance_due and paid_ahead (both never negative); held_over_total (R-082) is the net paid above job_total in every status (SGD only, never negative), so a closed job still shows money held beyond its bill. Money held, not revenue: no report reads it. Security invoker: staff through RLS.';

-- ---------------------------------------------------------------------------
-- work_order_unfitted_requests: approved items not on the bill (D140, R-082)
-- ---------------------------------------------------------------------------
create view public.work_order_unfitted_requests
with (security_invoker = on)
as
select r.work_order_id,
       r.currency,
       pg_catalog.count(*)::integer as item_count,
       sum(r.line_total)::public.money_amount as quoted_total
from public.job_part_requests r
where r.status in ('approved', 'ordered')
group by r.work_order_id, r.currency;

comment on view public.work_order_unfitted_requests is
  'D140, R-082: per job and currency, the live indent requests the customer approved that are not on the bill yet (approved or ordered; not fitted, declined or cancelled): how many, and the quoted total (sum of line_total, computed here). A memo beside the job''s total, never added to it, to yield or to Cult Commons; no cost. Security invoker: staff through job_part_requests'' RLS and column grants; customers 0 rows; anon no grant.';

-- ---------------------------------------------------------------------------
-- private.quote_view: the 20261014000500 body (:345-427) with job_closed in
-- the answered deposit object.
-- ---------------------------------------------------------------------------
create or replace function private.quote_view(quote public.quotes)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  wo public.work_orders;
  bike public.bikes;
  first_name text;
  state text;
  deposit jsonb;
  dstate text;
  ordered boolean;
begin
  select w.* into wo from public.work_orders w where w.id = quote.work_order_id;
  state := case
    when quote.status = 'open' and quote.expires_at <= pg_catalog.clock_timestamp() then 'expired'
    else quote.status::text
  end;
  if state in ('withdrawn', 'expired') then
    return pg_catalog.jsonb_build_object('status', state, 'job_number', wo.job_number);
  end if;
  select b.* into bike from public.bikes b where b.id = wo.bike_id;
  select c.first_name into first_name from public.customers c where c.id = wo.customer_id;
  -- D151, D158: the deposit the page may show. Open: the percent only (the
  -- amount is fixed when the customer answers). Answered: the amount and
  -- its state; a due deposit only while the job is open (D158c);
  -- parts_ordered, true once every approved part still live is ordered or
  -- fitted (D152: an admin or manager ordered them before the deposit was
  -- paid, so the page stops saying the order waits for it); and job_closed
  -- (R-082), true once the job is completed, ready, collected or
  -- cancelled, so the page stops saying the shop will order the parts.
  if quote.status = 'open' then
    if coalesce(quote.deposit_percent, 0) > 0
       and exists (select 1 from public.quote_items i where i.quote_id = quote.id and i.kind = 'part') then
      deposit := pg_catalog.jsonb_build_object('percent', quote.deposit_percent, 'amount', null,
                                               'status', 'on_answer');
    end if;
  elsif quote.deposit_amount is not null then
    select d.state into dstate from public.quote_deposits d where d.quote_id = quote.id;
    if dstate in ('processing', 'paid', 'refunded')
       or (dstate = 'due' and private.work_order_status_is_open(wo.status)) then
      select pg_catalog.bool_and(r.status in ('ordered', 'fitted')) into ordered
      from public.quote_items i
      join public.job_part_requests r on r.id = i.part_request_id
      where i.quote_id = quote.id and i.kind = 'part' and i.decision = 'approved'
        and r.status in ('approved', 'ordered', 'fitted');
      deposit := pg_catalog.jsonb_build_object('percent', quote.deposit_percent,
                                               'amount', quote.deposit_amount, 'status', dstate,
                                               'parts_ordered', coalesce(ordered, false),
                                               'job_closed', not private.work_order_status_is_open(wo.status));
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'status', state,
    'job_number', wo.job_number,
    'bike', pg_catalog.concat_ws(' ', bike.brand, bike.model, bike.variant),
    'first_name', first_name,
    'currency', quote.currency,
    'total', quote.total,
    'sent_at', quote.sent_at,
    'expires_at', quote.expires_at,
    'answered_at', quote.answered_at,
    'answered_name', quote.answered_name,
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', i.id,
          'kind', i.kind,
          'description', i.description,
          'quantity', i.quantity,
          'unit_sale_price', i.unit_sale_price,
          'line_total', i.line_total,
          'decision', i.decision
        )
        order by i.position
      )
      from public.quote_items i
      where i.quote_id = quote.id
    ), '[]'::jsonb),
    'deposit', deposit
  );
end;
$$;

comment on function private.quote_view(public.quotes) is
  'D143, D151, D158: what the quote page may show for one quote: never costs, notes, staff, contact details, other jobs or any Stripe id or URL. Withdrawn or expired: status and job number only. Otherwise 12 keys, the last ''deposit'': null, or {percent, amount, status} with status on_answer (open; amount null), or {percent, amount, status, parts_ordered, job_closed} with status due (answered, job open), processing, paid or refunded (quote_deposits), parts_ordered true once every approved part still live is ordered or fitted, and job_closed (R-082) true once the job is completed, ready for collection, collected or cancelled.';

-- ---------------------------------------------------------------------------
-- Privileges (DATA-MODEL §15): restated for the record; create or replace
-- keeps every grant above, and the new view gets the payment views' grant.
-- ---------------------------------------------------------------------------
revoke all on function
  public.cancel_part_request(uuid, text),
  public.withdraw_quote(uuid),
  public.order_part_requests(uuid[], uuid, uuid, boolean, text),
  private.quote_view(public.quotes)
from public, anon, authenticated, service_role;

grant execute on function
  public.cancel_part_request(uuid, text),
  public.withdraw_quote(uuid),
  public.order_part_requests(uuid[], uuid, uuid, boolean, text)
to authenticated;

revoke all on table public.payment_issues, public.work_order_payment_totals,
  public.work_order_unfitted_requests
  from public, anon, authenticated, service_role;
grant select on table public.payment_issues, public.work_order_payment_totals,
  public.work_order_unfitted_requests
  to authenticated;
