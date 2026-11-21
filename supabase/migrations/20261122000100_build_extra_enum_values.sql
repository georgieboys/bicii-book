-- D261: the job events of build extras, in their own migration so
-- 20261122000200_build_extras can use them (a value added by ALTER TYPE
-- cannot be used in the transaction that adds it).
alter type public.work_order_event_type add value if not exists 'build_extra_marked';
alter type public.work_order_event_type add value if not exists 'build_extra_unmarked';
