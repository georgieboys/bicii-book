-- Fixes from the 2026-11-14 audit (D220-D222). New enum values are committed
-- here, before 20261114002400_audit_high.sql uses them.
alter type public.adventure_booking_event_kind add value 'departure_changed';
alter type public.adventure_notice_kind add value 'departure_changed';
