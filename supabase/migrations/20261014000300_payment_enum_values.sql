-- Phase 14 step 1 (D153, D155; ADR-025): job timeline entries for customer
-- payments. In their own file: a new enum value cannot be used in the
-- transaction that adds it (the 20261014000100_indent_enum_values pattern).
-- Customers never see them: my_work_order_timeline lists its own types
-- (20261004001600:176). Their payloads carry customer amounts, never a
-- cost (the work_order_events rule bans cost, yield, rate and Cult
-- Commons only); 20261014000400_stripe_payments writes them.
alter type public.work_order_event_type add value if not exists 'payment_received';
alter type public.work_order_event_type add value if not exists 'payment_refunded';
alter type public.work_order_event_type add value if not exists 'payment_refund_failed';
