set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D272 MANAGERS REVIEW AND VOID COUNTER PAYMENTS (the owner, 2026-11-23:
-- "Yes, managers too"; amends D161d and D270). An active admin or manager
-- (private.can_record_refunds(), the D94 role check; no permission or
-- exception grants it) reviews a counter payment and voids one. A payment
-- an admin or manager records needs no review; one a mechanic records
-- still waits on the review list.
--
--   private.require_admin_or_manager()  42501 unless an active admin or
--                                        manager; returns the staff id.
--   record_counter_payment   re-created from 20261123000400 with
--                            needs_review = not can_record_refunds();
--                            nothing else changes.
--   review_counter_payment   re-created with require_admin_or_manager.
--   void_counter_payment     re-created from 20261014001300 with
--                            require_admin_or_manager; nothing else changes.
-- Existing rows keep their needs_review; a manager's unreviewed payment
-- stays on the list until someone presses Looks right.

create function private.require_admin_or_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_record_refunds() then
    raise exception 'admin or manager role required' using errcode = '42501';
  end if;
  return private.current_staff_id();
end;
$$;

comment on function private.require_admin_or_manager() is
  'D272: raises 42501 unless the caller is an active admin or manager (private.can_record_refunds()); returns their staff id.';

revoke all on function private.require_admin_or_manager() from public, anon, authenticated, service_role;

create or replace function public.record_counter_payment(
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
  actor uuid := private.require_staff();
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
      request_fingerprint, recorded_by, needs_review
    )
    values (
      record_counter_payment.p_id, wo.id, record_counter_payment.p_quote_id,
      (case when record_counter_payment.p_quote_id is null then 'balance' else 'deposit' end)::public.payment_kind,
      record_counter_payment.p_amount, 'SGD', record_counter_payment.p_method, received, clean_reference,
      clean_note, fingerprint, actor, not private.can_record_refunds()
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
  'D161, D270, D272: any active staff member records money taken at the counter on a job (42501 otherwise); recorded by a mechanic (not an admin or manager), it waits for an admin''s or manager''s review (needs_review). p_quote_id set: that quote''s deposit, exactly deposit_amount (counter_deposit_amount), while quote_deposits says due or refunded (deposit_not_due for none or no deposit, deposit_already_paid, deposit_processing; another job''s quote counter_payment_quote_mismatch); else a balance payment of any amount (0.01..999,999.99, 23514 counter_payments_amount_check). Refused on a cancelled job (work_order_cancelled), outside SGD (counter_payment_currency), while a Stripe payment on the job is being confirmed (counter_payment_stripe_processing), and when received_at (NULL = now) is more than 5 minutes ahead (counter_payment_in_future), before check-in or a deposit''s quote answer (counter_payment_before_job) or more than 30 days back (counter_payment_too_old). Replay-safe by p_id with a fingerprint of the request as given (counter_payment_conflict otherwise), answered under the job lock before any other check. Returns the id, replayed, and open_checkouts (open Stripe sessions of a balance or this quote''s deposit, for the app to expire). Writes counter_payment_recorded {counter_payment_id, kind, quote_id, amount, method, received_at}.';

create or replace function public.review_counter_payment(p_counter_payment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin_or_manager();
begin
  if review_counter_payment.p_counter_payment_id is null then
    raise exception 'p_counter_payment_id is required' using errcode = '22004';
  end if;
  if not exists (
    select 1 from public.counter_payments c where c.id = review_counter_payment.p_counter_payment_id
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'counter_payment_not_found',
      detail = 'That counter payment does not exist.';
  end if;
  -- Idempotent: one already reviewed, or one that needs no review, is left
  -- as it is.
  update public.counter_payments c
  set reviewed_at = pg_catalog.now(),
      reviewed_by = actor
  where c.id = review_counter_payment.p_counter_payment_id
    and c.needs_review and c.reviewed_at is null;
end;
$$;

comment on function public.review_counter_payment(uuid) is
  'D270, D272: an active admin or manager confirms a counter payment a mechanic recorded (42501 otherwise), taking it off the review list: reviewed_at and reviewed_by, set once. Idempotent (already reviewed, or one that needs no review: nothing changes); counter_payment_not_found (P0002). Changes no money and no total.';

create or replace function public.void_counter_payment(
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
  actor uuid := private.require_admin_or_manager();
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
  'D161d, D272: an active admin or manager voids a counter payment (42501 otherwise), on any job status, with a kind (recorded_in_error or given_back) and a reason (reason_required, reason_too_long); counter_payment_not_found (P0002). One void per payment: the same kind and reason again is replayed, anything else counter_payment_already_voided. Takes the job lock, then the row. BICII moves no money: given_back records cash handed back outside BICII. Writes counter_payment_voided {counter_payment_id, kind, quote_id, amount, method, void_kind, reason}.';

comment on column public.counter_payments.needs_review is
  'D270, D272: recorded by an active staff member who is not an admin or manager; listed for an admin or manager to review (reviewed_at) until reviewed or voided. Set at insert, never changed.';
