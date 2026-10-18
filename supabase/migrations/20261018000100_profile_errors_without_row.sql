-- ---------------------------------------------------------------------------
-- update_my_profile re-raises a check or not-null violation without its row
-- (audit 2026-10-18; DATA-MODEL §16 "Errors never print a hidden column").
--
-- The function is security definer, so Postgres builds a violation's DETAIL
-- ("Failing row contains (...)") with the owner's privileges: every column
-- of the caller's customers row, internal_notes and the internal ids
-- included. PostgREST returns DETAIL to the caller as `details`, so a
-- signed-in customer sending an over-long name or phone read the staff's
-- notes about them. Every staff definer writer to a table with hidden
-- columns already catches these two errors and re-raises them through
-- private.raise_without_row (20261004001200_workshop_catalog); this brings
-- the customer's own profile writer in line. The SQLSTATE, constraint,
-- table, column and message are unchanged, so the public site still maps
-- the error by constraint name.
--
-- Body otherwise identical to 20261004001000_customer_access.
-- ---------------------------------------------------------------------------

create or replace function public.update_my_profile(
  first_name text default null,
  last_name text default null,
  display_name text default null,
  phone text default null
)
returns public.customer_profile
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me uuid := private.require_customer();
  result public.customer_profile;
  err_state text;
  err_constraint text;
  err_table text;
  err_schema text;
  err_column text;
  err_message text;
begin
  begin
    update public.customers c
    set first_name = coalesce(update_my_profile.first_name, c.first_name),
        last_name = coalesce(update_my_profile.last_name, c.last_name),
        display_name = coalesce(update_my_profile.display_name, c.display_name),
        phone = coalesce(update_my_profile.phone, c.phone)
    where c.id = me
    returning c.id, c.first_name, c.last_name, c.display_name, c.email::text, c.phone, c.created_at
    into result;
  exception
    when check_violation or not_null_violation then
      -- No DETAIL: it would print the row, internal notes included.
      get stacked diagnostics
        err_state = returned_sqlstate, err_constraint = constraint_name, err_table = table_name,
        err_schema = schema_name, err_column = column_name, err_message = message_text;
      perform private.raise_without_row(err_state, err_constraint, err_table, err_schema, err_column, err_message);
  end;
  return result;
end;
$$;

comment on function public.update_my_profile(text, text, text, text) is
  'Signed-in customer: change their own name and phone (null keeps, empty clears); a violation is re-raised without its row.';
