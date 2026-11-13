-- Adventures Phase C, tracker hire (D187, D188): booking history records
-- a tracker issued, replaced, returned and a hire cancelled. Their own
-- migration: a new enum value cannot be used in the transaction that adds it.

alter type public.adventure_booking_event_kind add value 'tracker_issued';
alter type public.adventure_booking_event_kind add value 'tracker_replaced';
alter type public.adventure_booking_event_kind add value 'tracker_returned';
alter type public.adventure_booking_event_kind add value 'tracker_hire_cancelled';
