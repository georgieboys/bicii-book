set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- D263 (amends D86 for the customer's own view; the owner, 2026-11-22:
-- "Match by verified email"): a customer signed in on bicii.sg sees their
-- purchases, in the shop and online.
--
--   - A paid Shopify order belongs to a customer when its Shopify customer
--     is linked (D86, unchanged), or when the order's email is the email the
--     customer verified with a sign-in code. Shopify already sends that
--     address the order's receipt, so showing the order there reveals
--     nothing new. claim_my_customer already matches a login to a customer
--     record by the same verified email.
--   - When a new online order's email matches exactly one verified login and
--     neither side is linked yet, the customer's Shopify customer id is set
--     (audited as customer_linked, reason "Matched by verified email"), so
--     staff see the order on the customer and every later order attaches as
--     D86 links do. A customer who signs in later is linked from their latest
--     matching order the same way. Sales stay immutable: earlier orders are
--     shown through sales.shopify_customer_id, as a staff link shows them.
--   - my_purchases() returns the signed-in customer's in-store and online
--     sales (not voided), newest first, with their lines, refunds and any
--     build order: never a cost, a payout or another customer's order.

-- ---------------------------------------------------------------------------
-- Emails
-- ---------------------------------------------------------------------------
-- The email a paid order was placed with, lower case: the order's own, its
-- contact email, or its customer's.
create function private.shopify_order_email(payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(
    nullif(pg_catalog.btrim(shopify_order_email.payload ->> 'email'), ''),
    nullif(pg_catalog.btrim(shopify_order_email.payload ->> 'contact_email'), ''),
    shopify_order_email.payload #>> '{customer,email}'
  ))), '');
$$;

comment on function private.shopify_order_email(jsonb) is
  'D263: the email a Shopify order was placed with (email, contact_email, else customer.email), trimmed and lower case; NULL when none.';

revoke all on function private.shopify_order_email(jsonb) from public, anon, authenticated, service_role;

-- The email a customer verified with a sign-in code, lower case; NULL when
-- the customer has no login or its email is not confirmed.
create function private.customer_verified_email(customer_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.lower(u.email::text)
  from public.customers c
  join auth.users u on u.id = c.auth_user_id
  where c.id = customer_verified_email.customer_id
    and u.email is not null and u.email_confirmed_at is not null;
$$;

comment on function private.customer_verified_email(uuid) is
  'D263: the lower-case email of the customer''s login when it was confirmed with a code; NULL otherwise.';

revoke all on function private.customer_verified_email(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Linking by verified email
-- ---------------------------------------------------------------------------
-- Sets the customer's Shopify customer id from an order whose email is the
-- customer's verified login email, when the customer has none and no other
-- customer has that id. Audited. Returns true when it linked.
create function private.link_shopify_customer_by_email(customer_id uuid, sale_id uuid)
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
  earlier integer;
begin
  select c.* into cust from public.customers c where c.id = link_shopify_customer_by_email.customer_id for update;
  select s.* into sale from public.sales s where s.id = link_shopify_customer_by_email.sale_id;
  if cust.id is null or sale.id is null or cust.archived_at is not null
     or cust.shopify_customer_id is not null or sale.shopify_customer_id is null
     or sale.source <> 'online_shopify' then
    return false;
  end if;
  if exists (select 1 from public.customers o where o.shopify_customer_id = sale.shopify_customer_id) then
    return false;
  end if;
  select private.shopify_order_email(e.payload) into order_email
  from public.integration_events e where e.id = sale.integration_event_id;
  if order_email is null or order_email is distinct from private.customer_verified_email(cust.id) then
    return false;
  end if;

  select count(*)::integer into earlier
  from public.sales s
  where s.source = 'online_shopify' and s.shopify_customer_id = sale.shopify_customer_id and s.customer_id is null;
  perform private.set_change_reason('Matched by verified email (D263)');
  update public.customers c set shopify_customer_id = sale.shopify_customer_id where c.id = cust.id;
  perform private.set_change_reason(null);
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
  'D263: link the customer to the Shopify customer of an online sale whose order email is the customer''s verified login email, when the customer has no Shopify customer id and no other customer has that one; audited as customer_linked with matched_by verified_email. Returns whether it linked.';

revoke all on function private.link_shopify_customer_by_email(uuid, uuid) from public, anon, authenticated, service_role;

-- A new online sale with no customer: the one verified login with its email.
create function private.sales_link_by_verified_email()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  order_email text;
  cust uuid;
begin
  if new.source <> 'online_shopify' or new.customer_id is not null or new.shopify_customer_id is null then
    return null;
  end if;
  select private.shopify_order_email(e.payload) into order_email
  from public.integration_events e where e.id = new.integration_event_id;
  if order_email is null then
    return null;
  end if;
  select c.id into cust
  from public.customers c
  join auth.users u on u.id = c.auth_user_id
  where pg_catalog.lower(u.email::text) = order_email and u.email_confirmed_at is not null
    and c.archived_at is null;
  if cust is not null then
    perform private.link_shopify_customer_by_email(cust, new.id);
  end if;
  return null;
end;
$$;

revoke all on function private.sales_link_by_verified_email() from public, anon, authenticated, service_role;

-- Deferred to commit, like the other integration triggers, so order
-- processing keeps its lock order.
create constraint trigger sales_link_by_verified_email
  after insert on public.sales
  deferrable initially deferred
  for each row
  execute function private.sales_link_by_verified_email();

-- A customer who gets a login later: linked from their latest matching order.
create function private.customers_link_by_verified_email()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  login_email text;
  sid uuid;
begin
  if new.auth_user_id is null or new.shopify_customer_id is not null
     or (tg_op = 'UPDATE' and new.auth_user_id is not distinct from old.auth_user_id) then
    return null;
  end if;
  login_email := private.customer_verified_email(new.id);
  if login_email is null then
    return null;
  end if;
  select s.id into sid
  from public.sales s
  join public.integration_events e on e.id = s.integration_event_id
  where s.source = 'online_shopify' and s.customer_id is null and s.shopify_customer_id is not null
    and private.shopify_order_email(e.payload) = login_email
  order by s.recognized_at desc, s.id desc
  limit 1;
  if sid is not null then
    perform private.link_shopify_customer_by_email(new.id, sid);
  end if;
  return null;
end;
$$;

revoke all on function private.customers_link_by_verified_email() from public, anon, authenticated, service_role;

create constraint trigger customers_link_by_verified_email
  after insert or update of auth_user_id on public.customers
  deferrable initially deferred
  for each row
  execute function private.customers_link_by_verified_email();

-- The customers who already have a verified login, from their latest
-- matching order.
do $$
declare
  c record;
  sid uuid;
begin
  for c in
    select x.id, private.customer_verified_email(x.id) as email
    from public.customers x
    where x.auth_user_id is not null and x.shopify_customer_id is null and x.archived_at is null
    order by x.id
  loop
    continue when c.email is null;
    select s.id into sid
    from public.sales s
    join public.integration_events e on e.id = s.integration_event_id
    where s.source = 'online_shopify' and s.customer_id is null and s.shopify_customer_id is not null
      and private.shopify_order_email(e.payload) = c.email
    order by s.recognized_at desc, s.id desc
    limit 1;
    if sid is not null then
      perform private.link_shopify_customer_by_email(c.id, sid);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- my_purchases
-- ---------------------------------------------------------------------------
create function public.my_purchases()
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
begin
  select c.shopify_customer_id into my_shopify from public.customers c where c.id = me;
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
        s.customer_id = me
        or (my_shopify is not null and s.shopify_customer_id = my_shopify)
        or (my_email is not null and s.source = 'online_shopify' and s.customer_id is null
            and private.shopify_order_email(e.payload) = my_email)
      )
    order by s.recognized_at desc, s.id desc
    limit 100;
end;
$$;

comment on function public.my_purchases() is
  'D263: the signed-in customer''s in-store and online purchases (not voided), newest first, at most 100: sales they are the customer of, online sales of their linked Shopify customer, and unlinked online sales placed with their verified login email. Each with its lines (description, quantity, unit price, total), refunded amount and build orders (package, frame option, amount, linked job number). Never a cost, payout or another customer''s order.';

revoke all on function public.my_purchases() from public, anon, authenticated, service_role;
grant execute on function public.my_purchases() to authenticated;
