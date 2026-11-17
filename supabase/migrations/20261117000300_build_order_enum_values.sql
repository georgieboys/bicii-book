-- D255: the job event of linking an online build order, in its own
-- migration so 20261117000400_build_package_sales can use it.
alter type public.work_order_event_type add value if not exists 'build_order_linked';
