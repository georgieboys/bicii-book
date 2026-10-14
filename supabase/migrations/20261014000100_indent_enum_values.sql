-- Enum values Phase 13 needs before the migration that uses them (PLAN
-- Phase 13, D140-D148, ADR-024).
--
-- A new enum value cannot be used in the transaction that adds it, and every
-- migration runs in its own transaction, so they are added here on their
-- own (as 20261004002700_appointment_enum_values does). Each is a job
-- timeline entry written by 20261014000200_indent_parts; the staff timeline
-- describes them (src/lib/workshop-timeline.ts) and the customer timeline
-- never shows them (my_work_order_timeline lists its types, D8).
alter type public.work_order_event_type add value if not exists 'part_requested';
alter type public.work_order_event_type add value if not exists 'part_request_cancelled';
alter type public.work_order_event_type add value if not exists 'quote_sent';
alter type public.work_order_event_type add value if not exists 'quote_withdrawn';
alter type public.work_order_event_type add value if not exists 'quote_answered';
alter type public.work_order_event_type add value if not exists 'part_ordered';
alter type public.work_order_event_type add value if not exists 'part_fitted';
