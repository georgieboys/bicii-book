set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D271 DISCOUNTS (the owner, 2026-11-23; amends D14 "no negative-price or
-- discount lines"; D1 Cult Commons math unchanged). Any active staff member
-- may take an amount off a job (a discount or a round-off) with a reason,
-- at most the job's total. There is still no negative or discount line: the
-- amount is spread over the job's chargeable lines (live, total above zero:
-- parts, services and manual lines) as new sale prices, so every line's
-- yield and Cult Commons share is computed on what was actually charged.
--
--   * Allocation: each line gives its share of the amount (its total over
--     the job's total), each new unit price to the cent; the rounding
--     remainder goes on the largest line that can take it exactly, so the
--     job total drops by exactly the amount. Prices never go up and never
--     below zero. Only when no line can take the last cents (every line is
--     a quantity whose multiples skip them, e.g. 2 x 10.00 less 0.01) does
--     the applied amount differ; the preview shows it first.
--   * The prices change in place through private.reprice_line (D248's one
--     writer of a line's new price): the line, its stock movement, its
--     unit, its consignment item and its consignor payout snapshot stay as
--     they are, so the product history shows nothing new. A consigned part
--     may be sold below what is owed to its consignor; the preview flags it
--     (below_consignor) and the payout does not change.
--   * Build packages (D247-D261): the package's own lines (its parts that
--     are not extras, and its labour line) take their share like any other
--     line; the job's package price drops by what they gave and its labour
--     amount by what the labour line gave, so the package still adds up and
--     a later fit_build_to_budget keeps the discount and its split.
--     Extras, other services and manual lines are ordinary lines.
--   * Open jobs directly. Completed and ready-for-collection jobs are
--     reopened, discounted and completed again in the same transaction
--     (set_work_order_status; the reopen note is filled automatically), and
--     put back to ready when they were ready. As with any reopen (D15),
--     the job is then recognised on the shop day of this completion, and
--     the reopen's own checks apply (bike_with_customer, consignor_archived).
--     Collected and cancelled jobs are refused (discount_job_closed): the
--     money has been taken.
--   * Money already taken is not a block: the plan says how much would be
--     above the new total (paid, paid_over) and whether a live payment
--     link is withdrawn (withdraws_link).
--   * Replay-safe by request id (work_order_discounts.id).
--
--   public.preview_job_discount  what a discount would do, no writes.
--   public.apply_job_discount    the discount.

-- Used only inside function bodies below, never in this transaction.
alter type public.work_order_event_type add value if not exists 'discount_applied';

-- A package's price may be discounted down to zero (D271).
alter table public.work_order_builds
  drop constraint work_order_builds_price_positive,
  add constraint work_order_builds_price_not_negative check (price >= 0);

comment on table public.work_order_builds is
  'D247: the job''s build package with its price and labour amount at the time it was set, and the job''s labour line. Written only by set_work_order_build, clear_work_order_build, link_build_order and apply_job_discount (D271: the price drops by what the package''s lines gave).';

-- ---------------------------------------------------------------------------
-- work_order_discounts
-- ---------------------------------------------------------------------------
create table public.work_order_discounts (
  -- Client-supplied: the idempotency key of the discount.
  id uuid primary key,
  work_order_id uuid not null references public.work_orders (id) on delete restrict,
  amount public.money_amount not null,
  applied_amount public.money_amount not null,
  reason text not null,
  total_before public.money_amount not null,
  total_after public.money_amount not null,
  currency char(3) not null,
  -- The job was completed or ready and was reopened and completed again.
  reopened boolean not null default false,
  -- What apply_job_discount returned, for a replay.
  result jsonb not null,
  created_by uuid null references public.staff (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint work_order_discounts_amount_check check (amount > 0),
  constraint work_order_discounts_applied_check check (applied_amount > 0 and applied_amount <= total_before),
  constraint work_order_discounts_reason_check check (
    pg_catalog.btrim(reason) <> '' and pg_catalog.char_length(reason) <= 300
  ),
  constraint work_order_discounts_currency_check check (currency ~ '^[A-Z]{3}$')
);

create index work_order_discounts_work_order_id_idx on public.work_order_discounts (work_order_id);
create index work_order_discounts_created_by_idx on public.work_order_discounts (created_by);

comment on table public.work_order_discounts is
  'D271: each discount or round-off given on a job, with its reason and the job total before and after. Written only by apply_job_discount; the line prices themselves are on work_order_line_items.';

alter table public.work_order_discounts enable row level security;
revoke all on table public.work_order_discounts from public, anon, authenticated;
grant select on table public.work_order_discounts to authenticated;
grant select on table public.work_order_discounts to service_role;

create policy work_order_discounts_select_staff on public.work_order_discounts
  for select to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- The plan: each chargeable line's new price
-- ---------------------------------------------------------------------------
create function private.plan_job_discount(wo public.work_orders, amount numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ids uuid[];
  qs numeric[];
  ps numeric[];
  ss numeric[];
  pays numeric[];
  descs text[];
  kinds text[];
  np numeric[] := '{}';
  na numeric[] := '{}';
  n integer;
  total numeric;
  r numeric;
  want numeric;
  cand numeric;
  delta numeric;
  i integer;
  k integer;
  lines jsonb := '[]'::jsonb;
  applied numeric;
  paid numeric;
begin
  if plan_job_discount.amount is null or plan_job_discount.amount <= 0 then
    raise exception using errcode = 'P0001', message = 'discount_not_positive',
      detail = 'Take off an amount above zero.';
  end if;

  -- Largest line first: it takes the rounding remainder.
  select coalesce(pg_catalog.array_agg(l.id order by l.sale_total desc, l.id), '{}'),
         pg_catalog.array_agg(l.quantity::numeric order by l.sale_total desc, l.id),
         pg_catalog.array_agg(l.unit_sale_price_snapshot::numeric order by l.sale_total desc, l.id),
         pg_catalog.array_agg(l.sale_total::numeric order by l.sale_total desc, l.id),
         pg_catalog.array_agg(l.consignor_payout_snapshot::numeric order by l.sale_total desc, l.id),
         pg_catalog.array_agg(l.description_snapshot order by l.sale_total desc, l.id),
         pg_catalog.array_agg(l.line_type::text order by l.sale_total desc, l.id),
         coalesce(sum(l.sale_total), 0)
  into ids, qs, ps, ss, pays, descs, kinds, total
  from public.work_order_line_items l
  where l.work_order_id = wo.id and l.voided_at is null and l.sale_total > 0;
  n := coalesce(pg_catalog.cardinality(ids), 0);

  if plan_job_discount.amount > total then
    raise exception using errcode = 'P0001', message = 'discount_over_total',
      detail = pg_catalog.format('The most this job can take off is %s %s, its total.', wo.currency, total);
  end if;

  -- Each line's share, to the cent, never above its price.
  for i in 1 .. n loop
    if plan_job_discount.amount = total then
      np[i] := 0;
    else
      np[i] := round(round(ss[i] - plan_job_discount.amount * ss[i] / total, 2) / qs[i], 2);
      np[i] := greatest(least(np[i], ps[i]), 0);
    end if;
    na[i] := round(qs[i] * np[i], 2);
  end loop;

  r := (total - plan_job_discount.amount) - coalesce((select sum(x) from pg_catalog.unnest(na) x), 0);

  -- The remainder on the largest line that can take it exactly.
  if r <> 0 then
    for i in 1 .. n loop
      want := na[i] + r;
      continue when want < 0 or want > ss[i];
      foreach k in array array[0, -1, 1] loop
        cand := round(want / qs[i], 2) + k * 0.01;
        if cand >= 0 and cand <= ps[i] and round(qs[i] * cand, 2) = want then
          np[i] := cand;
          na[i] := want;
          r := 0;
          exit;
        end if;
      end loop;
      exit when r = 0;
    end loop;
  end if;

  -- No single line can: get as close as the lines allow.
  if r <> 0 then
    for i in 1 .. n loop
      cand := greatest(least(round((na[i] + r) / qs[i], 2), ps[i]), 0);
      delta := round(qs[i] * cand, 2) - na[i];
      if abs(r - delta) < abs(r) then
        np[i] := cand;
        na[i] := na[i] + delta;
        r := r - delta;
      end if;
      exit when r = 0;
    end loop;
  end if;

  applied := total - coalesce((select sum(x) from pg_catalog.unnest(na) x), 0);

  -- Money already taken (deposits, online and counter payments, build
  -- orders): the sheet says what would be above the new bill. Not a block.
  select t.net_paid into paid from public.work_order_payment_totals t where t.work_order_id = wo.id;
  paid := coalesce(paid, 0);

  for i in 1 .. n loop
    lines := lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'line_id', ids[i],
      'description', descs[i],
      'line_type', kinds[i],
      'quantity', qs[i]::text,
      'from_price', ps[i]::public.money_amount::text,
      'to_price', np[i]::public.money_amount::text,
      'from_total', ss[i]::public.money_amount::text,
      'to_total', na[i]::public.money_amount::text,
      'below_consignor', pays[i] is not null and np[i] < pays[i]
    ));
  end loop;

  return pg_catalog.jsonb_build_object(
    'currency', wo.currency,
    'total_before', total::public.money_amount::text,
    'amount', plan_job_discount.amount::public.money_amount::text,
    'applied', applied::public.money_amount::text,
    'total_after', (total - applied)::public.money_amount::text,
    'reopens', not private.work_order_status_is_open(wo.status),
    'paid', paid::public.money_amount::text,
    'paid_over', greatest(paid - (total - applied), 0)::public.money_amount::text,
    -- A reopen withdraws the job's live payment link (D156d).
    'withdraws_link', not private.work_order_status_is_open(wo.status) and exists (
      select 1 from public.balance_links b where b.work_order_id = wo.id and b.withdrawn_at is null
    ),
    'lines', lines
  );
end;
$$;

revoke all on function private.plan_job_discount(public.work_orders, numeric)
  from public, anon, authenticated, service_role;

-- collected and cancelled jobs cannot take a discount.
create function private.require_discountable(wo public.work_orders)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if wo.status in ('collected', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'discount_job_closed',
      detail = 'This job is collected or cancelled; the money has been taken, so give a refund instead.';
  end if;
end;
$$;

revoke all on function private.require_discountable(public.work_orders)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- preview_job_discount
-- ---------------------------------------------------------------------------
create function public.preview_job_discount(work_order_id uuid, amount public.money_amount)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  wo public.work_orders;
begin
  if preview_job_discount.work_order_id is null or preview_job_discount.amount is null then
    raise exception 'work_order_id and amount are required' using errcode = '22004';
  end if;
  select w.* into wo from public.work_orders w where w.id = preview_job_discount.work_order_id;
  if not found then
    raise exception 'work order % not found', preview_job_discount.work_order_id using errcode = 'P0002';
  end if;
  perform private.require_discountable(wo);
  return private.plan_job_discount(wo, preview_job_discount.amount);
end;
$$;

comment on function public.preview_job_discount(uuid, public.money_amount) is
  'D271: active staff: what apply_job_discount would do to the job (each chargeable line''s new unit price and total, below_consignor when a consigned part would sell below what its consignor is owed, the applied amount and the totals, reopens for a completed or ready job, paid and paid_over (what the job has taken and how much of it would be above the new total), withdraws_link when the reopen withdraws a live payment link). No writes.';

revoke all on function public.preview_job_discount(uuid, public.money_amount)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_job_discount(uuid, public.money_amount) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_job_discount
-- ---------------------------------------------------------------------------
create function public.apply_job_discount(
  request_id uuid,
  work_order_id uuid,
  amount public.money_amount,
  reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_staff();
  cleaned text := nullif(pg_catalog.btrim(coalesce(apply_job_discount.reason, '')), '');
  wo public.work_orders;
  prior public.work_order_discounts;
  was public.work_order_status;
  reopened boolean;
  plan jsonb;
  li jsonb;
  changed jsonb := '[]'::jsonb;
  build public.work_order_builds;
  pkg_share numeric := 0;
  labour_share numeric := 0;
  result jsonb;
begin
  if apply_job_discount.request_id is null or apply_job_discount.work_order_id is null
     or apply_job_discount.amount is null then
    raise exception 'request_id, work_order_id and amount are required' using errcode = '22004';
  end if;

  wo := private.lock_work_order(apply_job_discount.work_order_id);

  -- Replay: the same request returns what it did the first time.
  select d.* into prior from public.work_order_discounts d where d.id = apply_job_discount.request_id;
  if found then
    if prior.work_order_id = wo.id and prior.amount = apply_job_discount.amount
       and prior.reason = cleaned then
      return prior.result || pg_catalog.jsonb_build_object('replayed', true);
    end if;
    raise exception using errcode = 'P0001', message = 'discount_request_conflict',
      detail = 'This discount was already given with other details.';
  end if;

  if cleaned is null then
    raise exception using errcode = 'P0001', message = 'reason_required',
      detail = 'Say why the job is discounted.';
  end if;
  if pg_catalog.char_length(cleaned) > 300 then
    raise exception using errcode = 'P0001', message = 'discount_reason_too_long',
      detail = 'Keep the reason under 300 characters.';
  end if;
  perform private.require_discountable(wo);

  plan := private.plan_job_discount(wo, apply_job_discount.amount);
  if (plan ->> 'applied')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'discount_too_small',
      detail = 'The job''s lines come in quantities that cannot take this little off; take off a little more.';
  end if;

  was := wo.status;
  reopened := not private.work_order_status_is_open(was);
  if reopened then
    perform public.set_work_order_status(wo.id, 'in_progress', 'Reopened to give a discount: ' || cleaned);
  end if;

  -- Lines in id order, after the job (the lock-order contract).
  perform 1 from public.work_order_line_items l
  where l.work_order_id = wo.id and l.voided_at is null
  order by l.id
  for update;

  for li in select x from pg_catalog.jsonb_array_elements(plan -> 'lines') x loop
    if (li ->> 'to_price')::numeric <> (li ->> 'from_price')::numeric then
      perform private.reprice_line((li ->> 'line_id')::uuid, (li ->> 'to_price')::public.money_amount);
      changed := changed || pg_catalog.jsonb_build_array(li);
    end if;
  end loop;

  -- A build package still adds up: its price drops by what its lines gave,
  -- and its labour amount by what the labour line gave, so the parts
  -- budget drops by what the parts gave and a later fit keeps the split.
  select b.* into build from public.work_order_builds b where b.work_order_id = wo.id for update;
  if found then
    select coalesce(sum((x ->> 'from_total')::numeric - (x ->> 'to_total')::numeric), 0),
           coalesce(sum((x ->> 'from_total')::numeric - (x ->> 'to_total')::numeric)
                    filter (where l.id = build.labour_line_id), 0)
    into pkg_share, labour_share
    from pg_catalog.jsonb_array_elements(changed) x
    join public.work_order_line_items l on l.id = (x ->> 'line_id')::uuid
    where l.id = build.labour_line_id
       or (l.line_type = 'inventory'
           and not exists (select 1 from public.work_order_build_extras e where e.line_id = l.id));
    if pkg_share > 0 then
      update public.work_order_builds b
      set price = greatest(b.price - pkg_share, 0),
          labour_amount = greatest(least(b.labour_amount - labour_share, b.price - pkg_share), 0)
      where b.work_order_id = wo.id;
    end if;
  end if;

  perform private.record_work_order_event(
    wo.id, 'discount_applied',
    pg_catalog.jsonb_build_object(
      'discount_id', apply_job_discount.request_id,
      'amount', plan -> 'applied',
      'reason', cleaned,
      'total_before', plan -> 'total_before',
      'total_after', plan -> 'total_after',
      'currency', wo.currency,
      'lines', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'line_id', x -> 'line_id',
          'description', x -> 'description',
          'quantity', x -> 'quantity',
          'from_price', x -> 'from_price',
          'to_price', x -> 'to_price'
        )), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(changed) x
      )
    )
  );

  if reopened then
    perform public.set_work_order_status(wo.id, 'completed', null);
    if was = 'ready_for_collection' then
      perform public.set_work_order_status(wo.id, 'ready_for_collection', null);
    end if;
  end if;

  result := (plan - 'reopens') || pg_catalog.jsonb_build_object(
    'discount_id', apply_job_discount.request_id,
    'reason', cleaned,
    'reopened', reopened,
    'changed_count', pg_catalog.jsonb_array_length(changed),
    'replayed', false
  );

  insert into public.work_order_discounts (
    id, work_order_id, amount, applied_amount, reason, total_before, total_after,
    currency, reopened, result, created_by
  )
  values (
    apply_job_discount.request_id, wo.id, apply_job_discount.amount,
    (plan ->> 'applied')::public.money_amount, cleaned,
    (plan ->> 'total_before')::public.money_amount, (plan ->> 'total_after')::public.money_amount,
    wo.currency, reopened, result, actor
  );

  return result;
end;
$$;

comment on function public.apply_job_discount(uuid, uuid, public.money_amount, text) is
  'D271: active staff: take amount (above zero, at most the job total) off an open, completed or ready job with a reason (at most 300 characters), spread over its chargeable lines as new sale prices (private.plan_job_discount; the remainder on the largest line so the total drops by exactly the amount when the quantities allow). Lines keep their stock, unit, consignment item and payout; a build''s package price drops by what its lines gave. A completed or ready job is reopened and completed again (and put back to ready). discount_applied event; work_order_discounts row. Replay-safe by request_id.';

revoke all on function public.apply_job_discount(uuid, uuid, public.money_amount, text)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_job_discount(uuid, uuid, public.money_amount, text) to authenticated;
