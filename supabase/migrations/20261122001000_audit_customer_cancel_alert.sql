-- Booking emails (PLAN D163; DATA-MODEL §3 "Booking emails"): a customer's
-- online cancellation alerts the shop whoever made the booking.
--
-- appointments_queue_notices returned early for every appointment staff
-- made, so a customer who cancelled a staff-made booking from their
-- account (cancel_my_appointment) queued nothing and the shop was never
-- told. The source check now applies to the booking itself (staff bookings
-- still queue no 'booked' emails) and to staff cancellations; a
-- cancellation made by the customer queues the 'cancelled' notices (the
-- shop's alert with their reason, and their confirmation) for any booking.
-- private.queue_appointment_notices is unchanged.

create or replace function private.appointments_queue_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reason text;
begin
  if tg_op = 'INSERT' then
    -- D163a: only appointments booked online send booking emails.
    if new.source = 'customer' then
      perform private.queue_appointment_notices(new, 'booked', null);
    end if;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled'
    and (new.source = 'customer' or new.cancelled_via = 'customer') then
    -- An online booking's cancellation by anyone, and a customer's own
    -- cancellation of any booking. cancel_my_appointment sets the
    -- customer's reason as the change reason, or this default when they
    -- gave none.
    reason := nullif(private.change_reason(), 'Cancelled by the customer');
    perform private.queue_appointment_notices(
      new, 'cancelled',
      case when new.cancelled_via = 'customer' then pg_catalog.left(reason, 500) end
    );
  end if;
  return null;
end;
$$;

revoke all on function private.appointments_queue_notices() from public, anon, authenticated, service_role;
