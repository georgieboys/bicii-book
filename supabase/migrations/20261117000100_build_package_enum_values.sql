-- D246-D251: the job events of build packages, in their own migration so
-- 20261117000200_build_packages can use them (a value added by ALTER TYPE
-- cannot be used in the transaction that adds it).
alter type public.work_order_event_type add value if not exists 'build_set';
alter type public.work_order_event_type add value if not exists 'build_cleared';
alter type public.work_order_event_type add value if not exists 'build_fitted';
alter type public.work_order_event_type add value if not exists 'line_repriced';
