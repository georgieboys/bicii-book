-- Phase 14 step 3 (PLAN D156, D161; ADR-025; DATA-MODEL §5, §19): the job
-- timeline types for balance links and counter payments.
--
-- A new enum value cannot be used in the transaction that adds it, and every
-- migration runs in its own transaction, so they are added here on their
-- own (the 20261014000300_payment_enum_values pattern):
--
--   balance_link_sent        send_balance_link (20261014001400, D156)
--   balance_link_withdrawn   the link withdrawn on a resend, a reopen or
--                            collection (20261014001400, D156d)
--   counter_payment_recorded record_counter_payment (20261014001300, D161)
--   counter_payment_voided   void_counter_payment (20261014001300, D161d)
--
-- Customers never see them: my_work_order_timeline lists its own types
-- (20261004001600:176). Their payloads carry customer amounts and the void
-- reason, never a cost, a reference, a note or a token (the
-- work_order_events rule bans cost, yield, rate and Cult Commons). The staff
-- timeline describes each (src/lib/workshop-timeline.ts).
alter type public.work_order_event_type add value if not exists 'balance_link_sent';
alter type public.work_order_event_type add value if not exists 'balance_link_withdrawn';
alter type public.work_order_event_type add value if not exists 'counter_payment_recorded';
alter type public.work_order_event_type add value if not exists 'counter_payment_voided';
