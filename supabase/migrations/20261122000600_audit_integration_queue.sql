-- Integration queue fixes (audit A-17, A-19; R-049, R-046).
--
--   - claim_integration_jobs: a running job whose worker stopped reporting
--     was reclaimed every 10 minutes with no bound, because max_attempts was
--     applied only to a reported failure. A stalled job that has used all
--     its attempts now ends as needs_attention (integration_job_stalled, on
--     the Exceptions screen) and is never reclaimed; a shopify_event job
--     also marks its event failed, as private.shopify_event_failed does.
--   - record_product_sync_result: a deferral (D83) that hands its wait to a
--     queued successor now also hands over its error code and message, so
--     the successor's run counts the wait as taken and overwrites a stale
--     Shopify count instead of deferring again.

-- ---------------------------------------------------------------------------
-- claim_integration_jobs (service_role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_integration_jobs(max_jobs integer, only_job_id uuid default null)
returns setof public.integration_retry_queue
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n integer := greatest(1, least(coalesce(claim_integration_jobs.max_jobs, 1), 50));
  stalled_events uuid[];
begin
  -- 1. A stalled product sync is superseded by a queued one of its product.
  update public.integration_retry_queue r
  set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null,
      resolution_reason = 'Superseded after a stalled run'
  where r.kind = 'product_sync' and r.status = 'running'
    and r.locked_at < pg_catalog.now() - interval '10 minutes'
    and exists (
      select 1 from public.integration_retry_queue q
      where q.kind = 'product_sync' and q.status = 'queued' and q.product_id = r.product_id
    );

  -- 1b. A stalled job out of attempts needs attention. The processors lock
  -- the event before its job, so the events are locked first; an event a
  -- late run still holds is left for the next claim (its job is not a
  -- candidate either way).
  select pg_catalog.array_agg(l.id) into stalled_events
  from (
    select e.id
    from public.integration_events e
    where e.id in (
      select r.integration_event_id
      from public.integration_retry_queue r
      where r.kind = 'shopify_event' and r.status = 'running'
        and r.locked_at < pg_catalog.now() - interval '10 minutes'
        and r.attempts >= r.max_attempts
    )
    order by e.id
    for update skip locked
  ) l;

  with stalled as (
    update public.integration_retry_queue r
    set status = 'needs_attention', locked_at = null, next_attempt_at = pg_catalog.now(),
        last_error_code = 'integration_job_stalled',
        last_error = 'The last runs did not finish. Retry, or dismiss with a reason.'
    where r.status = 'running'
      and r.locked_at < pg_catalog.now() - interval '10 minutes'
      and r.attempts >= r.max_attempts
      and (
        r.kind = 'product_sync'
        or r.integration_event_id = any (coalesce(stalled_events, '{}'::uuid[]))
      )
    returning r.integration_event_id
  )
  update public.integration_events e
  set status = 'failed', last_error_code = 'integration_job_stalled',
      last_error = 'The last runs did not finish. Retry, or dismiss with a reason.'
  from stalled s
  where e.id = s.integration_event_id and e.status in ('pending', 'failed');

  -- 2-4. Lock candidates (SKIP LOCKED cannot share a SELECT with a window
  -- function, so a second CTE keeps one per product), then claim. A stalled
  -- running job is reclaimed only while it has attempts left.
  return query
    with candidates as (
      select r.id, r.kind, r.product_id, r.next_attempt_at, r.created_at
      from public.integration_retry_queue r
      where (
          (r.status = 'queued'
           and (r.next_attempt_at <= pg_catalog.now() or r.id = claim_integration_jobs.only_job_id))
          or (r.status = 'running' and r.locked_at < pg_catalog.now() - interval '10 minutes'
              and r.attempts < r.max_attempts)
        )
        and (claim_integration_jobs.only_job_id is null or r.id = claim_integration_jobs.only_job_id)
        and not (
          r.kind = 'product_sync'
          and exists (
            select 1 from public.integration_retry_queue o
            where o.kind = 'product_sync' and o.status = 'running' and o.product_id = r.product_id
              and o.id <> r.id and o.locked_at >= pg_catalog.now() - interval '10 minutes'
          )
        )
      order by r.next_attempt_at, r.created_at
      limit 4 * n
      for update of r skip locked
    ),
    picked as (
      select c.id
      from (
        select c.id, c.kind, c.next_attempt_at, c.created_at,
               row_number() over (
                 partition by case when c.kind = 'product_sync' then c.product_id end,
                              case when c.kind = 'product_sync' then null else c.id end
                 order by c.next_attempt_at, c.created_at
               ) as rn
        from candidates c
      ) c
      where c.rn = 1
      order by c.next_attempt_at, c.created_at
      limit n
    )
    update public.integration_retry_queue r
    set status = 'running', locked_at = pg_catalog.now(), attempts = r.attempts + 1
    from picked p
    where r.id = p.id
    returning r.*;
end;
$$;

comment on function public.claim_integration_jobs(integer, uuid) is
  'service_role (the cron and the webhook route, step 3): claim up to max_jobs (1..50) due jobs (queued and due, or the one named by only_job_id even before it is due, or running and stale for 10 minutes with attempts left), oldest due first, at most one product sync per product; each becomes running with attempts + 1. First, a stalled product sync with a queued successor is dismissed, and a stalled job out of attempts becomes needs_attention (integration_job_stalled), its event failed for a shopify_event job.';

-- ---------------------------------------------------------------------------
-- record_product_sync_result (service_role): the body of
-- 20261115000200_product_groups.sql; a deferral handed to a successor
-- carries its code and message.
-- ---------------------------------------------------------------------------
create or replace function public.record_product_sync_result(
  product_id uuid,
  job_id uuid,
  outcome text,
  shopify_product_id text,
  shopify_variant_id text,
  shopify_inventory_item_id text,
  shopify_location_id text,
  pushed_quantity integer,
  pushed_price public.money_amount,
  desired_hash text,
  api_version text,
  error_code text,
  error_message text,
  retriable boolean
)
returns public.shopify_product_sync
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- Arguments are always written qualified (record_product_sync_result.x);
-- a bare name is the column.
#variable_conflict use_column
declare
  prod public.products;
  sync public.shopify_product_sync;
  job public.integration_retry_queue;
  has_job boolean := false;
  product_gid text;
  variant_gid text;
  item_gid text;
  location_gid text;
  origin text;
  successor uuid;
  settled public.shopify_sync_status;
  clean_message text := nullif(pg_catalog.btrim(record_product_sync_result.error_message), '');
  clean_code text := nullif(pg_catalog.btrim(record_product_sync_result.error_code), '');
begin
  if record_product_sync_result.product_id is null or record_product_sync_result.outcome is null then
    raise exception 'product_id and outcome are required' using errcode = '22004';
  end if;
  if record_product_sync_result.outcome not in ('pushed', 'unchanged', 'deferred', 'failed') then
    raise exception 'unknown sync outcome %', record_product_sync_result.outcome using errcode = '22023';
  end if;
  if record_product_sync_result.outcome = 'failed' and clean_message is null then
    raise exception 'a failed sync needs its human message' using errcode = '22004';
  end if;

  -- Lock order: the settings row (only when filling the Shopify location),
  -- the product (7), its sync row (8), then the job.
  if record_product_sync_result.outcome = 'pushed' then
    product_gid := private.shopify_gid('Product', record_product_sync_result.shopify_product_id);
    variant_gid := private.shopify_gid('ProductVariant', record_product_sync_result.shopify_variant_id);
    item_gid := private.shopify_gid('InventoryItem', record_product_sync_result.shopify_inventory_item_id);
    location_gid := private.shopify_gid('Location', record_product_sync_result.shopify_location_id);
    if product_gid is null or variant_gid is null or record_product_sync_result.pushed_quantity is null then
      raise exception 'a push needs the Shopify product and variant and the pushed quantity' using errcode = '22004';
    end if;
    if location_gid is not null then
      update public.shopify_settings s
      set shopify_location_id = location_gid
      where s.id = 1 and s.shopify_location_id is null;
    end if;
  end if;

  select p.* into prod from public.products p where p.id = record_product_sync_result.product_id for update;
  if not found then
    raise exception 'product % not found', record_product_sync_result.product_id using errcode = 'P0002';
  end if;
  select s.* into sync from public.shopify_product_sync s where s.product_id = prod.id for update;
  if not found then
    raise exception 'product % has no Shopify sync record', prod.id using errcode = 'P0002';
  end if;
  if record_product_sync_result.job_id is not null then
    select q.* into job from public.integration_retry_queue q where q.id = record_product_sync_result.job_id for update;
    if not found then
      raise exception 'integration job % not found', record_product_sync_result.job_id using errcode = 'P0002';
    end if;
    if job.kind <> 'product_sync' or job.product_id <> prod.id then
      raise exception 'job % is not a sync of product %', job.id, prod.id using errcode = '22023';
    end if;
    -- A job closed meanwhile (dismissed, superseded) is left as it is.
    has_job := job.status in ('queued', 'running', 'needs_attention');
  end if;
  select q.id into successor
  from public.integration_retry_queue q
  where q.kind = 'product_sync' and q.product_id = prod.id and q.status = 'queued'
    and q.id is distinct from record_product_sync_result.job_id;

  if record_product_sync_result.outcome = 'pushed' then
    if (prod.shopify_product_id is not null and prod.shopify_product_id <> product_gid)
       or (prod.shopify_variant_id is not null and prod.shopify_variant_id <> variant_gid) then
      raise exception using
        errcode = 'P0001',
        message = 'shopify_ids_conflict',
        detail = 'This product is already linked to a different Shopify product.';
    end if;
    origin := coalesce(sync.shopify_origin, 'bicii');
    -- A Shopify product BICII created belongs to this one product (D84).
    -- D243: a group's members share the group's Shopify product.
    if origin = 'bicii' and exists (
      select 1 from public.products o where o.shopify_product_id = product_gid and o.id <> prod.id
    ) and not (
      prod.product_group_id is not null and exists (
        select 1 from public.product_groups g
        where g.id = prod.product_group_id and g.shopify_product_id = product_gid
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'shopify_ids_conflict',
        detail = 'That Shopify product belongs to another BICII product.';
    end if;
    if prod.shopify_product_id is null or prod.shopify_variant_id is null then
      perform private.set_change_reason('Created in Shopify by the BICII sync');
      -- Another product's variant raises products_shopify_variant_id_key.
      update public.products p
      set shopify_product_id = product_gid, shopify_variant_id = variant_gid
      where p.id = prod.id;
      perform private.set_change_reason(null);
    end if;
    update public.shopify_product_sync s
    set shopify_origin = origin,
        shopify_inventory_item_id = coalesce(item_gid, s.shopify_inventory_item_id),
        shopify_handle = case
          when origin <> 'bicii' then null
          when prod.product_group_id is not null then (
            select private.shopify_handle(g.short_id) from public.product_groups g where g.id = prod.product_group_id
          )
          else private.shopify_handle(prod.short_id)
        end,
        last_pushed_at = pg_catalog.now(),
        last_checked_at = pg_catalog.now(),
        last_pushed_quantity = record_product_sync_result.pushed_quantity,
        last_pushed_price = record_product_sync_result.pushed_price,
        desired_hash = record_product_sync_result.desired_hash,
        api_version = record_product_sync_result.api_version,
        last_error_code = null,
        last_error = null
    where s.product_id = prod.id
    returning s.* into sync;
  elsif record_product_sync_result.outcome = 'unchanged' then
    update public.shopify_product_sync s
    set last_checked_at = pg_catalog.now(), last_error_code = null, last_error = null
    where s.product_id = prod.id
    returning s.* into sync;
  end if;

  if record_product_sync_result.outcome in ('pushed', 'unchanged') then
    settled := case
      when successor is not null then 'pending'
      when private.shopify_effective_online(prod, sync.publish_online) then 'synced'
      when sync.last_pushed_at is null then 'not_synced'
      else 'unpublished'
    end;
    update public.shopify_product_sync s set sync_status = settled where s.product_id = prod.id
    returning s.* into sync;
    if has_job then
      update public.integration_retry_queue q
      set status = 'done', resolved_at = pg_catalog.now(), locked_at = null,
          last_error_code = null, last_error = null
      where q.id = job.id;
    end if;
    -- A later successful sync resolves an older one that needed attention.
    update public.integration_retry_queue q
    set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
        resolution_reason = 'Resolved by a later sync'
    where q.kind = 'product_sync' and q.product_id = prod.id and q.status = 'needs_attention'
      and q.id is distinct from record_product_sync_result.job_id;

  elsif record_product_sync_result.outcome = 'deferred' then
    -- D83: wait two minutes for the order webhook; a deferral consumes no
    -- attempt. A newer queued job of the product takes the wait instead,
    -- with the deferral's code and message, so its run counts the wait as
    -- taken (A-19).
    if has_job then
      if successor is not null then
        update public.integration_retry_queue q
        set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
            resolution_reason = 'Superseded by a newer change'
        where q.id = job.id;
        update public.integration_retry_queue q
        set next_attempt_at = greatest(q.next_attempt_at, pg_catalog.now() + interval '2 minutes'),
            last_error_code = pg_catalog.left(clean_code, 100),
            last_error = pg_catalog.left(clean_message, 2000)
        where q.id = successor;
      else
        update public.integration_retry_queue q
        set status = 'queued', locked_at = null,
            next_attempt_at = pg_catalog.now() + interval '2 minutes',
            attempts = greatest(q.attempts - 1, 0),
            last_error_code = pg_catalog.left(clean_code, 100),
            last_error = pg_catalog.left(clean_message, 2000)
        where q.id = job.id;
      end if;
    end if;

  else
    -- 'failed' (D87).
    update public.shopify_product_sync s
    set sync_status = 'error', last_checked_at = pg_catalog.now(),
        last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
        last_error = pg_catalog.left(clean_message, 1000)
    where s.product_id = prod.id
    returning s.* into sync;
    if has_job then
      if coalesce(record_product_sync_result.retriable, false) and job.attempts < job.max_attempts then
        if successor is not null then
          update public.integration_retry_queue q
          set status = 'dismissed', resolved_at = pg_catalog.now(), resolved_by = null, locked_at = null,
              resolution_reason = 'Superseded by a newer change'
          where q.id = job.id;
          update public.integration_retry_queue q
          set next_attempt_at = greatest(q.next_attempt_at, pg_catalog.now() + private.integration_backoff(job.attempts))
          where q.id = successor;
        else
          update public.integration_retry_queue q
          set status = 'queued', locked_at = null,
              next_attempt_at = pg_catalog.now() + private.integration_backoff(job.attempts),
              last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
              last_error = pg_catalog.left(clean_message, 2000)
          where q.id = job.id;
        end if;
      else
        update public.integration_retry_queue q
        set status = 'needs_attention', locked_at = null, next_attempt_at = pg_catalog.now(),
            last_error_code = pg_catalog.left(coalesce(clean_code, 'shopify_sync_failed'), 100),
            last_error = pg_catalog.left(clean_message, 2000)
        where q.id = job.id;
      end if;
    end if;
  end if;

  return sync;
end;
$$;

comment on function public.record_product_sync_result(
  uuid, uuid, text, text, text, text, text, integer, public.money_amount, text, text, text, text, boolean
) is
  'service_role (the sync worker, step 3): record one sync. pushed: the Shopify product and variant ids are stored on products when missing (origin bicii; reason "Created in Shopify by the BICII sync"; different ids, or a BICII-created Shopify product another product carries -> shopify_ids_conflict), the inventory item, handle (bicii only), pushed quantity, price, hash and API version on the sync row, errors cleared, the Shopify location filled when missing, the job done. unchanged: checked now, errors cleared, job done. Both settle the status: pending when another sync is queued, else synced when effectively online, not_synced when never pushed, unpublished otherwise; and close older needs_attention syncs. deferred (D83): the job re-queued 2 minutes out without consuming an attempt. failed (D87): status error with the human message; the job re-queued with backoff when retriable and attempts remain, else needs_attention. A queued successor takes over a re-queue (a deferral hands it its code and message, so the wait is taken once). job_id may be null; an unknown outcome is 22023.';
