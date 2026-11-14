-- Fixes from the 2026-11-14 audit, medium findings on bookings (D223-D227).
-- New enum values are committed here, before 20261114002600 uses them.
alter type public.adventure_notice_kind add value 'supported_cancelled';
