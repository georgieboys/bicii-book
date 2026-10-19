-- ---------------------------------------------------------------------------
-- Refunded amounts on the customer's quote and bill pages (audit
-- 2026-10-18, U2-11; DATA-MODEL §16).
--
-- A deposit refunded in part read "Deposit of $60.00 paid", and the bill's
-- "Paid so far" was net of Stripe refunds with nothing saying so. Both
-- payloads gain one display-only key, computed here:
--
-- * private.quote_view: the answered deposit object gains `refunded`, what
--   Stripe gave back of the quote's deposit payments that still count as
--   paid (partially_refunded), 0 otherwise. Body otherwise identical to
--   20261014000700_indent_closed_jobs.
-- * public.balance_by_token: the open page gains `refunded`,
--   work_order_payment_totals.refunded_online (succeeded Stripe refunds on
--   the job), which `paid` is already net of. Body otherwise identical to
--   20261014001400_balance_links.
--
-- Nothing else changes: no state, amount, gate or grant. Neither key is a
-- Stripe id, a cost or another job's figure; both are the customer's own
-- money on the page they already see it on (D143, D156f).
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
  refunded numeric;
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
  -- refunded (U2-11): what Stripe gave back of the deposit payments that
  -- still count as paid (partly refunded), so a paid deposit can say how
  -- much of it came back; 0 otherwise. A payment refunded in full is out:
  -- its money all came back (a duplicate payment, say), and when it was
  -- the deposit, the state is refunded and says so itself.
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
      select coalesce(sum(p.refunded_amount), 0) into refunded
      from public.payments p
      where p.quote_id = quote.id and p.kind = 'deposit' and p.status = 'partially_refunded';
      deposit := pg_catalog.jsonb_build_object('percent', quote.deposit_percent,
                                               'amount', quote.deposit_amount, 'status', dstate,
                                               'parts_ordered', coalesce(ordered, false),
                                               'job_closed', not private.work_order_status_is_open(wo.status),
                                               'refunded', refunded::public.money_amount);
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
  'D143, D151, D158: what the quote page may show for one quote: never costs, notes, staff, contact details, other jobs or any Stripe id or URL. Withdrawn or expired: status and job number only. Otherwise 12 keys, the last ''deposit'': null, or {percent, amount, status} with status on_answer (open; amount null), or {percent, amount, status, parts_ordered, job_closed, refunded} with status due (answered, job open), processing, paid or refunded (quote_deposits), parts_ordered true once every approved part still live is ordered or fitted, job_closed (R-082) true once the job is completed, ready for collection, collected or cancelled, and refunded (U2-11) what Stripe gave back of the deposit payments still counted as paid (partly refunded), else 0.';

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
  -- The link before the job; 'closed' is read from the job's status on
  -- every read (the status trigger withdraws the link first in practice).
  state := case
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
  'D156f: what the pay page shows for a link token (anon and authenticated): null for an unknown token; {status, job_number} only when the link is withdrawn, expired or its job is not completed or ready (closed); otherwise 13 keys: status open, shop_name, job_number, bike (brand, model, variant), first_name, currency, lines (live lines in order: description with any unit short_id and serial cut, quantity, line_total), job_total, paid (net_paid: Stripe net and counter), refunded (U2-11: succeeded Stripe refunds on the job, which paid is already net of), paid_ahead, balance_due (live), payment (processing while a Stripe payment on the job is being confirmed, else nothing_due, too_small under S$0.50, too_large above S$999,999.99, or due). Never costs, notes, staff, contacts, other jobs, ids of any kind, unit ids, serial numbers (lines or bike), voided lines, Stripe ids or URLs.';

-- ---------------------------------------------------------------------------
-- Privileges (DATA-MODEL §15): restated for the record; create or replace
-- keeps both.
-- ---------------------------------------------------------------------------
revoke all on function
  private.quote_view(public.quotes),
  public.balance_by_token(text)
from public, anon, authenticated, service_role;

-- D156f: the pay page, for anyone holding a link (as quote_by_token).
grant execute on function
  public.balance_by_token(text)
to anon, authenticated;
