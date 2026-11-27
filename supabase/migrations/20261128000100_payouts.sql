set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D276 MONTH-END PAYOUTS (the owner, 2026-11-28: "i want a simple system
-- to tell me how much do i owe bobby for service, consigners for stuff.
-- cult commons etc. Then i can transfer and record the payments."). PLAN
-- §6 D276, ADR-030, DATA-MODEL §19 "Month-end payouts", R-137.
--
-- What is owed is derived live and never stored; what was paid is recorded
-- here, append-only. Nothing in this migration changes a line, a snapshot,
-- yield, Cult Commons or any existing figure: mechanic pay and the
-- services reserve are BICII's money after Cult Commons.
--
-- Per shop month m (Asia/Singapore, the sale date basis, D32/D100):
--   service after CC (mechanic s, m)
--        = Σ (sale_total - cult_commons_share) over recognised service
--          lines (financial_lines source work_order, entry_kind line,
--          line_type service) recognised in m on jobs led by s
--   cap(s, m) = the monthly_cap of s's latest service_pay_rules row with
--          effective_from <= m (none: s has no pay rule in m)
--   pay(s, m)       = greatest(least(service after CC, cap), 0)  (no rule: 0)
--   to reserve(s,m) = service after CC - pay   (no rule or no lead: all of it)
--   Cult Commons owed (m) = Σ cult_commons_share over private.report_rows
--          for m on the sale basis: exactly what report_period_summary
--          returns for the month (net of the D273/D274 fees).
--   outstanding = owed - Σ non-reversed payouts against m (may be < 0:
--          "Over by"); carry-over = Σ outstanding of the tracked months
--          before m; reserve balance = Σ to reserve - Σ reserve payouts.
-- Tracking starts at the first month of the earliest service pay rule
-- (build default, owner to confirm): earlier months were settled outside
-- the app and never carry over, into owed or into the reserve. Payouts
-- never move it (one recorded for an old month, or reversed, changes no
-- carry-over); only with no pay rule at all does the earliest non-reversed
-- payout's month stand in.
--
-- Access: admin only (private.is_admin / require_admin), to read and to
-- write. A manager, a mechanic, a customer and anon read nothing and call
-- nothing (build default, owner to confirm).
--
-- The request fingerprint of a payout is md5 of the canonical JSON
--   {"kind", "amount": "3000.00", "period_month": "YYYY-MM-DD",
--    "staff_id"|null, "payee_name": trimmed|null,
--    "paid_at": "...Z"|null, "reference": trimmed|null, "notes": trimmed|null}
-- as record_settlement's: amounts as money_amount text, paid_at as given in
-- UTC, NULL staying NULL.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create type public.payout_kind as enum ('mechanic_pay', 'cult_commons', 'reserve_labour');

comment on type public.payout_kind is
  'D276: what a payout pays: a mechanic''s service pay for a month, the month''s Cult Commons, or ad hoc labour from the services reserve.';

create table public.service_pay_rules (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete restrict,
  monthly_cap public.money_amount not null,
  -- The first month the cap applies to (the first of a month).
  effective_from date not null,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint service_pay_rules_monthly_cap_check check (monthly_cap >= 0),
  constraint service_pay_rules_effective_from_check check (extract(day from effective_from) = 1)
);
create index service_pay_rules_staff_from_idx on public.service_pay_rules (staff_id, effective_from desc, created_at desc);
create index service_pay_rules_created_by_idx on public.service_pay_rules (created_by);

comment on table public.service_pay_rules is
  'D276: a mechanic''s monthly cap on service pay from a month on. The rule in force for a month is the latest effective_from <= that month (ties: the newest row). Append-only: a change is a new row, so earlier months keep their cap. Admins only.';

create table public.payouts (
  -- Client-supplied: the payout's idempotency key.
  id uuid primary key,
  kind public.payout_kind not null,
  -- The month the payout is for (the first of a month); for reserve
  -- labour, the month it was paid in.
  period_month date not null,
  -- mechanic_pay: the mechanic; reserve_labour: the staff member paid, or
  -- payee_name for someone who is not staff.
  staff_id uuid null references public.staff (id) on delete restrict,
  payee_name text null,
  amount public.money_amount not null,
  currency char(3) not null,
  paid_at timestamptz not null,
  reference text null,
  notes text null,
  -- The request's fingerprint (idempotency); never shown.
  request_fingerprint text null,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint payouts_amount_check check (amount > 0),
  constraint payouts_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payouts_period_month_check check (extract(day from period_month) = 1),
  constraint payouts_payee_check check (
    (kind = 'mechanic_pay' and staff_id is not null and payee_name is null)
    or (kind = 'cult_commons' and staff_id is null and payee_name is null)
    or (kind = 'reserve_labour' and ((staff_id is null) <> (payee_name is null)))
  ),
  constraint payouts_payee_name_check check (
    payee_name is null
    or (pg_catalog.btrim(payee_name) <> '' and pg_catalog.char_length(payee_name) <= 200)
  ),
  constraint payouts_reference_check check (pg_catalog.char_length(reference) <= 200),
  constraint payouts_notes_check check (pg_catalog.char_length(notes) <= 2000)
);
create index payouts_kind_month_idx on public.payouts (kind, period_month);
create index payouts_staff_id_idx on public.payouts (staff_id);
create index payouts_created_by_idx on public.payouts (created_by);

comment on table public.payouts is
  'D276: money the owner paid out at month end: a mechanic''s service pay, the month''s Cult Commons, or ad hoc labour from the services reserve. Append-only; corrected by a reversal (payout_reversals). Admins only.';

create table public.payout_reversals (
  payout_id uuid primary key references public.payouts (id) on delete restrict,
  reason text not null,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint payout_reversals_reason_check check (
    pg_catalog.btrim(reason) <> '' and pg_catalog.char_length(reason) <= 500
  )
);
create index payout_reversals_created_by_idx on public.payout_reversals (created_by);

comment on table public.payout_reversals is
  'D276: the correction of a payout: the payout stays, nothing counts it. At most one per payout; append-only. Admins only.';

-- Append-only, for every writer. Inserts are trimmed and stamped.
create function private.payouts_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if tg_table_name = 'payouts' then
      new.payee_name := nullif(pg_catalog.btrim(new.payee_name), '');
      new.reference := nullif(pg_catalog.btrim(new.reference), '');
      new.notes := nullif(pg_catalog.btrim(new.notes), '');
    elsif tg_table_name = 'payout_reversals' then
      new.reason := pg_catalog.btrim(new.reason);
    end if;
    new.created_by := coalesce(new.created_by, private.current_staff_id());
    return new;
  end if;
  raise exception using
    errcode = 'P0001',
    message = 'payout_immutable',
    detail = 'A payout or pay rule cannot be edited or deleted; reverse the payout, or set a new rule.';
end;
$$;

create trigger payout_immutable
  before insert or update or delete on public.payouts
  for each row execute function private.payouts_immutable();
create trigger payout_immutable
  before insert or update or delete on public.payout_reversals
  for each row execute function private.payouts_immutable();
create trigger payout_immutable
  before insert or update or delete on public.service_pay_rules
  for each row execute function private.payouts_immutable();

-- ---------------------------------------------------------------------------
-- set_service_pay_rule (admin)
-- ---------------------------------------------------------------------------
create function public.set_service_pay_rule(
  p_staff_id uuid,
  p_monthly_cap public.money_amount,
  p_effective_from date
)
returns public.service_pay_rules
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  v_from date;
  current_rule public.service_pay_rules;
  inserted public.service_pay_rules;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  if p_staff_id is null or p_monthly_cap is null or p_effective_from is null then
    raise exception 'p_staff_id, p_monthly_cap and p_effective_from are required' using errcode = '22004';
  end if;
  if not exists (select 1 from public.staff s where s.id = p_staff_id) then
    raise exception 'staff % not found', p_staff_id using errcode = 'P0002';
  end if;
  v_from := pg_catalog.date_trunc('month', p_effective_from::timestamp)::date;
  -- A repeat of the rule already in force for that month changes nothing.
  select r.* into current_rule
  from public.service_pay_rules r
  where r.staff_id = p_staff_id and r.effective_from = v_from
  order by r.created_at desc, r.id desc
  limit 1;
  if found and current_rule.monthly_cap = p_monthly_cap then
    return current_rule;
  end if;
  begin
    insert into public.service_pay_rules as r (staff_id, monthly_cap, effective_from, created_by)
    values (p_staff_id, p_monthly_cap, v_from, actor)
    returning r.* into inserted;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  return inserted;
end;
$$;

comment on function public.set_service_pay_rule(uuid, public.money_amount, date) is
  'Admin (D276): a mechanic''s monthly service pay cap from a month on (the date is taken to its month). A new row each time, so earlier months keep their cap; repeating the rule in force for that month returns it.';

-- ---------------------------------------------------------------------------
-- record_payout (admin)
-- ---------------------------------------------------------------------------
create function private.payout_request_fingerprint(
  kind public.payout_kind,
  amount public.money_amount,
  period_month date,
  staff_id uuid,
  payee_name text,
  paid_at timestamptz,
  reference text,
  notes text
)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'kind', payout_request_fingerprint.kind::text,
      'amount', payout_request_fingerprint.amount::text,
      'period_month', payout_request_fingerprint.period_month::text,
      'staff_id', payout_request_fingerprint.staff_id,
      'payee_name', nullif(pg_catalog.btrim(payout_request_fingerprint.payee_name), ''),
      'paid_at', pg_catalog.to_char(
        payout_request_fingerprint.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'reference', nullif(pg_catalog.btrim(payout_request_fingerprint.reference), ''),
      'notes', nullif(pg_catalog.btrim(payout_request_fingerprint.notes), '')
    )::text
  );
$$;

create function public.record_payout(
  p_id uuid,
  p_kind public.payout_kind,
  p_amount public.money_amount,
  p_period_month date default null,
  p_staff_id uuid default null,
  p_payee_name text default null,
  p_paid_at timestamptz default null,
  p_reference text default null,
  p_notes text default null
)
returns table (payout_id uuid, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_admin();
  v_payee text := nullif(pg_catalog.btrim(p_payee_name), '');
  v_month date;
  fingerprint text;
  header public.payouts;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  -- (1) Shape.
  if p_id is null or p_kind is null or p_amount is null then
    raise exception 'p_id, p_kind and p_amount are required' using errcode = '22004';
  end if;
  if p_paid_at > pg_catalog.now() + interval '5 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'payout_paid_in_future',
      detail = 'A payment cannot be dated in the future.';
  end if;
  if p_kind = 'reserve_labour' then
    v_month := pg_catalog.date_trunc(
      'month', coalesce(p_period_month, private.shop_day(coalesce(p_paid_at, pg_catalog.now())))::timestamp
    )::date;
  elsif p_period_month is null then
    raise exception using
      errcode = 'P0001',
      message = 'payout_month_required',
      detail = 'Choose the month this payment is for.';
  else
    v_month := pg_catalog.date_trunc('month', p_period_month::timestamp)::date;
  end if;
  if (p_kind = 'mechanic_pay' and (p_staff_id is null or v_payee is not null))
     or (p_kind = 'reserve_labour' and ((p_staff_id is null) = (v_payee is null))) then
    raise exception using
      errcode = 'P0001',
      message = 'payout_payee_required',
      detail = case when p_kind = 'mechanic_pay'
                    then 'Choose the mechanic this pay is for.'
                    else 'Choose a staff member, or type the name of the person paid.' end;
  end if;
  if p_kind = 'cult_commons' and (p_staff_id is not null or v_payee is not null) then
    raise exception using
      errcode = 'P0001',
      message = 'payout_payee_unexpected',
      detail = 'A Cult Commons payment has no payee to choose.';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff s where s.id = p_staff_id) then
    raise exception 'staff % not found', p_staff_id using errcode = 'P0002';
  end if;
  fingerprint := private.payout_request_fingerprint(
    p_kind, p_amount, v_month, p_staff_id, v_payee, p_paid_at, p_reference, p_notes
  );

  -- (2) Idempotency: the request's own row.
  begin
    insert into public.payouts as p (
      id, kind, period_month, staff_id, payee_name, amount, currency, paid_at, reference, notes,
      request_fingerprint, created_by
    )
    values (
      p_id, p_kind, v_month, p_staff_id, v_payee, p_amount, private.shop_currency(),
      coalesce(p_paid_at, pg_catalog.now()), p_reference, p_notes, fingerprint, actor
    )
    on conflict (id) do nothing
    returning p.* into header;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  if header.id is null then
    select p.* into header from public.payouts p where p.id = p_id;
    if header.request_fingerprint is not distinct from fingerprint then
      return query select header.id, true;
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'payout_conflict',
      detail = 'That payment id is already used for another payment.';
  end if;
  return query select header.id, false;
end;
$$;

comment on function public.record_payout(uuid, public.payout_kind, public.money_amount, date, uuid, text, timestamptz, text, text) is
  'Admin (D276): record a month-end payment: mechanic_pay (p_staff_id, p_period_month), cult_commons (p_period_month) or reserve_labour (p_staff_id or p_payee_name; the month of p_paid_at unless given). It may be more than is outstanding (operator first). Replay-safe by id with a request fingerprint (payout_conflict otherwise).';

-- ---------------------------------------------------------------------------
-- reverse_payout (admin)
-- ---------------------------------------------------------------------------
create function public.reverse_payout(p_payout_id uuid, p_reason text)
returns public.payout_reversals
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_admin();
  cleaned text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  existing public.payout_reversals;
  inserted public.payout_reversals;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  if p_payout_id is null then
    raise exception 'p_payout_id is required' using errcode = '22004';
  end if;
  if cleaned is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why the payment is being reversed.';
  end if;
  if pg_catalog.char_length(cleaned) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;
  perform 1 from public.payouts p where p.id = p_payout_id for update;
  if not found then
    raise exception 'payout % not found', p_payout_id using errcode = 'P0002';
  end if;
  -- Reversing twice is the same reversal (replay-safe).
  select r.* into existing from public.payout_reversals r where r.payout_id = p_payout_id;
  if found then
    return existing;
  end if;
  begin
    insert into public.payout_reversals as r (payout_id, reason, created_by)
    values (p_payout_id, cleaned, actor)
    returning r.* into inserted;
  exception
    when check_violation or not_null_violation then
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  return inserted;
end;
$$;

comment on function public.reverse_payout(uuid, text) is
  'Admin (D276): reverse a payout with a reason; the payout stays and stops counting. Reversing it again returns the first reversal.';

-- ---------------------------------------------------------------------------
-- payout_summary (admin): what is owed for a month, what was paid, what is
-- still outstanding, the carry-over and the services reserve.
-- ---------------------------------------------------------------------------
create function public.payout_summary(p_month date)
returns table (
  party text,
  staff_id uuid,
  consignor_id uuid,
  display_name text,
  period_month date,
  currency text,
  service_revenue numeric,
  service_after_cc numeric,
  monthly_cap numeric,
  owed numeric,
  paid numeric,
  outstanding numeric,
  carry_over numeric,
  carry_from date,
  balance numeric,
  item_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_month date;
  v_next date;
  v_track date;
  v_start date;
  v_currency text := private.shop_currency();
begin
  perform private.require_admin();
  if p_month is null then
    raise exception 'p_month is required' using errcode = '22004';
  end if;
  v_month := pg_catalog.date_trunc('month', p_month::timestamp)::date;
  v_next := (v_month + interval '1 month')::date;
  -- Tracking starts at the earliest pay rule's month; payouts never move it
  -- (with no rule at all, the earliest non-reversed payout's month). A
  -- month before it shows its own figures and no carry-over; payouts
  -- against months before it count in those months only.
  v_track := coalesce(
    (select min(r.effective_from) from public.service_pay_rules r),
    (select min(p.period_month) from public.payouts p
     where not exists (select 1 from public.payout_reversals x where x.payout_id = p.id)),
    v_month
  );
  v_start := least(v_track, v_month);

  return query
    with r as materialized (
      -- The Reports rows (D100 sale basis), shop currency, fee entries
      -- included for an admin (view_costs): Σ cult_commons_share per month
      -- is report_period_summary's cult_commons_share.
      select pg_catalog.date_trunc('month', x.recognized_day::timestamp)::date as m,
             x.source, x.entry_kind, x.line_type, x.lead_mechanic_id,
             x.sale_total, x.cult_commons_share
      from private.report_rows(v_start, v_next - 1, 'sale') x
    ),
    svc as (
      select r.m, r.lead_mechanic_id as sid,
             sum(r.sale_total) as revenue,
             sum(r.sale_total - r.cult_commons_share) as after_cc
      from r
      where r.source = 'work_order' and r.entry_kind = 'line' and r.line_type = 'service'
      group by r.m, r.lead_mechanic_id
    ),
    rules_in_force as (
      select k.m, k.sid,
             (select pr.monthly_cap::numeric
              from public.service_pay_rules pr
              where pr.staff_id = k.sid and pr.effective_from <= k.m
              order by pr.effective_from desc, pr.created_at desc, pr.id desc
              limit 1) as cap
      from (
        select g::date as m, s.sid
        from pg_catalog.generate_series(v_start::timestamp, v_month::timestamp, interval '1 month') g
        cross join (select distinct pr.staff_id as sid from public.service_pay_rules pr) s
      ) k
    ),
    pay as (
      select s.m, s.sid, s.revenue, s.after_cc,
             case when ru.cap is null then 0.00
                  else greatest(least(s.after_cc, ru.cap), 0.00) end as pay
      from svc s
      left join rules_in_force ru on ru.m = s.m and ru.sid = s.sid
    ),
    po as (
      select p.kind, p.period_month as m, p.staff_id as sid, p.amount::numeric as amount
      from public.payouts p
      where p.period_month < v_next
        and p.period_month >= v_start
        and p.currency::text = v_currency
        and not exists (select 1 from public.payout_reversals x where x.payout_id = p.id)
    ),
    mech as (
      select pr.staff_id as sid from public.service_pay_rules pr where pr.effective_from < v_next
      union
      select po.sid from po where po.kind = 'mechanic_pay'
    ),
    mech_rows as (
      select me.sid,
             coalesce((select sum(pa.revenue) from pay pa where pa.sid = me.sid and pa.m = v_month), 0.00) as revenue,
             coalesce((select sum(pa.after_cc) from pay pa where pa.sid = me.sid and pa.m = v_month), 0.00) as after_cc,
             (select ru.cap from rules_in_force ru where ru.sid = me.sid and ru.m = v_month) as cap,
             coalesce((select sum(pa.pay) from pay pa where pa.sid = me.sid and pa.m = v_month), 0.00) as owed,
             coalesce((select sum(po.amount) from po
                       where po.kind = 'mechanic_pay' and po.sid = me.sid and po.m = v_month), 0.00) as paid,
             coalesce((select sum(pa.pay) from pay pa where pa.sid = me.sid and pa.m < v_month), 0.00)
               - coalesce((select sum(po.amount) from po
                           where po.kind = 'mechanic_pay' and po.sid = me.sid and po.m < v_month), 0.00)
               as carry,
             -- The earliest earlier month still owed (the page links to it).
             (select min(x.m) from (
                select y.m from (
                  select pa.m, pa.pay as amt from pay pa where pa.sid = me.sid and pa.m < v_month
                  union all
                  select po.m, -po.amount from po
                  where po.kind = 'mechanic_pay' and po.sid = me.sid and po.m < v_month
                ) y
                group by y.m
                having sum(y.amt) > 0
              ) x) as carry_from
      from mech me
    ),
    cc as (
      select coalesce((select sum(r.cult_commons_share) from r where r.m = v_month), 0.00) as owed,
             coalesce((select sum(po.amount) from po where po.kind = 'cult_commons' and po.m = v_month), 0.00)
               as paid,
             coalesce((select sum(r.cult_commons_share) from r where r.m < v_month), 0.00)
               - coalesce((select sum(po.amount) from po where po.kind = 'cult_commons' and po.m < v_month), 0.00)
               as carry,
             (select min(x.m) from (
                select y.m from (
                  select r.m, r.cult_commons_share as amt from r where r.m < v_month
                  union all
                  select po.m, -po.amount from po where po.kind = 'cult_commons' and po.m < v_month
                ) y
                group by y.m
                having sum(y.amt) > 0
              ) x) as carry_from
    ),
    res as (
      select coalesce((select sum(pa.after_cc - pa.pay) from pay pa where pa.m = v_month), 0.00) as added,
             coalesce((select sum(po.amount) from po where po.kind = 'reserve_labour' and po.m = v_month), 0.00)
               as paid,
             coalesce((select sum(pa.after_cc - pa.pay) from pay pa where pa.m < v_month), 0.00)
               - coalesce((select sum(po.amount) from po where po.kind = 'reserve_labour' and po.m < v_month), 0.00)
               as earlier
    ),
    cons as (
      select l.consignor_id as cid, l.display_name as name, l.outstanding as outstanding,
             l.awaiting_settlement_items as items
      from reporting.consignor_ledger l
      where l.outstanding > 0
    ),
    total as (
      select coalesce((select sum(greatest(mr.owed - mr.paid + mr.carry, 0.00)) from mech_rows mr), 0.00)
             + (select greatest(c.owed - c.paid + c.carry, 0.00) from cc c)
             + coalesce((select sum(cs.outstanding) from cons cs), 0.00) as amount
    ),
    out_rows as (
      select 1 as ord, 'mechanic'::text as party, mr.sid as staff_id, null::uuid as consignor_id,
             st.display_name::text as display_name, mr.revenue as service_revenue,
             mr.after_cc as service_after_cc, mr.cap as monthly_cap, mr.owed as owed, mr.paid as paid,
             (mr.owed - mr.paid) as outstanding, mr.carry as carry_over, mr.carry_from as carry_from,
             null::numeric as balance, null::integer as item_count
      from mech_rows mr
      join public.staff st on st.id = mr.sid
      union all
      select 2, 'cult_commons', null, null, 'Cult Commons', null, null, null, c.owed, c.paid,
             c.owed - c.paid, c.carry, c.carry_from, null, null
      from cc c
      union all
      select 3, 'reserve', null, null, 'Services reserve', null, null, null, rs.added, rs.paid, null,
             rs.earlier, null, rs.earlier + rs.added - rs.paid, null
      from res rs
      union all
      select 4, 'consignors', null, null, 'Consignors', null, null, null,
             coalesce((select sum(cs.outstanding) from cons cs), 0.00), null,
             coalesce((select sum(cs.outstanding) from cons cs), 0.00), null, null, null,
             (select count(*) from cons)::integer
      union all
      select 5, 'consignor', null, cs.cid, cs.name::text, null, null, null, cs.outstanding, null,
             cs.outstanding, null, null, null, cs.items::integer
      from cons cs
      union all
      select 6, 'total', null, null, 'Total to transfer', null, null, null, t.amount, null, t.amount,
             null, null, null, null
      from total t
    )
    select o.party, o.staff_id, o.consignor_id, o.display_name, v_month, v_currency,
           o.service_revenue, o.service_after_cc, o.monthly_cap, o.owed, o.paid, o.outstanding,
           o.carry_over, o.carry_from, o.balance, o.item_count
    from out_rows o
    order by o.ord, o.outstanding desc nulls last, o.display_name;
end;
$$;

comment on function public.payout_summary(date) is
  'Admin (D276): for the month of p_month, one row per party: mechanic (each staff member with a service pay rule from before the next month, or paid: service_revenue and service_after_cc of the service lines on jobs they led, monthly_cap in force, owed = pay, paid, outstanding = owed - paid, carry_over = earlier months'' outstanding, carry_from = the earliest earlier month still owed), cult_commons (owed = report_period_summary''s cult_commons_share for the month, net of fees; paid, outstanding, carry_over, carry_from), reserve (owed = added this month, paid = reserve labour paid this month, carry_over = the balance before, balance = after), consignors (owed = outstanding = Σ positive consignor balances now, item_count = how many), consignor (one per consignor owed, from reporting.consignor_ledger) and total (owed = outstanding = Σ greatest(outstanding + carry_over, 0) for mechanics and Cult Commons, plus the consignors). Carry-over and the reserve count from the earliest pay rule''s month (payouts never move it). Derived live, never stored: a reopened job or a back-dated sale restates the month (R-137).';

-- ---------------------------------------------------------------------------
-- list_payouts (admin): the payouts recorded for a month.
-- ---------------------------------------------------------------------------
create function public.list_payouts(p_month date)
returns table (
  id uuid,
  kind public.payout_kind,
  period_month date,
  staff_id uuid,
  payee text,
  amount numeric,
  currency text,
  paid_at timestamptz,
  reference text,
  notes text,
  created_by_name text,
  created_at timestamptz,
  reversed_at timestamptz,
  reversal_reason text,
  reversed_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_month date;
begin
  perform private.require_admin();
  if p_month is null then
    raise exception 'p_month is required' using errcode = '22004';
  end if;
  v_month := pg_catalog.date_trunc('month', p_month::timestamp)::date;
  return query
    select p.id, p.kind, p.period_month, p.staff_id,
           case p.kind
             when 'cult_commons' then 'Cult Commons'
             else coalesce(s.display_name::text, p.payee_name)
           end,
           p.amount::numeric, p.currency::text, p.paid_at, p.reference, p.notes,
           cb.display_name::text, p.created_at, x.created_at, x.reason, xb.display_name::text
    from public.payouts p
    left join public.staff s on s.id = p.staff_id
    left join public.staff cb on cb.id = p.created_by
    left join public.payout_reversals x on x.payout_id = p.id
    left join public.staff xb on xb.id = x.created_by
    where p.period_month = v_month
    order by p.paid_at desc, p.created_at desc, p.id;
end;
$$;

comment on function public.list_payouts(date) is
  'Admin (D276): the payouts recorded for the month of p_month (reserve labour: paid in it), newest first, with the payee''s name, who recorded it, and the reversal if any.';

-- ---------------------------------------------------------------------------
-- Privileges and RLS (admin only)
-- ---------------------------------------------------------------------------
revoke all on function
  private.payouts_immutable(),
  private.payout_request_fingerprint(public.payout_kind, public.money_amount, date, uuid, text, timestamptz, text, text)
from public, anon, authenticated, service_role;

revoke all on function
  public.set_service_pay_rule(uuid, public.money_amount, date),
  public.record_payout(uuid, public.payout_kind, public.money_amount, date, uuid, text, timestamptz, text, text),
  public.reverse_payout(uuid, text),
  public.payout_summary(date),
  public.list_payouts(date)
from public, anon, authenticated, service_role;

grant execute on function
  public.set_service_pay_rule(uuid, public.money_amount, date),
  public.record_payout(uuid, public.payout_kind, public.money_amount, date, uuid, text, timestamptz, text, text),
  public.reverse_payout(uuid, text),
  public.payout_summary(date),
  public.list_payouts(date)
to authenticated;

alter table public.service_pay_rules enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_reversals enable row level security;

revoke all on table public.service_pay_rules from public, anon, authenticated, service_role;
revoke all on table public.payouts from public, anon, authenticated, service_role;
revoke all on table public.payout_reversals from public, anon, authenticated, service_role;

-- Every column except the request fingerprint; written only by the RPCs.
grant select on table public.service_pay_rules to authenticated;
grant select (
  id, kind, period_month, staff_id, payee_name, amount, currency, paid_at, reference, notes,
  created_by, created_at
) on table public.payouts to authenticated;
grant select on table public.payout_reversals to authenticated;

create policy service_pay_rules_select_admin on public.service_pay_rules
  for select to authenticated
  using ((select private.is_admin()));

create policy payouts_select_admin on public.payouts
  for select to authenticated
  using ((select private.is_admin()));

create policy payout_reversals_select_admin on public.payout_reversals
  for select to authenticated
  using ((select private.is_admin()));
