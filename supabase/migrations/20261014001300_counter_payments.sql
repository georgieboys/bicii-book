-- Phase 14 step 3: counter payments (PLAN D161 and its build defaults
-- D161a-j; ADR-025 amendment 2026-10-17; DATA-MODEL §5, §15, §16, §19;
-- RISKS R-089, R-090).
--
-- An active admin, and only an admin (D161a), records money the shop took
-- at the counter on a job (cash, the shop's own card terminal or PayNow QR,
-- a bank transfer, other; D161b), so the job's paid and still to pay, and
-- the deposit BICII asks for, count it. BICII moves no money: a record is
-- an admin's word (R-090), corrected only by a void with a kind and a
-- reason. Kept out of public.payments, so D153/D159a hold unchanged for
-- every Stripe row (payments_guard, the NOT NULL Stripe columns and Check
-- with Stripe never see a counter row). Modelled on the consignor
-- settlements (20261004003600): a client-chosen id with a request
-- fingerprint, append-only rows, and a separate void row.
--
--   counter_payment_method, counter_void_kind   new enums (D161b, D161d).
--   counter_payments      one row per payment (D161c): a deposit settles
--                         one quote's deposit (quote_id set), a balance
--                         counts towards the bill (D161f). Append-only for
--                         every role.
--   counter_payment_voids at most one per payment (D161d): recorded_in_error
--                         or given_back (cash the shop handed back outside
--                         BICII, not a refund from the Admin in ADR-025's
--                         sense), with a reason. Append-only for every role.
--   record_counter_payment, void_counter_payment  admins only, security
--                         definer; writes go only through them.
--   quote_deposits        a live counter deposit makes the deposit paid
--                         (counter_payment_id appended), which opens the
--                         D152 gate and the quote page's "paid" with no
--                         change to order_part_requests or quote_view.
--   work_order_payment_totals  a row for every job; paid_at_counter,
--                         net_paid and processing_online appended; balance,
--                         paid ahead and held over count net_paid.
--   payment_issues        paid_online_and_counter, the counter
--                         paid_job_cancelled and paid_parts_cancelled, and
--                         paid_above_bill; counter_payment_id appended.
--                         They reach Exceptions as payment_attention
--                         (admins and managers) with no further change.
--
-- 20261014000500 and 20261014000700 already ran on the hosted project, so
-- they are not edited: the three views are replaced keeping every column
-- (name, type, order) and appending only, with security_invoker and their
-- grants restated. A database with no counter payment and no balance
-- payment reads exactly as before (tests/db/counter-payments.test.ts
-- compares them with the merged views), apart from the totals rows that
-- now exist for jobs without a payment.
--
-- Lock order (DATA-MODEL §19): record_counter_payment takes the job
-- (private.lock_work_order), answers a replay, then takes the quote FOR
-- UPDATE (selected by id AND job, so another job's quote is never locked),
-- then inserts the counter row, then the timeline entry.
-- void_counter_payment takes the job, then the counter row FOR UPDATE, then
-- inserts the void and the timeline entry. Neither takes the Stripe
-- payment-intent advisory lock. Every writer of payments and of counter
-- rows holds the job's lock, so the D152 gate (order_part_requests reads
-- quote_deposits under its job locks) serialises with both.
--
-- The request fingerprint is md5 of the canonical JSON
--   {"work_order_id", "quote_id", "amount": "200.00", "method",
--    "received_at": "...Z"|null, "reference": trimmed|null,
--    "note": trimmed|null}
-- over the inputs AS GIVEN (the amount as money_amount, so "200" and
-- "200.00" match; received_at in UTC, NULL staying NULL, so a retry that
-- again means "now" replays).

-- ---------------------------------------------------------------------------
-- D161b, D161d: the enums
-- ---------------------------------------------------------------------------
create type public.counter_payment_method as enum ('cash', 'card', 'paynow', 'bank_transfer', 'other');

comment on type public.counter_payment_method is
  'D161b: how the shop took a counter payment: cash, card (the shop''s own terminal), paynow (the shop''s own QR), bank_transfer, other. Never Stripe.';

create type public.counter_void_kind as enum ('recorded_in_error', 'given_back');

comment on type public.counter_void_kind is
  'D161d: why a counter payment was voided: recorded_in_error (it never came in; D154 reports leave it out, so its day restates) or given_back (the shop handed the money back outside BICII; reported as its own movement on the void''s day).';

-- ---------------------------------------------------------------------------
-- D161c: counter_payments
-- ---------------------------------------------------------------------------
create table public.counter_payments (
  -- Client-chosen: the request's idempotency key.
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  -- Set for a deposit: the quote whose deposit it settles (D161f).
  quote_id uuid null references public.quotes (id) on delete restrict,
  kind public.payment_kind not null,
  amount public.money_amount not null,
  currency char(3) not null default 'SGD',
  method public.counter_payment_method not null,
  -- Business time: when the shop took the money (NULL in the RPC means now).
  received_at timestamptz not null,
  reference text null,
  note text null,
  -- The request's fingerprint (idempotency); never shown, never granted.
  request_fingerprint text not null,
  recorded_by uuid not null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint counter_payments_kind_quote check ((kind = 'deposit') = (quote_id is not null)),
  constraint counter_payments_amount_check check (amount > 0 and amount <= 999999.99),
  constraint counter_payments_currency_check check (currency = 'SGD'),
  constraint counter_payments_reference_check check (pg_catalog.char_length(reference) <= 200),
  constraint counter_payments_note_check check (pg_catalog.char_length(note) <= 2000)
);

create index counter_payments_work_order_idx on public.counter_payments (work_order_id, received_at);
create index counter_payments_received_at_idx on public.counter_payments (received_at);
create index counter_payments_quote_idx on public.counter_payments (quote_id) where quote_id is not null;
create index counter_payments_recorded_by_idx on public.counter_payments (recorded_by);

comment on table public.counter_payments is
  'D161: money the shop took at the counter on a job, recorded by an active admin (record_counter_payment). kind deposit (quote_id set) settles that quote''s deposit, exactly its amount (D161f); kind balance counts towards the bill. Money held, not revenue (D154). Append-only for every role (counter_payment_immutable); corrected only by a counter_payment_voids row. Staff read it (never request_fingerprint); customers and anon read nothing; no API role writes.';
comment on column public.counter_payments.received_at is
  'D161h: when the shop took the money (business time): never more than 5 minutes ahead, before the job''s check-in (or a deposit''s quote answer), or more than 30 days before it was recorded.';
comment on column public.counter_payments.created_at is
  'When the admin recorded it (clock time of the call), so rows of one transaction keep their order.';

-- ---------------------------------------------------------------------------
-- D161d: counter_payment_voids
-- ---------------------------------------------------------------------------
create table public.counter_payment_voids (
  counter_payment_id uuid primary key references public.counter_payments (id) on delete restrict,
  kind public.counter_void_kind not null,
  reason text not null,
  voided_by uuid not null references public.staff (id) on delete restrict,
  voided_at timestamptz not null default clock_timestamp(),
  constraint counter_payment_voids_reason_check check (
    pg_catalog.btrim(reason) <> '' and pg_catalog.char_length(reason) <= 500
  )
);

create index counter_payment_voids_voided_at_idx on public.counter_payment_voids (voided_at);
create index counter_payment_voids_voided_by_idx on public.counter_payment_voids (voided_by);

comment on table public.counter_payment_voids is
  'D161d: the one correction of a counter payment (at most one per payment), by an active admin (void_counter_payment), on any job status: recorded_in_error or given_back, with a reason (1..500). A voided payment no longer counts anywhere (quote_deposits, work_order_payment_totals, payment_issues). Append-only for every role.';

-- Append-only, for every writer (the owner included). An insert of a
-- deposit must name a quote of the same job.
create function private.counter_payments_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.quote_id is not null and not exists (
      select 1 from public.quotes q where q.id = new.quote_id and q.work_order_id = new.work_order_id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'counter_payment_quote_mismatch',
        detail = 'That quote is not on this job.';
    end if;
    return new;
  end if;
  raise exception using
    errcode = 'P0001',
    message = 'counter_payment_immutable',
    detail = 'A counter payment and its void are never changed or deleted; void it with a reason and record it again.';
end;
$$;

comment on function private.counter_payments_immutable() is
  'D161c/d: BEFORE INSERT OR UPDATE OR DELETE on counter_payments and BEFORE UPDATE OR DELETE on counter_payment_voids, for every role: an update or delete raises counter_payment_immutable; a deposit''s quote must be on its job (counter_payment_quote_mismatch). Owner-only.';

create trigger counter_payment_immutable
  before insert or update or delete on public.counter_payments
  for each row execute function private.counter_payments_immutable();
create trigger counter_payment_immutable
  before update or delete on public.counter_payment_voids
  for each row execute function private.counter_payments_immutable();

-- ---------------------------------------------------------------------------
-- The request fingerprint (settlement_request_fingerprint's pattern,
-- 20261004003600:304-338)
-- ---------------------------------------------------------------------------
create function private.counter_payment_request_fingerprint(
  work_order_id uuid,
  quote_id uuid,
  amount public.money_amount,
  method public.counter_payment_method,
  received_at timestamptz,
  reference text,
  note text
)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'work_order_id', counter_payment_request_fingerprint.work_order_id,
      'quote_id', counter_payment_request_fingerprint.quote_id,
      'amount', counter_payment_request_fingerprint.amount::text,
      'method', counter_payment_request_fingerprint.method,
      'received_at', pg_catalog.to_char(
        counter_payment_request_fingerprint.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'reference', nullif(pg_catalog.btrim(counter_payment_request_fingerprint.reference), ''),
      'note', nullif(pg_catalog.btrim(counter_payment_request_fingerprint.note), '')
    )::text
  );
$$;

comment on function private.counter_payment_request_fingerprint(uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text) is
  'D161i: md5 of the canonical JSON of a record_counter_payment request as given: the amount as money_amount text ("200" = "200.00"), received_at in UTC with NULL kept NULL, reference and note trimmed (blank = NULL). Owner-only.';

-- ---------------------------------------------------------------------------
-- D161i: record_counter_payment (admins only)
-- ---------------------------------------------------------------------------
-- Order: (1) require_admin; (2) shape; (3) the fingerprint of the inputs as
-- given; (4) the job lock; (5) replay by id, before any other check; (6)
-- the quote FOR UPDATE for a deposit (by id and job); (7) the job, time,
-- deposit and Stripe checks; (8) the insert (an id taken on another job
-- meanwhile is a conflict); (9) the timeline entry. open_checkouts: the
-- job's pending Stripe payments whose Checkout is still open (not
-- completed, not expired) and that this money makes stale: any balance, or
-- the quote's own deposit. The app expires them, best effort (D161g).
create function public.record_counter_payment(
  p_id uuid,
  p_work_order_id uuid,
  p_quote_id uuid,
  p_amount public.money_amount,
  p_method public.counter_payment_method,
  p_received_at timestamptz default null,
  p_reference text default null,
  p_note text default null
)
returns table (counter_payment_id uuid, replayed boolean, open_checkouts integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_admin();
  clean_reference text := nullif(pg_catalog.btrim(record_counter_payment.p_reference), '');
  clean_note text := nullif(pg_catalog.btrim(record_counter_payment.p_note), '');
  fingerprint text;
  wo public.work_orders;
  q public.quotes;
  existing public.counter_payments;
  inserted public.counter_payments;
  received timestamptz;
  dstate text;
  open_count integer;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  -- (2) Shape.
  if record_counter_payment.p_id is null or record_counter_payment.p_work_order_id is null
     or record_counter_payment.p_amount is null or record_counter_payment.p_method is null then
    raise exception 'p_id, p_work_order_id, p_amount and p_method are required' using errcode = '22004';
  end if;
  if record_counter_payment.p_amount <= 0 or record_counter_payment.p_amount > 999999.99 then
    perform private.raise_without_row('23514', 'counter_payments_amount_check', 'counter_payments', 'public',
      null, 'new row for relation "counter_payments" violates check constraint "counter_payments_amount_check"');
  end if;
  if pg_catalog.char_length(clean_reference) > 200 then
    perform private.raise_without_row('23514', 'counter_payments_reference_check', 'counter_payments', 'public',
      null, 'new row for relation "counter_payments" violates check constraint "counter_payments_reference_check"');
  end if;
  if pg_catalog.char_length(clean_note) > 2000 then
    perform private.raise_without_row('23514', 'counter_payments_note_check', 'counter_payments', 'public',
      null, 'new row for relation "counter_payments" violates check constraint "counter_payments_note_check"');
  end if;
  if record_counter_payment.p_received_at > pg_catalog.clock_timestamp() + interval '5 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_in_future',
      detail = 'A counter payment cannot be dated in the future.';
  end if;

  -- (3) The fingerprint of the request as given.
  fingerprint := private.counter_payment_request_fingerprint(
    record_counter_payment.p_work_order_id, record_counter_payment.p_quote_id, record_counter_payment.p_amount,
    record_counter_payment.p_method, record_counter_payment.p_received_at, record_counter_payment.p_reference,
    record_counter_payment.p_note
  );

  -- (4) The job (P0002 when there is none).
  wo := private.lock_work_order(record_counter_payment.p_work_order_id);
  select pg_catalog.count(*)::integer into open_count
  from public.payments p
  where p.work_order_id = wo.id and p.status = 'pending' and p.checkout_completed_at is null
    and p.stripe_session_expires_at > pg_catalog.clock_timestamp()
    and (p.kind = 'balance' or (record_counter_payment.p_quote_id is not null
                                 and p.quote_id = record_counter_payment.p_quote_id));

  -- (5) Replay of the same id: before any other check.
  select c.* into existing from public.counter_payments c where c.id = record_counter_payment.p_id;
  if found then
    if existing.request_fingerprint = fingerprint and existing.work_order_id = wo.id then
      return query select existing.id, true, open_count;
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_conflict',
      detail = 'That counter payment id is already used for another payment.';
  end if;

  -- (6) A deposit: its quote, on this job, locked.
  if record_counter_payment.p_quote_id is not null then
    select x.* into q
    from public.quotes x
    where x.id = record_counter_payment.p_quote_id and x.work_order_id = wo.id
    for update;
    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'counter_payment_quote_mismatch',
        detail = 'That quote is not on this job.';
    end if;
  end if;

  -- (7) D161e: the job.
  if wo.status = 'cancelled' then
    raise exception using
      errcode = 'P0001',
      message = 'work_order_cancelled',
      detail = 'This job is cancelled; no payment can be recorded on it.';
  end if;
  if wo.currency <> 'SGD' or wo.currency <> private.shop_currency() then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_currency',
      detail = 'Counter payments are recorded in SGD, the shop currency, only.';
  end if;
  -- D161h: when.
  received := coalesce(record_counter_payment.p_received_at, pg_catalog.clock_timestamp());
  if received < wo.checked_in_at
     or (record_counter_payment.p_quote_id is not null and received < q.answered_at) then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_before_job',
      detail = 'A counter payment cannot be dated before the job was checked in (a deposit, before the quote was answered).';
  end if;
  if received < pg_catalog.clock_timestamp() - interval '30 days' then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_too_old',
      detail = 'A counter payment cannot be dated more than 30 days back.';
  end if;
  -- D161f: a deposit is due or refunded, and paid exactly.
  if record_counter_payment.p_quote_id is not null then
    select d.state into dstate from public.quote_deposits d where d.quote_id = q.id;
    if dstate is null or dstate = 'none' then
      raise exception using
        errcode = 'P0001',
        message = 'deposit_not_due',
        detail = 'There is no deposit to pay on this quote.';
    elsif dstate = 'paid' then
      raise exception using
        errcode = 'P0001',
        message = 'deposit_already_paid',
        detail = 'This deposit is already paid.';
    elsif dstate = 'processing' then
      raise exception using
        errcode = 'P0001',
        message = 'deposit_processing',
        detail = 'An online payment of this deposit is still being confirmed. Press Check with Stripe first.';
    end if;
    if record_counter_payment.p_amount <> q.deposit_amount then
      raise exception using
        errcode = 'P0001',
        message = 'counter_deposit_amount',
        detail = pg_catalog.format('The deposit is %s; record any other amount towards the bill.',
                                   pg_catalog.to_char(q.deposit_amount, 'FM999,999,990.00'));
    end if;
  end if;
  -- D161g: no Stripe money on the job still being confirmed.
  if exists (select 1 from public.payments p
             where p.work_order_id = wo.id and p.status = 'pending' and p.checkout_completed_at is not null) then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_stripe_processing',
      detail = 'An online payment on this job is still being confirmed. Press Check with Stripe first.';
  end if;

  -- (8) The row (the FK KEY SHARE locks on the job and the quote come after
  -- their FOR UPDATE). An id another job took meanwhile is a conflict.
  begin
    insert into public.counter_payments as c (
      id, work_order_id, quote_id, kind, amount, currency, method, received_at, reference, note,
      request_fingerprint, recorded_by
    )
    values (
      record_counter_payment.p_id, wo.id, record_counter_payment.p_quote_id,
      (case when record_counter_payment.p_quote_id is null then 'balance' else 'deposit' end)::public.payment_kind,
      record_counter_payment.p_amount, 'SGD', record_counter_payment.p_method, received, clean_reference,
      clean_note, fingerprint, actor
    )
    on conflict (id) do nothing
    returning c.* into inserted;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  if inserted.id is null then
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_conflict',
      detail = 'That counter payment id is already used for another payment.';
  end if;

  -- (9) The timeline (no reference or note).
  perform private.record_work_order_event(
    wo.id,
    'counter_payment_recorded',
    pg_catalog.jsonb_build_object(
      'counter_payment_id', inserted.id, 'kind', inserted.kind, 'quote_id', inserted.quote_id,
      'amount', inserted.amount, 'method', inserted.method, 'received_at', inserted.received_at
    )
  );
  return query select inserted.id, false, open_count;
end;
$$;

comment on function public.record_counter_payment(uuid, uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text) is
  'D161: an active admin records money taken at the counter on a job (42501 otherwise). p_quote_id set: that quote''s deposit, exactly deposit_amount (counter_deposit_amount), while quote_deposits says due or refunded (deposit_not_due for none or no deposit, deposit_already_paid, deposit_processing; another job''s quote counter_payment_quote_mismatch); else a balance payment of any amount (0.01..999,999.99, 23514 counter_payments_amount_check). Refused on a cancelled job (work_order_cancelled), outside SGD (counter_payment_currency), while a Stripe payment on the job is being confirmed (counter_payment_stripe_processing), and when received_at (NULL = now) is more than 5 minutes ahead (counter_payment_in_future), before check-in or a deposit''s quote answer (counter_payment_before_job) or more than 30 days back (counter_payment_too_old). Replay-safe by p_id with a fingerprint of the request as given (counter_payment_conflict otherwise), answered under the job lock before any other check. Returns the id, replayed, and open_checkouts (open Stripe sessions of a balance or this quote''s deposit, for the app to expire). Writes counter_payment_recorded {counter_payment_id, kind, quote_id, amount, method, received_at}.';

-- ---------------------------------------------------------------------------
-- D161d: void_counter_payment (admins only)
-- ---------------------------------------------------------------------------
create function public.void_counter_payment(
  p_counter_payment_id uuid,
  p_kind public.counter_void_kind,
  p_reason text
)
returns table (counter_payment_id uuid, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_admin();
  cleaned text := private.require_reason(void_counter_payment.p_reason);
  target public.counter_payments;
  existing public.counter_payment_voids;
begin
  if void_counter_payment.p_counter_payment_id is null or void_counter_payment.p_kind is null then
    raise exception 'p_counter_payment_id and p_kind are required' using errcode = '22004';
  end if;
  select c.* into target from public.counter_payments c where c.id = void_counter_payment.p_counter_payment_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'counter_payment_not_found',
      detail = 'That counter payment does not exist.';
  end if;
  -- The job, then the counter row (lock order, DATA-MODEL §19).
  perform private.lock_work_order(target.work_order_id);
  select c.* into target from public.counter_payments c where c.id = target.id for update;

  select v.* into existing from public.counter_payment_voids v where v.counter_payment_id = target.id;
  if found then
    if existing.kind = void_counter_payment.p_kind and existing.reason = cleaned then
      return query select target.id, true;
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'counter_payment_already_voided',
      detail = 'That counter payment is already voided.';
  end if;

  insert into public.counter_payment_voids (counter_payment_id, kind, reason, voided_by)
  values (target.id, void_counter_payment.p_kind, cleaned, actor);
  perform private.record_work_order_event(
    target.work_order_id,
    'counter_payment_voided',
    pg_catalog.jsonb_build_object(
      'counter_payment_id', target.id, 'kind', target.kind, 'quote_id', target.quote_id,
      'amount', target.amount, 'method', target.method, 'void_kind', void_counter_payment.p_kind,
      'reason', cleaned
    )
  );
  return query select target.id, false;
end;
$$;

comment on function public.void_counter_payment(uuid, public.counter_void_kind, text) is
  'D161d: an active admin voids a counter payment (42501 otherwise), on any job status, with a kind (recorded_in_error or given_back) and a reason (reason_required, reason_too_long); counter_payment_not_found (P0002). One void per payment: the same kind and reason again is replayed, anything else counter_payment_already_voided. Takes the job lock, then the row. BICII moves no money: given_back records cash handed back outside BICII. Writes counter_payment_voided {counter_payment_id, kind, quote_id, amount, method, void_kind, reason}.';

-- ---------------------------------------------------------------------------
-- D161j: quote_deposits, the 20261014000500 view (:188-218) with a live
-- counter deposit in the paid branch and counter_payment_id appended.
-- ---------------------------------------------------------------------------
create or replace view public.quote_deposits
with (security_invoker = on)
as
select q.id as quote_id,
       q.work_order_id,
       q.sent_at,
       q.answered_at,
       q.currency,
       q.deposit_percent,
       q.deposit_amount,
       case
         when c.counter_payment_id is not null
           or exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit'
                        and p.status in ('paid', 'partially_refunded')) then 'paid'
         when exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit' and p.status = 'refunded') then 'refunded'
         when exists (select 1 from public.payments p
                      where p.quote_id = q.id and p.kind = 'deposit'
                        and p.status = 'pending' and p.checkout_completed_at is not null) then 'processing'
         when exists (select 1 from public.quote_items i
                      join public.job_part_requests r on r.id = i.part_request_id
                      where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
                        and r.status in ('approved', 'ordered', 'fitted')) then 'due'
         else 'none'
       end as state,
       coalesce((select pg_catalog.array_agg(i.part_request_id order by i.position)
                 from public.quote_items i
                 where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'),
                '{}'::uuid[]) as part_request_ids,
       c.counter_payment_id
from public.quotes q
-- The live (not voided) counter deposit, picked deterministically: the
-- newest recorded. record_counter_payment keeps at most one live per quote
-- under the quote lock (a void lives in another table, so no index can).
left join lateral (
  select cp.id as counter_payment_id
  from public.counter_payments cp
  where cp.quote_id = q.id and cp.kind = 'deposit'
    and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
  order by cp.created_at desc, cp.id desc
  limit 1
) c on true
where q.status = 'answered' and q.deposit_amount is not null;

comment on view public.quote_deposits is
  'D151/D152/D158/D161: each answered quote''s deposit and its state: paid (a live counter deposit, or a Stripe deposit paid or partly refunded, D158e), refunded, processing (Checkout complete, Stripe still confirming), due, none (every approved part cancelled). counter_payment_id: the live counter deposit (newest recorded), or null. A void takes the counter deposit out and the state falls back to what the Stripe payments and the parts give it. Security invoker: staff through RLS; the definer RPCs (the D152 gate, quote_view, the Checkout RPCs, record_counter_payment) read it as owner. One definition for all of them.';

-- ---------------------------------------------------------------------------
-- D161j: work_order_payment_totals, the 20261014000700 view (:574-603) for
-- every job, with counter money in the net and three columns appended.
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
             then greatest(coalesce(t.sale_total, 0) - n.net_paid, 0)
        end)::public.money_amount as balance_due,
       (case when w.currency = 'SGD' and w.status not in ('collected', 'cancelled')
             then greatest(n.net_paid - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as paid_ahead,
       -- R-082: what is held above the live-lines total, in every status;
       -- never negative; SGD only, like the two above.
       (case when w.currency = 'SGD'
             then greatest(n.net_paid - coalesce(t.sale_total, 0), 0)
        end)::public.money_amount as held_over_total,
       c.paid_at_counter::public.money_amount as paid_at_counter,
       n.net_paid::public.money_amount as net_paid,
       x.processing_online::public.money_amount as processing_online
from public.work_orders w
cross join lateral (
  select coalesce(sum(coalesce(p.amount_received, p.amount))
                    filter (where p.status in ('paid', 'partially_refunded', 'refunded')), 0) as paid_online,
         coalesce(sum(p.refunded_amount)
                    filter (where p.status in ('paid', 'partially_refunded', 'refunded')), 0) as refunded_online,
         -- Checkout completed, Stripe still confirming (PayNow): shown apart,
         -- never in net_paid or the balance.
         coalesce(sum(p.amount)
                    filter (where p.status = 'pending' and p.checkout_completed_at is not null), 0)
           as processing_online
  from public.payments p
  where p.work_order_id = w.id
) x
cross join lateral (
  select coalesce(sum(cp.amount), 0) as paid_at_counter
  from public.counter_payments cp
  where cp.work_order_id = w.id
    and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
) c
cross join lateral (
  select x.paid_online - x.refunded_online + c.paid_at_counter as net_paid
) n
left join public.work_order_totals t on t.work_order_id = w.id;

comment on view public.work_order_payment_totals is
  'D154, D161: per job (a row for every job): what Stripe confirmed (paid_online), what was refunded, the online net, the live-lines sale total (job_total, as work_order_totals), live counter payments (paid_at_counter), net_paid (online net + counter) and, while the job is not collected or cancelled and in SGD, balance_due and paid_ahead from net_paid (both never negative); held_over_total (R-082) is net_paid above job_total in every status (SGD only, never negative); processing_online is the amount of Stripe payments whose Checkout completed but Stripe is still confirming (never in net_paid or the balance). Money held, not revenue; D154''s reports read it. Security invoker: staff through RLS.';

-- ---------------------------------------------------------------------------
-- D161j: payment_issues, the 20261014000700 view (:436-565) with two new
-- kinds on Stripe rows, a counter branch, and counter_payment_id appended.
-- ---------------------------------------------------------------------------
create or replace view public.payment_issues
with (security_invoker = on)
as
select p.id as payment_id, p.work_order_id, p.quote_id, x.issue, x.severity, x.since, x.message,
       null::uuid as counter_payment_id
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
         coalesce(p.amount_received, p.amount) - p.refunded_amount as held_amount,
         -- D161: when the quote's live counter deposit (the newest
         -- recorded) was taken, or null.
         (select cp.received_at
          from public.counter_payments cp
          where cp.quote_id = p.quote_id and cp.kind = 'deposit'
            and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = cp.id)
          order by cp.created_at desc, cp.id desc
          limit 1) as counter_deposit_at
) h
cross join lateral (
  select '$' || pg_catalog.to_char(h.unfitted_amount, 'FM999,999,990.00') as unfitted,
         h.unfitted_amount >= h.held_amount as all_unfitted
) u
-- D161j: the job paid at least S$0.50 above its bill once it is completed,
-- ready or collected (net_paid: Stripe and counter), named only when the
-- job has a balance payment or live counter money (so a database with
-- neither reads as before), and not when paid_twice,
-- paid_online_and_counter or a deposit held for cancelled parts
-- (paid_parts_cancelled, Stripe or counter) or for parts not fitted
-- (paid_parts_not_fitted) already names the surplus: those name the same
-- money and ask for its refund. Once that deposit is refunded or voided,
-- what is still above the bill shows here (the paid_twice precedent).
left join lateral (
  select '$' || pg_catalog.to_char(t.held_over_total, 'FM999,999,990.00') as over,
         '$' || pg_catalog.to_char(t.job_total, 'FM999,999,990.00') as bill,
         (t.held_over_total >= 0.50
          and w.status in ('completed', 'ready_for_collection', 'collected')
          and (exists (select 1 from public.payments o
                       where o.work_order_id = w.id and o.kind = 'balance'
                         and o.status in ('paid', 'partially_refunded', 'refunded'))
               or exists (select 1 from public.counter_payments cp
                          where cp.work_order_id = w.id
                            and not exists (select 1 from public.counter_payment_voids v
                                            where v.counter_payment_id = cp.id)))
          and not exists (select 1 from public.payments o1
                          join public.payments o2 on o2.quote_id = o1.quote_id and o2.id <> o1.id
                          where o1.work_order_id = w.id and o1.kind = 'deposit' and o2.kind = 'deposit'
                            and o1.status in ('paid', 'partially_refunded')
                            and o2.status in ('paid', 'partially_refunded'))
          and not exists (select 1 from public.payments o
                          join public.counter_payments cp on cp.quote_id = o.quote_id and cp.kind = 'deposit'
                          where o.work_order_id = w.id and o.kind = 'deposit'
                            and o.status in ('paid', 'partially_refunded')
                            and not exists (select 1 from public.counter_payment_voids v
                                            where v.counter_payment_id = cp.id))
          -- paid_parts_cancelled (either source): a quote of the job holds a
          -- Stripe deposit paid or partly refunded, or a live counter
          -- deposit, and none of its approved parts is approved, ordered or
          -- fitted. Inline, not quote_deposits.state (which also needs the
          -- quote answered; the Stripe predicate does not).
          and not exists (
            select 1 from public.quotes q
            where q.work_order_id = w.id
              and (exists (select 1 from public.payments o
                           where o.quote_id = q.id and o.kind = 'deposit'
                             and o.status in ('paid', 'partially_refunded'))
                   or exists (select 1 from public.counter_payments cp
                              where cp.quote_id = q.id and cp.kind = 'deposit'
                                and not exists (select 1 from public.counter_payment_voids v
                                                where v.counter_payment_id = cp.id)))
              and not exists (select 1 from public.quote_items i
                              join public.job_part_requests r on r.id = i.part_request_id
                              where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
                                and r.status in ('approved', 'ordered', 'fitted')))
          -- paid_parts_not_fitted (a Stripe deposit on a job closed before
          -- D149b): the same predicate, with the same unfitted share > 0.
          and not exists (
            select 1 from public.payments o
            where o.work_order_id = w.id and o.kind = 'deposit'
              and o.status in ('paid', 'partially_refunded')
              and exists (select 1 from public.quote_items i
                          join public.job_part_requests r on r.id = i.part_request_id
                          where i.quote_id = o.quote_id and i.kind = 'part' and i.decision = 'approved'
                            and r.status in ('approved', 'ordered'))
              and (select greatest(
                            least(coalesce(o.amount_received, o.amount) - o.refunded_amount, o.amount)
                            - coalesce(pg_catalog.round(
                                sum(i.line_total) filter (where r.status = 'fitted')
                                * pg_catalog.max(q.deposit_percent) / 100, 2), 0),
                            0)
                   from public.quotes q
                   join public.quote_items i on i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
                   join public.job_part_requests r on r.id = i.part_request_id
                   where q.id = o.quote_id) > 0)) as above_bill
  from public.work_order_payment_totals t
  where t.work_order_id = w.id
) b on true
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
  -- D161j, R-089: the deposit paid online while a counter deposit for the
  -- same quote is live (a Checkout tab left open, finished after the
  -- counter payment; D159b records it). Since: the later of the two.
  ('paid_online_and_counter', 'danger', greatest(p.paid_at, h.counter_deposit_at),
   pg_catalog.format('The deposit of %s was paid online and at the counter. Refund the online payment in Stripe, or, if the counter money was given back, an admin records it as given back.',
                     h.asked),
   p.kind = 'deposit' and p.status in ('paid', 'partially_refunded') and h.counter_deposit_at is not null),
  -- D161j: on the job's newest paid Stripe payment (the counter branch
  -- below carries it when the job has none). Since: the later of the
  -- completion and that payment.
  ('paid_above_bill', 'danger', greatest(w.completed_at, p.paid_at),
   pg_catalog.format('%s more than this job''s bill of %s has been paid. Refund the extra in Stripe, or an admin records counter money given back.',
                     b.over, b.bill),
   coalesce(b.above_bill, false)
     and p.status in ('paid', 'partially_refunded', 'refunded')
     and not exists (select 1 from public.payments o
                     where o.work_order_id = p.work_order_id
                       and o.status in ('paid', 'partially_refunded', 'refunded')
                       and (o.paid_at, o.id) > (p.paid_at, p.id))),
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
where x.hit

union all

-- D161j: live counter payments (payment_id null, counter_payment_id set).
select null::uuid, c.work_order_id, c.quote_id, x.issue, x.severity, x.since, x.message, c.id
from public.counter_payments c
join public.work_orders w on w.id = c.work_order_id
cross join lateral (
  select '$' || pg_catalog.to_char(c.amount, 'FM999,999,990.00') as held
) h
-- paid_above_bill here only when no Stripe payment is in the paid group
-- (below), so paid_twice, paid_online_and_counter and
-- paid_parts_not_fitted cannot be on the job; a deposit held for cancelled
-- parts (paid_parts_cancelled, counter or Stripe) is skipped as in the
-- Stripe branch.
left join lateral (
  select '$' || pg_catalog.to_char(t.held_over_total, 'FM999,999,990.00') as over,
         '$' || pg_catalog.to_char(t.job_total, 'FM999,999,990.00') as bill,
         (t.held_over_total >= 0.50
          and w.status in ('completed', 'ready_for_collection', 'collected')
          and not exists (
            select 1 from public.quotes q
            where q.work_order_id = w.id
              and (exists (select 1 from public.payments o
                           where o.quote_id = q.id and o.kind = 'deposit'
                             and o.status in ('paid', 'partially_refunded'))
                   or exists (select 1 from public.counter_payments cp
                              where cp.quote_id = q.id and cp.kind = 'deposit'
                                and not exists (select 1 from public.counter_payment_voids v
                                                where v.counter_payment_id = cp.id)))
              and not exists (select 1 from public.quote_items i
                              join public.job_part_requests r on r.id = i.part_request_id
                              where i.quote_id = q.id and i.kind = 'part' and i.decision = 'approved'
                                and r.status in ('approved', 'ordered', 'fitted')))) as above_bill
  from public.work_order_payment_totals t
  where t.work_order_id = w.id
) b on true
cross join lateral (values
  -- Money held on a cancelled job (the Stripe kind of the same name).
  ('paid_job_cancelled', 'danger', c.received_at,
   pg_catalog.format('%s taken at the counter is held but this job is cancelled. Give it back and have an admin record it as given back, or agree with the customer how it counts.',
                     h.held),
   w.status = 'cancelled'),
  -- A counter deposit whose parts are all cancelled (the Stripe predicate).
  -- No counter paid_parts_not_fitted: D149b settles every approved part
  -- before a job leaves the open statuses.
  ('paid_parts_cancelled', 'danger', c.received_at,
   pg_catalog.format('%s taken at the counter is held but every part it was for is cancelled. Give it back and have an admin record it as given back, or agree with the customer that it counts towards the job.',
                     h.held),
   c.kind = 'deposit' and w.status <> 'cancelled'
     and not exists (select 1 from public.quote_items i
                     join public.job_part_requests r on r.id = i.part_request_id
                     where i.quote_id = c.quote_id and i.kind = 'part' and i.decision = 'approved'
                       and r.status in ('approved', 'ordered', 'fitted'))),
  -- paid_above_bill on the job's newest live counter payment, only when no
  -- Stripe payment of the job is in the paid group (else it sits there).
  ('paid_above_bill', 'danger', greatest(w.completed_at, c.received_at),
   pg_catalog.format('%s more than this job''s bill of %s has been paid. Refund the extra in Stripe, or an admin records counter money given back.',
                     b.over, b.bill),
   coalesce(b.above_bill, false)
     and not exists (select 1 from public.payments o
                     where o.work_order_id = c.work_order_id
                       and o.status in ('paid', 'partially_refunded', 'refunded'))
     and not exists (select 1 from public.counter_payments o
                     where o.work_order_id = c.work_order_id and o.id <> c.id
                       and (o.created_at, o.id) > (c.created_at, c.id)
                       and not exists (select 1 from public.counter_payment_voids v
                                       where v.counter_payment_id = o.id)))
) as x (issue, severity, since, message, hit)
where x.hit
  and not exists (select 1 from public.counter_payment_voids v where v.counter_payment_id = c.id);

comment on view public.payment_issues is
  'D159b, D161j: payment conditions needing an admin or manager, derived live (clear when their cause clears). The message is the sentence shown on the job card and in Exceptions (money as the screens print it: $1,234.50). Stripe rows (payment_id set, counter_payment_id null): paid_job_cancelled, paid_parts_cancelled, paid_parts_not_fitted (R-082, D149: a deposit paid or partly refunded whose approved parts are still approved or ordered on a completed, ready or collected job, while what it holds is more than its fitted parts'' share; the message names that unfitted share when it is less than what is held; since the later of completion and payment), paid_twice, paid_online_and_counter (D161: a Stripe deposit paid or partly refunded while its quote has a live counter deposit), amount_mismatch, refund_failed, refund_not_counted (a linked refund in another currency or mode), refund_exceeds_payment (danger); pending_unconfirmed (warning, 15 minutes after the session expired). Counter rows (payment_id null, counter_payment_id set; live counter payments only): paid_job_cancelled, paid_parts_cancelled (a counter deposit; no counter paid_parts_not_fitted, which D149b makes unreachable). paid_above_bill (danger): a completed, ready or collected job paid at least S$0.50 above its bill (held_over_total, Stripe and counter), on its newest paid Stripe payment or, with none, its newest live counter payment; only when the job has a balance payment or a live counter payment, and not beside paid_twice, paid_online_and_counter or a deposit held for cancelled parts (paid_parts_cancelled, Stripe or counter) or parts not fitted (paid_parts_not_fitted), which name the same money; once that deposit is refunded or voided, what is still above the bill shows. Security invoker over the base tables and work_order_payment_totals (no definer helper): staff through RLS.';

-- ---------------------------------------------------------------------------
-- Privileges and RLS (DATA-MODEL §15)
-- ---------------------------------------------------------------------------
revoke all on function
  private.counter_payments_immutable(),
  private.counter_payment_request_fingerprint(uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text),
  public.record_counter_payment(uuid, uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text),
  public.void_counter_payment(uuid, public.counter_void_kind, text)
from public, anon, authenticated, service_role;

-- The role check is inside (private.require_admin()).
grant execute on function
  public.record_counter_payment(uuid, uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text),
  public.void_counter_payment(uuid, public.counter_void_kind, text)
to authenticated;

alter table public.counter_payments enable row level security;
alter table public.counter_payment_voids enable row level security;

revoke all on table public.counter_payments, public.counter_payment_voids
  from public, anon, authenticated, service_role;

-- Every column except the request fingerprint; written only by the RPCs.
grant select (
  id, work_order_id, quote_id, kind, amount, currency, method, received_at, reference, note, recorded_by,
  created_at
) on table public.counter_payments to authenticated;
grant select on table public.counter_payment_voids to authenticated;

-- D154: every active staff member sees counter rows on the job card.
create policy counter_payments_select_staff on public.counter_payments
  for select to authenticated
  using ((select private.is_staff()));

create policy counter_payment_voids_select_staff on public.counter_payment_voids
  for select to authenticated
  using ((select private.is_staff()));

-- Restated for the record (create or replace keeps the grants).
revoke all on table public.quote_deposits, public.payment_issues, public.work_order_payment_totals
  from public, anon, authenticated, service_role;
grant select on table public.quote_deposits, public.payment_issues, public.work_order_payment_totals
  to authenticated;
