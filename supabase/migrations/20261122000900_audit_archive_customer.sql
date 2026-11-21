-- Audit 2026-11-13, A-22: a customer is archived only once nothing is still
-- open for them, and the archive date is the database's.
--
-- Archiving a customer makes private.current_customer_id() return null for
-- their login, so the website stops showing their jobs and bookings and they
-- can no longer cancel a booking, and new check-ins and sales for them are
-- refused (customer_archived). Archiving with work still in flight left a
-- booking holding capacity that its customer could not see or cancel, and a
-- job that could not be re-booked. Consignors, products and units already
-- refuse archiving while something is open; customers now do too.
--
-- customers_guard_archive (BEFORE UPDATE OF archived_at, every writer):
--   * archiving (old null, new not null) raises P0001 customer_has_open_work
--     while the customer has
--       - a work order that is not collected or cancelled,
--       - an appointment booked, confirmed or arrived that has not ended,
--       - an open, unexpired quote or a live (not withdrawn, unexpired)
--         balance link on any of their jobs,
--       - a consignor linked to them that is not archived;
--     otherwise it stamps archived_at := now(), whatever value was sent;
--   * an archived customer re-archived keeps their first archive date;
--   * unarchiving (new null) is never refused.
--
-- No function signature, type or grant changes; customers keep their column
-- grants. The trigger takes no lock beyond the UPDATE's own row lock.

create function private.customers_guard_archive()
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

revoke all on function private.customers_guard_archive()
from public, anon, authenticated, service_role;

comment on function private.customers_guard_archive() is
  'A-22: refuses archiving a customer with an open job, an upcoming booking, an open quote, a live balance link or a non-archived consignor (customer_has_open_work); stamps archived_at with now() and keeps the first archive date.';

create trigger customers_guard_archive
  before update of archived_at on public.customers
  for each row execute function private.customers_guard_archive();
