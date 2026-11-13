-- Adventures Phase D, group departures (D193-D195): booking history and
-- emails for joining, leaving and a cancelled departure. Their own
-- migration: a new enum value cannot be used in the transaction that adds it.

alter type public.adventure_booking_event_kind add value 'departure_joined';
alter type public.adventure_booking_event_kind add value 'departure_left';
alter type public.adventure_booking_event_kind add value 'departure_cancelled';
alter type public.adventure_notice_kind add value 'departure_joined';
alter type public.adventure_notice_kind add value 'departure_cancelled';
