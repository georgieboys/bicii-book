set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 2026-11-22 front-end audit: a purchase order line a customer job's part
-- was ordered on is never removed.
--
-- order_part_requests (20261014000200) puts a job's approved indent part on
-- a line and points job_part_requests.purchase_order_line_id at it, ON
-- DELETE RESTRICT. remove_purchase_order_line checked receipts, the order's
-- status and the reason, then ran the DELETE, so such a line failed with a
-- bare foreign-key violation that the app could only report as "That
-- refers to something that no longer exists". Now, before the DELETE and
-- under the purchase order lock (which order_part_requests also takes, so
-- no part is newly ordered on the line meanwhile):
--
--   * purchase_order_has_indent_requests (A-21's code) while a job's
--     ordered part on the line has not arrived;
--   * purchase_line_has_job_parts when only arrived, fitted or cancelled
--     requests still name the line. The link is the job's purchase
--     history and is kept; the line's quantity can still be lowered.
--
-- A refusal changes no data. Signature, grants and the replay behaviour
-- are unchanged.
-- ---------------------------------------------------------------------------

-- remove_purchase_order_line: 20261005000300 with the job-part refusals.
create or replace function public.remove_purchase_order_line(line_id uuid, reason text default null)
returns setof public.purchase_order_lines
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleaned text := nullif(pg_catalog.btrim(coalesce(remove_purchase_order_line.reason, '')), '');
  po_id uuid;
  po public.purchase_orders;
  line public.purchase_order_lines;
  waiting_jobs text;
begin
  perform private.require_permission('manage_purchasing');
  if remove_purchase_order_line.line_id is null then
    raise exception 'line_id is required' using errcode = '22004';
  end if;
  if cleaned is not null and pg_catalog.char_length(cleaned) > 500 then
    raise exception using
      errcode = 'P0001',
      message = 'reason_too_long',
      detail = 'Keep the reason under 500 characters.';
  end if;

  select l.purchase_order_id into po_id from public.purchase_order_lines l where l.id = remove_purchase_order_line.line_id;
  if not found then
    return;
  end if;
  po := private.lock_purchase_order(po_id);
  select l.* into line from public.purchase_order_lines l where l.id = remove_purchase_order_line.line_id;
  if not found then
    return;
  end if;

  if po.status in ('received', 'cancelled') then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_order_closed',
      detail = 'This order is closed: it has been fully received or cancelled.';
  end if;
  if exists (select 1 from public.purchase_receipt_lines rl where rl.purchase_order_line_id = line.id) then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_line_has_receipts',
      detail = 'Part of this line has been received; lower its quantity instead.';
  end if;

  select pg_catalog.string_agg(distinct w.job_number, ', ' order by w.job_number) into waiting_jobs
  from private.purchase_order_waiting_indent(po.id, line.id) x
  join public.work_orders w on w.id = x.work_order_id;
  if waiting_jobs is not null then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_order_has_indent_requests',
      detail = pg_catalog.format(
        'Customer jobs are waiting for parts on this line (%s). Fit or cancel those parts on the jobs first.',
        waiting_jobs
      );
  end if;
  if exists (select 1 from public.job_part_requests r where r.purchase_order_line_id = line.id) then
    raise exception using
      errcode = 'P0001',
      message = 'purchase_line_has_job_parts',
      detail = 'Customer jobs ordered parts on this line, so it stays; lower its quantity instead.';
  end if;

  if po.status <> 'draft' then
    if cleaned is null then
      raise exception using
        errcode = 'P0001',
        message = 'reason_required',
        detail = 'Say why the line is being removed from a submitted order.';
    end if;
    if not exists (
      select 1 from public.purchase_order_lines l where l.purchase_order_id = po.id and l.id <> line.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'purchase_order_needs_lines',
        detail = 'A submitted order keeps at least one line; cancel the order instead.';
    end if;
  end if;

  perform private.set_change_reason(cleaned);
  delete from public.purchase_order_lines l where l.id = line.id;
  perform private.set_change_reason(null);
  perform private.refresh_purchase_order_status(po.id, now());
  return next line;
end;
$$;

comment on function public.remove_purchase_order_line(uuid, text) is
  'manage_purchasing: remove a PO line without receipts or customer-job parts (a reason once submitted; never the last line); no row on a replay.';
