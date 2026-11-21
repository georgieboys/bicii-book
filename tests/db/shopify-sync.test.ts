/**
 * Shopify outbound: Publish online, the product-sync queue, the sync
 * worker's state and result RPCs, the settings, the sync status view and
 * the Buy-online link of reporting.public_items (SPEC §17, §25, §26;
 * DATA-MODEL §13, §14, §15, §16; PLAN D24 (amended), D26, D45, D58, D81
 * SHOP-UNIQUE, D83 SHOP-LOCATION, D84 SHOP-PUBLISH, D86 SHOP-ACCESS, D87
 * SHOP-RETRY, D89 SHOP-TAX-TEST; ADR-020).
 *
 * Tests create products, units, consignment items and jobs (the P, U, C
 * and J sequences), so everything but the seed and access checks runs only
 * on a per-file clone, in rolled-back transactions. The enqueue triggers
 * are deferred to commit; `flush` fires them the way a commit does. The
 * service-role RPCs are called as service_role, as the sync worker will
 * call them.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  LOCATION,
  SHOPIFY_GID,
  SHOPIFY_PRODUCT,
  SHOPIFY_PRODUCT_SHORT_ID,
  SHOPIFY_SETTINGS,
} from "../fixtures/ids";
import { orderPaidPayload, SHOPIFY_TEST_SHOP } from "../fixtures/shopify";
import {
  createConsignor,
  intakeQuantity,
  intakeUnique,
  staffWith,
  updateTerms,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  MECHANIC2,
  addPart,
  addPublicPhoto,
  addStock,
  makeLocation,
  makeProduct,
  makeUnit,
  newJob,
  publish,
  publishProduct,
  readAsOwner,
  setPublication,
  writeOff,
} from "./inventory-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sequence = 0;
const idBase = 8_500_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
/** A Shopify numeric id no other test (or the seed) uses. */
const nextShopifyId = () => idBase + ++sequence;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A rolled-back transaction acting as the admin. */
const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

/** Fires the deferred enqueue triggers now, as a commit would. */
async function flush(tx: pg.Client): Promise<void> {
  await tx.query("set constraints all immediate");
  await tx.query("set constraints all deferred");
}

/** Runs `fn` as the service role, then acts as `back` again. */
async function asService<T>(tx: pg.Client, fn: () => Promise<T>, back: Claims = ADMIN): Promise<T> {
  await actAs(tx, SERVICE);
  try {
    return await fn();
  } finally {
    await actAs(tx, back);
  }
}

/** A shop-owned, public quantity product with stock at `locationId`; ends as the admin. */
async function publicQuantityProduct(
  tx: pg.Client,
  {
    price = "20.00",
    stock = 5,
    locationId = LOCATION.shopFloor as string,
  }: { price?: string | null; stock?: number; locationId?: string } = {},
): Promise<string> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price });
  await addPublicPhoto(tx, "product", productId);
  await publish(tx, productId);
  await actAs(tx, ADMIN);
  if (stock > 0) await addStock(tx, productId, stock, { locationId });
  return productId;
}

type UnitSpec = { price?: string | null; locationId?: string };

/**
 * A shop-owned, public unique product whose units are created oldest first
 * (ascending ids, so the (created_at, id) order is the given order); ends
 * as the admin.
 */
async function publicUniqueProduct(
  tx: pg.Client,
  { price = "120.00", units = [{}] }: { price?: string | null; units?: UnitSpec[] } = {},
): Promise<{ productId: string; units: { unit_id: string; short_id: string }[] }> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { tracking: "unique", price });
  await actAs(tx, ADMIN);
  const ids = units.map(() => randomUUID()).sort();
  const created = [];
  for (const [i, u] of units.entries()) {
    created.push(
      await makeUnit(tx, productId, {
        unitId: ids[i],
        price: u.price ?? null,
        locationId: u.locationId ?? LOCATION.shopFloor,
      }),
    );
  }
  await ownerMode(tx);
  await addPublicPhoto(tx, "product", productId);
  await publish(tx, productId);
  await actAs(tx, ADMIN);
  return { productId, units: created };
}

type PublishResult = {
  product_id: string;
  publish_online: boolean;
  sync_status: string;
  job_id: string | null;
};

/** public.set_publish_online as whoever `tx` is. */
async function setPublish(tx: pg.Client, productId: string, on: boolean): Promise<PublishResult> {
  const { rows } = await tx.query<PublishResult>(
    `select (r).product_id, (r).publish_online, (r).sync_status::text as sync_status, (r).job_id
       from (select public.set_publish_online($1, $2) r) s`,
    [productId, on],
  );
  return rows[0];
}

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  last_error: string | null;
  resolution_reason: string | null;
  due_in_seconds: number;
};

/** The product's sync jobs (owner), oldest first. */
const syncJobs = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<JobRow>(
      `select id, status::text, attempts, next_attempt_at, last_error_code, last_error, resolution_reason,
              round(extract(epoch from next_attempt_at - now()))::int as due_in_seconds
         from public.integration_retry_queue
        where kind = 'product_sync' and product_id = $1
        order by created_at, id`,
      [productId],
    );
    return rows;
  });

const queuedJobs = async (tx: pg.Client, productId: string) =>
  (await syncJobs(tx, productId)).filter((j) => j.status === "queued");

type SyncRow = {
  publish_online: boolean;
  sync_status: string;
  shopify_origin: string | null;
  shopify_inventory_item_id: string | null;
  shopify_handle: string | null;
  last_pushed_at: Date | null;
  last_pushed_quantity: number | null;
  last_pushed_price: string | null;
  desired_hash: string | null;
  api_version: string | null;
  last_error_code: string | null;
  last_error: string | null;
};

/** The product's sync row (owner), or undefined. */
const syncRow = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<SyncRow>(
      `select publish_online, sync_status::text, shopify_origin, shopify_inventory_item_id, shopify_handle,
              last_pushed_at, last_pushed_quantity, last_pushed_price::text, desired_hash, api_version,
              last_error_code, last_error
         from public.shopify_product_sync where product_id = $1`,
      [productId],
    );
    return rows[0] as SyncRow | undefined;
  });

type SyncState = {
  product_id: string;
  short_id: string;
  tracking_type: string;
  publication_status: string;
  archived: boolean;
  sale_price: string | null;
  publish_online: boolean;
  effective_online: boolean;
  available_quantity: number;
  unit_price_conflicts: string[];
  public_photo_paths: string[];
  handle: string | null;
  shopify_origin: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_location_id: string | null;
  online_location_name: string;
  last_desired_hash: string | null;
  orders_in_flight: boolean;
  sync_status: string;
};

/** public.product_sync_state as the service role; ends as `back`. */
const syncState = (tx: pg.Client, productId: string, back: Claims = ADMIN) =>
  asService(
    tx,
    async () => {
      const { rows } = await tx.query<SyncState>(
        `select product_id, short_id, tracking_type::text, publication_status::text, archived,
                sale_price::text, publish_online, effective_online, available_quantity, unit_price_conflicts,
                public_photo_paths, handle, shopify_origin, shopify_product_id, shopify_variant_id,
                shopify_location_id, online_location_name, last_desired_hash, orders_in_flight,
                sync_status::text
           from public.product_sync_state($1)`,
        [productId],
      );
      return rows[0];
    },
    back,
  );

type ResultArgs = {
  productId: string;
  jobId?: string | null;
  outcome: string;
  productGid?: string | null;
  variantGid?: string | null;
  inventoryItemGid?: string | null;
  locationGid?: string | null;
  quantity?: number | null;
  price?: string | null;
  hash?: string | null;
  apiVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retriable?: boolean | null;
};

/** public.record_product_sync_result as whoever `tx` is; returns the sync row. */
async function recordResult(tx: pg.Client, a: ResultArgs) {
  const { rows } = await tx.query<SyncRow & { product_id: string }>(
    `select product_id, sync_status::text, shopify_origin, shopify_handle, shopify_inventory_item_id,
            last_pushed_quantity, last_pushed_price::text, last_error_code, last_error
       from public.record_product_sync_result($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      a.productId,
      a.jobId ?? null,
      a.outcome,
      a.productGid ?? null,
      a.variantGid ?? null,
      a.inventoryItemGid ?? null,
      a.locationGid ?? null,
      a.quantity ?? null,
      a.price ?? null,
      a.hash ?? null,
      a.apiVersion ?? null,
      a.errorCode ?? null,
      a.errorMessage ?? null,
      a.retriable ?? null,
    ],
  );
  return rows[0];
}

/** claim_integration_jobs for exactly one job, as the service role (stays service). */
async function claim(tx: pg.Client, jobId: string) {
  const { rows } = await tx.query<{ id: string; status: string; attempts: number }>(
    "select id, status::text, attempts from public.claim_integration_jobs(1, $1)",
    [jobId],
  );
  return rows;
}

/** The product's Shopify ids (owner). */
const productIds = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      shopify_product_id: string | null;
      shopify_variant_id: string | null;
    }>("select shopify_product_id, shopify_variant_id from public.products where id = $1", [
      productId,
    ]);
    return rows[0];
  });

/**
 * Runs the product's queued sync like the worker would: claim it, push the
 * state (fresh Shopify ids when it has none), record 'pushed'. Ends as the
 * admin. Returns the ids pushed.
 */
async function pushQueued(tx: pg.Client, productId: string, extra: Partial<ResultArgs> = {}) {
  const [job] = await queuedJobs(tx, productId);
  if (!job) throw new Error("no queued sync job");
  const ids = await productIds(tx, productId);
  const state = await syncState(tx, productId);
  const productGid = ids.shopify_product_id ?? `gid://shopify/Product/${nextShopifyId()}`;
  const variantGid = ids.shopify_variant_id ?? `gid://shopify/ProductVariant/${nextShopifyId()}`;
  const row = await asService(tx, async () => {
    expect(await claim(tx, job.id)).toHaveLength(1);
    return recordResult(tx, {
      productId,
      jobId: job.id,
      outcome: "pushed",
      productGid,
      variantGid,
      inventoryItemGid: `gid://shopify/InventoryItem/${nextShopifyId()}`,
      locationGid: SHOPIFY_SETTINGS.shopifyLocationId,
      quantity: state.effective_online ? state.available_quantity : 0,
      price: state.sale_price,
      hash: sha(`${productId}:${randomUUID()}`),
      apiVersion: "2026-07",
      ...extra,
    });
  });
  return { jobId: job.id, productGid, variantGid, row };
}

/** Closes the product's queued sync as 'unchanged' (a worker run that found nothing to do). */
async function settleQueued(tx: pg.Client, productId: string) {
  const [job] = await queuedJobs(tx, productId);
  if (!job) throw new Error("no queued sync job");
  await asService(tx, async () => {
    await claim(tx, job.id);
    await recordResult(tx, { productId, jobId: job.id, outcome: "unchanged" });
  });
}

/** A published product that is synced with no open job; ends as the admin. */
async function syncedProduct(tx: pg.Client, o: { price?: string; stock?: number } = {}) {
  const productId = await publicQuantityProduct(tx, o);
  await setPublish(tx, productId, true);
  await flush(tx);
  const pushed = await pushQueued(tx, productId);
  expect((await syncRow(tx, productId))?.sync_status).toBe("synced");
  return { productId, ...pushed };
}

/** After `change`, exactly one queued sync and a pending row (the dedupe), returned. */
async function expectOneQueued(tx: pg.Client, productId: string): Promise<string> {
  await flush(tx);
  const queued = await queuedJobs(tx, productId);
  expect(queued).toHaveLength(1);
  expect((await syncRow(tx, productId))?.sync_status).toBe("pending");
  return queued[0].id;
}

/** Owner: a needs_attention sync job for the product; returns its id. */
async function stuckJob(tx: pg.Client, productId: string): Promise<string> {
  return readAsOwner(tx, () =>
    scalar<string>(
      tx,
      `insert into public.integration_retry_queue (kind, product_id, status, attempts, last_error)
       values ('product_sync', $1, 'needs_attention', 8, 'Shopify said no') returning id`,
      [productId],
    ),
  );
}

const auditRows = (tx: pg.Client, productId: string, type: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      actor_staff_id: string | null;
      job_id: string | null;
      reason: string | null;
      payload: Record<string, unknown>;
      correlation_id: string | null;
    }>(
      `select actor_staff_id, job_id, reason, payload, correlation_id from public.integration_audit_events
        where product_id = $1 and event_type = $2 order by created_at`,
      [productId, type],
    );
    return rows;
  });

const shortIdOf = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, () =>
    scalar<string>(tx, "select short_id from public.products where id = $1", [productId]),
  );

/** public.link_shopify_variant as the admin (numeric ids); returns its sync row's origin and handle. */
async function linkVariant(
  tx: pg.Client,
  productId: string,
  shopifyProduct: number,
  variant: number,
) {
  const { rows } = await tx.query<{ shopify_origin: string | null; shopify_handle: string | null }>(
    "select shopify_origin, shopify_handle from public.link_shopify_variant($1, $2, $3, $4)",
    [productId, String(shopifyProduct), String(variant), "Matched to the product made in Shopify"],
  );
  return rows[0];
}

/** public.set_shopify_settings as whoever `tx` is. */
async function setSettings(
  tx: pg.Client,
  a: {
    locationId?: string;
    storefront?: string | null;
    acceptTests?: boolean;
    reason?: string | null;
  } = {},
) {
  const { rows } = await tx.query<{
    online_location_id: string;
    storefront_url: string | null;
    accept_test_orders: boolean;
    shopify_location_id: string | null;
  }>(
    `select online_location_id, storefront_url, accept_test_orders, shopify_location_id
       from public.set_shopify_settings($1, $2, $3, $4)`,
    [
      a.locationId ?? SHOPIFY_SETTINGS.onlineLocationId,
      a.storefront === undefined ? SHOPIFY_SETTINGS.storefrontUrl : a.storefront,
      a.acceptTests ?? SHOPIFY_SETTINGS.acceptTestOrders,
      a.reason ?? null,
    ],
  );
  return rows[0];
}

/** The public_items row of a short id as whoever `tx` is. */
async function publicRow(tx: pg.Client, shortId: string) {
  const { rows } = await tx.query<Record<string, unknown> & { buy_online_url: string | null }>(
    "select * from reporting.public_items where short_id = $1",
    [shortId],
  );
  return rows[0];
}

const handleOf = (shortId: string) => `bicii-${shortId.toLowerCase()}`;

// ---------------------------------------------------------------------------
// Publish online
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Publish online (D84, D86; D24 amended)", () => {
  it("needs manage_inventory: mechanic2 gets 42501, a staff member with manage_inventory publishes", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx);
      await ownerMode(tx);
      const inventory = await staffWith(tx, ["manage_inventory"]);
      for (const sql of [
        "select public.set_publish_online($1, true)",
        "select public.request_product_sync($1)",
      ]) {
        await actAs(tx, MECHANIC2);
        await failsWith(tx, () => tx.query(sql, [productId]), { code: "42501" });
      }
      await actAs(tx, inventory.claims);
      const result = await setPublish(tx, productId, true);
      expect(result).toMatchObject({ publish_online: true, sync_status: "pending" });
      expect(result.job_id).not.toBeNull();
      const audits = await auditRows(tx, productId, "publish_online_changed");
      expect(audits).toEqual([
        expect.objectContaining({
          actor_staff_id: inventory.staffId,
          job_id: result.job_id,
          payload: { from: false, to: true },
        }),
      ]);
    });
  });

  it("returns the single queued job and a pending row with one audit; a replay queues and audits nothing", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx);
      const first = await setPublish(tx, productId, true);
      const jobs = await syncJobs(tx, productId);
      expect(jobs).toEqual([expect.objectContaining({ id: first.job_id, status: "queued" })]);
      expect(await syncRow(tx, productId)).toMatchObject({
        publish_online: true,
        sync_status: "pending",
        shopify_handle: null,
        shopify_origin: null,
      });
      const replay = await setPublish(tx, productId, true);
      expect(replay).toEqual({
        product_id: productId,
        publish_online: true,
        sync_status: "pending",
        job_id: null,
      });
      await flush(tx);
      expect(await syncJobs(tx, productId)).toHaveLength(1);
      expect(await auditRows(tx, productId, "publish_online_changed")).toHaveLength(1);
    });
  });

  it("refuses a product that is not public, customer-owned, archived or without a price", async () => {
    await inTx(async (tx) => {
      // Not public (internal only, priced).
      await ownerMode(tx);
      const internal = await makeProduct(tx, { price: "30.00" });
      // Customer-owned (checked before publication).
      const customerOwned = randomUUID();
      await tx.query(
        `insert into public.products (id, name, tracking_type, ownership_type, publication_status)
         values ($1, 'Customer wheelset', 'unique', 'customer_owned', 'internal_only')`,
        [customerOwned],
      );
      // Archived (checked first).
      const archived = await makeProduct(tx, { price: "30.00" });
      await tx.query("update public.products set archived_at = now() where id = $1", [archived]);
      await actAs(tx, ADMIN);
      // Public, then its price removed (only NULL is missing).
      const unpriced = await publicQuantityProduct(tx);
      await tx.query("update public.products set default_sale_price = null where id = $1", [
        unpriced,
      ]);

      for (const [productId, message] of [
        [internal, "shopify_requires_public"],
        [customerOwned, "shopify_not_saleable"],
        [archived, "shopify_product_archived"],
        [unpriced, "shopify_price_missing"],
      ] as const) {
        await failsWith(tx, () => setPublish(tx, productId, true), { code: "P0001", message });
        expect({ productId, row: await syncRow(tx, productId) }).toEqual({
          productId,
          row: undefined,
        });
      }
      await failsWith(tx, () => setPublish(tx, randomUUID(), true), { code: "P0002" });
    });
  });

  it("a price of 0 is a price: it publishes and is the online price", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx, { price: "0.00" });
      expect(await setPublish(tx, productId, true)).toMatchObject({ publish_online: true });
      expect((await syncState(tx, productId)).sale_price).toBe("0.00");
      // A push of 0 at 0 is recorded too.
      const { row } = await pushQueued(tx, productId, { price: "0.00", quantity: 0 });
      expect(row).toMatchObject({ last_pushed_price: "0.00", last_pushed_quantity: 0 });
    });
  });

  it("unpublishing a product never pushed is not_synced with no job; unpublishing a pushed one queues its draft", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx);
      const published = await setPublish(tx, productId, true);
      const off = await setPublish(tx, productId, false);
      expect(off).toEqual({
        product_id: productId,
        publish_online: false,
        sync_status: "not_synced",
        job_id: null,
      });
      expect(await syncJobs(tx, productId)).toEqual([
        expect.objectContaining({
          id: published.job_id,
          status: "dismissed",
          resolution_reason: "Unpublished before the first sync",
        }),
      ]);
      expect(
        (await auditRows(tx, productId, "publish_online_changed")).map((a) => a.payload),
      ).toEqual([
        { from: false, to: true },
        { from: true, to: false },
      ]);
      // Stock changes of the unpublished, never-pushed product queue nothing.
      await addStock(tx, productId, 2);
      await flush(tx);
      expect(await queuedJobs(tx, productId)).toEqual([]);

      const synced = await syncedProduct(tx);
      const draft = await setPublish(tx, synced.productId, false);
      expect(draft.job_id).not.toBeNull();
      expect(draft.sync_status).toBe("pending");
      const { row } = await pushQueued(tx, synced.productId);
      expect(row.sync_status).toBe("unpublished");
    });
  });

  it("Sync now needs a published product and returns the queued job, due now, with the hash cleared", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx);
      await failsWith(tx, () => tx.query("select public.request_product_sync($1)", [productId]), {
        code: "P0001",
        message: "shopify_not_published",
      });
      const { productId: synced } = await syncedProduct(tx);
      expect((await syncRow(tx, synced))?.desired_hash).toMatch(/^[0-9a-f]{64}$/);
      const jobId = await scalar<string>(tx, "select public.request_product_sync($1)", [synced]);
      const queued = await queuedJobs(tx, synced);
      expect(queued).toEqual([expect.objectContaining({ id: jobId })]);
      expect(queued[0].due_in_seconds).toBeLessThanOrEqual(0);
      expect((await syncRow(tx, synced))?.desired_hash).toBeNull();
      // Again: the same job.
      expect(await scalar<string>(tx, "select public.request_product_sync($1)", [synced])).toBe(
        jobId,
      );
      expect(await auditRows(tx, synced, "sync_requested")).toEqual([
        expect.objectContaining({ job_id: jobId }),
        expect.objectContaining({ job_id: jobId }),
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Changes queue one sync per product (D84, D87)", () => {
  it("stock movements, a price edit and a public photo each leave exactly one queued job and supersede a stuck one", async () => {
    await inTx(async (tx) => {
      const { productId } = await syncedProduct(tx);

      await addStock(tx, productId, 3);
      await addStock(tx, productId, 2);
      await expectOneQueued(tx, productId);
      await settleQueued(tx, productId);

      const stuck = await stuckJob(tx, productId);
      await tx.query("update public.products set default_sale_price = 22.50 where id = $1", [
        productId,
      ]);
      await expectOneQueued(tx, productId);
      expect((await syncJobs(tx, productId)).find((j) => j.id === stuck)).toMatchObject({
        status: "dismissed",
        resolution_reason: "Superseded by a newer change",
      });
      await settleQueued(tx, productId);

      await ownerMode(tx);
      await addPublicPhoto(tx, "product", productId);
      await actAs(tx, ADMIN);
      await expectOneQueued(tx, productId);
      await settleQueued(tx, productId);

      // An internal photo is not pushed: nothing queued.
      await ownerMode(tx);
      await addPublicPhoto(tx, "product", productId, { visibility: "internal" });
      await actAs(tx, ADMIN);
      await flush(tx);
      expect(await queuedJobs(tx, productId)).toEqual([]);
      expect((await syncRow(tx, productId))?.sync_status).toBe("synced");
    });
  });

  it("a frame grade change queues one job, and the sync state carries the grade (D260)", async () => {
    await inTx(async (tx) => {
      const { productId } = await syncedProduct(tx);
      await tx.query("update public.products set frame_grade = 'B+' where id = $1", [productId]);
      await expectOneQueued(tx, productId);
      const state = await readAsOwner(tx, () =>
        tx.query<{ frame_grade: string | null }>(
          "select (public.product_sync_state($1)).frame_grade",
          [productId],
        ),
      );
      expect(state.rows).toEqual([{ frame_grade: "B+" }]);
    });
  });

  it("a unit status change and a unit price edit of a unique product each queue one job", async () => {
    await inTx(async (tx) => {
      const { productId, units } = await publicUniqueProduct(tx, { units: [{}, {}] });
      await setPublish(tx, productId, true);
      await flush(tx);
      await pushQueued(tx, productId);

      await writeOff(tx, units[1].unit_id);
      await expectOneQueued(tx, productId);
      await settleQueued(tx, productId);

      await tx.query("update public.inventory_units set sale_price = 99.00 where id = $1", [
        units[0].unit_id,
      ]);
      await expectOneQueued(tx, productId);
    });
  });

  it("a consignment asking-price change (update_consignment_terms) queues one job and moves the online price", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const item = await intakeQuantity(tx, {
        consignorId,
        agreed: "20.00",
        asking: "30.00",
        quantity: 4,
      });
      await ownerMode(tx);
      await addPublicPhoto(tx, "product", item.product_id);
      await actAs(tx, ADMIN);
      await publishProduct(tx, item.product_id);
      await setPublish(tx, item.product_id, true);
      await flush(tx);
      await pushQueued(tx, item.product_id);
      expect((await syncState(tx, item.product_id)).sale_price).toBe("30.00");

      await updateTerms(tx, item.item_id, { asking: "36.00", reason: "Price drop agreed" });
      await expectOneQueued(tx, item.product_id);
      expect((await syncState(tx, item.product_id)).sale_price).toBe("36.00");
    });
  });

  it("an online sale of a published product queues its sync", async () => {
    await inTx(async (tx) => {
      const { productId, productGid, variantGid } = await syncedProduct(tx, { stock: 4 });
      const orderId = nextShopifyId();
      const payload = orderPaidPayload({
        orderId,
        name: `#S${orderId}`,
        lines: [
          {
            lineItemId: nextShopifyId(),
            productId: Number(productGid.split("/").pop()),
            variantId: Number(variantGid.split("/").pop()),
            title: "Synced part",
            quantity: 1,
            price: "20.00",
          },
        ],
      });
      await asService(tx, async () => {
        const raw = JSON.stringify(payload);
        const { rows } = await tx.query<{ event_id: string }>(
          `select event_id from public.record_shopify_webhook('orders/paid', $1, null, $2, '2026-07', null,
                  '{}'::jsonb, $3::jsonb, $4, $5, true, null, null)`,
          [`sync-test-${randomUUID()}`, SHOPIFY_TEST_SHOP, raw, sha(raw), Buffer.byteLength(raw)],
        );
        const { rows: processed } = await tx.query<{ outcome: string }>(
          "select outcome from public.process_shopify_event($1)",
          [rows[0].event_id],
        );
        expect(processed[0].outcome).toBe("sale_recorded");
      });
      await expectOneQueued(tx, productId);
      expect((await syncState(tx, productId)).available_quantity).toBe(3);
    });
  });

  it("a product only linked to a Shopify-made product's variant is never queued until published", async () => {
    await inTx(async (tx) => {
      const productId = await publicQuantityProduct(tx);
      expect(await linkVariant(tx, productId, nextShopifyId(), nextShopifyId())).toEqual({
        shopify_origin: "external",
        shopify_handle: null,
      });
      await addStock(tx, productId, 4);
      await tx.query("update public.products set default_sale_price = 21.00 where id = $1", [
        productId,
      ]);
      await ownerMode(tx);
      await addPublicPhoto(tx, "product", productId);
      await actAs(tx, ADMIN);
      await flush(tx);
      expect(await syncJobs(tx, productId)).toEqual([]);
      expect((await syncRow(tx, productId))?.sync_status).toBe("not_synced");
      // Published: queued like any other.
      const published = await setPublish(tx, productId, true);
      expect(published.job_id).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Shopify-made products
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Shopify-made products are linked, not created (D84)", () => {
  it("two BICII products link two variants of one Shopify product; a BICII-created product is not shared", async () => {
    await inTx(async (tx) => {
      const a = await publicQuantityProduct(tx);
      const b = await publicQuantityProduct(tx);
      const shopifyProduct = nextShopifyId();
      expect(await linkVariant(tx, a, shopifyProduct, nextShopifyId())).toEqual({
        shopify_origin: "external",
        shopify_handle: null,
      });
      expect(await linkVariant(tx, b, shopifyProduct, nextShopifyId())).toEqual({
        shopify_origin: "external",
        shopify_handle: null,
      });

      // Published: the state says external with no handle; a push keeps it so.
      await setPublish(tx, a, true);
      await flush(tx);
      const state = await syncState(tx, a);
      expect(state).toMatchObject({
        shopify_origin: "external",
        handle: null,
        shopify_product_id: `gid://shopify/Product/${shopifyProduct}`,
        effective_online: true,
      });
      const { row } = await pushQueued(tx, a);
      expect(row).toMatchObject({
        shopify_origin: "external",
        shopify_handle: null,
        sync_status: "synced",
      });

      // A Shopify product BICII created belongs to that one product.
      const { productGid } = await syncedProduct(tx);
      const c = await publicQuantityProduct(tx);
      await failsWith(
        tx,
        () => linkVariant(tx, c, Number(productGid.split("/").pop()), nextShopifyId()),
        { code: "P0001", message: "shopify_ids_conflict" },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// product_sync_state
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "What the sync worker reads (product_sync_state; D81, D83)",
  () => {
    it("a quantity product's online quantity is the ledger at the online location, floored at 0", async () => {
      await inTx(async (tx) => {
        const productId = await publicQuantityProduct(tx, { stock: 5 });
        await addStock(tx, productId, 9, { locationId: LOCATION.workshopStore });
        await setPublish(tx, productId, true);
        const state = await syncState(tx, productId);
        expect(state).toMatchObject({
          tracking_type: "quantity",
          available_quantity: 5,
          sale_price: "20.00",
          effective_online: true,
          unit_price_conflicts: [],
          handle: handleOf(await shortIdOf(tx, productId)),
          shopify_origin: null,
          shopify_location_id: SHOPIFY_SETTINGS.shopifyLocationId,
          online_location_name: expect.any(String),
          sync_status: "pending",
        });
        expect(state.public_photo_paths).toHaveLength(1);

        // A job part takes the online location below zero (D23): 0 online.
        const job = await newJob(tx);
        await addPart(tx, {
          workOrderId: job.id,
          productId,
          quantity: 7,
          locationId: LOCATION.shopFloor,
        });
        expect((await syncState(tx, productId)).available_quantity).toBe(0);
      });
    });

    it("a unique product counts available units at the online location; its price is the oldest unit's selling price; others that differ conflict", async () => {
      await inTx(async (tx) => {
        const { productId, units } = await publicUniqueProduct(tx, {
          price: "120.00",
          units: [
            { price: "150.00" },
            {},
            { price: "150.00" },
            { locationId: LOCATION.workshopStore },
            {},
          ],
        });
        await writeOff(tx, units[4].unit_id);
        const state = await syncState(tx, productId);
        expect(state).toMatchObject({
          tracking_type: "unique",
          available_quantity: 3,
          sale_price: "150.00",
          unit_price_conflicts: [units[1].short_id],
        });

        // Without its own price the oldest unit sells at the product default.
        const plain = await publicUniqueProduct(tx, { price: "80.00", units: [{}, {}] });
        expect(await syncState(tx, plain.productId)).toMatchObject({
          available_quantity: 2,
          sale_price: "80.00",
          unit_price_conflicts: [],
        });
      });
    });

    it("a consigned unit sells online at its asking price, a consigned quantity product at its FIFO item's", async () => {
      await inTx(async (tx) => {
        const consignorId = await createConsignor(tx);
        const bike = await intakeUnique(tx, { consignorId, agreed: "700.00", asking: "900.00" });
        await ownerMode(tx);
        await tx.query("update public.products set default_sale_price = 500.00 where id = $1", [
          bike.product_id,
        ]);
        await actAs(tx, ADMIN);
        expect(await syncState(tx, bike.product_id)).toMatchObject({
          sale_price: "900.00",
          available_quantity: 1,
          unit_price_conflicts: [],
        });

        const first = await intakeQuantity(tx, {
          consignorId,
          agreed: "20.00",
          asking: "30.00",
          quantity: 2,
          receivedAt: "2026-09-01T10:00:00+08:00",
        });
        await intakeQuantity(tx, {
          consignorId,
          agreed: "25.00",
          asking: "35.00",
          quantity: 2,
          productId: first.product_id,
          receivedAt: "2026-09-02T10:00:00+08:00",
        });
        expect(await syncState(tx, first.product_id)).toMatchObject({
          sale_price: "30.00",
          available_quantity: 4,
        });
      });
    });

    it("effective_online is false when unpublished, archived or not public", async () => {
      await inTx(async (tx) => {
        // No stock: an archived product holds none.
        const productId = await publicQuantityProduct(tx, { stock: 0 });
        expect((await syncState(tx, productId)).effective_online).toBe(false);
        await setPublish(tx, productId, true);
        expect((await syncState(tx, productId)).effective_online).toBe(true);
        await setPublication(tx, productId, "internal_only", "Back to the shop only");
        expect(await syncState(tx, productId)).toMatchObject({
          effective_online: false,
          publication_status: "internal_only",
        });
        // Archiving needs the product off the public list and out of stock.
        await tx.query("update public.products set archived_at = now() where id = $1", [productId]);
        expect(await syncState(tx, productId)).toMatchObject({
          effective_online: false,
          archived: true,
          publish_online: true,
        });
      });
    });

    it("orders_in_flight is true while a recent orders/paid event is pending", async () => {
      await inTx(async (tx) => {
        const productId = await publicQuantityProduct(tx);
        expect((await syncState(tx, productId)).orders_in_flight).toBe(false);
        await asService(tx, async () => {
          const raw = JSON.stringify({ id: nextShopifyId(), name: "#INFLIGHT", line_items: [] });
          await tx.query(
            `select public.record_shopify_webhook('orders/paid', $1, null, $2, '2026-07', null,
                  '{}'::jsonb, $3::jsonb, $4, $5, true, null, null)`,
            [`sync-test-${randomUUID()}`, SHOPIFY_TEST_SHOP, raw, sha(raw), Buffer.byteLength(raw)],
          );
        });
        expect((await syncState(tx, productId)).orders_in_flight).toBe(true);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// record_product_sync_result
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "What a sync records (record_product_sync_result; D83, D84, D87)",
  () => {
    it("pushed stores the ids on the product (origin bicii), the item and handle on the sync row, clears errors, finishes the job and fills the location", async () => {
      await inTx(async (tx) => {
        const productId = await publicQuantityProduct(tx, { stock: 6 });
        await setPublish(tx, productId, true);
        await readAsOwner(tx, () =>
          tx.query(
            "update public.shopify_product_sync set last_error_code = 'old', last_error = 'Old failure' where product_id = $1",
            [productId],
          ),
        );
        await readAsOwner(tx, () =>
          tx.query("update public.shopify_settings set shopify_location_id = null"),
        );
        const location = `gid://shopify/Location/${nextShopifyId()}`;
        const { jobId, productGid, variantGid, row } = await pushQueued(tx, productId, {
          locationGid: location,
          quantity: 6,
        });
        const shortId = await shortIdOf(tx, productId);
        expect(row).toMatchObject({
          sync_status: "synced",
          shopify_origin: "bicii",
          shopify_handle: handleOf(shortId),
          last_pushed_quantity: 6,
          last_pushed_price: "20.00",
          last_error_code: null,
          last_error: null,
        });
        expect(row.shopify_inventory_item_id).toMatch(/^gid:\/\/shopify\/InventoryItem\//);
        expect(await productIds(tx, productId)).toEqual({
          shopify_product_id: productGid,
          shopify_variant_id: variantGid,
        });
        expect(await syncJobs(tx, productId)).toEqual([
          expect.objectContaining({ id: jobId, status: "done" }),
        ]);
        expect(
          await readAsOwner(tx, () =>
            scalar<string>(tx, "select shopify_location_id from public.shopify_settings"),
          ),
        ).toBe(location);
        const history = await readAsOwner(tx, async () => {
          const { rows } = await tx.query(
            "select reason from public.product_events where product_id = $1 and event_type = 'details_changed'",
            [productId],
          );
          return rows;
        });
        expect(history).toContainEqual({ reason: "Created in Shopify by the BICII sync" });
      });
    });

    it("pushed while another sync is queued stays pending; conflicting ids are shopify_ids_conflict", async () => {
      await inTx(async (tx) => {
        const productId = await publicQuantityProduct(tx);
        await setPublish(tx, productId, true);
        const [job] = await queuedJobs(tx, productId);
        await asService(tx, () => claim(tx, job.id));
        await addStock(tx, productId, 1);
        await flush(tx);
        const [successor] = await queuedJobs(tx, productId);
        expect(successor.id).not.toBe(job.id);
        const productGid = `gid://shopify/Product/${nextShopifyId()}`;
        const variantGid = `gid://shopify/ProductVariant/${nextShopifyId()}`;
        const row = await asService(tx, () =>
          recordResult(tx, {
            productId,
            jobId: job.id,
            outcome: "pushed",
            productGid,
            variantGid,
            quantity: 5,
            price: "20.00",
          }),
        );
        expect(row.sync_status).toBe("pending");
        expect((await syncJobs(tx, productId)).map((j) => [j.id, j.status])).toEqual(
          expect.arrayContaining([
            [job.id, "done"],
            [successor.id, "queued"],
          ]),
        );

        await asService(tx, async () => {
          await failsWith(
            tx,
            () =>
              recordResult(tx, {
                productId,
                outcome: "pushed",
                productGid: `gid://shopify/Product/${nextShopifyId()}`,
                variantGid,
                quantity: 5,
              }),
            { code: "P0001", message: "shopify_ids_conflict" },
          );
        });

        // A BICII-created Shopify product another BICII product carries.
        const other = await publicQuantityProduct(tx);
        await setPublish(tx, other, true);
        await asService(tx, async () => {
          await failsWith(
            tx,
            () =>
              recordResult(tx, {
                productId: other,
                outcome: "pushed",
                productGid,
                variantGid: `gid://shopify/ProductVariant/${nextShopifyId()}`,
                quantity: 1,
              }),
            { code: "P0001", message: "shopify_ids_conflict" },
          );
          await failsWith(tx, () => recordResult(tx, { productId: other, outcome: "skipped" }), {
            code: "22023",
          });
        });
      });
    });

    it("deferred re-queues two minutes out without consuming an attempt; the sync row is unchanged", async () => {
      await inTx(async (tx) => {
        const { productId } = await syncedProduct(tx);
        await addStock(tx, productId, 1);
        const jobId = await expectOneQueued(tx, productId);
        const before = await syncRow(tx, productId);
        await asService(tx, async () => {
          expect(await claim(tx, jobId)).toEqual([expect.objectContaining({ attempts: 1 })]);
          await recordResult(tx, {
            productId,
            jobId,
            outcome: "deferred",
            errorCode: "shopify_order_in_flight",
            errorMessage:
              "Waiting for an online order to arrive before overwriting Shopify's count.",
          });
        });
        const [job] = await syncJobs(tx, productId).then((jobs) =>
          jobs.filter((j) => j.id === jobId),
        );
        expect(job).toMatchObject({
          status: "queued",
          attempts: 0,
          last_error_code: "shopify_order_in_flight",
        });
        expect(job.due_in_seconds).toBeGreaterThanOrEqual(115);
        expect(job.due_in_seconds).toBeLessThanOrEqual(125);
        expect(await syncRow(tx, productId)).toEqual(before);
      });
    });

    it("deferred with a newer change queued hands the wait, its code and message to the successor (A-19)", async () => {
      await inTx(async (tx) => {
        const { productId } = await syncedProduct(tx);
        await addStock(tx, productId, 1);
        const jobId = await expectOneQueued(tx, productId);
        await asService(tx, async () => {
          expect(await claim(tx, jobId)).toHaveLength(1);
        });
        // A change while the job runs queues a successor.
        await addStock(tx, productId, 1);
        const successor = await expectOneQueued(tx, productId);
        expect(successor).not.toBe(jobId);
        const message = "Shopify's count changed. BICII will check again shortly.";
        await asService(tx, async () => {
          await recordResult(tx, {
            productId,
            jobId,
            outcome: "deferred",
            errorCode: "shopify_quantity_changed",
            errorMessage: message,
          });
        });
        const jobs = await syncJobs(tx, productId);
        expect(jobs.find((j) => j.id === jobId)).toMatchObject({
          status: "dismissed",
          resolution_reason: "Superseded by a newer change",
        });
        const next = jobs.find((j) => j.id === successor)!;
        // The successor's run sees the wait as taken and overwrites.
        expect(next).toMatchObject({
          status: "queued",
          last_error_code: "shopify_quantity_changed",
          last_error: message,
        });
        expect(next.due_in_seconds).toBeGreaterThanOrEqual(115);
        expect(next.due_in_seconds).toBeLessThanOrEqual(125);
        await asService(tx, async () => {
          const [claimed] = (
            await tx.query<{ last_error_code: string | null }>(
              "select last_error_code from public.claim_integration_jobs(1, $1)",
              [successor],
            )
          ).rows;
          expect(claimed.last_error_code).toBe("shopify_quantity_changed");
        });
      });
    });

    it("failed and retriable backs off with status error and the message; not retriable needs attention", async () => {
      await inTx(async (tx) => {
        const { productId } = await syncedProduct(tx);
        await addStock(tx, productId, 1);
        const jobId = await expectOneQueued(tx, productId);
        await asService(tx, async () => {
          await claim(tx, jobId);
          await recordResult(tx, {
            productId,
            jobId,
            outcome: "failed",
            errorCode: "shopify_throttled",
            errorMessage: "Shopify is busy. BICII will try again shortly.",
            retriable: true,
          });
        });
        let job = (await syncJobs(tx, productId)).find((j) => j.id === jobId)!;
        expect(job).toMatchObject({
          status: "queued",
          attempts: 1,
          last_error: "Shopify is busy. BICII will try again shortly.",
        });
        expect(job.due_in_seconds).toBeGreaterThanOrEqual(55);
        expect(job.due_in_seconds).toBeLessThanOrEqual(65);
        expect(await syncRow(tx, productId)).toMatchObject({
          sync_status: "error",
          last_error_code: "shopify_throttled",
          last_error: "Shopify is busy. BICII will try again shortly.",
        });

        await asService(tx, async () => {
          await claim(tx, jobId);
          await recordResult(tx, {
            productId,
            jobId,
            outcome: "failed",
            errorCode: "shopify_user_error",
            errorMessage: "Shopify refused the title.",
            retriable: false,
          });
        });
        job = (await syncJobs(tx, productId)).find((j) => j.id === jobId)!;
        expect(job).toMatchObject({
          status: "needs_attention",
          last_error: "Shopify refused the title.",
        });
        expect((await syncRow(tx, productId))?.sync_status).toBe("error");
      });
    });

    it("a push recorded without the job or hash, then a failed job, keeps the ids and quantity and retries (A-09)", async () => {
      await inTx(async (tx) => {
        const productId = await publicQuantityProduct(tx);
        await setPublish(tx, productId, true);
        await flush(tx);
        const [job] = await queuedJobs(tx, productId);
        const productGid = `gid://shopify/Product/${nextShopifyId()}`;
        const variantGid = `gid://shopify/ProductVariant/${nextShopifyId()}`;
        const itemGid = `gid://shopify/InventoryItem/${nextShopifyId()}`;
        const state = await syncState(tx, productId);
        await asService(tx, async () => {
          expect(await claim(tx, job.id)).toHaveLength(1);
          // What the runner keeps before publishing to the Online Store.
          await recordResult(tx, {
            productId,
            jobId: null,
            outcome: "pushed",
            productGid,
            variantGid,
            inventoryItemGid: itemGid,
            locationGid: SHOPIFY_SETTINGS.shopifyLocationId,
            quantity: state.available_quantity,
            price: state.sale_price,
            apiVersion: "2026-07",
          });
          // The publish was throttled.
          await recordResult(tx, {
            productId,
            jobId: job.id,
            outcome: "failed",
            errorCode: "shopify_throttled",
            errorMessage: "Shopify is busy. BICII will try again shortly.",
            retriable: true,
          });
        });
        expect(await productIds(tx, productId)).toEqual({
          shopify_product_id: productGid,
          shopify_variant_id: variantGid,
        });
        expect(await syncRow(tx, productId)).toMatchObject({
          sync_status: "error",
          shopify_inventory_item_id: itemGid,
          last_pushed_quantity: state.available_quantity,
          desired_hash: null,
          last_error_code: "shopify_throttled",
        });
        expect((await syncJobs(tx, productId)).find((j) => j.id === job.id)).toMatchObject({
          status: "queued",
          attempts: 1,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Shopify settings (D83, D86, D89)", () => {
  it("are admin-only; recording test orders changes only with a reason; same values change nothing", async () => {
    await inTx(async (tx) => {
      await actAs(tx, MECHANIC1);
      await failsWith(tx, () => setSettings(tx), { code: "42501" });
      await actAs(tx, ADMIN);
      const count = () =>
        readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.integration_audit_events where event_type = 'settings_changed'",
          ),
        );
      const before = await count();
      expect(await setSettings(tx)).toMatchObject({
        storefront_url: SHOPIFY_SETTINGS.storefrontUrl,
        accept_test_orders: SHOPIFY_SETTINGS.acceptTestOrders,
      });
      expect(await count()).toBe(before);
      await failsWith(tx, () => setSettings(tx, { acceptTests: false }), {
        code: "P0001",
        message: "reason_required",
      });
      expect(
        await setSettings(tx, { acceptTests: false, reason: "Go-live: test orders are not sales" }),
      ).toMatchObject({ accept_test_orders: false });
      const audit = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          `select actor_staff_id is not null as has_actor, reason, payload from public.integration_audit_events
            where event_type = 'settings_changed' order by created_at desc limit 1`,
        );
        return rows[0];
      });
      expect(audit).toMatchObject({
        has_actor: true,
        reason: "Go-live: test orders are not sales",
        payload: {
          from: { accept_test_orders: true },
          to: { accept_test_orders: false },
        },
      });
      // The storefront: https or nothing, trailing slash trimmed.
      expect(
        (await setSettings(tx, { acceptTests: false, storefront: "https://shop.example.test/" }))
          .storefront_url,
      ).toBe("https://shop.example.test");
      await failsWith(
        tx,
        () => setSettings(tx, { acceptTests: false, storefront: "http://shop.example.test" }),
        { code: "23514", constraint: "shopify_settings_storefront_url_check" },
      );
      expect(
        (await setSettings(tx, { acceptTests: false, storefront: null })).storefront_url,
      ).toBeNull();
    });
  });

  it("the online location must exist and be active; changing it queues every published product, never a link-only one", async () => {
    await inTx(async (tx) => {
      const { productId } = await syncedProduct(tx);
      const linked = await publicQuantityProduct(tx);
      await linkVariant(tx, linked, nextShopifyId(), nextShopifyId());
      await ownerMode(tx);
      const inactive = await makeLocation(tx, { active: false });
      await actAs(tx, ADMIN);
      await failsWith(tx, () => setSettings(tx, { locationId: randomUUID() }), { code: "P0002" });
      await failsWith(tx, () => setSettings(tx, { locationId: inactive }), {
        code: "P0001",
        message: "location_inactive",
      });
      expect(await queuedJobs(tx, SHOPIFY_PRODUCT.syncedTyre)).toEqual([]);

      await setSettings(tx, { locationId: LOCATION.workshopStore });
      for (const id of [productId, SHOPIFY_PRODUCT.syncedTyre]) {
        expect({ id, queued: (await queuedJobs(tx, id)).length }).toEqual({ id, queued: 1 });
        expect((await syncRow(tx, id))?.sync_status).toBe("pending");
      }
      expect(await syncJobs(tx, linked)).toEqual([]);
      expect((await syncState(tx, productId)).available_quantity).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// The Buy-online link
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Buy online link (D84; Phase 11 consumes it)", () => {
  it("is storefront/products/<handle> for a published, synced, available BICII-created product, product and unit rows, read by anon", async () => {
    await inTx(async (tx) => {
      const { productId } = await syncedProduct(tx);
      const shortId = await shortIdOf(tx, productId);
      const unique = await publicUniqueProduct(tx, { units: [{}] });
      await setPublish(tx, unique.productId, true);
      await flush(tx);
      await pushQueued(tx, unique.productId);
      const uniqueShortId = await shortIdOf(tx, unique.productId);

      await actAs(tx, ANON);
      expect((await publicRow(tx, shortId)).buy_online_url).toBe(
        `${SHOPIFY_SETTINGS.storefrontUrl}/products/${handleOf(shortId)}`,
      );
      for (const sid of [uniqueShortId, unique.units[0].short_id]) {
        expect({ sid, url: (await publicRow(tx, sid)).buy_online_url }).toEqual({
          sid,
          url: `${SHOPIFY_SETTINGS.storefrontUrl}/products/${handleOf(uniqueShortId)}`,
        });
      }
      // Never a Shopify id, sync state or cost.
      const row = await publicRow(tx, shortId);
      expect(Object.keys(row)).toEqual([
        "kind",
        "short_id",
        "slug",
        "name",
        "description",
        "brand",
        "category",
        "condition",
        "sale_price",
        "currency",
        "availability",
        "photos",
        "updated_at",
        "buy_online_url",
        "group_short_id",
        "group_name",
        "option_name",
        "option_value",
        "frame_grade",
      ]);
      const { rows: all } = await tx.query("select * from reporting.public_items");
      expect(JSON.stringify(all)).not.toMatch(/gid:\/\/shopify|synced|pending|InventoryItem/);
    });
  });

  it("is null when unpublished, pending, in error, external, without a storefront or not available", async () => {
    await inTx(async (tx) => {
      const urlOf = async (sid: string) => {
        await actAs(tx, ANON);
        const url = (await publicRow(tx, sid)).buy_online_url;
        await actAs(tx, ADMIN);
        return url;
      };

      // Pending: a change is queued.
      const pending = await syncedProduct(tx);
      const pendingSid = await shortIdOf(tx, pending.productId);
      expect(await urlOf(pendingSid)).not.toBeNull();
      await addStock(tx, pending.productId, 1);
      await flush(tx);
      expect(await urlOf(pendingSid)).toBeNull();

      // Error: the last sync failed.
      await asService(tx, async () => {
        const [job] = await queuedJobs(tx, pending.productId);
        await claim(tx, job.id);
        await recordResult(tx, {
          productId: pending.productId,
          jobId: job.id,
          outcome: "failed",
          errorMessage: "Shopify is down.",
          retriable: true,
        });
      });
      expect((await syncRow(tx, pending.productId))?.sync_status).toBe("error");
      expect(await urlOf(pendingSid)).toBeNull();

      // Unpublished (drafted in Shopify).
      const off = await syncedProduct(tx);
      const offSid = await shortIdOf(tx, off.productId);
      await setPublish(tx, off.productId, false);
      await pushQueued(tx, off.productId);
      expect((await syncRow(tx, off.productId))?.sync_status).toBe("unpublished");
      expect(await urlOf(offSid)).toBeNull();

      // External origin: synced, but no handle.
      const external = await publicQuantityProduct(tx);
      await linkVariant(tx, external, nextShopifyId(), nextShopifyId());
      await setPublish(tx, external, true);
      await flush(tx);
      await pushQueued(tx, external);
      expect((await syncRow(tx, external))?.sync_status).toBe("synced");
      expect(await urlOf(await shortIdOf(tx, external))).toBeNull();

      // Not available: sold out (synced again afterwards).
      const soldOut = await syncedProduct(tx, { stock: 2 });
      const soldOutSid = await shortIdOf(tx, soldOut.productId);
      await addStock(tx, soldOut.productId, -2, { reason: "Damaged in the shop" });
      await flush(tx);
      await pushQueued(tx, soldOut.productId);
      expect((await syncRow(tx, soldOut.productId))?.sync_status).toBe("synced");
      await actAs(tx, ANON);
      expect(await publicRow(tx, soldOutSid)).toMatchObject({
        availability: "sold_out",
        buy_online_url: null,
      });
      await actAs(tx, ADMIN);

      // Not available: a unit that sold (written off here) has no link.
      const unique = await publicUniqueProduct(tx, { units: [{}, {}] });
      await setPublish(tx, unique.productId, true);
      await flush(tx);
      await pushQueued(tx, unique.productId);
      await writeOff(tx, unique.units[0].unit_id);
      await flush(tx);
      await pushQueued(tx, unique.productId);
      const uniqueSid = await shortIdOf(tx, unique.productId);
      expect(await urlOf(uniqueSid)).not.toBeNull();
      expect(await urlOf(unique.units[1].short_id)).not.toBeNull();
      await actAs(tx, ANON);
      expect(
        (
          await tx.query("select 1 from reporting.public_items where short_id = $1", [
            unique.units[0].short_id,
          ])
        ).rowCount,
      ).toBe(0);
      await actAs(tx, ADMIN);

      // No storefront: nothing links anywhere.
      const synced = await syncedProduct(tx);
      const syncedSid = await shortIdOf(tx, synced.productId);
      expect(await urlOf(syncedSid)).not.toBeNull();
      await setSettings(tx, { storefront: null });
      expect(await urlOf(syncedSid)).toBeNull();
      expect(await urlOf(SHOPIFY_PRODUCT_SHORT_ID.syncedTyre)).toBeNull();
    });
  });

  it("links only what Shopify sells: the oldest unit at the online location, and a product row only at the online price (D81)", async () => {
    await inTx(async (tx) => {
      const urlOf = async (sid: string) => {
        await actAs(tx, ANON);
        const url = (await publicRow(tx, sid)).buy_online_url;
        await actAs(tx, ADMIN);
        return url;
      };

      // Two units at the online location (same price, so the sync does not
      // refuse) and one elsewhere at its own price: only the oldest online
      // unit, the one an order takes, links; the product row's price is the
      // online price, so it links too.
      const unique = await publicUniqueProduct(tx, {
        price: "120.00",
        units: [{}, {}, { price: "90.00", locationId: LOCATION.workshopStore }],
      });
      await setPublish(tx, unique.productId, true);
      await flush(tx);
      await pushQueued(tx, unique.productId);
      expect((await syncRow(tx, unique.productId))?.sync_status).toBe("synced");
      const sid = await shortIdOf(tx, unique.productId);
      const url = `${SHOPIFY_SETTINGS.storefrontUrl}/products/${handleOf(sid)}`;
      expect(await urlOf(sid)).toBe(url);
      expect(await urlOf(unique.units[0].short_id)).toBe(url);
      // The second online unit is available but an order would take the first.
      expect(await urlOf(unique.units[1].short_id)).toBeNull();
      // The unit at another location shows 90.00; Shopify charges 120.00.
      await actAs(tx, ANON);
      expect(await publicRow(tx, unique.units[2].short_id)).toMatchObject({
        availability: "available",
        sale_price: "90.00",
        buy_online_url: null,
      });
      await actAs(tx, ADMIN);

      // The oldest online unit leaves: the next one is what an order takes.
      await writeOff(tx, unique.units[0].unit_id);
      await flush(tx);
      await pushQueued(tx, unique.productId);
      expect(await urlOf(unique.units[1].short_id)).toBe(url);
      expect(await urlOf(unique.units[2].short_id)).toBeNull();

      // A unit priced above its product's default: Shopify charges the
      // unit's 150.00, the product row shows 100.00, so only the unit links.
      const priced = await publicUniqueProduct(tx, {
        price: "100.00",
        units: [{ price: "150.00" }],
      });
      await setPublish(tx, priced.productId, true);
      await flush(tx);
      await pushQueued(tx, priced.productId);
      expect((await syncRow(tx, priced.productId))?.sync_status).toBe("synced");
      expect((await syncState(tx, priced.productId)).sale_price).toBe("150.00");
      const pricedSid = await shortIdOf(tx, priced.productId);
      await actAs(tx, ANON);
      expect(await publicRow(tx, pricedSid)).toMatchObject({
        availability: "available",
        sale_price: "100.00",
        buy_online_url: null,
      });
      expect((await publicRow(tx, priced.units[0].short_id)).buy_online_url).toBe(
        `${SHOPIFY_SETTINGS.storefrontUrl}/products/${handleOf(pricedSid)}`,
      );
      await actAs(tx, ADMIN);
    });
  });
});

// ---------------------------------------------------------------------------
// DATA-MODEL §15
// ---------------------------------------------------------------------------

describe("Who can reach it (DATA-MODEL §15; D86)", () => {
  it("anon and authenticated (admin included) get 42501 from the sync worker's RPCs", async () => {
    await inTransaction(conn, async (tx) => {
      const calls = [
        `select * from public.product_sync_state('${SHOPIFY_PRODUCT.syncedTyre}')`,
        `select * from public.record_product_sync_result('${SHOPIFY_PRODUCT.syncedTyre}', null, 'unchanged',
           null, null, null, null, null, null, null, null, null, null, null)`,
      ];
      for (const claims of [ANON, ADMIN, MECHANIC2]) {
        for (const sql of calls) {
          await actAs(tx, claims);
          await failsWith(tx, () => tx.query(sql), {
            code: "42501",
            message: expect.stringContaining("permission denied for function"),
          });
        }
      }
      await actAs(tx, ANON);
      for (const sql of [
        `select public.set_publish_online('${SHOPIFY_PRODUCT.syncedTyre}', false)`,
        "select * from reporting.shopify_sync_status",
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
    });
  });

  it("every staff member reads the sync status; the open job shows to admins only", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      const jobId = await scalar<string>(tx, "select public.request_product_sync($1)", [
        SHOPIFY_PRODUCT.syncedTyre,
      ]);
      const read = async (claims: Claims) => {
        await actAs(tx, claims);
        const { rows } = await tx.query(
          `select short_id, publish_online, shopify_origin, sync_status::text, shopify_variant_id, open_job_id,
                  open_job_status::text, open_job_next_attempt_at
             from reporting.shopify_sync_status where product_id = $1`,
          [SHOPIFY_PRODUCT.syncedTyre],
        );
        return rows;
      };
      expect(await read(ADMIN)).toEqual([
        expect.objectContaining({
          short_id: SHOPIFY_PRODUCT_SHORT_ID.syncedTyre,
          publish_online: true,
          shopify_origin: "bicii",
          sync_status: "pending",
          shopify_variant_id: SHOPIFY_GID.syncedTyreVariant,
          open_job_id: jobId,
          open_job_status: "queued",
        }),
      ]);
      expect(await read(MECHANIC2)).toEqual([
        expect.objectContaining({
          short_id: SHOPIFY_PRODUCT_SHORT_ID.syncedTyre,
          sync_status: "pending",
          open_job_id: null,
          open_job_status: null,
          open_job_next_attempt_at: null,
        }),
      ]);
    });
  });
});

describe("Seeded sync data is consistent", () => {
  it("syncedTyre is synced with no open sync job and links to its storefront page", async () => {
    await inTransaction(conn, async (tx) => {
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            `select count(*)::int from public.integration_retry_queue
              where kind = 'product_sync' and status in ('queued', 'running', 'needs_attention')`,
          ),
        ),
      ).toBe(0);
      expect((await syncRow(tx, SHOPIFY_PRODUCT.syncedTyre))?.sync_status).toBe("synced");
      await actAs(tx, ANON);
      expect((await publicRow(tx, SHOPIFY_PRODUCT_SHORT_ID.syncedTyre)).buy_online_url).toBe(
        `${SHOPIFY_SETTINGS.storefrontUrl}/products/${SHOPIFY_GID.syncedTyreHandle}`,
      );
    });
  });
});
