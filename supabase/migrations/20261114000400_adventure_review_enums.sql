-- Adventures Phase B, slice 4 (review): booking history kinds for review
-- outcomes. Their own migration (a new enum value cannot be used in the
-- transaction that adds it; 20261114000500 uses them).
alter type public.adventure_booking_event_kind add value 'review_started';
alter type public.adventure_booking_event_kind add value 'changes_requested';
alter type public.adventure_booking_event_kind add value 'certified';
alter type public.adventure_booking_event_kind add value 'not_certified';
alter type public.adventure_booking_event_kind add value 'certificate_revoked';
alter type public.adventure_booking_event_kind add value 'pack_updated';
