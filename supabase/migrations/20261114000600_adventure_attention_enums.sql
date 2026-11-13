-- Adventures Phase B, Admin screens (D181): booking history records an
-- admin clearing a payment flag. Its own migration: a new enum value cannot
-- be used in the transaction that adds it.

alter type public.adventure_booking_event_kind add value 'attention_cleared';
