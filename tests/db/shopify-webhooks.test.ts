/**
 * Shopify inbound: webhook recording, the queue, order and refund
 * processing, retries, dismissals, links and the integration exceptions
 * (SPEC §2 "Idempotent ... mutations", §10, §13, §17, §23, §25, §26, §27.2;
 * DATA-MODEL §8, §13, §14, §15, §16; PLAN D1, D7, D24 (amended), D26, D49,
 * D80 SHOP-PRICE, D81 SHOP-UNIQUE, D82 SHOP-STOCK, D85 SHOP-REFUND, D86
 * SHOP-ACCESS, D87 SHOP-RETRY, D88 SHOP-REJECTED, D89 SHOP-TAX-TEST;
 * ADR-020).
 *
 * Tests create products, units, sales and events (the P, U, C and S
 * sequences), and the concurrency cases commit, so everything but the
 * seed and access checks runs only on a per-file clone. They set up their
 * own Shopify mappings as the owner and use fresh Shopify ids
 * (nextShopifyId), never the seeded events, except "Seeded integration data
 * is consistent". The service-role RPCs are called as service_role, as the
 * webhook route will call them.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CUSTOMER,
  LOCATION,
  SHOPIFY_GID,
  SHOPIFY_ORDER,
  SHOPIFY_PRODUCT,
  SHOPIFY_PRODUCT_SHORT_ID,
  SHOPIFY_SETTINGS,
  SHOPIFY_WEBHOOK_ID,
  STAFF,
} from "../fixtures/ids";
import {
  orderPaidPayload,
  refundPayload,
  SHOPIFY_TEST_SHOP,
  type OrderLineInput,
  type OrderPaidInput,
  type RefundInput,
} from "../fixtures/shopify";
import {
  addCharge,
  createConsignor,
  intakeQuantity,
  intakeUnique,
  itemLedger,
  itemStatus,
  recordSale,
  saleLines,
  staffWith,
} from "./consignment-fixtures";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
  type Claims,
} from "./harness";
import {
  ADMIN,
  MECHANIC1,
  MECHANIC2,
  addPublicPhoto,
  addStock,
  assertLedgerConsistent,
  committed,
  makeProduct,
  makeUnit,
  onHand,
  publication,
  publishProduct,
  readAsOwner,
  type Outcome,
} from "./inventory-fixtures";
import { seedToday, addDays } from "./reporting-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };

let conn: pg.Client;
let setup: pg.Client;

beforeAll(async () => {
  conn = await connect();
  setup = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sequence = 0;
const idBase = 8_000_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
/** A Shopify numeric id no other test (or the seed) uses. */
const nextShopifyId = () => idBase + ++sequence;
const newWebhookId = () => `test-webhook-${randomUUID()}`;

/** A rolled-back transaction acting as the admin. */
const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Recorded = {
  event_id: string;
  duplicate: boolean;
  event_status: string;
  job_id: string | null;
  webhookId: string;
};

type Processed = {
  event_status: string;
  outcome: string | null;
  sale_id: string | null;
  error_code: string | null;
  error_message: string | null;
};

/** public.record_shopify_webhook as whoever `tx` is. */
async function record(
  tx: pg.Client,
  a: {
    topic: string;
    payload: unknown;
    webhookId?: string;
    triggeredAt?: string | null;
    headers?: Record<string, string>;
    hmacValid?: boolean;
    rejection?: string | null;
    raw?: string;
  },
): Promise<Recorded> {
  const raw = a.raw ?? JSON.stringify(a.payload);
  const webhookId = a.webhookId ?? newWebhookId();
  const { rows } = await tx.query<Omit<Recorded, "webhookId">>(
    `select event_id, duplicate, event_status::text, job_id
       from public.record_shopify_webhook($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11,
                                          $12::public.integration_rejection_reason, $13)`,
    [
      a.topic,
      webhookId,
      null,
      SHOPIFY_TEST_SHOP,
      "2026-07",
      a.triggeredAt ?? null,
      JSON.stringify(a.headers ?? {}),
      a.payload === null ? null : JSON.stringify(a.payload),
      createHash("sha256").update(raw).digest("hex"),
      Buffer.byteLength(raw),
      a.hmacValid ?? true,
      a.rejection ?? null,
      null,
    ],
  );
  return { ...rows[0], webhookId };
}

/** One of the processing RPCs as whoever `tx` is. */
async function processEvent(
  tx: pg.Client,
  eventId: string,
  fn:
    | "process_shopify_event"
    | "process_shopify_order_paid"
    | "process_shopify_refund" = "process_shopify_event",
): Promise<Processed> {
  const { rows } = await tx.query<Processed>(
    `select event_status::text, outcome, sale_id, error_code, error_message from public.${fn}($1)`,
    [eventId],
  );
  return rows[0];
}

/** Record then process as the service role; leaves `tx` as the service role. */
async function deliver(
  tx: pg.Client,
  topic: string,
  payload: unknown,
  opts: { webhookId?: string; triggeredAt?: string | null; headers?: Record<string, string> } = {},
): Promise<Recorded & { result: Processed }> {
  await actAs(tx, SERVICE);
  const recorded = await record(tx, { topic, payload, ...opts });
  const result = await processEvent(tx, recorded.event_id);
  return { ...recorded, result };
}

type EventRow = {
  id: string;
  topic: string;
  status: string;
  outcome: string | null;
  attempts: number;
  delivery_count: number;
  payload: Record<string, unknown> | null;
  headers: Record<string, string>;
  result: Record<string, unknown>;
  last_error_code: string | null;
  last_error: string | null;
  last_error_detail: string | null;
  sale_id: string | null;
  subject: string | null;
  shopify_order_gid: string | null;
  test_delivery: boolean;
  rejection_reason: string | null;
  processed_at: Date | null;
};

const eventRow = (tx: pg.Client, eventId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<EventRow>(
      `select id, topic, status::text, outcome, attempts, delivery_count, payload, headers, result,
              last_error_code, last_error, last_error_detail, sale_id, subject, shopify_order_gid,
              test_delivery, rejection_reason::text, processed_at
         from public.integration_events where id = $1`,
      [eventId],
    );
    return rows[0];
  });

type JobRow = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error: string | null;
  resolution_reason: string | null;
  resolved_by: string | null;
  due_in_minutes: number;
};

const JOB_COLUMNS = `id, kind::text, status::text, attempts, max_attempts, last_error_code, last_error,
  resolution_reason, resolved_by,
  round(extract(epoch from next_attempt_at - now()) / 60)::int as due_in_minutes`;

/** The event's jobs, newest first (owner). */
const jobsOf = (tx: pg.Client, eventId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<JobRow>(
      `select ${JOB_COLUMNS} from public.integration_retry_queue
        where integration_event_id = $1 order by created_at desc, id`,
      [eventId],
    );
    return rows;
  });

const jobRow = (tx: pg.Client, jobId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<JobRow>(
      `select ${JOB_COLUMNS} from public.integration_retry_queue where id = $1`,
      [jobId],
    );
    return rows[0];
  });

/** Today's integration_failed rows for these jobs, read as the admin; ends as the admin. */
async function failedRowsFor(tx: pg.Client, jobIds: string[]): Promise<string[]> {
  await actAs(tx, ADMIN);
  const { rows } = await tx.query<{ entity_id: string }>(
    "select entity_id from public.operational_exceptions(200) where kind = 'integration_failed' and entity_id = any($1::uuid[])",
    [jobIds],
  );
  return rows.map((r) => r.entity_id);
}

/** The sale_refunds rows of a Shopify refund id (owner). */
const refundRowsOf = (tx: pg.Client, refundId: number) =>
  readAsOwner(tx, () =>
    scalar<number>(
      tx,
      "select count(*)::int from public.sale_refunds where shopify_refund_id = $1",
      [`gid://shopify/Refund/${refundId}`],
    ),
  );

/** The sale recorded for a Shopify order id, or undefined (owner). */
const saleOfOrder = (tx: pg.Client, orderId: number) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      id: string;
      sale_number: string;
      status: string;
      source: string;
      customer_id: string | null;
      shopify_customer_id: string | null;
      recognized_at: Date;
      created_by: string | null;
      integration_event_id: string | null;
    }>(
      `select id, sale_number, status::text, source::text, customer_id, shopify_customer_id, recognized_at,
              created_by, integration_event_id
         from public.sales where shopify_order_id = $1`,
      [`gid://shopify/Order/${orderId}`],
    );
    return rows[0];
  });

/** Lines with the part column (owner). */
const partsOf = (tx: pg.Client, saleId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      line_number: number;
      quantity: string;
      unit_sale_price_snapshot: string;
      sale_total: string;
      shopify_line_item_id: string | null;
      shopify_line_part: number | null;
      inventory_unit_id: string | null;
    }>(
      `select line_number, quantity::text, unit_sale_price_snapshot::text, sale_total::text, shopify_line_item_id,
              shopify_line_part, inventory_unit_id
         from public.sale_lines where sale_id = $1 order by line_number`,
      [saleId],
    );
    return rows;
  });

/** Online-sale movements of a product (owner). */
const onlineMovements = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      quantity_delta: number;
      sale_line_id: string;
      location_id: string;
    }>(
      `select quantity_delta, sale_line_id, location_id from public.inventory_movements
        where product_id = $1 and movement_type = 'online_sale' order by id`,
      [productId],
    );
    return rows;
  });

const movementCount = (tx: pg.Client) =>
  readAsOwner(tx, () => scalar<number>(tx, "select count(*)::int from public.inventory_movements"));

/** Owner: link a product to a fresh Shopify product and variant; returns the variant's number. */
async function linkVariant(tx: pg.Client, productId: string): Promise<number> {
  const variant = nextShopifyId();
  await readAsOwner(tx, () =>
    tx.query(
      "update public.products set shopify_product_id = $2, shopify_variant_id = $3 where id = $1",
      [
        productId,
        `gid://shopify/Product/${nextShopifyId()}`,
        `gid://shopify/ProductVariant/${variant}`,
      ],
    ),
  );
  return variant;
}

/** A shop-owned quantity product with stock and a variant; ends acting as the admin. */
async function quantityProduct(
  tx: pg.Client,
  {
    price = "20.00",
    cost = "8.00",
    stock = 10,
    locationId = LOCATION.shopFloor,
    name,
  }: {
    price?: string | null;
    cost?: string | null;
    stock?: number;
    locationId?: string;
    name?: string;
  } = {},
): Promise<{ productId: string; variant: number }> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price, cost, name });
  await actAs(tx, ADMIN);
  if (stock > 0) await addStock(tx, productId, stock, { locationId });
  return { productId, variant: await linkVariant(tx, productId) };
}

/** A unique product with `units` available units at `locationId`; ends acting as the admin. */
async function uniqueProduct(
  tx: pg.Client,
  {
    units = 1,
    price = "900.00",
    cost = "600.00",
    locationId = LOCATION.shopFloor as string,
  }: { units?: number; price?: string; cost?: string; locationId?: string } = {},
): Promise<{ productId: string; variant: number; unitIds: string[] }> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { tracking: "unique", price, cost });
  await actAs(tx, ADMIN);
  const unitIds: string[] = [];
  for (let i = 0; i < units; i++)
    unitIds.push((await makeUnit(tx, productId, { locationId })).unit_id);
  return { productId, variant: await linkVariant(tx, productId), unitIds };
}

/** An order line for a variant (a fresh line id). */
const line = (
  variantId: number | null,
  o: Partial<Omit<OrderLineInput, "variantId">> = {},
): OrderLineInput => ({
  lineItemId: o.lineItemId ?? nextShopifyId(),
  productId: o.productId ?? null,
  variantId,
  title: o.title ?? "Test item",
  variantTitle: o.variantTitle ?? null,
  quantity: o.quantity ?? 1,
  currentQuantity: o.currentQuantity,
  price: o.price ?? "20.00",
  discount: o.discount,
});

/** An orders/paid payload with a fresh order id and name. */
function order(lines: OrderLineInput[], extra: Partial<OrderPaidInput> = {}) {
  const orderId = extra.orderId ?? nextShopifyId();
  return orderPaidPayload({
    orderId,
    name: extra.name ?? `#T${orderId}`,
    lines,
    ...extra,
  });
}

/** A refunds/create payload with a fresh refund id. */
const refundFor = (orderId: number, extra: Partial<RefundInput> & { amount: string }) =>
  refundPayload({ refundId: nextShopifyId(), orderId, ...extra });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `c` is blocked on a lock (labels-concurrency.test.ts pattern). */
async function untilBlocked(c: pg.Client, settled: () => boolean, timeoutMs = 10_000) {
  const pid = (c as unknown as { processID: number }).processID;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (settled()) throw new Error("the second transaction finished without waiting on a lock");
    const waiting = await scalar<number>(
      setup,
      `select count(*)::int from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );
    if (waiting === 1) return;
    if (Date.now() > deadline) throw new Error("the second transaction never waited on a lock");
    await pause(20);
  }
}

/**
 * `first` in an open transaction (holding its locks), `second` committed on
 * another connection, proven to wait on a lock; then `first` commits.
 */
async function race<A, B>(
  first: (tx: pg.Client) => Promise<A>,
  second: (tx: pg.Client) => Promise<B>,
  claimsA: Claims = SERVICE,
  claimsB: Claims = claimsA,
): Promise<[Outcome<A>, Outcome<B>]> {
  const [a, b] = await openConnections(2);
  await a.query("begin");
  await actAs(a, claimsA);
  let firstResult: Outcome<A>;
  try {
    firstResult = { ok: true, value: await first(a) };
  } catch (error) {
    await a.query("rollback");
    throw error;
  }
  let settled = false;
  const secondResult = committed(b, second, claimsB).finally(() => {
    settled = true;
  });
  try {
    await untilBlocked(b, () => settled);
  } catch (error) {
    await a.query("rollback");
    await secondResult;
    throw error;
  }
  await a.query("commit");
  return [firstResult, await secondResult];
}

async function must<T>(outcome: Promise<Outcome<T>>): Promise<T> {
  const r = await outcome;
  if (!r.ok) throw r.error;
  return r.value;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("Shopify ids and exact splits (D80)", () => {
  it("private.shopify_gid accepts digits and gids of its kind; anything else is shopify_gid_invalid", async () => {
    await inTransaction(conn, async (tx) => {
      const gid = (kind: string, value: string | null) =>
        scalar<string | null>(tx, "select private.shopify_gid($1, $2)", [kind, value]);
      expect(await gid("Order", "1042")).toBe("gid://shopify/Order/1042");
      expect(await gid("Order", " 1042 ")).toBe("gid://shopify/Order/1042");
      expect(await gid("ProductVariant", "gid://shopify/ProductVariant/77")).toBe(
        "gid://shopify/ProductVariant/77",
      );
      expect(await gid("Customer", null)).toBeNull();
      for (const [kind, value] of [
        ["Product", "gid://shopify/ProductVariant/77"],
        ["Order", "#1042"],
        ["LineItem", "abc"],
        ["Refund", ""],
        ["Customer", "gid://shopify/Customer/"],
      ]) {
        await failsWith(tx, () => gid(kind, value), {
          code: "P0001",
          message: "shopify_gid_invalid",
          detail: expect.stringContaining(kind),
        });
      }
      await failsWith(tx, () => gid("Shop", "1"), { code: "22023" });
      expect(await scalar(tx, "select private.shopify_gid_or_null('Order', 'garbage')")).toBeNull();
      expect(await scalar(tx, "select private.shopify_handle('P-000123')")).toBe("bicii-p-000123");
    });
  });

  it("private.shopify_split_amount splits exactly, both prices >= 0", async () => {
    await inTransaction(conn, async (tx) => {
      const cases: [string, number, [number, string][]][] = [
        [
          "100.00",
          3,
          [
            [2, "33.33"],
            [1, "33.34"],
          ],
        ],
        [
          "0.10",
          3,
          [
            [2, "0.03"],
            [1, "0.04"],
          ],
        ],
        [
          "0.05",
          11,
          [
            [10, "0.00"],
            [1, "0.05"],
          ],
        ],
        ["120.00", 1, [[1, "120.00"]]],
        ["0", 2, [[2, "0.00"]]],
        [
          "99.99",
          4,
          [
            [3, "24.99"],
            [1, "25.02"],
          ],
        ],
      ];
      for (const [total, qty, want] of cases) {
        const { rows } = await tx.query<{ quantity: number; unit_price: string }>(
          "select quantity, round(unit_price, 2)::text as unit_price from private.shopify_split_amount($1::numeric, $2)",
          [total, qty],
        );
        expect({ total, qty, rows: rows.map((r) => [r.quantity, r.unit_price]) }).toEqual({
          total,
          qty,
          rows: want,
        });
        const sum = await scalar<string>(
          tx,
          "select sum(quantity * unit_price)::numeric(12,2)::text from private.shopify_split_amount($1::numeric, $2)",
          [total, qty],
        );
        expect(sum).toBe(Number(total).toFixed(2));
      }
      await failsWith(tx, () => tx.query("select * from private.shopify_split_amount(-1, 2)"), {
        code: "22023",
      });
      await failsWith(tx, () => tx.query("select * from private.shopify_split_amount(1, 0)"), {
        code: "22023",
      });
      await failsWith(tx, () => tx.query("select * from private.shopify_split_amount(1.005, 1)"), {
        code: "22023",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC §23: a replay has one business effect
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Duplicate Shopify webhook has one effect (SPEC §23, §27.2)",
  () => {
    it("the same delivery recorded twice is one event with delivery_count 2 and one job", async () => {
      await inTx(async (tx) => {
        const { variant } = await quantityProduct(tx);
        const payload = order([line(variant)]);
        await actAs(tx, SERVICE);
        const first = await record(tx, { topic: "orders/paid", payload });
        expect(first).toMatchObject({ duplicate: false, event_status: "pending" });
        expect(first.job_id).not.toBeNull();
        const second = await record(tx, {
          topic: "orders/paid",
          payload,
          webhookId: first.webhookId,
        });
        expect(second).toMatchObject({ event_id: first.event_id, duplicate: true, job_id: null });
        expect((await eventRow(tx, first.event_id)).delivery_count).toBe(2);
        expect(await jobsOf(tx, first.event_id)).toHaveLength(1);
      });
    });

    it("processing an orders/paid event twice records one sale, one online_sale movement per line, stock down once; a replay closes a reclaimed job", async () => {
      await inTx(async (tx) => {
        const { productId, variant } = await quantityProduct(tx, { stock: 10 });
        const payload = order([line(variant, { quantity: 3, price: "20.00" })]);
        const d = await deliver(tx, "orders/paid", payload);
        expect(d.result).toMatchObject({
          event_status: "processed",
          outcome: "sale_recorded",
          error_code: null,
        });
        const sale = await saleOfOrder(tx, payload.id);
        expect(sale).toMatchObject({
          id: d.result.sale_id,
          source: "online_shopify",
          status: "recorded",
        });
        expect(sale.sale_number).toMatch(/^S-[0-9]{6}$/);
        // As the service role: no staff member made it.
        expect(sale.created_by).toBeNull();
        expect(sale.integration_event_id).toBe(d.event_id);
        const lines = await saleLines(tx, sale.id);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          quantity: "3.00",
          unit_sale_price_snapshot: "20.00",
          sale_total: "60.00",
        });
        expect(await onlineMovements(tx, productId)).toEqual([
          { quantity_delta: -3, sale_line_id: lines[0].id, location_id: LOCATION.shopFloor },
        ]);
        expect(await onHand(tx, productId)).toBe(7);
        expect((await jobsOf(tx, d.event_id)).map((j) => j.status)).toEqual(["done"]);

        // A worker reclaimed a stale job after the event was processed: the
        // replay writes nothing and closes it.
        const stale = randomUUID();
        await readAsOwner(tx, () =>
          tx.query(
            `insert into public.integration_retry_queue (id, kind, integration_event_id, status, attempts, locked_at)
           values ($1, 'shopify_event', $2, 'running', 2, now() - interval '11 minutes')`,
            [stale, d.event_id],
          ),
        );
        const replay = await processEvent(tx, d.event_id);
        expect(replay).toEqual(d.result);
        expect((await jobRow(tx, stale)).status).toBe("done");
        expect(await saleLines(tx, sale.id)).toEqual(lines);
        expect(await onlineMovements(tx, productId)).toHaveLength(1);
        expect(await onHand(tx, productId)).toBe(7);
        await assertLedgerConsistent(tx);
      });
    });

    it("the same order under a second webhook id is duplicate_order with the same sale", async () => {
      await inTx(async (tx) => {
        const { productId, variant } = await quantityProduct(tx, { stock: 5 });
        const payload = order([line(variant, { quantity: 2 })]);
        const first = await deliver(tx, "orders/paid", payload);
        const again = await deliver(tx, "orders/paid", payload);
        expect(again.duplicate).toBe(false);
        expect(again.result).toEqual({
          event_status: "processed",
          outcome: "duplicate_order",
          sale_id: first.result.sale_id,
          error_code: null,
          error_message: null,
        });
        expect((await jobsOf(tx, again.event_id)).map((j) => j.status)).toEqual(["done"]);
        expect(await onHand(tx, productId)).toBe(3);
        expect(await onlineMovements(tx, productId)).toHaveLength(1);
      });
    });

    describe("under concurrency (committed, real connections)", () => {
      /** A committed product with stock and a variant. */
      const committedProduct = (stock = 10) =>
        must(committed(setup, (tx) => quantityProduct(tx, { stock }), ADMIN));

      it("the same event processed at once records one sale", async () => {
        const { productId, variant } = await committedProduct(10);
        const payload = order([line(variant, { quantity: 2 })]);
        const recorded = await must(
          committed(setup, (tx) => record(tx, { topic: "orders/paid", payload }), SERVICE),
        );
        const [a, b] = await race(
          (tx) => processEvent(tx, recorded.event_id),
          (tx) => processEvent(tx, recorded.event_id),
        );
        expect(a).toMatchObject({ ok: true, value: { outcome: "sale_recorded" } });
        expect(b).toMatchObject({ ok: true, value: { outcome: "sale_recorded" } });
        const saleA = (a as { value: Processed }).value.sale_id;
        expect((b as { value: Processed }).value.sale_id).toBe(saleA);
        expect(
          await scalar<number>(
            setup,
            "select count(*)::int from public.sales where shopify_order_id = $1",
            [`gid://shopify/Order/${payload.id}`],
          ),
        ).toBe(1);
        expect(await onHand(setup, productId)).toBe(8);
      });

      it("two deliveries of one order at once record one sale (the order's lock)", async () => {
        const { productId, variant } = await committedProduct(10);
        const payload = order([line(variant, { quantity: 4 })]);
        const e1 = await must(
          committed(setup, (tx) => record(tx, { topic: "orders/paid", payload }), SERVICE),
        );
        const e2 = await must(
          committed(setup, (tx) => record(tx, { topic: "orders/paid", payload }), SERVICE),
        );
        expect(e2.event_id).not.toBe(e1.event_id);
        const [a, b] = await race(
          (tx) => processEvent(tx, e1.event_id),
          (tx) => processEvent(tx, e2.event_id),
        );
        expect(a).toMatchObject({ ok: true, value: { outcome: "sale_recorded" } });
        expect(b).toMatchObject({
          ok: true,
          value: { outcome: "duplicate_order", sale_id: (a as { value: Processed }).value.sale_id },
        });
        expect(await onHand(setup, productId)).toBe(6);
      });

      it("the same webhook id recorded at once is one event with delivery_count 2", async () => {
        const { variant } = await committedProduct(1);
        const payload = order([line(variant)]);
        const webhookId = newWebhookId();
        const [a, b] = await race(
          (tx) => record(tx, { topic: "orders/paid", payload, webhookId }),
          (tx) => record(tx, { topic: "orders/paid", payload, webhookId }),
        );
        expect(a).toMatchObject({ ok: true, value: { duplicate: false } });
        expect(b).toMatchObject({
          ok: true,
          value: {
            duplicate: true,
            event_id: (a as { value: Recorded }).value.event_id,
            job_id: null,
          },
        });
        const { rows } = await setup.query(
          "select delivery_count from public.integration_events where external_event_id = $1",
          [webhookId],
        );
        expect(rows).toEqual([{ delivery_count: 2 }]);
        expect(
          await scalar<number>(
            setup,
            `select count(*)::int from public.integration_retry_queue q join public.integration_events e
              on e.id = q.integration_event_id where e.external_event_id = $1`,
            [webhookId],
          ),
        ).toBe(1);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// SPEC §17.1, §26: unmapped variants
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Unmapped variants go to the retry queue and nothing is partial (SPEC §17.1, §26)",
  () => {
    it("one mapped and one unmapped line: nothing is written; the event says which line, the job needs attention", async () => {
      await inTx(async (tx) => {
        const { productId, variant } = await quantityProduct(tx, { stock: 10 });
        const unknownVariant = nextShopifyId();
        const unknownProduct = nextShopifyId();
        const before = await movementCount(tx);
        const payload = order(
          [
            line(variant, { quantity: 2, title: "Brake pads" }),
            line(unknownVariant, {
              title: "Cotton cap",
              productId: unknownProduct,
              variantTitle: "Navy",
            }),
          ],
          { name: "#4401" },
        );
        const d = await deliver(tx, "orders/paid", payload);
        const message = `Order #4401: "Cotton cap" (Shopify variant ${unknownVariant}) is not linked to a BICII product. Link it to the product it is, then retry.`;
        expect(d.result).toEqual({
          event_status: "failed",
          outcome: null,
          sale_id: null,
          error_code: "shopify_variant_unmapped",
          error_message: message,
        });
        expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
        expect(await movementCount(tx)).toBe(before);
        expect(await onHand(tx, productId)).toBe(10);
        const ev = await eventRow(tx, d.event_id);
        expect(ev).toMatchObject({
          status: "failed",
          attempts: 1,
          last_error_code: "shopify_variant_unmapped",
          last_error: message,
          last_error_detail: null,
        });
        expect(ev.result).toEqual({
          unmapped_lines: [
            {
              line_item_id: `gid://shopify/LineItem/${payload.line_items[1].id}`,
              title: "Cotton cap",
              variant_title: "Navy",
              variant_gid: `gid://shopify/ProductVariant/${unknownVariant}`,
              product_gid: `gid://shopify/Product/${unknownProduct}`,
              quantity: 1,
            },
          ],
        });
        expect(await jobsOf(tx, d.event_id)).toEqual([
          expect.objectContaining({
            status: "needs_attention",
            last_error_code: "shopify_variant_unmapped",
            last_error: message,
          }),
        ]);
      });
    });

    it("a custom line (no variant) is unmapped too, with a null variant", async () => {
      await inTx(async (tx) => {
        const { variant } = await quantityProduct(tx);
        const payload = order([line(variant), line(null, { title: "Gift wrapping" })], {
          name: "#4402",
        });
        const d = await deliver(tx, "orders/paid", payload);
        expect(d.result).toMatchObject({
          event_status: "failed",
          error_code: "shopify_variant_unmapped",
          error_message:
            'Order #4402: "Gift wrapping" is a custom Shopify line with no product. Record it by hand if needed and dismiss this with a reason.',
        });
        const ev = await eventRow(tx, d.event_id);
        expect(ev.result).toEqual({
          unmapped_lines: [
            expect.objectContaining({ title: "Gift wrapping", variant_gid: null, quantity: 1 }),
          ],
        });
      });
    });

    it("after link_shopify_variant and retry_integration_job the order is recorded with both lines", async () => {
      await inTx(async (tx) => {
        const { productId: mapped, variant } = await quantityProduct(tx, { stock: 10 });
        const { productId: later } = await quantityProduct(tx, { stock: 10, price: "15.00" });
        // `later` gets the order's variant only after the failure.
        await readAsOwner(tx, () =>
          tx.query(
            "update public.products set shopify_product_id = null, shopify_variant_id = null where id = $1",
            [later],
          ),
        );
        const unknownVariant = nextShopifyId();
        const payload = order([
          line(variant, { quantity: 1 }),
          line(unknownVariant, { quantity: 2, price: "15.00" }),
        ]);
        const d = await deliver(tx, "orders/paid", payload);
        expect(d.result.error_code).toBe("shopify_variant_unmapped");
        const [job] = await jobsOf(tx, d.event_id);

        await actAs(tx, ADMIN);
        const { rows: linked } = await tx.query(
          "select product_id, shopify_origin, publish_online, shopify_handle from public.link_shopify_variant($1, $2, $3, $4)",
          [later, String(nextShopifyId()), String(unknownVariant), "It is the cap we sell online"],
        );
        expect(linked[0]).toEqual({
          product_id: later,
          shopify_origin: "external",
          publish_online: false,
          shopify_handle: null,
        });
        const { rows: retried } = await tx.query(
          "select status::text, max_attempts from public.retry_integration_job($1)",
          [job.id],
        );
        expect(retried[0]).toEqual({ status: "queued", max_attempts: 8 });

        await actAs(tx, SERVICE);
        const { rows: claimed } = await tx.query(
          "select id, status::text, attempts from public.claim_integration_jobs(1, $1)",
          [job.id],
        );
        expect(claimed).toEqual([{ id: job.id, status: "running", attempts: 1 }]);
        const result = await processEvent(tx, d.event_id);
        expect(result).toMatchObject({ event_status: "processed", outcome: "sale_recorded" });
        const lines = await saleLines(tx, result.sale_id!);
        expect(lines.map((l) => [l.product_id, l.quantity, l.sale_total])).toEqual([
          [mapped, "1.00", "20.00"],
          [later, "2.00", "30.00"],
        ]);
        expect((await jobRow(tx, job.id)).status).toBe("done");
        const ev = await eventRow(tx, d.event_id);
        expect(ev).toMatchObject({
          status: "processed",
          attempts: 2,
          last_error_code: null,
          last_error: null,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// The one sale-line writer
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Online sales use the shared sale-line writer (P6 sell_line)",
  () => {
    it("an online line's cost, yield, Cult Commons and rate snapshot equal record_retail_sale's for the same product, price and instant", async () => {
      await inTx(async (tx) => {
        const { productId, variant } = await quantityProduct(tx, {
          price: "50.00",
          cost: "20.00",
          stock: 10,
        });
        const at = "2026-09-15T03:00:00.000Z";
        const d = await deliver(
          tx,
          "orders/paid",
          order([line(variant, { quantity: 2, price: "50.00" })], { processedAt: at }),
        );
        await actAs(tx, ADMIN);
        const retail = await recordSale(tx, {
          lines: [{ product_id: productId, quantity: 2, unit_sale_price: "50.00" }],
          recognizedAt: at,
        });
        const [online] = await saleLines(tx, d.result.sale_id!);
        const [inStore] = await saleLines(tx, retail.sale_id);
        const economics = (l: typeof online) => ({
          description: l.description_snapshot,
          quantity: l.quantity,
          price: l.unit_sale_price_snapshot,
          cost: l.unit_direct_cost_snapshot,
          payout: l.consignor_payout_snapshot,
          rate: l.cult_commons_rate_snapshot,
          sale_total: l.sale_total,
          cost_total: l.cost_total,
          yield_total: l.yield_total,
          cult_commons_share: l.cult_commons_share,
        });
        expect(economics(online)).toEqual(economics(inStore));
        expect(economics(online)).toMatchObject({
          cost: "20.00",
          yield_total: "60.00",
          cult_commons_share: "18.00",
          rate: "0.3000",
        });
        expect(online.shopify_line_item_id).toMatch(/^gid:\/\/shopify\/LineItem\/[0-9]+$/);
        expect(inStore.shopify_line_item_id).toBeNull();
        const types = await readAsOwner(tx, async () => {
          const { rows } = await tx.query<{ movement_type: string }>(
            "select movement_type::text from public.inventory_movements where sale_line_id = any ($1::uuid[]) order by movement_type",
            [[online.id, inStore.id]],
          );
          return rows.map((r) => r.movement_type);
        });
        expect(types).toEqual(["online_sale", "retail_sale"]);
      });
    });

    it("there is one writer: private.sell_line only, no private.write_sale_line", async () => {
      await inTransaction(conn, async (tx) => {
        const { rows } = await tx.query(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.proname in ('sell_line', 'write_sale_line')`,
        );
        expect(rows).toEqual([{ proname: "sell_line" }]);
      });
    });

    it("an in-store line cannot carry a Shopify line id or claim a part without one", async () => {
      await inTx(async (tx) => {
        const { productId } = await quantityProduct(tx, { stock: 5 });
        await failsWith(
          tx,
          () =>
            recordSale(tx, {
              lines: [
                {
                  product_id: productId,
                  quantity: 1,
                  shopify_line_item_id: "gid://shopify/LineItem/1",
                },
              ],
            }),
          { code: "P0001", message: "sale_line_invalid" },
        );
        await failsWith(
          tx,
          () =>
            recordSale(tx, {
              lines: [{ product_id: productId, quantity: 1, shopify_line_part: 1 }],
            }),
          { code: "23514", message: expect.stringContaining("sale_lines_shopify_line_part_check") },
        );
        expect(await onHand(tx, productId)).toBe(5);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// D24 amended
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Zero is a known price and cost (D24 amended)", () => {
  it("a fully discounted line is recorded at 0.00 with Cult Commons 0.00", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { price: "30.00", cost: "12.00" });
      const d = await deliver(
        tx,
        "orders/paid",
        order([line(variant, { price: "30.00", discount: "30.00" })]),
      );
      expect(d.result.outcome).toBe("sale_recorded");
      const [l] = await saleLines(tx, d.result.sale_id!);
      expect(l).toMatchObject({
        unit_sale_price_snapshot: "0.00",
        sale_total: "0.00",
        yield_total: "-12.00",
        cult_commons_share: "0.00",
      });
    });
  });

  it("a product whose cost is 0 is recorded at cost 0.00", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { price: "10.00", cost: "0.00" });
      const d = await deliver(tx, "orders/paid", order([line(variant, { price: "10.00" })]));
      const [l] = await saleLines(tx, d.result.sale_id!);
      expect(l).toMatchObject({
        unit_direct_cost_snapshot: "0.00",
        yield_total: "10.00",
        cult_commons_share: "3.00",
      });
    });
  });

  it("a product whose cost is NULL is refused (shopify_sale_refused naming the missing cost); nothing is written", async () => {
    await inTx(async (tx) => {
      const { productId, variant } = await quantityProduct(tx, { price: "10.00", cost: null });
      const before = await movementCount(tx);
      const payload = order([line(variant, { price: "10.00" })], { name: "#4501" });
      const d = await deliver(tx, "orders/paid", payload);
      expect(d.result).toMatchObject({
        event_status: "failed",
        error_code: "shopify_sale_refused",
        error_message: expect.stringMatching(
          /^Order #4501 could not be recorded: This item has no cost yet/,
        ),
      });
      expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
      expect(await movementCount(tx)).toBe(before);
      expect(await onHand(tx, productId)).toBe(10);
      expect((await jobsOf(tx, d.event_id))[0].status).toBe("needs_attention");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC §23: a unique unit sells once
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "A unique inventory unit cannot be sold twice (SPEC §23)",
  () => {
    it("the oldest available unit at the online location is sold; the product becomes sold when none is left (D26, D81)", async () => {
      await inTx(async (tx) => {
        const { productId, variant, unitIds } = await uniqueProduct(tx, { units: 2 });
        const [newer, older] = unitIds;
        await readAsOwner(tx, () =>
          tx.query(
            "update public.inventory_units set created_at = now() - interval '3 days' where id = $1",
            [older],
          ),
        );
        await ownerMode(tx);
        await addPublicPhoto(tx, "product", productId);
        await actAs(tx, ADMIN);
        await publishProduct(tx, productId);

        const first = await deliver(tx, "orders/paid", order([line(variant, { price: "900.00" })]));
        const [l1] = await saleLines(tx, first.result.sale_id!);
        expect(l1.inventory_unit_id).toBe(older);
        const unitRow = (id: string) =>
          readAsOwner(tx, async () => {
            const { rows } = await tx.query(
              "select status::text, sold_sale_line_id from public.inventory_units where id = $1",
              [id],
            );
            return rows[0];
          });
        expect(await unitRow(older)).toEqual({ status: "sold", sold_sale_line_id: l1.id });
        expect(await publication(tx, productId)).toBe("public");

        const second = await deliver(
          tx,
          "orders/paid",
          order([line(variant, { price: "900.00" })]),
        );
        const [l2] = await saleLines(tx, second.result.sale_id!);
        expect(l2.inventory_unit_id).toBe(newer);
        expect(await publication(tx, productId)).toBe("sold");
        await assertLedgerConsistent(tx);
      });
    });

    it("a unit already sold in the shop: shopify_unit_unavailable, nothing written", async () => {
      await inTx(async (tx) => {
        const { productId, variant, unitIds } = await uniqueProduct(tx, { units: 1 });
        await recordSale(tx, { lines: [{ inventory_unit_id: unitIds[0] }] });
        const before = await movementCount(tx);
        const payload = order([line(variant, { title: "Colnago C64", price: "900.00" })], {
          name: "#4601",
        });
        const d = await deliver(tx, "orders/paid", payload);
        expect(d.result).toMatchObject({
          event_status: "failed",
          error_code: "shopify_unit_unavailable",
          error_message:
            'Order #4601: "Colnago C64" needs 1 available unit at Shop floor but none is available. It may have sold in the shop. Refund it in Shopify and dismiss this, or make a unit available and retry.',
        });
        expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
        expect(await movementCount(tx)).toBe(before);
        expect(await onlineMovements(tx, productId)).toEqual([]);
      });
    });

    it("customer-owned units and units at another location are never chosen", async () => {
      await inTx(async (tx) => {
        const elsewhere = await uniqueProduct(tx, { units: 1, locationId: LOCATION.workshopStore });
        const d1 = await deliver(
          tx,
          "orders/paid",
          order([line(elsewhere.variant, { price: "900.00" })]),
        );
        expect(d1.result.error_code).toBe("shopify_unit_unavailable");

        await ownerMode(tx);
        const productId = await makeProduct(tx, {
          tracking: "unique",
          price: "900.00",
          cost: "600.00",
        });
        const customerUnit = randomUUID();
        await tx.query(
          `select private.register_unit($1, $2, $3, 'customer_owned', null, null, null, 100.00, null, null)`,
          [customerUnit, productId, LOCATION.shopFloor],
        );
        const variant = await linkVariant(tx, productId);
        const d2 = await deliver(tx, "orders/paid", order([line(variant, { price: "900.00" })]));
        expect(d2.result.error_code).toBe("shopify_unit_unavailable");
        const status = await readAsOwner(tx, () =>
          scalar<string>(tx, "select status::text from public.inventory_units where id = $1", [
            customerUnit,
          ]),
        );
        expect(status).toBe("available");
      });
    });

    it("an in-store sale and an online order of the same unit at once: exactly one sale line for the unit", async (ctx) => {
      if (!isolatedDatabase()) ctx.skip();
      const { variant, unitIds } = await must(
        committed(setup, (tx) => uniqueProduct(tx, { units: 1 }), ADMIN),
      );
      const payload = order([line(variant, { price: "900.00" })]);
      const recorded = await must(
        committed(setup, (tx) => record(tx, { topic: "orders/paid", payload }), SERVICE),
      );
      const [a, b] = await race(
        (tx) => recordSale(tx, { lines: [{ inventory_unit_id: unitIds[0] }] }),
        (tx) => processEvent(tx, recorded.event_id),
        ADMIN,
        SERVICE,
      );
      expect(a.ok).toBe(true);
      expect(b).toMatchObject({
        ok: true,
        value: { event_status: "failed", error_code: "shopify_unit_unavailable" },
      });
      expect(
        await scalar<number>(
          setup,
          "select count(*)::int from public.sale_lines where inventory_unit_id = $1",
          [unitIds[0]],
        ),
      ).toBe(1);
    });
  },
);

// ---------------------------------------------------------------------------
// SPEC §10, §13: consignment
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Consignment sale creates correct liability and yield (SPEC §10, §13, §23)",
  () => {
    it("a 1,000.00 online sale of a consigned unit owed 500 costs 500, yields 500, Cult Commons 150; the item is sold, the liability +500, no settlement", async () => {
      await inTx(async (tx) => {
        const consignor = await createConsignor(tx);
        const item = await intakeUnique(tx, {
          consignorId: consignor,
          agreed: "500.00",
          asking: "1000.00",
        });
        const variant = await linkVariant(tx, item.product_id);
        const d = await deliver(tx, "orders/paid", order([line(variant, { price: "1000.00" })]));
        expect(d.result.outcome).toBe("sale_recorded");
        const [l] = await saleLines(tx, d.result.sale_id!);
        expect(l).toMatchObject({
          inventory_unit_id: item.inventory_unit_id,
          consignment_item_id: item.item_id,
          unit_direct_cost_snapshot: "500.00",
          consignor_payout_snapshot: "500.00",
          sale_total: "1000.00",
          yield_total: "500.00",
          cult_commons_share: "150.00",
        });
        expect(await itemStatus(tx, item.item_id)).toBe("sold");
        expect(await itemLedger(tx, item.item_id)).toMatchObject({
          liability: "500.00",
          paid: "0.00",
        });
        expect(
          await readAsOwner(tx, () =>
            scalar<number>(
              tx,
              "select count(*)::int from public.settlement_lines where consignment_item_id = $1",
              [item.item_id],
            ),
          ),
        ).toBe(0);
      });
    });

    it("a consigned unit's live shop-borne charges are part of its cost (D4); a consigned quantity line draws one consignment (D45)", async () => {
      await inTx(async (tx) => {
        const consignor = await createConsignor(tx);
        const bike = await intakeUnique(tx, {
          consignorId: consignor,
          agreed: "500.00",
          asking: "1000.00",
        });
        await addCharge(tx, {
          itemId: bike.item_id,
          description: "Service before listing",
          amount: "40.00",
          bearer: "shop",
        });
        const bikeVariant = await linkVariant(tx, bike.product_id);
        const jerseys = await intakeQuantity(tx, {
          consignorId: consignor,
          agreed: "35.00",
          asking: "70.00",
          quantity: 3,
        });
        const jerseyVariant = await linkVariant(tx, jerseys.product_id);
        const d = await deliver(
          tx,
          "orders/paid",
          order([
            line(bikeVariant, { price: "1000.00" }),
            line(jerseyVariant, { quantity: 2, price: "70.00" }),
          ]),
        );
        expect(d.result.outcome).toBe("sale_recorded");
        const [bikeLine, jerseyLine] = await saleLines(tx, d.result.sale_id!);
        expect(bikeLine).toMatchObject({
          unit_direct_cost_snapshot: "540.00",
          yield_total: "460.00",
          cult_commons_share: "138.00",
        });
        expect(jerseyLine).toMatchObject({
          consignment_item_id: jerseys.item_id,
          quantity: "2.00",
          unit_direct_cost_snapshot: "35.00",
          consignor_payout_snapshot: "35.00",
          sale_total: "140.00",
        });

        // More than one consignment holds at the online location: refused.
        const big = await deliver(
          tx,
          "orders/paid",
          order([line(jerseyVariant, { quantity: 2, price: "70.00" })]),
        );
        expect(big.result).toMatchObject({
          event_status: "failed",
          error_code: "shopify_insufficient_stock",
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Historical snapshots do not change with catalogue edits",
  () => {
    it("editing the product's price and cost after an online sale leaves the line unchanged", async () => {
      await inTx(async (tx) => {
        const { productId, variant } = await quantityProduct(tx, { price: "40.00", cost: "15.00" });
        const d = await deliver(
          tx,
          "orders/paid",
          order([line(variant, { quantity: 2, price: "40.00" })]),
        );
        const before = await saleLines(tx, d.result.sale_id!);
        await readAsOwner(tx, () =>
          tx.query(
            "update public.products set default_sale_price = 99.00, default_direct_cost = 60.00, name = 'Renamed' where id = $1",
            [productId],
          ),
        );
        expect(await saleLines(tx, d.result.sale_id!)).toEqual(before);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// D80
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Online prices equal Shopify's totals exactly (D80)", () => {
  it("a discounted quantity line is price x qty - allocations, split 2 x 33.33 (part 1) + 1 x 33.34 (part 2)", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const payload = order([line(variant, { quantity: 3, price: "40.00", discount: "20.00" })]);
      const d = await deliver(tx, "orders/paid", payload);
      const parts = await partsOf(tx, d.result.sale_id!);
      const lineGid = `gid://shopify/LineItem/${payload.line_items[0].id}`;
      expect(
        parts.map((p) => [
          p.quantity,
          p.unit_sale_price_snapshot,
          p.sale_total,
          p.shopify_line_item_id,
          p.shopify_line_part,
        ]),
      ).toEqual([
        ["2.00", "33.33", "66.66", lineGid, 1],
        ["1.00", "33.34", "33.34", lineGid, 2],
      ]);
      const ev = await eventRow(tx, d.event_id);
      expect(ev.result).toMatchObject({
        sale_id: d.result.sale_id,
        lines: [
          {
            shopify_line_item_id: lineGid,
            quantity: 3,
            line_total: 100.0,
            unit_prices: [33.33, 33.34],
            unit_ids: [],
          },
        ],
      });
    });
  });

  it("an even split is one line with no part; current_quantity wins over quantity; zero-quantity lines are ignored", async () => {
    await inTx(async (tx) => {
      const { productId, variant } = await quantityProduct(tx, { stock: 10 });
      const { variant: removed } = await quantityProduct(tx, { stock: 10 });
      const d = await deliver(
        tx,
        "orders/paid",
        order([
          line(variant, { quantity: 5, currentQuantity: 4, price: "25.00" }),
          line(removed, { quantity: 1, currentQuantity: 0, price: "25.00" }),
        ]),
      );
      expect(
        (await partsOf(tx, d.result.sale_id!)).map((p) => [
          p.quantity,
          p.unit_sale_price_snapshot,
          p.shopify_line_part,
        ]),
      ).toEqual([["4.00", "25.00", null]]);
      expect(await onHand(tx, productId)).toBe(6);
    });
  });

  it("a unique product ordered 3 times sells three units, one line each, summing to the total", async () => {
    await inTx(async (tx) => {
      const { variant, unitIds } = await uniqueProduct(tx, { units: 3 });
      const d = await deliver(
        tx,
        "orders/paid",
        order([line(variant, { quantity: 3, price: "40.00", discount: "20.00" })]),
      );
      const parts = await partsOf(tx, d.result.sale_id!);
      expect(parts.map((p) => [p.unit_sale_price_snapshot, p.shopify_line_part])).toEqual([
        ["33.33", null],
        ["33.33", null],
        ["33.34", null],
      ]);
      expect(parts.map((p) => p.inventory_unit_id).sort()).toEqual([...unitIds].sort());
      const total = parts.reduce((s, p) => s + Math.round(Number(p.sale_total) * 100), 0);
      expect(total).toBe(10000);
    });
  });
});

// ---------------------------------------------------------------------------
// D89: tax, test and POS orders
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Tax basis is explicit (D89)", () => {
  it("taxes_included true records Shopify's price; false with tax refuses; false with no tax records", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const inclusive = await deliver(
        tx,
        "orders/paid",
        order([line(variant, { price: "109.00" })], { taxesIncluded: true, totalTax: "9.00" }),
      );
      expect((await saleLines(tx, inclusive.result.sale_id!))[0].unit_sale_price_snapshot).toBe(
        "109.00",
      );

      const before = await movementCount(tx);
      const exclusive = await deliver(
        tx,
        "orders/paid",
        order([line(variant, { price: "100.00" })], {
          name: "#4701",
          taxesIncluded: false,
          totalTax: "9.00",
        }),
      );
      expect(exclusive.result).toMatchObject({
        event_status: "failed",
        error_code: "shopify_tax_basis_unsupported",
        error_message:
          "Order #4701 was charged tax on top of the price; BICII records tax-inclusive prices. Record it by hand and dismiss this.",
      });
      expect((await jobsOf(tx, exclusive.event_id))[0].status).toBe("needs_attention");
      expect(await movementCount(tx)).toBe(before);

      const untaxed = await deliver(
        tx,
        "orders/paid",
        order([line(variant, { price: "100.00" })], { taxesIncluded: false, totalTax: "0.00" }),
      );
      expect(untaxed.result.outcome).toBe("sale_recorded");
    });
  });
});

describe.skipIf(!isolatedDatabase())("Test and POS orders are not sales (D89)", () => {
  it("with accept_test_orders false a test payload and a test header are stored skipped (test_order) with no job, sale or movement; POS orders are skipped", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      await readAsOwner(tx, () =>
        tx.query("update public.shopify_settings set accept_test_orders = false"),
      );
      const before = await movementCount(tx);
      await actAs(tx, SERVICE);
      const byPayload = order([line(variant)], { test: true });
      const r1 = await record(tx, { topic: "orders/paid", payload: byPayload });
      const byHeader = order([line(variant)]);
      const r2 = await record(tx, {
        topic: "orders/paid",
        payload: byHeader,
        headers: { "X-Shopify-Test": "true" },
      });
      for (const r of [r1, r2]) {
        expect(r).toMatchObject({ event_status: "skipped", job_id: null });
        expect(await eventRow(tx, r.event_id)).toMatchObject({
          status: "skipped",
          outcome: "test_order",
          test_delivery: true,
        });
        expect(await jobsOf(tx, r.event_id)).toEqual([]);
        expect(await processEvent(tx, r.event_id)).toMatchObject({
          event_status: "skipped",
          outcome: "test_order",
        });
      }
      const pos = order([line(variant)], { sourceName: "pos" });
      const r3 = await record(tx, { topic: "orders/paid", payload: pos });
      expect(r3).toMatchObject({ event_status: "skipped", job_id: null });
      expect((await eventRow(tx, r3.event_id)).outcome).toBe("pos_order");
      for (const p of [byPayload, byHeader, pos])
        expect(await saleOfOrder(tx, p.id)).toBeUndefined();
      expect(await movementCount(tx)).toBe(before);

      // An unhandled topic is stored and skipped too.
      const other = await record(tx, { topic: "products/update", payload: { id: 1 } });
      expect(other).toMatchObject({ event_status: "skipped", job_id: null });
      expect((await eventRow(tx, other.event_id)).outcome).toBe("topic_not_handled");
    });
  });

  it("with the flag true (the dev/E2E seed) a test order is recorded; switched off before processing, it is skipped", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const accepted = await deliver(tx, "orders/paid", order([line(variant)], { test: true }));
      expect(accepted.result.outcome).toBe("sale_recorded");

      const pending = await record(tx, {
        topic: "orders/paid",
        payload: order([line(variant)], { test: true }),
      });
      expect(pending.event_status).toBe("pending");
      await readAsOwner(tx, () =>
        tx.query("update public.shopify_settings set accept_test_orders = false"),
      );
      expect(await processEvent(tx, pending.event_id)).toMatchObject({
        event_status: "skipped",
        outcome: "test_order",
      });
      expect((await jobsOf(tx, pending.event_id))[0].status).toBe("done");
    });
  });
});

// ---------------------------------------------------------------------------
// D82, D35
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Online stock follows the ledger rules (D82)", () => {
  it("too little on hand at the online location: shopify_insufficient_stock, nothing written (stock elsewhere does not count)", async () => {
    await inTx(async (tx) => {
      const { productId, variant } = await quantityProduct(tx, {
        stock: 1,
        name: "Brake pads (online test)",
      });
      await addStock(tx, productId, 10, { locationId: LOCATION.workshopStore });
      const before = await movementCount(tx);
      const payload = order([line(variant, { quantity: 3, title: "Brake pads" })], {
        name: "#4801",
      });
      const d = await deliver(tx, "orders/paid", payload);
      expect(d.result).toMatchObject({
        event_status: "failed",
        error_code: "shopify_insufficient_stock",
        error_message:
          'Order #4801: "Brake pads" needs 3 but BICII shows 1 on hand at Shop floor. Count and adjust the stock, then retry, or refund in Shopify and dismiss this.',
      });
      expect(await movementCount(tx)).toBe(before);
      expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
    });
  });

  it("an order in another currency needs attention (shopify_currency_mismatch)", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx);
      const d = await deliver(
        tx,
        "orders/paid",
        order([line(variant)], { name: "#4802", currency: "USD" }),
      );
      expect(d.result).toMatchObject({
        error_code: "shopify_currency_mismatch",
        error_message:
          "Order #4802 is in USD but the shop records sales in SGD. Record it by hand and dismiss this.",
      });
      expect((await jobsOf(tx, d.event_id))[0].status).toBe("needs_attention");
    });
  });

  it("an unreadable payload needs attention (shopify_payload_invalid naming the field)", async () => {
    await inTx(async (tx) => {
      const d = await deliver(tx, "orders/paid", {
        id: nextShopifyId(),
        name: "#4803",
        currency: "SGD",
      });
      expect(d.result).toMatchObject({
        error_code: "shopify_payload_invalid",
        error_message:
          "Shopify sent an order BICII cannot read (missing line_items). Check the payload in the event inspector.",
      });
      expect((await jobsOf(tx, d.event_id))[0].status).toBe("needs_attention");
    });
  });

  it("missing Shopify settings are transient: the job is queued with backoff", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx);
      await readAsOwner(tx, () => tx.query("delete from public.shopify_settings"));
      const d = await deliver(tx, "orders/paid", order([line(variant)]));
      expect(d.result).toMatchObject({ error_code: "shopify_settings_missing" });
      expect((await jobsOf(tx, d.event_id))[0]).toMatchObject({
        status: "queued",
        due_in_minutes: 1,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// D80 recognition
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Recognition date (D80)", () => {
  it("recognized_at is the payload's processed_at whatever the deliveries' trigger times; else the trigger time; reported online on that shop day", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const processedAt = "2026-09-20T15:59:00.000Z"; // 23:59 on 20 Sep in Singapore
      const payload = order([line(variant)], { processedAt });
      const first = await deliver(tx, "orders/paid", payload, {
        triggeredAt: "2026-09-21T01:00:00Z",
      });
      const second = await deliver(tx, "orders/paid", payload, {
        triggeredAt: "2026-09-22T01:00:00Z",
      });
      expect(second.result.outcome).toBe("duplicate_order");
      const sale = await saleOfOrder(tx, payload.id);
      expect(sale.recognized_at.toISOString()).toBe(processedAt);
      const entries = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          // D274: lines only (the sale's Shopify fee entry is pending beside them).
          "select recognized_day::text as day, channel, source from reporting.financial_lines where document_id = $1 and entry_kind = 'line'",
          [first.result.sale_id],
        );
        return rows;
      });
      expect(entries).toEqual([{ day: "2026-09-20", channel: "online", source: "sale" }]);

      const noProcessedAt = order([line(variant)]);
      await deliver(tx, "orders/paid", noProcessedAt, { triggeredAt: "2026-09-25T04:05:06Z" });
      expect((await saleOfOrder(tx, noProcessedAt.id)).recognized_at.toISOString()).toBe(
        "2026-09-25T04:05:06.000Z",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// D7, D85, D49
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Refunds are financial only (D7, D85, D49)", () => {
  /** A recorded online sale: 2 x a 50.00 quantity product + a consigned unit at 1000.00. */
  async function soldOrder(tx: pg.Client) {
    const { productId, variant } = await quantityProduct(tx, {
      price: "50.00",
      cost: "20.00",
      stock: 10,
    });
    const consignor = await createConsignor(tx);
    const item = await intakeUnique(tx, {
      consignorId: consignor,
      agreed: "500.00",
      asking: "1000.00",
    });
    const bikeVariant = await linkVariant(tx, item.product_id);
    const payload = order([
      line(variant, { quantity: 2, price: "50.00" }),
      line(bikeVariant, { price: "1000.00" }),
    ]);
    const d = await deliver(tx, "orders/paid", payload);
    expect(d.result.outcome).toBe("sale_recorded");
    return { payload, saleId: d.result.sale_id!, productId, item };
  }

  const refundsOf = (tx: pg.Client, saleId: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query(
        `select amount::text, currency, reason, restocked, recorded_by, shopify_refund_id, integration_event_id
           from public.sale_refunds where sale_id = $1 order by created_at`,
        [saleId],
      );
      return rows;
    });

  const financialRows = (tx: pg.Client, saleId: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query(
        "select * from reporting.financial_lines where document_id = $1 order by entry_key",
        [saleId],
      );
      return rows;
    });

  it("one sale_refunds row, the sale partially refunded, no movement; units, consignment, lines and reports unchanged", async () => {
    await inTx(async (tx) => {
      const { payload, saleId, item } = await soldOrder(tx);
      const lines = await saleLines(tx, saleId);
      const reported = await financialRows(tx, saleId);
      const movements = await movementCount(tx);
      const r = refundFor(payload.id, {
        amount: "40.00",
        lines: [
          {
            lineItemId: payload.line_items[0].id,
            quantity: 1,
            subtotal: "40.00",
            restockType: "return",
          },
        ],
      });
      const d = await deliver(tx, "refunds/create", r);
      expect(d.result).toEqual({
        event_status: "processed",
        outcome: "refund_recorded",
        sale_id: saleId,
        error_code: null,
        error_message: null,
      });
      expect(await refundsOf(tx, saleId)).toEqual([
        {
          amount: "40.00",
          currency: "SGD",
          reason: "Refunded in Shopify",
          restocked: false,
          recorded_by: null,
          shopify_refund_id: `gid://shopify/Refund/${r.id}`,
          integration_event_id: d.event_id,
        },
      ]);
      expect((await saleOfOrder(tx, payload.id)).status).toBe("partially_refunded");
      expect(await movementCount(tx)).toBe(movements);
      expect(await itemStatus(tx, item.item_id)).toBe("sold");
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select status::text from public.inventory_units where id = $1", [
            item.inventory_unit_id,
          ]),
        ),
      ).toBe("sold");
      expect(await saleLines(tx, saleId)).toEqual(lines);
      expect(await financialRows(tx, saleId)).toEqual(reported);
      expect((await eventRow(tx, d.event_id)).result).toMatchObject({
        amount: 40,
        transactions_total: 40,
        line_items_total: 40,
        shipping_refunded: 0,
        unallocated_refund: 0,
        refund_line_items: [
          {
            line_item_id: `gid://shopify/LineItem/${payload.line_items[0].id}`,
            quantity: 1,
            subtotal: 40,
            restock_type: "return",
          },
        ],
      });
    });
  });

  it("a full refund with shipping records the sale total and keeps shipping and the excess in the result; the sale is refunded; reports unchanged", async () => {
    await inTx(async (tx) => {
      const { payload, saleId } = await soldOrder(tx);
      const reported = await financialRows(tx, saleId);
      const r = refundFor(payload.id, {
        amount: "1108.00",
        note: "  Returned unopened  ",
        lines: [
          { lineItemId: payload.line_items[0].id, quantity: 2, subtotal: "100.00" },
          { lineItemId: payload.line_items[1].id, quantity: 1, subtotal: "1000.00" },
        ],
        shipping: "8.00",
      });
      const d = await deliver(tx, "refunds/create", r);
      expect(d.result.outcome).toBe("refund_recorded");
      expect(await refundsOf(tx, saleId)).toEqual([
        expect.objectContaining({ amount: "1100.00", reason: "Returned unopened" }),
      ]);
      expect((await saleOfOrder(tx, payload.id)).status).toBe("refunded");
      expect((await eventRow(tx, d.event_id)).result).toMatchObject({
        amount: 1100,
        transactions_total: 1108,
        line_items_total: 1100,
        shipping_refunded: 8,
        unallocated_refund: 8,
      });
      expect(await financialRows(tx, saleId)).toEqual(reported);
    });
  });

  it("an amount-only refund is the transactions total, capped at what is left of the sale", async () => {
    await inTx(async (tx) => {
      const { payload, saleId } = await soldOrder(tx);
      await deliver(
        tx,
        "refunds/create",
        refundFor(payload.id, { amount: "30.00", transactions: 2 }),
      );
      const capped = await deliver(
        tx,
        "refunds/create",
        refundFor(payload.id, { amount: "2000.00" }),
      );
      expect(capped.result.outcome).toBe("refund_recorded");
      expect((await refundsOf(tx, saleId)).map((x) => x.amount)).toEqual(["30.00", "1070.00"]);
      expect((await saleOfOrder(tx, payload.id)).status).toBe("refunded");
      expect((await eventRow(tx, capped.event_id)).result).toMatchObject({
        amount: 1070,
        transactions_total: 2000,
        unallocated_refund: 930,
      });
      // Nothing left: refund_not_allocated, no row.
      const nothing = await deliver(
        tx,
        "refunds/create",
        refundFor(payload.id, { amount: "5.00" }),
      );
      expect(nothing.result).toMatchObject({
        event_status: "processed",
        outcome: "refund_not_allocated",
        sale_id: saleId,
      });
      // No money moved: no_money_refunded, no row.
      const zero = refundFor(payload.id, { amount: "0.00" });
      const none = await deliver(tx, "refunds/create", { ...zero, transactions: [] });
      expect(none.result).toMatchObject({ outcome: "no_money_refunded" });
      expect(await refundsOf(tx, saleId)).toHaveLength(2);
    });
  });

  it("a replay and a second webhook id of the same refund record one row", async () => {
    await inTx(async (tx) => {
      const { payload, saleId } = await soldOrder(tx);
      const r = refundFor(payload.id, { amount: "10.00" });
      const first = await deliver(tx, "refunds/create", r);
      expect(await processEvent(tx, first.event_id)).toEqual(first.result);
      const again = await deliver(tx, "refunds/create", r);
      expect(again.result).toMatchObject({
        event_status: "processed",
        outcome: "duplicate_refund",
        sale_id: saleId,
      });
      expect(await refundsOf(tx, saleId)).toHaveLength(1);
    });
  });

  it("a refund before its order waits (queued, retried later) and is recorded as soon as the order is; one that reached needs_attention is re-queued too", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const payload = order([line(variant, { quantity: 2, price: "50.00" })], { name: "#4901" });
      const r = refundFor(payload.id, { amount: "50.00" });
      const early = await deliver(tx, "refunds/create", r);
      expect(early.result).toMatchObject({
        event_status: "failed",
        error_code: "shopify_refund_order_unknown",
        error_message: `Refund ${r.id} is for Shopify order ${payload.id}, which BICII has not recorded yet. It is recorded automatically as soon as the order is.`,
      });
      const [waiting] = await jobsOf(tx, early.event_id);
      expect(waiting).toMatchObject({ status: "queued" });
      expect(waiting.due_in_minutes).toBeGreaterThan(0);

      // A second refund of the order that already needs attention.
      const r2 = refundFor(payload.id, { amount: "20.00" });
      const late = await deliver(tx, "refunds/create", r2);
      await readAsOwner(tx, () =>
        tx.query(
          "update public.integration_retry_queue set status = 'needs_attention' where integration_event_id = $1",
          [late.event_id],
        ),
      );

      const o = await deliver(tx, "orders/paid", payload);
      expect(o.result.outcome).toBe("sale_recorded");
      for (const ev of [early.event_id, late.event_id]) {
        const [job] = await jobsOf(tx, ev);
        expect(job).toMatchObject({ status: "queued", due_in_minutes: 0, max_attempts: 8 });
      }
      expect(await processEvent(tx, early.event_id)).toMatchObject({
        outcome: "refund_recorded",
        sale_id: o.result.sale_id,
      });
      expect(await processEvent(tx, late.event_id)).toMatchObject({ outcome: "refund_recorded" });
      expect((await saleOfOrder(tx, payload.id)).status).toBe("partially_refunded");
    });
  });

  it("a refund of a dismissed order is skipped (order_not_recorded) with no open job; dismissing an order closes its waiting refunds", async () => {
    await inTx(async (tx) => {
      const payload = order([line(nextShopifyId(), { title: "Unknown thing" })]);
      const o = await deliver(tx, "orders/paid", payload);
      expect(o.result.error_code).toBe("shopify_variant_unmapped");
      const waitingRefund = await deliver(
        tx,
        "refunds/create",
        refundFor(payload.id, { amount: "5.00" }),
      );
      expect(waitingRefund.result.error_code).toBe("shopify_refund_order_unknown");
      const [orderJob] = await jobsOf(tx, o.event_id);
      const [refundJob] = await jobsOf(tx, waitingRefund.event_id);

      await actAs(tx, ADMIN);
      const { rows } = await tx.query(
        "select status::text, resolution_reason from public.dismiss_integration_job($1, $2)",
        [orderJob.id, "Refunded in Shopify; we never had it"],
      );
      expect(rows[0]).toEqual({
        status: "dismissed",
        resolution_reason: "Refunded in Shopify; we never had it",
      });
      expect(await jobRow(tx, refundJob.id)).toMatchObject({
        status: "dismissed",
        resolution_reason: "The order was dismissed: Refunded in Shopify; we never had it",
        resolved_by: STAFF.admin,
      });
      expect(await eventRow(tx, waitingRefund.event_id)).toMatchObject({
        status: "skipped",
        outcome: "order_not_recorded",
      });
      expect(await eventRow(tx, o.event_id)).toMatchObject({
        status: "skipped",
        outcome: "dismissed",
        last_error_code: "shopify_variant_unmapped",
      });
      const audit = await readAsOwner(tx, async () => {
        const { rows: a } = await tx.query(
          "select event_type::text, actor_staff_id, reason, payload from public.integration_audit_events where job_id = $1",
          [orderJob.id],
        );
        return a;
      });
      expect(audit).toEqual([
        {
          event_type: "job_dismissed",
          actor_staff_id: STAFF.admin,
          reason: "Refunded in Shopify; we never had it",
          payload: { closed_refund_job_ids: [refundJob.id], closed_order_job_ids: [] },
        },
      ]);

      // A refund arriving after the dismissal.
      const later = await deliver(tx, "refunds/create", refundFor(payload.id, { amount: "5.00" }));
      expect(later.result).toMatchObject({
        event_status: "skipped",
        outcome: "order_not_recorded",
        sale_id: null,
      });
      expect((await jobsOf(tx, later.event_id)).every((j) => j.status === "done")).toBe(true);
    });
  });

  it("a refund of a test order (accept_test_orders false) is skipped (order_not_recorded): no job left open, no refund row, nothing on Today", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      await readAsOwner(tx, () =>
        tx.query("update public.shopify_settings set accept_test_orders = false"),
      );
      const payload = order([line(variant)], { test: true });
      const o = await deliver(tx, "orders/paid", payload);
      expect(o.result).toMatchObject({ event_status: "skipped", outcome: "test_order" });
      expect((await eventRow(tx, o.event_id)).shopify_order_gid).toBe(
        `gid://shopify/Order/${payload.id}`,
      );
      // Shopify's refund carries no test flag: it is stored pending and
      // reaches the order lookup.
      const r = refundFor(payload.id, { amount: "20.00" });
      const refund = await deliver(tx, "refunds/create", r);
      expect(refund).toMatchObject({ event_status: "pending" });
      expect(refund.result).toMatchObject({
        event_status: "skipped",
        outcome: "order_not_recorded",
        sale_id: null,
        error_code: null,
      });
      const jobs = await jobsOf(tx, refund.event_id);
      expect(jobs.map((j) => j.status)).toEqual(["done"]);
      expect(await refundRowsOf(tx, r.id)).toBe(0);
      expect(
        await failedRowsFor(
          tx,
          jobs.map((j) => j.id),
        ),
      ).toEqual([]);
    });
  });

  it("a refund of a POS order is skipped (order_not_recorded): no job left open, no refund row, nothing on Today", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const payload = order([line(variant)], { sourceName: "pos" });
      const o = await deliver(tx, "orders/paid", payload);
      expect(o.result).toMatchObject({ event_status: "skipped", outcome: "pos_order" });
      expect((await eventRow(tx, o.event_id)).shopify_order_gid).toBe(
        `gid://shopify/Order/${payload.id}`,
      );
      const r = refundFor(payload.id, { amount: "20.00" });
      const refund = await deliver(tx, "refunds/create", r);
      expect(refund).toMatchObject({ event_status: "pending" });
      expect(refund.result).toMatchObject({
        event_status: "skipped",
        outcome: "order_not_recorded",
        sale_id: null,
        error_code: null,
      });
      const jobs = await jobsOf(tx, refund.event_id);
      expect(jobs.map((j) => j.status)).toEqual(["done"]);
      expect(await refundRowsOf(tx, r.id)).toBe(0);
      expect(
        await failedRowsFor(
          tx,
          jobs.map((j) => j.id),
        ),
      ).toEqual([]);
      // Named after its order as staff know it, so a search by #name finds it.
      expect((await eventRow(tx, refund.event_id)).subject).toBe(
        `Refund ${r.id} of #T${payload.id}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// One order, several webhook ids (D80, D87)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "An order's deliveries close together; a dismissal is final (D80, D87)",
  () => {
    /** A quantity product whose variant is not linked yet; `link` links it (owner). */
    async function unlinkedProduct(tx: pg.Client) {
      const { productId } = await quantityProduct(tx, { stock: 10 });
      await readAsOwner(tx, () =>
        tx.query(
          "update public.products set shopify_product_id = null, shopify_variant_id = null where id = $1",
          [productId],
        ),
      );
      const variant = nextShopifyId();
      const link = () =>
        readAsOwner(tx, () =>
          tx.query(
            "update public.products set shopify_product_id = $2, shopify_variant_id = $3 where id = $1",
            [
              productId,
              `gid://shopify/Product/${nextShopifyId()}`,
              `gid://shopify/ProductVariant/${variant}`,
            ],
          ),
        );
      return { productId, variant, link };
    }

    it("two webhook ids of one order both fail; recording one closes the other as duplicate_order, so nothing stays on Today", async () => {
      await inTx(async (tx) => {
        const { variant, link } = await unlinkedProduct(tx);
        const payload = order([line(variant)]);
        const a = await deliver(tx, "orders/paid", payload);
        const b = await deliver(tx, "orders/paid", payload);
        expect(a.event_id).not.toBe(b.event_id);
        for (const d of [a, b]) expect(d.result.error_code).toBe("shopify_variant_unmapped");
        const [jobA] = await jobsOf(tx, a.event_id);
        const [jobB] = await jobsOf(tx, b.event_id);
        expect((await failedRowsFor(tx, [jobA.id, jobB.id])).sort()).toEqual(
          [jobA.id, jobB.id].sort(),
        );

        await link();
        await actAs(tx, ADMIN);
        await tx.query("select public.retry_integration_job($1)", [jobA.id]);
        await actAs(tx, SERVICE);
        const recorded = await processEvent(tx, a.event_id);
        expect(recorded).toMatchObject({ event_status: "processed", outcome: "sale_recorded" });
        expect(await eventRow(tx, b.event_id)).toMatchObject({
          status: "processed",
          outcome: "duplicate_order",
          sale_id: recorded.sale_id,
        });
        expect((await jobRow(tx, jobB.id)).status).toBe("done");
        expect(await failedRowsFor(tx, [jobA.id, jobB.id])).toEqual([]);
        // A later manual retry of B finds it closed.
        await failsWith(tx, () => tx.query("select public.retry_integration_job($1)", [jobB.id]), {
          code: "P0001",
          message: "integration_job_closed",
        });
      });
    });

    it("dismissing one delivery closes the order's other open deliveries and its waiting refunds; a later delivery records nothing", async () => {
      await inTx(async (tx) => {
        const { productId, variant, link } = await unlinkedProduct(tx);
        const payload = order([line(variant)]);
        const a = await deliver(tx, "orders/paid", payload);
        const b = await deliver(tx, "orders/paid", payload);
        const waiting = await deliver(
          tx,
          "refunds/create",
          refundFor(payload.id, { amount: "5.00" }),
        );
        expect(waiting.result.error_code).toBe("shopify_refund_order_unknown");
        const [jobA] = await jobsOf(tx, a.event_id);
        const [jobB] = await jobsOf(tx, b.event_id);
        const [refundJob] = await jobsOf(tx, waiting.event_id);

        await actAs(tx, ADMIN);
        await tx.query("select public.dismiss_integration_job($1, $2)", [
          jobA.id,
          "Recorded by hand in the shop",
        ]);
        expect(await jobRow(tx, jobB.id)).toMatchObject({
          status: "dismissed",
          resolution_reason:
            "Another delivery of this order was dismissed: Recorded by hand in the shop",
          resolved_by: STAFF.admin,
        });
        expect(await eventRow(tx, b.event_id)).toMatchObject({
          status: "skipped",
          outcome: "dismissed",
        });
        expect((await jobRow(tx, refundJob.id)).status).toBe("dismissed");
        const audit = await readAsOwner(tx, async () => {
          const { rows } = await tx.query(
            "select payload from public.integration_audit_events where job_id = $1 and event_type = 'job_dismissed'",
            [jobA.id],
          );
          return rows;
        });
        expect(audit).toEqual([
          { payload: { closed_refund_job_ids: [refundJob.id], closed_order_job_ids: [jobB.id] } },
        ]);
        expect(await failedRowsFor(tx, [jobA.id, jobB.id, refundJob.id])).toEqual([]);

        // The cause clears and the same order arrives under a new webhook id:
        // the dismissal is final, so no sale and no movement.
        await link();
        const before = await movementCount(tx);
        const c = await deliver(tx, "orders/paid", payload);
        expect(c.result).toMatchObject({
          event_status: "skipped",
          outcome: "earlier_delivery_skipped",
          sale_id: null,
          error_code: null,
        });
        expect((await jobsOf(tx, c.event_id)).map((j) => j.status)).toEqual(["done"]);
        expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
        expect(await movementCount(tx)).toBe(before);
        expect(await onlineMovements(tx, productId)).toEqual([]);
      });
    });

    it("a dismissed order delivered again under a new webhook id records nothing (the replay has no business effect)", async () => {
      await inTx(async (tx) => {
        const { productId, variant, link } = await unlinkedProduct(tx);
        const payload = order([line(variant)]);
        const a = await deliver(tx, "orders/paid", payload);
        const [jobA] = await jobsOf(tx, a.event_id);
        await actAs(tx, ADMIN);
        await tx.query("select public.dismiss_integration_job($1, $2)", [
          jobA.id,
          "Refunded in Shopify",
        ]);
        await link();
        const before = await movementCount(tx);
        const again = await deliver(tx, "orders/paid", payload, {
          webhookId: "replayed-webhook-id",
        });
        expect(again).toMatchObject({ duplicate: false, event_status: "pending" });
        expect(again.result).toMatchObject({
          event_status: "skipped",
          outcome: "earlier_delivery_skipped",
        });
        expect(await saleOfOrder(tx, payload.id)).toBeUndefined();
        expect(await movementCount(tx)).toBe(before);
        expect(await onlineMovements(tx, productId)).toEqual([]);
        // Its refunds are not recorded either.
        const refund = await deliver(
          tx,
          "refunds/create",
          refundFor(payload.id, { amount: "5.00" }),
        );
        expect(refund.result).toMatchObject({
          event_status: "skipped",
          outcome: "order_not_recorded",
        });
      });
    });

    it("a dismissed refund delivered again under a new webhook id records nothing; a processed one is duplicate_refund", async () => {
      await inTx(async (tx) => {
        const { variant } = await quantityProduct(tx, { stock: 10 });
        const payload = order([line(variant, { quantity: 2, price: "50.00" })]);
        // The refund arrives first and the admin dismisses it.
        const r = refundFor(payload.id, { amount: "50.00" });
        const early = await deliver(tx, "refunds/create", r);
        expect(early.result.error_code).toBe("shopify_refund_order_unknown");
        const [job] = await jobsOf(tx, early.event_id);
        // Before its order arrives a refund is named by Shopify's order number.
        expect((await eventRow(tx, early.event_id)).subject).toBe(
          `Refund ${r.id} of order ${payload.id}`,
        );
        await actAs(tx, ADMIN);
        await tx.query("select public.dismiss_integration_job($1, $2)", [
          job.id,
          "Refund handled in the shop",
        ]);
        const o = await deliver(tx, "orders/paid", payload);
        expect(o.result.outcome).toBe("sale_recorded");
        expect((await jobRow(tx, job.id)).status).toBe("dismissed");

        const again = await deliver(tx, "refunds/create", r);
        expect(again.result).toMatchObject({
          event_status: "skipped",
          outcome: "earlier_delivery_skipped",
          error_code: null,
        });
        expect(await refundRowsOf(tx, r.id)).toBe(0);
        expect((await saleOfOrder(tx, payload.id)).status).toBe("recorded");

        // A refund that was processed without a row (nothing refunded) stays
        // processed under any webhook id.
        const none = refundFor(payload.id, { amount: "0.00" });
        const first = await deliver(tx, "refunds/create", none);
        expect(first.result).toMatchObject({
          event_status: "processed",
          outcome: "no_money_refunded",
        });
        const second = await deliver(tx, "refunds/create", none);
        expect(second.result).toMatchObject({
          event_status: "processed",
          outcome: "duplicate_refund",
          sale_id: o.result.sale_id,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// D88
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Rejected deliveries are evidence, not input (D88)", () => {
  it("is stored without a body, never queued; the same bad body is one row with a delivery count", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, SERVICE);
      const raw = `{"id": ${nextShopifyId()}}`;
      const r1 = await record(tx, {
        topic: "orders/paid",
        payload: JSON.parse(raw),
        raw,
        rejection: "shop_domain_mismatch",
      });
      expect(r1).toMatchObject({ duplicate: false, event_status: "rejected", job_id: null });
      const r2 = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw,
        rejection: "shop_domain_mismatch",
      });
      expect(r2).toMatchObject({ event_id: r1.event_id, duplicate: true });
      expect(await eventRow(tx, r1.event_id)).toMatchObject({
        status: "rejected",
        payload: null,
        rejection_reason: "shop_domain_mismatch",
        delivery_count: 2,
      });
      // hmac_valid false alone is hmac_invalid.
      const r3 = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw: "not json",
        hmacValid: false,
      });
      expect((await eventRow(tx, r3.event_id)).rejection_reason).toBe("hmac_invalid");
      expect(await jobsOf(tx, r1.event_id)).toEqual([]);
      // Processing it changes nothing.
      expect(await processEvent(tx, r1.event_id)).toMatchObject({
        event_status: "rejected",
        outcome: null,
      });
    });
  });

  it("headers are capped: 16 lower-cased keys, values cut to 512 characters, and a marker", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, SERVICE);
      const headers: Record<string, string> = { "X-Shopify-Topic": "orders/paid" };
      for (let i = 0; i < 20; i++)
        headers[`X-Extra-${String(i).padStart(2, "0")}`] = "v".repeat(600);
      const r = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw: `bad ${randomUUID()}`,
        hmacValid: false,
        headers,
      });
      const stored = (await eventRow(tx, r.event_id)).headers;
      expect(Object.keys(stored)).toHaveLength(17);
      expect(stored["x-bicii-truncated"]).toBe("true");
      expect(Object.keys(stored).every((k) => k === k.toLowerCase())).toBe(true);
      expect(Object.values(stored).every((v) => v.length <= 512)).toBe(true);

      const small = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw: `bad ${randomUUID()}`,
        hmacValid: false,
        headers: { "X-Shopify-Topic": "orders/paid" },
      });
      expect((await eventRow(tx, small.event_id)).headers).toEqual({
        "x-shopify-topic": "orders/paid",
      });
    });
  });

  it("a later valid delivery with the same webhook id is accepted and processed", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx);
      const payload = order([line(variant)]);
      await actAs(tx, SERVICE);
      const rejected = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw: "forged",
        hmacValid: false,
      });
      const valid = await record(tx, {
        topic: "orders/paid",
        payload,
        webhookId: rejected.webhookId,
      });
      expect(valid).toMatchObject({ duplicate: false, event_status: "pending" });
      expect(valid.event_id).not.toBe(rejected.event_id);
      expect(await processEvent(tx, valid.event_id)).toMatchObject({ outcome: "sale_recorded" });
    });
  });
});

describe.skipIf(!isolatedDatabase())("Webhook evidence is immutable (D88)", () => {
  it("received webhooks cannot be changed or deleted, even by the owner; integration history is append-only", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, SERVICE);
      const r = await record(tx, { topic: "orders/paid", payload: { id: nextShopifyId() } });
      await ownerMode(tx);
      for (const sql of [
        "update public.integration_events set payload = '{}'::jsonb where id = $1",
        `update public.integration_events set headers = '{"a": "b"}'::jsonb where id = $1`,
        "update public.integration_events set topic = 'refunds/create' where id = $1",
        "update public.integration_events set external_event_id = 'other' where id = $1",
        "update public.integration_events set hmac_valid = false, rejection_reason = 'hmac_invalid', status = 'rejected', payload = null where id = $1",
        "delete from public.integration_events where id = $1",
      ]) {
        await failsWith(tx, () => tx.query(sql, [r.event_id]), {
          code: "P0001",
          message: "integration_event_immutable",
        });
      }
      await tx.query(
        "insert into public.integration_audit_events (event_type, actor_staff_id, reason) values ('job_retried', $1, 'Test')",
        [STAFF.admin],
      );
      for (const sql of [
        "update public.integration_audit_events set reason = 'Changed'",
        "delete from public.integration_audit_events",
      ]) {
        await failsWith(tx, () => tx.query(sql), {
          code: "P0001",
          message: "integration_history_append_only",
        });
      }
    });
  });

  it("private.purge_integration_events (owner only) deletes old rejected rows and clears old processed payloads; never failed events; at least 30 days", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx);
      const processed = await deliver(tx, "orders/paid", order([line(variant)]));
      const failed = await deliver(tx, "orders/paid", order([line(nextShopifyId())]));
      const rejected = await record(tx, {
        topic: "orders/paid",
        payload: null,
        raw: `old ${randomUUID()}`,
        hmacValid: false,
      });
      await ownerMode(tx);
      await tx.query(
        "update public.integration_events set last_delivered_at = now() - interval '40 days' where id = $1",
        [rejected.event_id],
      );
      await tx.query(
        "update public.integration_events set processed_at = now() - interval '40 days' where id = any ($1::uuid[])",
        [[processed.event_id]],
      );
      await tx.query(
        "update public.integration_events set last_delivered_at = now() - interval '40 days' where id = $1",
        [failed.event_id],
      );
      await failsWith(
        tx,
        () => tx.query("select * from private.purge_integration_events('29 days')"),
        { code: "22023" },
      );
      const { rows } = await tx.query("select * from private.purge_integration_events('30 days')");
      expect(rows).toEqual([{ rejected_deleted: 1, payloads_purged: 1 }]);
      expect(
        await scalar(tx, "select count(*)::int from public.integration_events where id = $1", [
          rejected.event_id,
        ]),
      ).toBe(0);
      const purged = await tx.query(
        "select payload, payload_purged_at is not null as purged from public.integration_events where id = $1",
        [processed.event_id],
      );
      expect(purged.rows[0]).toEqual({ payload: null, purged: true });
      expect((await eventRow(tx, failed.event_id)).payload).not.toBeNull();
      // The purge setting does not outlive the call.
      await failsWith(
        tx,
        () => tx.query("delete from public.integration_events where status = 'rejected'"),
        {
          message: "integration_event_immutable",
        },
      );
      // No API role may run it.
      for (const claims of [ADMIN, SERVICE, ANON]) {
        await actAs(tx, claims);
        await failsWith(
          tx,
          () => tx.query("select * from private.purge_integration_events('365 days')"),
          { code: "42501" },
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// D87
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Retry policy (D87)", () => {
  it("a transient failure backs off 1, 2, 4 ... minutes, capped at 6 hours, and needs attention after max_attempts", async () => {
    await inTx(async (tx) => {
      const backoff = async (n: number) =>
        scalar<number>(
          tx,
          "select (extract(epoch from private.integration_backoff($1)) / 60)::int",
          [n],
        );
      await readAsOwner(tx, async () => {
        expect([
          await backoff(0),
          await backoff(1),
          await backoff(2),
          await backoff(3),
          await backoff(9),
          await backoff(10),
          await backoff(1000),
        ]).toEqual([1, 1, 2, 4, 256, 360, 360]);
      });
      // A refund for an order that never arrives is transient.
      const d = await deliver(tx, "refunds/create", refundFor(nextShopifyId(), { amount: "5.00" }));
      const [job] = await jobsOf(tx, d.event_id);
      const dues: number[] = [];
      for (let attempt = 1; attempt <= 8; attempt++) {
        const { rows } = await tx.query(
          "select attempts from public.claim_integration_jobs(1, $1)",
          [job.id],
        );
        expect(rows).toEqual([{ attempts: attempt }]);
        expect((await processEvent(tx, d.event_id)).error_code).toBe(
          "shopify_refund_order_unknown",
        );
        const now = await jobRow(tx, job.id);
        if (attempt < 8) {
          expect(now.status).toBe("queued");
          dues.push(now.due_in_minutes);
        } else {
          expect(now).toMatchObject({ status: "needs_attention", attempts: 8 });
        }
      }
      expect(dues).toEqual([1, 2, 4, 8, 16, 32, 64]);
      expect((await eventRow(tx, d.event_id)).attempts).toBe(9);
    });
  });

  it("claim skips jobs not yet due unless named, reclaims running jobs stalled 10 minutes, and keeps one running product sync per product", async () => {
    await inTx(async (tx) => {
      const later = await deliver(
        tx,
        "refunds/create",
        refundFor(nextShopifyId(), { amount: "5.00" }),
      );
      const [job] = await jobsOf(tx, later.event_id);
      expect(job.due_in_minutes).toBeGreaterThan(0);
      const claimedIds = async (sql: string, params: unknown[] = []) =>
        (await tx.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
      expect(await claimedIds("select id from public.claim_integration_jobs(50)")).not.toContain(
        job.id,
      );
      expect(
        await claimedIds("select id from public.claim_integration_jobs(5, $1)", [job.id]),
      ).toEqual([job.id]);
      // Running and fresh: not claimed again; stalled for 10 minutes: reclaimed.
      expect(await claimedIds("select id from public.claim_integration_jobs(50)")).not.toContain(
        job.id,
      );
      await readAsOwner(tx, () =>
        tx.query(
          "update public.integration_retry_queue set locked_at = now() - interval '11 minutes' where id = $1",
          [job.id],
        ),
      );
      expect(await claimedIds("select id from public.claim_integration_jobs(50)")).toContain(
        job.id,
      );
      expect((await jobRow(tx, job.id)).attempts).toBe(2);

      // Product syncs (rows written as the owner; step 2 adds their writers).
      const { productId } = await quantityProduct(tx);
      const { productId: busy } = await quantityProduct(tx);
      const [stale, queued, running, waiting] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await readAsOwner(tx, () =>
        tx.query(
          `insert into public.integration_retry_queue (id, kind, product_id, status, locked_at, next_attempt_at) values
             ($1, 'product_sync', $5, 'running', now() - interval '20 minutes', now() - interval '30 minutes'),
             ($2, 'product_sync', $5, 'queued', null, now() - interval '1 minute'),
             ($3, 'product_sync', $6, 'running', now() - interval '1 minute', now() - interval '5 minutes'),
             ($4, 'product_sync', $6, 'queued', null, now() - interval '1 minute')`,
          [stale, queued, running, waiting, productId, busy],
        ),
      );
      await actAs(tx, SERVICE);
      const claimed = await claimedIds("select id from public.claim_integration_jobs(50)");
      expect(claimed).toContain(queued);
      expect(claimed).not.toContain(stale);
      expect(claimed).not.toContain(waiting);
      expect(await jobRow(tx, stale)).toMatchObject({
        status: "dismissed",
        resolution_reason: "Superseded after a stalled run",
        resolved_by: null,
      });
      expect((await jobRow(tx, waiting)).status).toBe("queued");
    });
  });

  it("a stalled job out of attempts is never reclaimed: it needs attention and its event is failed (A-17)", async () => {
    await inTx(async (tx) => {
      const stalledMessage = "The last runs did not finish. Retry, or dismiss with a reason.";
      const exhausted = await deliver(
        tx,
        "refunds/create",
        refundFor(nextShopifyId(), { amount: "5.00" }),
      );
      const spare = await deliver(
        tx,
        "refunds/create",
        refundFor(nextShopifyId(), { amount: "6.00" }),
      );
      const [eventJob] = await jobsOf(tx, exhausted.event_id);
      const [spareJob] = await jobsOf(tx, spare.event_id);
      const { productId } = await quantityProduct(tx);
      const syncJob = randomUUID();
      await readAsOwner(tx, async () => {
        await tx.query(
          `update public.integration_retry_queue
              set status = 'running', locked_at = now() - interval '11 minutes',
                  attempts = case when id = $1 then 8 else 7 end
            where id = any($2::uuid[])`,
          [eventJob.id, [eventJob.id, spareJob.id]],
        );
        await tx.query(
          `insert into public.integration_retry_queue (id, kind, product_id, status, attempts, locked_at)
           values ($1, 'product_sync', $2, 'running', 8, now() - interval '11 minutes')`,
          [syncJob, productId],
        );
      });

      await actAs(tx, SERVICE);
      const { rows } = await tx.query<{ id: string; attempts: number }>(
        "select id, attempts from public.claim_integration_jobs(50)",
      );
      const claimed = rows.map((r) => r.id);
      expect(claimed).not.toContain(eventJob.id);
      expect(claimed).not.toContain(syncJob);
      // A stalled job with an attempt left is still reclaimed.
      expect(rows.find((r) => r.id === spareJob.id)?.attempts).toBe(8);

      for (const id of [eventJob.id, syncJob]) {
        expect(await jobRow(tx, id)).toMatchObject({
          status: "needs_attention",
          attempts: 8,
          last_error_code: "integration_job_stalled",
          last_error: stalledMessage,
        });
      }
      expect(await eventRow(tx, exhausted.event_id)).toMatchObject({
        status: "failed",
        last_error_code: "integration_job_stalled",
        last_error: stalledMessage,
      });
      expect(await failedRowsFor(tx, [eventJob.id, syncJob])).toEqual(
        expect.arrayContaining([eventJob.id, syncJob]),
      );

      // A later claim leaves it alone.
      await actAs(tx, SERVICE);
      expect(
        (await tx.query("select id from public.claim_integration_jobs(5, $1)", [eventJob.id])).rows,
      ).toEqual([]);
      expect((await jobRow(tx, eventJob.id)).status).toBe("needs_attention");
    });
  });

  it("two concurrent claimers never get the same job", async (ctx) => {
    if (!isolatedDatabase()) ctx.skip();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await must(
        committed(
          setup,
          (tx) =>
            record(tx, {
              topic: "refunds/create",
              payload: refundFor(nextShopifyId(), { amount: "1.00" }),
            }),
          SERVICE,
        ),
      );
      ids.push(r.job_id!);
    }
    const [a, b] = await openConnections(2);
    await a.query("begin");
    await actAs(a, SERVICE);
    const first = (
      await a.query<{ id: string }>("select id from public.claim_integration_jobs(50)")
    ).rows.map((r) => r.id);
    const second = await must(
      committed(
        b,
        async (tx) =>
          (
            await tx.query<{ id: string }>("select id from public.claim_integration_jobs(50)")
          ).rows.map((r) => r.id),
        SERVICE,
      ),
    );
    await a.query("commit");
    for (const id of ids) expect(first).toContain(id);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
  });

  it("dismiss needs an admin and a reason, closes the job, marks the event skipped/dismissed and writes an audit row; closed and running jobs are refused", async () => {
    await inTx(async (tx) => {
      const d = await deliver(tx, "orders/paid", order([line(nextShopifyId())]));
      const [job] = await jobsOf(tx, d.event_id);
      await actAs(tx, MECHANIC1);
      await failsWith(
        tx,
        () => tx.query("select public.dismiss_integration_job($1, 'x')", [job.id]),
        { code: "42501" },
      );
      await actAs(tx, ADMIN);
      for (const reason of [null, "   "]) {
        await failsWith(
          tx,
          () => tx.query("select public.dismiss_integration_job($1, $2)", [job.id, reason]),
          {
            code: "P0001",
            message: "reason_required",
          },
        );
      }
      await failsWith(
        tx,
        () => tx.query("select public.dismiss_integration_job($1, $2)", [job.id, "x".repeat(501)]),
        {
          message: "reason_too_long",
        },
      );
      await tx.query("select public.dismiss_integration_job($1, $2)", [job.id, "Sold by hand"]);
      expect(await jobRow(tx, job.id)).toMatchObject({
        status: "dismissed",
        resolution_reason: "Sold by hand",
        resolved_by: STAFF.admin,
      });
      expect(await eventRow(tx, d.event_id)).toMatchObject({
        status: "skipped",
        outcome: "dismissed",
        last_error_code: "shopify_variant_unmapped",
      });
      for (const sql of [
        "select public.dismiss_integration_job($1, 'Again')",
        "select public.retry_integration_job($1)",
      ]) {
        await failsWith(tx, () => tx.query(sql, [job.id]), {
          code: "P0001",
          message: "integration_job_closed",
        });
      }

      const running = await deliver(
        tx,
        "refunds/create",
        refundFor(nextShopifyId(), { amount: "5.00" }),
      );
      const [runningJob] = await jobsOf(tx, running.event_id);
      await tx.query("select public.claim_integration_jobs(1, $1)", [runningJob.id]);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => tx.query("select public.dismiss_integration_job($1, 'Stop')", [runningJob.id]),
        {
          code: "P0001",
          message: "integration_job_running",
        },
      );
      // Retrying a running job returns it unchanged.
      const { rows } = await tx.query(
        "select status::text, attempts from public.retry_integration_job($1)",
        [runningJob.id],
      );
      expect(rows[0]).toEqual({ status: "running", attempts: 1 });
    });
  });

  it("retry: admins any job; manage_inventory product-sync jobs only; others 42501; audited", async () => {
    await inTx(async (tx) => {
      const d = await deliver(tx, "orders/paid", order([line(nextShopifyId())]));
      const [eventJob] = await jobsOf(tx, d.event_id);
      const { productId } = await quantityProduct(tx);
      const syncJob = randomUUID();
      await readAsOwner(tx, () =>
        tx.query(
          `insert into public.integration_retry_queue (id, kind, product_id, status, attempts, last_error)
           values ($1, 'product_sync', $2, 'needs_attention', 8, 'Shopify said no')`,
          [syncJob, productId],
        ),
      );
      await ownerMode(tx);
      const inventory = await staffWith(tx, ["manage_inventory"]);
      await actAs(tx, inventory.claims);
      await failsWith(
        tx,
        () => tx.query("select public.retry_integration_job($1)", [eventJob.id]),
        { code: "42501" },
      );
      const { rows } = await tx.query(
        "select status::text, max_attempts, last_retried_by from public.retry_integration_job($1)",
        [syncJob],
      );
      expect(rows[0]).toEqual({
        status: "queued",
        max_attempts: 11,
        last_retried_by: inventory.staffId,
      });
      for (const claims of [MECHANIC1, MECHANIC2]) {
        await actAs(tx, claims);
        for (const id of [eventJob.id, syncJob]) {
          await failsWith(tx, () => tx.query("select public.retry_integration_job($1)", [id]), {
            code: "42501",
          });
        }
      }
      await actAs(tx, ADMIN);
      const retried = await tx.query("select status::text from public.retry_integration_job($1)", [
        eventJob.id,
      ]);
      expect(retried.rows[0].status).toBe("queued");
      const audit = await readAsOwner(tx, async () => {
        const { rows: a } = await tx.query(
          "select job_id, actor_staff_id from public.integration_audit_events where event_type = 'job_retried' and job_id = any ($1::uuid[]) order by created_at",
          [[eventJob.id, syncJob]],
        );
        return a;
      });
      expect(audit).toEqual([
        { job_id: syncJob, actor_staff_id: inventory.staffId },
        { job_id: eventJob.id, actor_staff_id: STAFF.admin },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC §26, D86
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "Integration failures are operational exceptions (SPEC §26, D86)",
  () => {
    type ExceptionRow = {
      kind: string;
      severity: string;
      entity_type: string;
      entity_id: string;
      entity_label: string;
      subject_label: string;
      days: number;
    };
    const exceptionsAs = async (tx: pg.Client, claims: Claims) => {
      await actAs(tx, claims);
      const { rows } = await tx.query<ExceptionRow>(
        "select kind, severity, entity_type, entity_id, entity_label, subject_label, days from public.operational_exceptions(200)",
      );
      return rows;
    };
    const exceptionsNow = async (tx: pg.Client, claims: Claims) => {
      await actAs(tx, claims);
      return scalar<number>(tx, "select exceptions_now from public.today_dashboard(null)");
    };

    it("a needs_attention job is an integration_failed row for admins only; retrying it to done removes it; P5's kinds are unchanged", async () => {
      await inTx(async (tx) => {
        const { productId } = await quantityProduct(tx, { stock: 10 });
        await readAsOwner(tx, () =>
          tx.query(
            "update public.products set shopify_product_id = null, shopify_variant_id = null where id = $1",
            [productId],
          ),
        );
        const variant = nextShopifyId();
        const d = await deliver(
          tx,
          "orders/paid",
          order([line(variant, { title: "Bar tape" })], { name: "#5001" }),
        );
        const [job] = await jobsOf(tx, d.event_id);

        const admin = await exceptionsAs(tx, ADMIN);
        expect(admin.filter((r) => r.entity_id === job.id)).toEqual([
          {
            kind: "integration_failed",
            severity: "danger",
            entity_type: "integration_job",
            entity_id: job.id,
            entity_label: "#5001",
            subject_label: d.result.error_message,
            days: 0,
          },
        ]);
        for (const claims of [MECHANIC1, MECHANIC2]) {
          const rows = await exceptionsAs(tx, claims);
          expect(rows.filter((r) => r.kind === "integration_failed")).toEqual([]);
          expect(rows).toEqual(admin.filter((r) => r.kind !== "integration_failed"));
        }
        const failing = await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.integration_retry_queue where status = 'needs_attention'",
          ),
        );
        expect((await exceptionsNow(tx, ADMIN)) - (await exceptionsNow(tx, MECHANIC2))).toBe(
          failing,
        );

        await actAs(tx, ADMIN);
        await tx.query("select public.link_shopify_variant($1, $2, $3, 'The bar tape')", [
          productId,
          String(nextShopifyId()),
          String(variant),
        ]);
        await tx.query("select public.retry_integration_job($1)", [job.id]);
        await actAs(tx, SERVICE);
        await tx.query("select public.claim_integration_jobs(1, $1)", [job.id]);
        expect(await processEvent(tx, d.event_id)).toMatchObject({ outcome: "sale_recorded" });
        expect((await exceptionsAs(tx, ADMIN)).filter((r) => r.entity_id === job.id)).toEqual([]);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// SPEC §17.2, D86
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("Customer linking is explicit (SPEC §17.2, D86)", () => {
  it("never by email; an admin links with a reason; recorded sales are never edited; later orders get the customer", async () => {
    await inTx(async (tx) => {
      const { variant } = await quantityProduct(tx, { stock: 10 });
      const shopifyCustomer = nextShopifyId();
      const gid = `gid://shopify/Customer/${shopifyCustomer}`;
      const first = order([line(variant)], {
        customer: { id: shopifyCustomer, email: "priya.ramasamy@example.com" },
      });
      await deliver(tx, "orders/paid", first);
      expect(await saleOfOrder(tx, first.id)).toMatchObject({
        customer_id: null,
        shopify_customer_id: gid,
      });

      await actAs(tx, MECHANIC1);
      await failsWith(
        tx,
        () => tx.query("select public.link_shopify_customer($1, $2, 'x')", [CUSTOMER.priya, gid]),
        {
          code: "42501",
        },
      );
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => tx.query("select public.link_shopify_customer($1, $2, ' ')", [CUSTOMER.priya, gid]),
        {
          message: "reason_required",
        },
      );
      const link = async (customerId: string, id: string) => {
        const { rows } = await tx.query(
          `select (r).customer_id, (r).shopify_customer_id, (r).earlier_online_sales
             from (select public.link_shopify_customer($1, $2, 'Confirmed by phone') r) s`,
          [customerId, id],
        );
        return rows[0];
      };
      expect(await link(CUSTOMER.priya, String(shopifyCustomer))).toEqual({
        customer_id: CUSTOMER.priya,
        shopify_customer_id: gid,
        earlier_online_sales: 1,
      });
      // Replay: no-op.
      expect(await link(CUSTOMER.priya, gid)).toEqual({
        customer_id: CUSTOMER.priya,
        shopify_customer_id: gid,
        earlier_online_sales: 1,
      });
      expect(await saleOfOrder(tx, first.id)).toMatchObject({
        customer_id: null,
        shopify_customer_id: gid,
      });
      await failsWith(tx, () => link(CUSTOMER.priya, String(nextShopifyId())), {
        code: "P0001",
        message: "shopify_customer_already_linked",
      });
      await failsWith(tx, () => link(CUSTOMER.hafiz, gid), {
        code: "23505",
        constraint: "customers_shopify_customer_id_key",
      });
      const audits = await readAsOwner(tx, () =>
        scalar<number>(
          tx,
          "select count(*)::int from public.integration_audit_events where event_type = 'customer_linked' and customer_id = $1",
          [CUSTOMER.priya],
        ),
      );
      expect(audits).toBe(1);

      const second = order([line(variant)], {
        customer: { id: shopifyCustomer, email: "someone.else@example.com" },
      });
      await deliver(tx, "orders/paid", second);
      expect(await saleOfOrder(tx, second.id)).toMatchObject({
        customer_id: CUSTOMER.priya,
        shopify_customer_id: gid,
      });
    });
  });

  it("link_shopify_variant: admin and reason; conflicts; the same ids are a no-op; recorded in the product's history", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const a = await makeProduct(tx);
      const b = await makeProduct(tx);
      const shopifyProduct = String(nextShopifyId());
      const [v1, v2] = [String(nextShopifyId()), String(nextShopifyId())];
      const link = (productId: string, variant: string, reason = "Matched by hand") =>
        tx.query(
          "select product_id, shopify_origin from public.link_shopify_variant($1, $2, $3, $4)",
          [productId, shopifyProduct, variant, reason],
        );
      await actAs(tx, MECHANIC1);
      await failsWith(tx, () => link(a, v1), { code: "42501" });
      await actAs(tx, ADMIN);
      await failsWith(tx, () => link(a, v1, ""), { message: "reason_required" });
      await failsWith(tx, () => link(a, "variant-1"), {
        code: "P0001",
        message: "shopify_gid_invalid",
      });
      await link(a, v1);
      // Two BICII products may link two variants of one Shopify product.
      await link(b, v2);
      await link(a, v1);
      await failsWith(tx, () => link(a, v2), { code: "P0001", message: "shopify_ids_conflict" });
      const c = await readAsOwner(tx, () => makeProduct(tx));
      await failsWith(tx, () => link(c, v1), {
        code: "23505",
        constraint: "products_shopify_variant_id_key",
      });
      const audits = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          "select payload from public.integration_audit_events where event_type = 'variant_linked' and product_id = $1",
          [a],
        );
        return rows;
      });
      expect(audits).toEqual([
        {
          payload: {
            from: { product: null, variant: null },
            to: {
              product: `gid://shopify/Product/${shopifyProduct}`,
              variant: `gid://shopify/ProductVariant/${v1}`,
            },
          },
        },
      ]);
      const history = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          "select payload, reason from public.product_events where product_id = $1 and event_type = 'details_changed'",
          [a],
        );
        return rows;
      });
      expect(history).toEqual([
        {
          payload: { fields: ["shopify_product_id", "shopify_variant_id"] },
          reason: "Matched by hand",
        },
      ]);

      // A Shopify product BICII created belongs to its one BICII product.
      await readAsOwner(tx, () =>
        tx.query(
          "update public.shopify_product_sync set shopify_origin = 'bicii' where product_id = $1",
          [b],
        ),
      );
      await failsWith(tx, () => link(c, String(nextShopifyId())), {
        code: "P0001",
        message: "shopify_ids_conflict",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// DATA-MODEL §15
// ---------------------------------------------------------------------------

describe("Who can reach it (DATA-MODEL §15)", () => {
  const SERVICE_CALLS = [
    "select * from public.record_shopify_webhook('orders/paid', 'x', null, null, null, null, '{}', '{}', repeat('a', 64), 1, true, null, null)",
    "select * from public.claim_integration_jobs(1)",
    `select * from public.process_shopify_order_paid('${randomUUID()}')`,
    `select * from public.process_shopify_refund('${randomUUID()}')`,
    `select * from public.process_shopify_event('${randomUUID()}')`,
  ];
  const TABLES = [
    "integration_events",
    "integration_retry_queue",
    "integration_audit_events",
    "shopify_settings",
    "shopify_product_sync",
  ];

  it("anon and authenticated (admin included) get 42501 from every service RPC", async () => {
    await inTransaction(conn, async (tx) => {
      for (const claims of [ANON, ADMIN, MECHANIC2]) {
        for (const sql of SERVICE_CALLS) {
          await actAs(tx, claims);
          await failsWith(tx, () => tx.query(sql), {
            code: "42501",
            message: expect.stringContaining("permission denied for function"),
          });
        }
      }
    });
  });

  it("admins read events, the queue and the audit trail; mechanics read none of them but read the settings and sync rows", async () => {
    await inTransaction(conn, async (tx) => {
      const count = (table: string) =>
        scalar<number>(tx, `select count(*)::int from public.${table}`);
      await actAs(tx, ADMIN);
      expect(await count("integration_events")).toBeGreaterThanOrEqual(4);
      expect(await count("integration_retry_queue")).toBeGreaterThanOrEqual(3);
      await count("integration_audit_events");
      for (const claims of [MECHANIC1, MECHANIC2]) {
        await actAs(tx, claims);
        for (const table of [
          "integration_events",
          "integration_retry_queue",
          "integration_audit_events",
        ]) {
          expect({ table, n: await count(table) }).toEqual({ table, n: 0 });
        }
        expect(await count("shopify_settings")).toBe(1);
        expect(await count("shopify_product_sync")).toBeGreaterThanOrEqual(1);
      }
      // Nothing is written through the API.
      await actAs(tx, ADMIN);
      for (const sql of [
        "update public.shopify_settings set accept_test_orders = false",
        "update public.shopify_product_sync set publish_online = false",
        "delete from public.integration_retry_queue",
        "insert into public.integration_audit_events (event_type) values ('sync_requested')",
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
    });
  });

  it("a signed-in customer reads zero rows from every new table and no Shopify field in my_customer_profile; anon cannot select them", async () => {
    await inTransaction(conn, async (tx) => {
      const authUserId = await linkCustomerLogin(tx, CUSTOMER.priya);
      await actAs(tx, customerClaims(authUserId));
      for (const table of TABLES) {
        expect({
          table,
          n: await scalar<number>(tx, `select count(*)::int from public.${table}`),
        }).toEqual({ table, n: 0 });
      }
      const { fields } = await tx.query("select * from public.my_customer_profile()");
      expect(fields.map((f) => f.name).filter((n) => n.includes("shopify"))).toEqual([]);
      for (const table of TABLES) {
        await actAs(tx, ANON);
        await failsWith(tx, () => tx.query(`select * from public.${table}`), { code: "42501" });
      }
    });
  });

  it("authenticated cannot update products' Shopify columns or a customer's Shopify id (links change only through the RPCs)", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      for (const sql of [
        `update public.products set shopify_variant_id = 'gid://shopify/ProductVariant/1' where id = '${SHOPIFY_PRODUCT.e2ePhone}'`,
        `update public.products set shopify_product_id = 'gid://shopify/Product/1' where id = '${SHOPIFY_PRODUCT.e2ePhone}'`,
        `update public.customers set shopify_customer_id = 'gid://shopify/Customer/1' where id = '${CUSTOMER.tan}'`,
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The seed (DATA-MODEL §18 "Phase 10 part")
// ---------------------------------------------------------------------------

describe("Seeded integration data is consistent", () => {
  const seededEvent = (tx: pg.Client, webhookId: string) =>
    readAsOwner(tx, async () => {
      const { rows } = await tx.query<EventRow>(
        `select id, topic, status::text, outcome, payload, result, last_error_code, sale_id, rejection_reason::text,
                delivery_count
           from public.integration_events where external_event_id = $1`,
        [webhookId],
      );
      return rows;
    });

  it("#1001 is one online sale with one movement, recognised 8 shop days back; its refund one row and no movement", async () => {
    await inTransaction(conn, async (tx) => {
      const [paid] = await seededEvent(tx, SHOPIFY_WEBHOOK_ID.orderPaid);
      expect(paid).toMatchObject({ status: "processed", outcome: "sale_recorded" });
      const sales = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          `select id, sale_number, status::text, source::text, customer_id, shopify_customer_id,
                  to_char(private.shop_day(recognized_at), 'YYYY-MM-DD') as day
             from public.sales where shopify_order_id = $1`,
          [SHOPIFY_ORDER.synced.gid],
        );
        return rows;
      });
      expect(sales).toHaveLength(1);
      const anchor = await seedToday(tx);
      expect(sales[0]).toMatchObject({
        id: paid.sale_id,
        sale_number: SHOPIFY_ORDER.synced.saleNumber,
        status: "partially_refunded",
        source: "online_shopify",
        customer_id: null,
        shopify_customer_id: SHOPIFY_GID.onlineCustomer,
        day: addDays(anchor, -SHOPIFY_ORDER.synced.processedDaysAgo),
      });
      const lines = await saleLines(tx, paid.sale_id!);
      expect(lines).toEqual([
        expect.objectContaining({
          product_id: SHOPIFY_PRODUCT.syncedTyre,
          quantity: "1.00",
          sale_total: SHOPIFY_ORDER.synced.total,
          shopify_line_item_id: SHOPIFY_ORDER.synced.lineItemGid,
        }),
      ]);
      const movements = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          "select movement_type::text, quantity_delta, sale_line_id from public.inventory_movements where product_id = $1 order by id",
          [SHOPIFY_PRODUCT.syncedTyre],
        );
        return rows;
      });
      expect(movements).toEqual([
        { movement_type: "stock_adjustment", quantity_delta: 12, sale_line_id: null },
        { movement_type: "online_sale", quantity_delta: -1, sale_line_id: lines[0].id },
      ]);

      const [refunded] = await seededEvent(tx, SHOPIFY_WEBHOOK_ID.refund);
      expect(refunded).toMatchObject({
        status: "processed",
        outcome: "refund_recorded",
        sale_id: paid.sale_id,
      });
      const refunds = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          "select amount::text, shopify_refund_id, restocked, recorded_by from public.sale_refunds where sale_id = $1",
          [paid.sale_id],
        );
        return rows;
      });
      expect(refunds).toEqual([
        {
          amount: SHOPIFY_ORDER.synced.refunded,
          shopify_refund_id: SHOPIFY_ORDER.synced.refundGid,
          restocked: false,
          recorded_by: null,
        },
      ]);
      const entries = await readAsOwner(tx, async () => {
        const { rows } = await tx.query(
          // D274: lines only (the sale's Shopify fee entry is pending beside them).
          "select channel, recognized_day::text as day, sale_total::text from reporting.financial_lines where document_id = $1 and entry_kind = 'line'",
          [paid.sale_id],
        );
        return rows;
      });
      expect(entries).toEqual([
        {
          channel: "online",
          day: addDays(anchor, -SHOPIFY_ORDER.synced.processedDaysAgo),
          sale_total: "95.00",
        },
      ]);
    });
  });

  it("#1002 waits for an admin; the rejected delivery has no body", async () => {
    await inTransaction(conn, async (tx) => {
      const [unmapped] = await seededEvent(tx, SHOPIFY_WEBHOOK_ID.unmappedOrder);
      expect(unmapped).toMatchObject({
        status: "failed",
        last_error_code: "shopify_variant_unmapped",
        sale_id: null,
      });
      expect(unmapped.result).toEqual({
        unmapped_lines: [
          expect.objectContaining({
            title: "BICII cotton cap",
            variant_gid: SHOPIFY_GID.unmappedVariant,
          }),
        ],
      });
      expect(await jobsOf(tx, unmapped.id)).toEqual([
        expect.objectContaining({ status: "needs_attention" }),
      ]);
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(tx, "select count(*)::int from public.sales where shopify_order_id = $1", [
            SHOPIFY_ORDER.unmapped.gid,
          ]),
        ),
      ).toBe(0);
      const [rejected] = await seededEvent(tx, SHOPIFY_WEBHOOK_ID.rejected);
      expect(rejected).toMatchObject({
        status: "rejected",
        rejection_reason: "hmac_invalid",
        payload: null,
        delivery_count: 1,
      });
      expect(await jobsOf(tx, rejected.id)).toEqual([]);
    });
  });

  it("syncedTyre is public, linked and synced at its on-hand and selling price; the settings are the documented ones", async () => {
    await inTransaction(conn, async (tx) => {
      await readAsOwner(tx, async () => {
        const { rows: product } = await tx.query(
          "select short_id, publication_status::text, shopify_product_id, shopify_variant_id from public.products where id = $1",
          [SHOPIFY_PRODUCT.syncedTyre],
        );
        expect(product[0]).toEqual({
          short_id: SHOPIFY_PRODUCT_SHORT_ID.syncedTyre,
          publication_status: "public",
          shopify_product_id: SHOPIFY_GID.syncedTyreProduct,
          shopify_variant_id: SHOPIFY_GID.syncedTyreVariant,
        });
        const { rows: sync } = await tx.query(
          `select publish_online, sync_status::text, shopify_origin, shopify_inventory_item_id, shopify_handle,
                  last_pushed_quantity, last_pushed_price::text, desired_hash
             from public.shopify_product_sync where product_id = $1`,
          [SHOPIFY_PRODUCT.syncedTyre],
        );
        expect(sync[0]).toEqual({
          publish_online: true,
          sync_status: "synced",
          shopify_origin: "bicii",
          shopify_inventory_item_id: SHOPIFY_GID.syncedTyreInventoryItem,
          shopify_handle: SHOPIFY_GID.syncedTyreHandle,
          last_pushed_quantity: await onHand(tx, SHOPIFY_PRODUCT.syncedTyre),
          last_pushed_price: await scalar(tx, "select private.selling_price($1, null)::text", [
            SHOPIFY_PRODUCT.syncedTyre,
          ]),
          desired_hash: null,
        });
        expect(sync[0].last_pushed_quantity).toBe(11);
        const { rows: settings } = await tx.query(
          "select online_location_id, shopify_location_id, storefront_url, accept_test_orders from public.shopify_settings",
        );
        expect(settings).toEqual([
          {
            online_location_id: SHOPIFY_SETTINGS.onlineLocationId,
            shopify_location_id: SHOPIFY_SETTINGS.shopifyLocationId,
            storefront_url: SHOPIFY_SETTINGS.storefrontUrl,
            accept_test_orders: SHOPIFY_SETTINGS.acceptTestOrders,
          },
        ]);
        // The fixture products: stock at the Shop floor, no other Shopify ids.
        for (const [key, stock] of [
          ["e2ePhone", 20],
          ["e2eTablet", 20],
          ["e2eLinkPhone", 20],
          ["e2eLinkTablet", 20],
          ["stack", 50],
          ["stackExternal", 50],
        ] as const) {
          const id = SHOPIFY_PRODUCT[key];
          expect({ key, stock: await onHand(tx, id) }).toEqual({ key, stock });
          const { rows } = await tx.query(
            "select short_id, publication_status::text, shopify_variant_id from public.products where id = $1",
            [id],
          );
          expect(rows[0]).toEqual({
            short_id: SHOPIFY_PRODUCT_SHORT_ID[key],
            publication_status: "internal_only",
            shopify_variant_id: null,
          });
        }
      });
    });
  });
});
