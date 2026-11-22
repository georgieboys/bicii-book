set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 2026-11-22 quick audit, Admin fixes.
--
-- 1. unlink_shopify_customer(customer_id, reason): an admin can undo a
--    Shopify customer link (D86, D263; R-131).
--
--    D263 sets customers.shopify_customer_id by itself when a paid order's
--    Shopify customer carries a verified login's email, and from then on the
--    customer's account shows every order of that Shopify customer. A wrong
--    match could not be undone in the app: link_shopify_customer refuses a
--    customer who already has a different id (shopify_customer_already_linked)
--    and the right customer could not be linked either (the id is unique).
--
--      * unlink_shopify_customer (admins, reason required) sets the id to
--        NULL, audited as customer_unlinked {from, to: null, online_sales_kept}
--        with the reason. A customer
--        with no link is shopify_customer_not_linked.
--      * The automatic match never makes the pair an admin unlinked again
--        (private.link_shopify_customer_by_email); linking by hand still can.
--      * Sales are immutable: orders recorded for the customer while the
--        wrong link stood keep sales.customer_id for staff (counted in
--        online_sales_kept), but my_purchases no longer returns them to that
--        customer. They show again to whoever the Shopify customer is linked
--        to next (through sales.shopify_customer_id).
--
-- 2. customers_guard_archive (A-22) also covers Adventures: archiving a
--    customer makes private.require_customer() refuse their login, and the
--    rider RPCs (the ride page, evidence, request_my_adventure_cancellation)
--    rest on it. Archiving is now also customer_has_open_work while they have
--      * an adventure booking waiting for payment, or paid and not finished
--        (no active certificate, and its latest submission is not rejected);
--      * a hired tracker that has not been returned (an open
--        tracker_assignments row on any of their bookings).
--    Everything else about the trigger is 20261122000900's.

-- ---------------------------------------------------------------------------
-- 1. Unlinking a Shopify customer
-- ---------------------------------------------------------------------------
create type public.shopify_customer_unlink_result as (
  customer_id uuid,
  shopify_customer_id text,
  online_sales_kept integer
);

create function public.unlink_shopify_customer(customer_id uuid, reason text)
returns public.shopify_customer_unlink_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor uuid := private.require_admin();
  cleaned text := private.require_reason(unlink_shopify_customer.reason);
  cust public.customers;
  kept integer;
  result public.shopify_customer_unlink_result;
begin
  if unlink_shopify_customer.customer_id is null then
    raise exception 'customer_id is required' using errcode = '22004';
  end if;
  select c.* into cust from public.customers c where c.id = unlink_shopify_customer.customer_id for update;
  if not found then
    raise exception 'customer % not found', unlink_shopify_customer.customer_id using errcode = 'P0002';
  end if;
  if cust.shopify_customer_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'shopify_customer_not_linked',
      detail = 'That customer is not linked to a Shopify customer.';
  end if;
  -- Recorded for them while the link stood; sales are immutable.
  select count(*)::integer into kept
  from public.sales s
  where s.source = 'online_shopify' and s.customer_id = cust.id
    and s.shopify_customer_id = cust.shopify_customer_id;
  perform private.set_change_reason(cleaned);
  update public.customers c set shopify_customer_id = null where c.id = cust.id;
  perform private.set_change_reason(null);
  insert into public.integration_audit_events (
    event_type, customer_id, actor_staff_id, reason, payload, correlation_id
  )
  values (
    'customer_unlinked', cust.id, actor, cleaned,
    pg_catalog.jsonb_build_object('from', cust.shopify_customer_id, 'to', null, 'online_sales_kept', kept),
    private.current_correlation_id()
  );
  result := row(cust.id, cust.shopify_customer_id, kept);
  return result;
end;
$$;

comment on function public.unlink_shopify_customer(uuid, text) is
  'Admins (D86, D263), reason required: remove a customer''s Shopify customer link, made by hand or by the verified-email match. Returns the id removed and online_sales_kept, the online sales recorded for the customer while it stood (sales are immutable: they stay on the customer for staff, and my_purchases hides them from that customer). The automatic match never links that pair again; an admin still can. No link -> shopify_customer_not_linked. Audited (customer_unlinked).';

revoke all on function public.unlink_shopify_customer(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.unlink_shopify_customer(uuid, text) to authenticated;

-- 20261122001500's function with one more refusal: a pair an admin unlinked.
create or replace function private.link_shopify_customer_by_email(customer_id uuid, sale_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cust public.customers;
  sale public.sales;
  order_email text;
  customer_email text;
  login_email text;
  earlier integer;
begin
  -- Best effort: a busy customer row is skipped, never waited on (this runs
  -- at the commit of order processing, which holds the stock locks).
  select c.* into cust from public.customers c
  where c.id = link_shopify_customer_by_email.customer_id
  for update skip locked;
  select s.* into sale from public.sales s where s.id = link_shopify_customer_by_email.sale_id;
  if cust.id is null or sale.id is null or cust.archived_at is not null
     or cust.shopify_customer_id is not null or sale.shopify_customer_id is null
     or sale.source <> 'online_shopify' then
    return false;
  end if;
  if exists (select 1 from public.customers o where o.shopify_customer_id = sale.shopify_customer_id) then
    return false;
  end if;
  -- An admin unlinked exactly this pair (unlink_shopify_customer): the match
  -- was wrong, so it is never made again automatically. An admin can still
  -- link them by hand (link_shopify_customer).
  if exists (
    select 1 from public.integration_audit_events a
    where a.customer_id = cust.id and a.event_type = 'customer_unlinked'
      and a.payload ->> 'from' = sale.shopify_customer_id
  ) then
    return false;
  end if;
  select private.shopify_order_email(e.payload), private.shopify_customer_email(e.payload)
  into order_email, customer_email
  from public.integration_events e where e.id = sale.integration_event_id;
  login_email := private.customer_verified_email(cust.id);
  -- The Shopify customer's own email must be the verified login email, and
  -- the order's email must not name someone else: a link shows every order
  -- of that Shopify customer.
  if login_email is null or customer_email is distinct from login_email
     or (order_email is not null and order_email <> login_email) then
    return false;
  end if;

  select count(*)::integer into earlier
  from public.sales s
  where s.source = 'online_shopify' and s.shopify_customer_id = sale.shopify_customer_id and s.customer_id is null;
  begin
    perform private.set_change_reason('Matched by verified email (D263)');
    update public.customers c set shopify_customer_id = sale.shopify_customer_id where c.id = cust.id;
    perform private.set_change_reason(null);
  exception when unique_violation then
    -- Another customer took that Shopify customer meanwhile: no link.
    perform private.set_change_reason(null);
    return false;
  end;
  insert into public.integration_audit_events (
    event_type, customer_id, integration_event_id, actor_staff_id, reason, payload, correlation_id
  )
  values (
    'customer_linked', cust.id, sale.integration_event_id, null, 'Matched by verified email (D263)',
    pg_catalog.jsonb_build_object(
      'from', null, 'to', sale.shopify_customer_id, 'earlier_online_sales', earlier,
      'matched_by', 'verified_email', 'sale_id', sale.id
    ),
    private.current_correlation_id()
  );
  return true;
end;
$$;

comment on function private.link_shopify_customer_by_email(uuid, uuid) is
  'D263: link the customer to the Shopify customer of an online sale whose Shopify customer email is the customer''s verified login email (and whose order email, if any, is too), when the customer has no Shopify customer id, no other customer has that one and no admin unlinked that pair (customer_unlinked); audited as customer_linked with matched_by verified_email. Returns whether it linked.';

-- 20261122001500's function; an order recorded for the customer through a
-- link an admin has since removed is no longer theirs to see.
create or replace function public.my_purchases()
returns table (
  sale_id uuid,
  sale_number text,
  source public.sale_source,
  order_name text,
  purchased_at timestamptz,
  status public.sale_status,
  currency char(3),
  total numeric,
  refunded numeric,
  lines jsonb,
  builds jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  my_shopify text;
  my_email text;
  unlinked text[];
begin
  select c.shopify_customer_id into my_shopify from public.customers c where c.id = me;
  -- Shopify customers an admin unlinked from this customer (and that are not
  -- their link now): orders recorded for them while the wrong link stood.
  select coalesce(pg_catalog.array_agg(distinct a.payload ->> 'from'), '{}'::text[]) into unlinked
  from public.integration_audit_events a
  where a.customer_id = me and a.event_type = 'customer_unlinked'
    and a.payload ->> 'from' is not null
    and a.payload ->> 'from' is distinct from my_shopify;
  my_email := private.customer_verified_email(me);
  return query
    select s.id,
           s.sale_number,
           s.source,
           s.shopify_order_name,
           s.recognized_at,
           s.status,
           s.currency,
           coalesce((select sum(l.sale_total) from public.sale_lines l where l.sale_id = s.id), 0)
             + coalesce((select sum(b.amount) from public.build_orders b where b.sale_id = s.id), 0),
           coalesce((select sum(r.amount) from public.sale_refunds r where r.sale_id = s.id), 0),
           coalesce((
             select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'description', l.description_snapshot,
                 'quantity', l.quantity,
                 'unit_price', l.unit_sale_price_snapshot,
                 'total', l.sale_total
               )
               order by l.line_number
             )
             from public.sale_lines l where l.sale_id = s.id
           ), '[]'::jsonb),
           coalesce((
             select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'package', p.name,
                 'frame_source', b.frame_source,
                 'amount', b.amount,
                 'job_number', w.job_number
               )
               order by b.line_part, b.id
             )
             from public.build_orders b
             join public.build_packages p on p.id = b.build_package_id
             left join public.work_orders w on w.id = b.work_order_id
             where b.sale_id = s.id
           ), '[]'::jsonb)
    from public.sales s
    left join public.integration_events e on e.id = s.integration_event_id
    where s.status <> 'voided'
      and s.source in ('retail', 'online_shopify')
      and (
        (s.customer_id = me
         and (s.shopify_customer_id is null or s.shopify_customer_id <> all (unlinked)))
        or (my_shopify is not null and s.shopify_customer_id = my_shopify)
        or (my_email is not null and s.source = 'online_shopify' and s.customer_id is null
            and private.shopify_order_email(e.payload) = my_email)
      )
    order by s.recognized_at desc, s.id desc
    limit 100;
end;
$$;

comment on function public.my_purchases() is
  'D263: the signed-in customer''s in-store and online purchases (not voided), newest first, at most 100: sales they are the customer of (except online sales of a Shopify customer an admin unlinked from them), online sales of their linked Shopify customer, and unlinked online sales placed with their verified login email. Each with its lines (description, quantity, unit price, total), refunded amount and build orders (package, frame option, amount, linked job number). Never a cost, payout or another customer''s order.';

-- ---------------------------------------------------------------------------
-- 2. customers_guard_archive: 20261122000900 with the Adventures checks
-- ---------------------------------------------------------------------------
create or replace function private.customers_guard_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  what text;
begin
  if new.archived_at is null then
    return new;
  end if;
  if old.archived_at is not null then
    -- Already archived: the first archive date stands.
    new.archived_at := old.archived_at;
    return new;
  end if;

  if exists (
    select 1 from public.work_orders w
    where w.customer_id = new.id and w.status not in ('collected', 'cancelled')
  ) then
    what := 'a job that is not collected or cancelled';
  elsif exists (
    select 1 from public.appointments a
    where a.customer_id = new.id
      and a.status in ('booked', 'confirmed', 'arrived')
      and a.ends_at > pg_catalog.now()
  ) then
    what := 'an upcoming booking';
  elsif exists (
    select 1
    from public.quotes q
    join public.work_orders w on w.id = q.work_order_id
    where w.customer_id = new.id and q.status = 'open' and q.expires_at > pg_catalog.now()
  ) then
    what := 'an open quote';
  elsif exists (
    select 1
    from public.balance_links l
    join public.work_orders w on w.id = l.work_order_id
    where w.customer_id = new.id and l.withdrawn_at is null and l.expires_at > pg_catalog.now()
  ) then
    what := 'a live payment link';
  elsif exists (
    select 1 from public.consignors c where c.customer_id = new.id and c.archived_at is null
  ) then
    what := 'a consignor record that is not archived';
  elsif exists (
    select 1 from public.adventure_bookings b
    where b.customer_id = new.id
      and (
        b.status = 'pending_payment'
        or (
          b.status = 'confirmed'
          -- Finished: certified, or its latest submission was not certified.
          and not exists (
            select 1 from public.adventure_certificates c
            where c.booking_id = b.id and c.status = 'active'
          )
          and coalesce((
            select s.state <> 'rejected'
            from public.adventure_attempts t
            join public.adventure_submissions s on s.attempt_id = t.id
            where t.booking_id = b.id
            order by t.attempt_number desc, s.version desc
            limit 1
          ), true)
        )
      )
  ) then
    what := 'an adventure booking that is waiting for payment, or paid and not finished';
  elsif exists (
    select 1
    from public.tracker_assignments x
    join public.adventure_bookings b on b.id = x.booking_id
    where b.customer_id = new.id and x.returned_at is null
  ) then
    what := 'a hired tracker that has not been returned';
  end if;

  if what is not null then
    raise exception using
      errcode = 'P0001',
      message = 'customer_has_open_work',
      detail = pg_catalog.format('This customer still has %s; close it before archiving.', what);
  end if;

  new.archived_at := pg_catalog.now();
  return new;
end;
$$;

comment on function private.customers_guard_archive() is
  'A-22: refuses archiving a customer with an open job, an upcoming booking, an open quote, a live balance link, a non-archived consignor, an adventure booking that is waiting for payment or paid and not finished, or a hired tracker not returned (customer_has_open_work); stamps archived_at with now() and keeps the first archive date.';
