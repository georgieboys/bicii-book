-- Audit fix: reactivation stays within the delegation ceiling (D11, D93).
--
-- Deactivation keeps a person's staff_permissions rows; they simply stop
-- counting while the person is inactive. Reactivating them makes every
-- retained exception count again, so a manage_staff holder who is not an
-- admin may reactivate a mechanic only when they could have granted each of
-- that mechanic's exceptions themselves: never manage_staff, and only
-- permissions the caller holds (the same ceiling as grant_permission,
-- private.authorize_permission_change). Otherwise 42501 and nothing changes;
-- an admin still reactivates anyone. Deactivation and everything else are
-- unchanged. Body copied from 20261006000300_staff_role_administration.sql.

-- ---------------------------------------------------------------------------
-- set_staff_active: an admin acts on anyone; a manage_staff holder who is
-- not an admin on mechanics only, and reactivates only someone whose
-- exceptions they could grant.
-- ---------------------------------------------------------------------------
create or replace function public.set_staff_active(target_staff_id uuid, active boolean, reason text default null)
returns public.staff
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid;
  caller_is_admin boolean := private.is_admin();
  target public.staff;
begin
  if caller_is_admin then
    actor := private.current_staff_id();
  else
    actor := private.require_permission('manage_staff');
  end if;

  if set_staff_active.active is null then
    raise exception 'active must be true or false' using errcode = '22004';
  end if;

  select s.* into target from public.staff s where s.id = target_staff_id for update;
  if not found then
    raise exception 'staff % not found', target_staff_id using errcode = 'P0002';
  end if;

  if target.id = actor and not set_staff_active.active then
    raise exception 'staff cannot deactivate themselves' using errcode = '42501';
  end if;
  if target.role <> 'mechanic' and not caller_is_admin then
    raise exception 'only an admin changes an admin''s or a manager''s access' using errcode = '42501';
  end if;
  if target.active = set_staff_active.active then
    return target;
  end if;
  if set_staff_active.active and not caller_is_admin and exists (
    select 1
    from public.staff_permissions sp
    where sp.staff_id = target.id
      and (sp.permission = 'manage_staff' or not private.has_permission(sp.permission))
  ) then
    raise exception 'only an admin reactivates someone with access the caller cannot grant'
      using errcode = '42501';
  end if;
  if not set_staff_active.active and nullif(pg_catalog.btrim(coalesce(reason, '')), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'reason_required',
      detail = 'Say why this person is being deactivated.';
  end if;

  perform private.set_staff_event_reason(reason);
  update public.staff s
  set active = set_staff_active.active
  where s.id = target_staff_id
  returning s.* into target;
  perform private.set_staff_event_reason(null);
  return target;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (restated for the function replaced here)
-- ---------------------------------------------------------------------------
revoke all on function public.set_staff_active(uuid, boolean, text)
from public, anon, authenticated, service_role;

grant execute on function public.set_staff_active(uuid, boolean, text) to authenticated;
