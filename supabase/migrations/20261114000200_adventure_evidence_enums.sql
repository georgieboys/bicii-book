-- Adventures Phase B, slice 3 (evidence): booking history kinds for the
-- evidence journey. Their own migration because a new enum value cannot be
-- used in the transaction that adds it (20261114000300 uses them).
alter type public.adventure_booking_event_kind add value 'evidence_started';
alter type public.adventure_booking_event_kind add value 'evidence_submitted';
