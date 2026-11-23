set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D270 STAFF COUNTER PAYMENTS (the owner, 2026-11-23: operators,
-- mechanics and managers finish what they are doing in place; amends
-- D161a). Any active staff member records money the shop took at the
-- counter on a job (cash, card, PayNow, bank transfer, other), a quote's
-- deposit included; a payment recorded by someone who is not an admin is
-- listed for an admin to review ("Looks right"). Voiding stays admin only
-- (void_counter_payment unchanged); refunds are unchanged (D94).
--
--   counter_payments.needs_review    set at insert: the recorder was not
--                                    an admin. Existing rows (all recorded
--                                    by admins) read false.
--   counter_payments.reviewed_at/by  an admin's review, set once.
--   counter_payments_immutable       re-created: the one update it lets
--                                    through is that review (reviewed_at
--                                    and reviewed_by from null, nothing
--                                    else); every other change still
--                                    raises counter_payment_immutable.
--   record_counter_payment           re-created from 20261014001300 with
--                                    private.require_staff() and
--                                    needs_review; nothing else changes.
--                                    A deposit still settles the quote's
--                                    deposit through quote_deposits in the
--                                    same transaction, so the quote page
--                                    reads it paid at once.
--   review_counter_payment           admins only, idempotent.
--
-- Lock order (DATA-MODEL §19): review_counter_payment takes only the
-- counter row (FOR UPDATE through its UPDATE); it changes no money and no
-- view counts it, so it needs no job lock.

alter table public.counter_payments
  add column needs_review boolean not null default false,
  add column reviewed_at timestamptz null,
  add column reviewed_by uuid null references public.staff (id) on delete restrict,
  add constraint counter_payments_review_check check ((reviewed_at is null) = (reviewed_by is null));

comment on column public.counter_payments.needs_review is
  'D270: recorded by an active staff member who is not an admin; listed for an admin to review (reviewed_at) until reviewed or voided. Set at insert, never changed.';
comment on column public.counter_payments.reviewed_at is
  'D270: when an admin reviewed the payment (review_counter_payment), with reviewed_by; set once.';

create index counter_payments_to_review_idx
  on public.counter_payments (created_at)
  where needs_review and reviewed_at is null;
create index counter_payments_reviewed_by_idx
  on public.counter_payments (reviewed_by) where reviewed_by is not null;

comment on table public.counter_payments is
  'D161, D270: money the shop took at the counter on a job, recorded by any active staff member (record_counter_payment); one recorded by someone who is not an admin waits for an admin''s review (needs_review, reviewed_at). kind deposit (quote_id set) settles that quote''s deposit, exactly its amount (D161f); kind balance counts towards the bill. Money held, not revenue (D154). Append-only for every role (counter_payment_immutable) apart from the review, set once; corrected only by a counter_payment_voids row. Staff read it (never request_fingerprint); customers and anon read nothing; no API role writes.';

-- Readable like the row's other columns (never the fingerprint).
grant select (needs_review, reviewed_at, reviewed_by) on table public.counter_payments to authenticated;

-- ---------------------------------------------------------------------------
-- The append-only guard, with the review let through
-- ---------------------------------------------------------------------------
create or replace function private.counter_payments_immutable()
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
  -- D270: the one change a counter payment takes, once: an admin's review
  -- (reviewed_at and reviewed_by set from null, nothing else touched).
  if tg_op = 'UPDATE' and tg_table_name = 'counter_payments' then
    if old.reviewed_at is null and new.reviewed_at is not null and new.reviewed_by is not null
       and (pg_catalog.to_jsonb(new) - 'reviewed_at' - 'reviewed_by')
           = (pg_catalog.to_jsonb(old) - 'reviewed_at' - 'reviewed_by') then
      return new;
    end if;
  end if;
  raise exception using
    errcode = 'P0001',
    message = 'counter_payment_immutable',
    detail = 'A counter payment and its void are never changed or deleted; void it with a reason and record it again.';
end;
$$;

comment on function private.counter_payments_immutable() is
  'D161c/d, D270: BEFORE INSERT OR UPDATE OR DELETE on counter_payments and BEFORE UPDATE OR DELETE on counter_payment_voids, for every role: an update or delete raises counter_payment_immutable, except the one review of a counter payment (reviewed_at and reviewed_by set from null, every other column unchanged); a deposit''s quote must be on its job (counter_payment_quote_mismatch). Owner-only.';

-- ---------------------------------------------------------------------------
-- D270: record_counter_payment for any active staff member
-- ---------------------------------------------------------------------------
-- 20261014001300's function with private.require_staff() in place of
-- private.require_admin() and needs_review (not private.is_admin()) on
-- the insert; its order, checks, replay and lock order are unchanged.
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
      clean_note, fingerprint, actor, not private.is_admin()
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
  'D161, D270: any active staff member records money taken at the counter on a job (42501 otherwise); recorded by someone who is not an admin, it waits for an admin''s review (needs_review). p_quote_id set: that quote''s deposit, exactly deposit_amount (counter_deposit_amount), while quote_deposits says due or refunded (deposit_not_due for none or no deposit, deposit_already_paid, deposit_processing; another job''s quote counter_payment_quote_mismatch); else a balance payment of any amount (0.01..999,999.99, 23514 counter_payments_amount_check). Refused on a cancelled job (work_order_cancelled), outside SGD (counter_payment_currency), while a Stripe payment on the job is being confirmed (counter_payment_stripe_processing), and when received_at (NULL = now) is more than 5 minutes ahead (counter_payment_in_future), before check-in or a deposit''s quote answer (counter_payment_before_job) or more than 30 days back (counter_payment_too_old). Replay-safe by p_id with a fingerprint of the request as given (counter_payment_conflict otherwise), answered under the job lock before any other check. Returns the id, replayed, and open_checkouts (open Stripe sessions of a balance or this quote''s deposit, for the app to expire). Writes counter_payment_recorded {counter_payment_id, kind, quote_id, amount, method, received_at}.';

-- ---------------------------------------------------------------------------
-- D270: review_counter_payment (admins only)
-- ---------------------------------------------------------------------------
create function public.review_counter_payment(p_counter_payment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
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
  'D270: an active admin confirms a counter payment recorded by someone who is not an admin (42501 otherwise), taking it off the review list: reviewed_at and reviewed_by, set once. Idempotent (already reviewed, or one that needs no review: nothing changes); counter_payment_not_found (P0002). Changes no money and no total.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.counter_payments_immutable(),
  public.record_counter_payment(uuid, uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text),
  public.review_counter_payment(uuid)
from public, anon, authenticated, service_role;

-- The role checks are inside (require_staff, require_admin).
grant execute on function
  public.record_counter_payment(uuid, uuid, uuid, public.money_amount, public.counter_payment_method, timestamptz, text, text),
  public.review_counter_payment(uuid)
to authenticated;
