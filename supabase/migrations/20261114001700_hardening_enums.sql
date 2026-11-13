-- Adventures Phase F, hardening (D200-D203): booking history and emails for
-- a rider's cancellation request, a staff cancellation and a moved seat.
-- Their own migration: a new enum value cannot be used in the transaction
-- that adds it.

alter type public.adventure_booking_event_kind add value 'cancellation_requested';
alter type public.adventure_booking_event_kind add value 'booking_cancelled';
alter type public.adventure_booking_event_kind add value 'seat_moved';
alter type public.adventure_notice_kind add value 'cancellation_requested';
alter type public.adventure_notice_kind add value 'booking_cancelled';
