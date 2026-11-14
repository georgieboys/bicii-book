-- Adventures: the owner's sales terms (D212-D218). New enum values are
-- committed here, before 20261114002200_rider_terms.sql uses them.
alter type public.adventure_finisher_name add value 'preferred_name';
alter type public.adventure_booking_event_kind add value 'board_name_changed';
alter type public.adventure_booking_event_kind add value 'late_fee_recorded';
alter type public.adventure_booking_event_kind add value 'late_fee_settled';
alter type public.adventure_notice_kind add value 'tracker_late_fee';
