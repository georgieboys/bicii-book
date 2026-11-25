/**
 * D274: Shopify Payments fees are borne by Cult Commons too (PLAN D274,
 * amends D273; ADR-020 amendment; DATA-MODEL §19a). The invariant:
 *
 *   per online sale:  net CC = gross CC - least(sale share, gross CC)
 *   per job:          Stripe borne  = least(stripe, gross)
 *                     Shopify borne = least(build share, gross - Stripe borne)
 *
 * where an order's fee (Σ TransactionFee.amount, read as the fee less GST)
 * is split pro rata by amount between its build orders and the sale (the
 * sale keeps the rest, shipping included). A fee comes only from a server
 * read of the order (record_shopify_fee_read), is insert-only and
 * view_costs to read; the deduction is one shopify_fee entry per sale (on
 * recognized_at) and per completed job with a build order share (on its
 * current completed_at) in reporting.financial_lines.
 *
 * The file creates products, sales and jobs, so it runs only on a per-file
 * clone, in rolled-back transactions. Period figures are compared as
 * differences within one transaction (the seed recognises other entries on
 * the same days and its online sales are pending too: history restated).
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import { paymentIntentObject } from "../fixtures/stripe";
import {
  orderPaidPayload,
  refundPayload,
  SHOPIFY_TEST_SHOP,
  type OrderLineInput,
  type OrderPaidInput,
} from "../fixtures/shopify";
import { createConsignor, intakeUnique, itemLedger, saleLines } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  MECHANIC2,
  addPart,
  addStock,
  completeJob,
  makeProduct,
  newJob,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { pay, tag, type Pay } from "./payment-fixtures";
import { addDays, shopToday } from "./reporting-fixtures";
import { failsWith, makeService, ownerMode, setStatus, voidLine } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sequence = 0;
const idBase = 8_700_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
const nextShopifyId = () => idBase + ++sequence;

/** A rolled-back transaction acting as the admin. */
const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

/** Owner: link a product to a fresh Shopify variant; returns the variant's number. */
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

/** A stocked quantity product (price 100.00, cost 40.00: yield 60, Cult Commons 18). */
async function product(tx: pg.Client, price = "100.00", cost = "40.00"): Promise<number> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price, cost });
  await actAs(tx, ADMIN);
  await addStock(tx, productId, 5, { locationId: LOCATION.shopFloor });
  return linkVariant(tx, productId);
}

/** A full build pushed to Shopify (as build-package-sales.test.ts). */
async function onlinePackage(tx: pg.Client, price: string): Promise<number> {
  await ownerMode(tx);
  const serviceId = await makeService(tx, {
    name: `Build labour ${randomUUID().slice(0, 6)}`,
    price: "180.00",
  });
  const donorServiceId = await makeService(tx, {
    name: `Donor strip ${randomUUID().slice(0, 6)}`,
    price: "185.00",
  });
  const variant = nextShopifyId();
  await tx.query(
    `insert into public.build_packages
       (kind, name, price, labour_amount, labour_service_id, publish_online, shopify_product_id, shopify_variant_id,
        shopify_own_frame_variant_id, shopify_donor_variant_id, shopify_donor_amount, donor_service_id)
     values ('full_build', $1, $2, 180, $3, true, $4, $5, $6, $7, 185, $8)`,
    [
      `Restomod ${randomUUID().slice(0, 6)}`,
      price,
      serviceId,
      `gid://shopify/Product/${nextShopifyId()}`,
      `gid://shopify/ProductVariant/${variant}`,
      `gid://shopify/ProductVariant/${nextShopifyId()}`,
      `gid://shopify/ProductVariant/${nextShopifyId()}`,
      donorServiceId,
    ],
  );
  await actAs(tx, ADMIN);
  return variant;
}

const line = (variantId: number, price: string): OrderLineInput => ({
  lineItemId: nextShopifyId(),
  productId: null,
  variantId,
  title: "Test item",
  variantTitle: null,
  quantity: 1,
  price,
});

type Order = { saleId: string; orderGid: string; orderId: number };

/** Records and processes an orders/paid event as the service role; ends as the admin. */
async function deliverOrder(
  tx: pg.Client,
  lines: OrderLineInput[],
  extra: Partial<OrderPaidInput> = {},
): Promise<Order> {
  const orderId = nextShopifyId();
  const payload = orderPaidPayload({ orderId, name: `#F${orderId}`, lines, ...extra });
  const raw = JSON.stringify(payload);
  await actAs(tx, SERVICE);
  const recorded = await tx.query<{ event_id: string }>(
    `select event_id from public.record_shopify_webhook($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11,
                                                         $12::public.integration_rejection_reason, $13)`,
    [
      "orders/paid",
      `test-webhook-${randomUUID()}`,
      null,
      SHOPIFY_TEST_SHOP,
      "2026-07",
      null,
      "{}",
      raw,
      createHash("sha256").update(raw).digest("hex"),
      Buffer.byteLength(raw),
      true,
      null,
      null,
    ],
  );
  const { rows } = await tx.query<{ outcome: string | null; sale_id: string | null }>(
    "select outcome, sale_id from public.process_shopify_order_paid($1)",
    [recorded.rows[0].event_id],
  );
  await actAs(tx, ADMIN);
  expect(rows[0].outcome).toBe("sale_recorded");
  return { saleId: rows[0].sale_id!, orderGid: `gid://shopify/Order/${orderId}`, orderId };
}

type TxInput = {
  kind?: string;
  status?: string;
  gateway?: string;
  test?: boolean;
  amount: string;
  currency?: string;
  fees?: { amount: string; tax?: string; currency?: string }[];
};

/** The GraphQL Order node as the fee read returns it (Order.transactions with fees). */
function orderRead(order: Pick<Order, "orderGid">, txs: TxInput[]) {
  return {
    id: order.orderGid,
    transactions: txs.map((t) => ({
      id: `gid://shopify/OrderTransaction/${nextShopifyId()}`,
      kind: t.kind ?? "SALE",
      status: t.status ?? "SUCCESS",
      gateway: t.gateway ?? "shopify_payments",
      test: t.test ?? false,
      // Never stored: only amounts and ids are kept.
      receiptJson: '{"payer_email":"someone@example.com"}',
      amountSet: { shopMoney: { amount: t.amount, currencyCode: t.currency ?? "SGD" } },
      fees: (t.fees ?? []).map((f) => ({
        id: `gid://shopify/TransactionFee/${nextShopifyId()}`,
        type: "processing",
        rate: "0.034",
        rateName: "Card rate",
        amount: { amount: f.amount, currencyCode: f.currency ?? "SGD" },
        taxAmount: { amount: f.tax ?? "0.00", currencyCode: f.currency ?? "SGD" },
        flatFee: { amount: "0.50", currencyCode: f.currency ?? "SGD" },
      })),
    })),
  };
}

/** One successful Shopify Payments charge of `amount` with a fee of `fee` (GST `tax`). */
const charge = (amount: string, fee: string, tax = "0.00"): TxInput => ({
  amount,
  fees: [{ amount: fee, tax }],
});

/** record_shopify_fee_read as the service role; ends as the admin. */
async function readFee(tx: pg.Client, saleId: string, read: unknown): Promise<string> {
  await actAs(tx, SERVICE);
  const o = await scalar<string>(
    tx,
    "select public.record_shopify_fee_read($1, $2::jsonb, '2026-10')",
    [saleId, read === null ? null : JSON.stringify(read)],
  );
  await actAs(tx, ADMIN);
  return o;
}

/** shopify_fees_due as the service role (p_sale_id optional); ends as the admin. */
async function due(tx: pg.Client, saleId: string | null = null) {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<{
    sale_id: string;
    shopify_order_id: string;
    test_order: boolean;
  }>("select sale_id, shopify_order_id, test_order from public.shopify_fees_due(20, $1)", [saleId]);
  await actAs(tx, ADMIN);
  return rows;
}

/** Put every online sale that exists now behind a long backoff, so the due list holds only this test's sales. */
const quietOthers = (tx: pg.Client) =>
  readAsOwner(tx, () =>
    tx.query(
      `insert into private.shopify_fee_reads (sale_id, failures, last_failed_at, last_outcome)
       select id, 20, now(), 'quiet' from public.sales where source = 'online_shopify'
       on conflict (sale_id) do update set failures = 20, last_failed_at = now()`,
    ),
  );

const feeRow = (tx: pg.Client, saleId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      basis: string;
      fee: string;
      fee_tax: string;
      fee_ex_tax: string;
      order_charged: string;
      gateways: string[];
      transactions: string;
      api_version: string | null;
    }>(
      `select basis, fee::text, fee_tax::text, fee_ex_tax::text, order_charged::text, gateways,
              transactions::text, api_version
         from public.shopify_sale_fees where sale_id = $1`,
      [saleId],
    );
    return rows;
  });

type Entry = {
  entry_kind: string;
  source: string;
  line_type: string;
  description: string;
  sale_total: string;
  cult_commons_share: string;
  bicii_yield_after_cc: string;
  stripe_fee: string;
  shopify_fee: string;
  shopify_fee_pending: boolean;
  recognized_at: Date;
};

/** A document's financial_lines entries, as the owner (lines first). */
const entries = (tx: pg.Client, documentId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<Entry>(
      `select entry_kind, source, line_type, description, sale_total::text,
              cult_commons_share::text, bicii_yield_after_cc::text, stripe_fee::text,
              shopify_fee::text, shopify_fee_pending, recognized_at
         from reporting.financial_lines where document_id = $1
        order by entry_kind, entry_key`,
      [documentId],
    );
    return rows;
  });

const shopifyEntry = async (tx: pg.Client, documentId: string) =>
  (await entries(tx, documentId)).find((e) => e.entry_kind === "shopify_fee") ?? null;

const cents = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100);

type Summary = {
  line_count: number;
  sale_count: number;
  job_count: number;
  cult_commons_share: string | null;
  yield_after_cc: string | null;
  shopify_fees: string | null;
  shopify_fees_borne: string | null;
  shopify_fee_pending_sales: number | null;
  shopify_fee_pending_jobs: number | null;
};

const summary = async (
  tx: pg.Client,
  day: string,
  claims = ADMIN,
  basis: "sale" | "completion" | "collection" | "check_in" = "sale",
) => {
  await actAs(tx, claims);
  const { rows } = await tx.query<Summary>(
    `select line_count, sale_count, job_count, cult_commons_share::text, yield_after_cc::text,
            shopify_fees::text, shopify_fees_borne::text, shopify_fee_pending_sales,
            shopify_fee_pending_jobs
       from public.report_period_summary($1::date, $1::date, $2::public.report_date_basis)`,
    [day, basis],
  );
  await actAs(tx, ADMIN);
  return rows[0];
};

const delta = (before: Summary, after: Summary) => ({
  lines: after.line_count - before.line_count,
  sales: after.sale_count - before.sale_count,
  cc: cents(after.cult_commons_share) - cents(before.cult_commons_share),
  afterCc: cents(after.yield_after_cc) - cents(before.yield_after_cc),
  fees: cents(after.shopify_fees) - cents(before.shopify_fees),
  borne: cents(after.shopify_fees_borne) - cents(before.shopify_fees_borne),
  pendingSales: (after.shopify_fee_pending_sales ?? 0) - (before.shopify_fee_pending_sales ?? 0),
  pendingJobs: (after.shopify_fee_pending_jobs ?? 0) - (before.shopify_fee_pending_jobs ?? 0),
});

type SaleFees = {
  cult_commons_share: string;
  shopify_fees: string;
  shopify_fees_borne: string;
  cult_commons_after_fees: string;
  shopify_fee_pending: boolean;
  build_order_fees: string;
};

const saleFees = async (tx: pg.Client, saleId: string, claims = ADMIN) => {
  await actAs(tx, claims);
  const { rows } = await tx.query<SaleFees>(
    `select cult_commons_share::numeric(12,2)::text, shopify_fees::numeric(12,2)::text,
            shopify_fees_borne::numeric(12,2)::text, cult_commons_after_fees::numeric(12,2)::text,
            shopify_fee_pending, build_order_fees::numeric(12,2)::text
       from public.sale_shopify_fees(array[$1]::uuid[])`,
    [saleId],
  );
  await actAs(tx, ADMIN);
  return rows;
};

type Totals = {
  cult_commons_share: string;
  stripe_fees_borne: string;
  shopify_fees: string;
  shopify_fees_borne: string;
  cult_commons_after_fees: string;
  bicii_yield_after_fees: string;
  shopify_fee_pending_count: number;
};

const TOTALS = `cult_commons_share::text, stripe_fees_borne::text, shopify_fees::text,
                shopify_fees_borne::text, cult_commons_after_fees::text,
                bicii_yield_after_fees::text, shopify_fee_pending_count`;

const totalsOf = async (tx: pg.Client, jobId: string) => {
  await actAs(tx, ADMIN);
  return (
    await tx.query<Totals>(
      `select ${TOTALS} from public.work_order_totals_staff where work_order_id = $1`,
      [jobId],
    )
  ).rows[0];
};

const yieldOf = async (tx: pg.Client, jobId: string) => {
  await actAs(tx, ADMIN);
  return (await tx.query<Totals>(`select ${TOTALS} from public.work_order_yield($1)`, [jobId]))
    .rows[0];
};

/**
 * A package bought online (the order's `index`-th build order, by id),
 * linked to a fresh job with a part, fitted (as build-package-sales.test.ts).
 */
async function linkedBuild(tx: pg.Client, order: Order, index = 0) {
  const { rows } = await tx.query<{ id: string }>(
    "select id from public.build_orders where sale_id = $1 order by id",
    [order.saleId],
  );
  const job = await newJob(tx, MECHANIC1);
  await tx.query("select public.link_build_order($1, $2, $3)", [
    rows[index].id,
    job.id,
    randomUUID(),
  ]);
  await ownerMode(tx);
  const part = await makeProduct(tx, { price: "300.00", cost: "120.00" });
  await actAs(tx, ADMIN);
  await addStock(tx, part, 2);
  await addPart(tx, { workOrderId: job.id, productId: part });
  await tx.query("select public.fit_build_to_budget($1)", [job.id]);
  return { job, buildOrderId: rows[0].id };
}

/** A paid Stripe balance payment on the job whose fee is read as `feeCents` (D273). */
async function stripeFee(tx: pg.Client, workOrderId: string, feeCents: number) {
  await ownerMode(tx);
  const id = randomUUID();
  const sessionId = `cs_test_${tag()}`;
  await tx.query(
    `insert into public.payments
       (id, work_order_id, quote_id, kind, amount, stripe_checkout_session_id,
        stripe_session_expires_at, livemode)
     values ($1, $2, null, 'balance', 100.00, $3, clock_timestamp() + interval '1 hour', false)`,
    [id, workOrderId, sessionId],
  );
  const p: Pay = {
    paymentId: id,
    sessionId,
    workOrderId,
    quoteId: null,
    cents: 10000,
    pi: `pi_${tag()}`,
  };
  await pay(tx, p);
  await actAs(tx, SERVICE);
  const outcome = await scalar<string>(
    tx,
    "select outcome from public.record_stripe_read($1, $2::jsonb, $3)",
    [
      id,
      JSON.stringify({
        ...paymentIntentObject({ id: p.pi, status: "succeeded", amountCents: p.cents }),
        latest_charge: {
          id: `ch_${p.pi.slice(3)}`,
          object: "charge",
          balance_transaction: {
            id: `txn_${tag()}`,
            object: "balance_transaction",
            amount: p.cents,
            fee: feeCents,
            net: p.cents - feeCents,
            currency: "sgd",
            fee_details: [{ type: "stripe_fee", amount: feeCents, currency: "sgd" }],
          },
        },
      }),
      `corr-${tag()}`,
    ],
  );
  await actAs(tx, ADMIN);
  expect(outcome).toBe("stripe_fee_recorded");
}

// ---------------------------------------------------------------------------
// 1. The fee fact
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("D274: a Shopify fee is Shopify's word, recorded once", () => {
  it("a read records the order's fees less GST; refunds keep the fee; the evidence keeps amounts and ids only", () =>
    inTx(async (tx) => {
      const variant = await product(tx);
      const order = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(await due(tx, order.saleId)).toEqual([
        { sale_id: order.saleId, shopify_order_id: order.orderGid, test_order: false },
      ]);
      const read = orderRead(order, [
        charge("100.00", "3.20", "0.29"),
        { kind: "REFUND", amount: "100.00", fees: [] },
      ]);
      expect(await readFee(tx, order.saleId, read)).toBe("shopify_fee_recorded");
      const [row] = await feeRow(tx, order.saleId);
      expect(row).toMatchObject({
        basis: "shopify_payments",
        fee_ex_tax: "3.20",
        fee_tax: "0.29",
        fee: "3.49",
        order_charged: "100.00",
        gateways: ["shopify_payments"],
        api_version: "2026-10",
      });
      expect(row.transactions).toContain('"amount": "3.20"');
      expect(row.transactions).not.toMatch(/someone@example\.com|receiptJson|rateName|flatFee/);
      // A replay changes nothing, and the sale is off the list.
      expect(await readFee(tx, order.saleId, orderRead(order, [charge("100.00", "9.99")]))).toBe(
        "shopify_fee_unchanged",
      );
      expect((await feeRow(tx, order.saleId)).map((r) => r.fee_ex_tax)).toEqual(["3.20"]);
      expect(await due(tx, order.saleId)).toEqual([]);
    }));

  it("no fee on the charge yet: pending with a backoff; another gateway is a zero row; another currency, a bad amount or another order need attention", () =>
    inTx(async (tx) => {
      await quietOthers(tx);
      const variant = await product(tx);
      const pending = await deliverOrder(tx, [line(variant, "100.00")]);
      expect((await due(tx)).map((r) => r.sale_id)).toContain(pending.saleId);
      expect(
        await readFee(tx, pending.saleId, orderRead(pending, [{ amount: "100.00", fees: [] }])),
      ).toBe("shopify_fee_pending");
      expect(await feeRow(tx, pending.saleId)).toEqual([]);
      // Within five minutes of a pending read the sweep leaves it; the read
      // after sale_recorded (p_sale_id) still names it.
      expect((await due(tx)).map((r) => r.sale_id)).not.toContain(pending.saleId);
      expect((await due(tx, pending.saleId)).map((r) => r.sale_id)).toEqual([pending.saleId]);

      const manual = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(
        await readFee(
          tx,
          manual.saleId,
          orderRead(manual, [{ amount: "100.00", gateway: "manual" }]),
        ),
      ).toBe("shopify_fee_recorded");
      expect((await feeRow(tx, manual.saleId))[0]).toMatchObject({
        basis: "no_shopify_payments",
        fee: "0.00",
        order_charged: "100.00",
        gateways: ["manual"],
      });
      expect(await shopifyEntry(tx, manual.saleId)).toBeNull();

      const usd = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(
        await readFee(
          tx,
          usd.saleId,
          orderRead(usd, [{ amount: "100.00", fees: [{ amount: "3.00", currency: "USD" }] }]),
        ),
      ).toBe("shopify_fee_currency_mismatch");
      const bad = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(await readFee(tx, bad.saleId, orderRead(bad, [charge("100.00", "three")]))).toBe(
        "object_invalid",
      );
      const other = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(
        await readFee(
          tx,
          other.saleId,
          orderRead({ orderGid: usd.orderGid }, [charge("100.00", "1.00")]),
        ),
      ).toBe("read_mismatch");
      for (const s of [usd, bad, other]) {
        expect(await feeRow(tx, s.saleId)).toEqual([]);
        expect((await due(tx)).map((r) => r.sale_id)).not.toContain(s.saleId);
      }
      // Still pending: the entry says so and the exceptions list it (admins, danger).
      expect(await shopifyEntry(tx, usd.saleId)).toMatchObject({ shopify_fee_pending: true });
      const exceptions = async (claims: Claims) => {
        await actAs(tx, claims);
        return (
          await tx.query<{ kind: string; severity: string; entity_type: string }>(
            "select kind, severity, entity_type from public.operational_exceptions(500) where entity_id = $1",
            [usd.saleId],
          )
        ).rows;
      };
      expect(await exceptions(ADMIN)).toEqual([
        { kind: "integration_failed", severity: "danger", entity_type: "sale" },
      ]);
      expect(await exceptions(MECHANIC1)).toEqual([]);
      await actAs(tx, ADMIN);
    }));

  it("a sale the sweep could not read a day on is a warning; a failed read backs off without taking never-tried sales' slots", () =>
    inTx(async (tx) => {
      await quietOthers(tx);
      const variant = await product(tx);
      const day = await shopToday(tx);
      const stuck = await deliverOrder(tx, [line(variant, "100.00")], {
        processedAt: `${addDays(day, -3)}T02:00:00Z`,
      });
      const fresh = await deliverOrder(tx, [line(variant, "100.00")], {
        processedAt: `${addDays(day, -2)}T02:00:00Z`,
      });
      const ids = async () => (await due(tx)).map((r) => r.sale_id);
      const before = await ids();
      // Never tried, both within 60 days: newest first.
      expect(before.indexOf(fresh.saleId)).toBeLessThan(before.indexOf(stuck.saleId));
      const listed = async () => {
        await actAs(tx, ADMIN);
        return (
          await tx.query<{ kind: string; severity: string }>(
            "select kind, severity from public.operational_exceptions(500) where entity_id = $1",
            [stuck.saleId],
          )
        ).rows;
      };
      // Never tried (Shopify off): pending in the reports, not an exception.
      expect(await listed()).toEqual([]);

      // A 403 (no orders access) leaves no read: the sweep notes it, and the
      // sale, three days old, is a warning for admins.
      await actAs(tx, SERVICE);
      await tx.query("select public.note_shopify_fee_read_failed($1, 'shopify_auth_failed')", [
        stuck.saleId,
      ]);
      expect(await listed()).toEqual([{ kind: "integration_failed", severity: "warning" }]);
      const after = await ids();
      expect(after).not.toContain(stuck.saleId);
      expect(after).toContain(fresh.saleId);
      await readAsOwner(tx, () =>
        tx.query(
          "update private.shopify_fee_reads set last_failed_at = now() - interval '1 hour' where sale_id = $1",
          [stuck.saleId],
        ),
      );
      const later = await ids();
      expect(later.indexOf(stuck.saleId)).toBeGreaterThan(later.indexOf(fresh.saleId));

      // The warning's words follow the last attempt (only a refusal names the scopes).
      const subject = async () => {
        await actAs(tx, ADMIN);
        return scalar<string>(
          tx,
          "select subject_label from public.operational_exceptions(500) where entity_id = $1",
          [stuck.saleId],
        );
      };
      expect(await subject()).toContain("read_orders and read_all_orders");
      expect(await readFee(tx, stuck.saleId, orderRead(stuck, [{ amount: "100.00" }]))).toBe(
        "shopify_fee_pending",
      );
      expect(await subject()).toBe(
        "Shopify has not reported the fee on this online sale yet, so its Cult Commons is provisional. BICII keeps reading it.",
      );
      for (const [code, words] of [
        ["shopify_order_not_found", "Shopify no longer has this sale's order"],
        ["shopify_unavailable", "BICII could not read this sale's order from Shopify"],
        ["database_error", "BICII could not read this sale's order from Shopify"],
      ] as const) {
        await actAs(tx, SERVICE);
        await tx.query("select public.note_shopify_fee_read_failed($1, $2)", [stuck.saleId, code]);
        const said = await subject();
        expect(said, code).toContain(words);
        expect(said, code).not.toContain("read_orders");
      }

      // Only the service role reads the list, records or notes; nobody reads the counts.
      await actAs(tx, ADMIN);
      for (const sql of [
        "select public.note_shopify_fee_read_failed($1, 'x')",
        "select public.record_shopify_fee_read($1, '{}'::jsonb)",
        "select * from public.shopify_fees_due(5, $1)",
      ]) {
        await failsWith(tx, () => tx.query(sql, [stuck.saleId]), { code: "42501" });
      }
      await actAs(tx, SERVICE);
      await failsWith(tx, () => tx.query("select * from private.shopify_fee_reads"), {
        code: "42501",
      });
      await actAs(tx, ADMIN);
    }));

  it("a test order gets a zero row without a read; so does an order whose charges are all tests", () =>
    inTx(async (tx) => {
      await readAsOwner(tx, () =>
        tx.query("update public.shopify_settings set accept_test_orders = true"),
      );
      const variant = await product(tx);
      const test = await deliverOrder(tx, [line(variant, "100.00")], { test: true });
      expect((await due(tx, test.saleId))[0]).toMatchObject({ test_order: true });
      expect(await readFee(tx, test.saleId, null)).toBe("shopify_fee_test_order");
      expect((await feeRow(tx, test.saleId))[0]).toMatchObject({
        basis: "test_order",
        fee: "0.00",
      });
      expect(await shopifyEntry(tx, test.saleId)).toBeNull();

      const sandbox = await deliverOrder(tx, [line(variant, "100.00")]);
      expect(
        await readFee(
          tx,
          sandbox.saleId,
          orderRead(sandbox, [{ ...charge("100.00", "3.00"), test: true }]),
        ),
      ).toBe("shopify_fee_test_order");
      expect((await feeRow(tx, sandbox.saleId))[0]).toMatchObject({
        basis: "test_order",
        fee: "0.00",
      });
    }));

  it("insert-only, written only inside a read's apply, view_costs to read", () =>
    inTx(async (tx) => {
      const variant = await product(tx);
      const order = await deliverOrder(tx, [line(variant, "100.00")]);
      await readFee(tx, order.saleId, orderRead(order, [charge("100.00", "1.00")]));
      const count = async (claims: Claims) => {
        await actAs(tx, claims);
        return scalar<number>(
          tx,
          "select count(*)::int from public.shopify_sale_fees where sale_id = $1",
          [order.saleId],
        );
      };
      expect(await count(ADMIN)).toBe(1);
      expect(await count(MECHANIC1)).toBe(1); // view_costs as an exception
      expect(await count(MECHANIC2)).toBe(0); // no view_costs
      await actAs(tx, ADMIN);
      for (const sql of [
        "insert into public.shopify_sale_fees default values",
        "update public.shopify_sale_fees set fee_tax = fee_tax where false",
        "delete from public.shopify_sale_fees where false",
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
      await actAs(tx, SERVICE);
      await failsWith(tx, () => tx.query("select * from public.shopify_sale_fees"), {
        code: "42501",
      });
      // Not even the owner changes one, or records one outside a read.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.shopify_sale_fees set fee_ex_tax = 0 where sale_id = $1", [
            order.saleId,
          ]),
        { code: "P0001", message: "shopify_fee_immutable" },
      );
      await failsWith(
        tx,
        () => tx.query("delete from public.shopify_sale_fees where sale_id = $1", [order.saleId]),
        { code: "P0001", message: "shopify_fee_immutable" },
      );
      const other = await deliverOrder(tx, [line(variant, "100.00")]);
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.shopify_sale_fees
               (sale_id, shopify_order_id, basis, fee_ex_tax, fee_tax, order_charged, gateways,
                transactions, currency)
             values ($1, $2, 'shopify_payments', 1.00, 0, 100.00, '{}', '[]', 'SGD')`,
            [other.saleId, other.orderGid],
          ),
        { code: "P0001", message: "shopify_fee_immutable" },
      );

      // The sale's fee figures are cost figures: no row of them reaches staff
      // without view_costs.
      await ownerMode(tx);
      await tx.query(
        "insert into public.staff_permissions (staff_id, permission) values ($1, 'view_financial_reports')",
        [STAFF.mechanic2],
      );
      const day = await shopToday(tx);
      const s = await summary(tx, day, MECHANIC2);
      expect(s.shopify_fees).toBeNull();
      expect(s.shopify_fees_borne).toBeNull();
      expect(s.shopify_fee_pending_sales).toBeNull();
      expect(await saleFees(tx, order.saleId, MECHANIC2)).toEqual([]);
      await actAs(tx, MECHANIC2);
      const kinds = async (sql: string) =>
        (await tx.query<{ k: string }>(sql, [day, order.saleId])).rows.map((x) => x.k);
      expect(
        await kinds(
          "select entry_kind as k from public.financial_lines($1::date, $1::date) where document_id = $2",
        ),
      ).toEqual(["line"]);
      expect(
        await kinds(
          "select line_type as k from public.report_line_items($1::date, $1::date) where document_id = $2",
        ),
      ).not.toContain("shopify_fee");
      expect(
        (
          await tx.query(
            "select 1 from public.report_breakdown($1::date, $1::date, 'sale', 'product', 10, 'shopify_fees')",
            [day],
          )
        ).rows,
      ).toEqual([]);
      await actAs(tx, ADMIN);
      const own = await tx.query<{ entry_kind: string; shopify_fee: string | null }>(
        "select entry_kind, shopify_fee::numeric(12,2)::text as shopify_fee from public.financial_lines($1::date, $1::date) where document_id = $2 order by entry_kind",
        [day, order.saleId],
      );
      expect(own.rows).toEqual([
        { entry_kind: "line", shopify_fee: "0.00" },
        { entry_kind: "shopify_fee", shopify_fee: "1.00" },
      ]);
    }));
});

// ---------------------------------------------------------------------------
// 2. The invariant on a sale
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "D274: net Cult Commons = max(gross - fees, 0) per sale",
  () => {
    it("one fee entry on the sale's day; pending until read; reports, Today and the sale agree", () =>
      inTx(async (tx) => {
        const day = await shopToday(tx);
        const variant = await product(tx);
        const before = await summary(tx, day);
        const today = async () => {
          await actAs(tx, ADMIN);
          return (
            await tx.query<{ f: string; b: string; ps: number; cc: string }>(
              `select shopify_fees::text as f, shopify_fees_borne::text as b,
                    shopify_fee_pending_sales as ps, cult_commons_share::text as cc
               from public.today_dashboard($1::date)`,
              [day],
            )
          ).rows[0];
        };
        const todayBefore = await today();

        const order = await deliverOrder(tx, [line(variant, "100.00")]); // gross CC 18.00
        // History restated: unread, the sale is pending, with nothing deducted.
        expect(await shopifyEntry(tx, order.saleId)).toMatchObject({
          source: "sale",
          line_type: "shopify_fee",
          shopify_fee_pending: true,
        });
        expect(cents((await shopifyEntry(tx, order.saleId))!.cult_commons_share)).toBe(0);
        expect(delta(before, await summary(tx, day))).toEqual({
          lines: 1,
          sales: 1,
          cc: 1800,
          afterCc: 4200,
          fees: 0,
          borne: 0,
          pendingSales: 1,
          pendingJobs: 0,
        });

        await readFee(tx, order.saleId, orderRead(order, [charge("100.00", "3.20", "0.29")]));
        const entry = await shopifyEntry(tx, order.saleId);
        expect(entry).toMatchObject({ description: "Shopify fees", shopify_fee_pending: false });
        expect(
          [
            entry!.sale_total,
            entry!.cult_commons_share,
            entry!.bicii_yield_after_cc,
            entry!.shopify_fee,
          ].map(cents),
        ).toEqual([0, -320, 0, 320]);
        expect(delta(before, await summary(tx, day))).toEqual({
          lines: 1,
          sales: 1,
          cc: 1480,
          afterCc: 4200,
          fees: 320,
          borne: 320,
          pendingSales: 0,
          pendingJobs: 0,
        });
        const t = await today();
        expect(cents(t.f) - cents(todayBefore.f)).toBe(320);
        expect(cents(t.b) - cents(todayBefore.b)).toBe(320);
        expect(cents(t.cc) - cents(todayBefore.cc)).toBe(1480);
        expect(await saleFees(tx, order.saleId)).toEqual([
          {
            cult_commons_share: "18.00",
            shopify_fees: "3.20",
            shopify_fees_borne: "3.20",
            cult_commons_after_fees: "14.80",
            shopify_fee_pending: false,
            build_order_fees: "0.00",
          },
        ]);

        // Breakdown: the entry joins its sale's group and is its own group elsewhere.
        const group = async (dimension: string, key: string) => {
          await actAs(tx, ADMIN);
          return (
            await tx.query<{ label: string; sale_count: number; cult_commons_share: string }>(
              `select label, sale_count, cult_commons_share::text
               from public.report_breakdown($1::date, $1::date, 'sale', $2::public.report_dimension, 10, $3)`,
              [day, dimension, key],
            )
          ).rows[0];
        };
        expect(await group("job", order.saleId)).toMatchObject({
          sale_count: 1,
          cult_commons_share: "14.80",
        });
        expect(await group("product", "shopify_fees")).toMatchObject({
          label: "Shopify fees",
          sale_count: 0,
        });
        await actAs(tx, ADMIN);
        expect(
          (
            await tx.query<{ line_type: string; shopify_fee: string }>(
              `select line_type, shopify_fee::numeric(12,2)::text as shopify_fee
               from public.report_line_items($1::date, $1::date, 'sale', 'job', $2)`,
              [day, order.saleId],
            )
          ).rows.find((r) => r.line_type === "shopify_fee"),
        ).toEqual({ line_type: "shopify_fee", shopify_fee: "3.20" });
      }));

    it("the floor is per sale: fees above the sale's share are BICII's", () =>
      inTx(async (tx) => {
        const variant = await product(tx);
        const order = await deliverOrder(tx, [line(variant, "100.00")]);
        await readFee(tx, order.saleId, orderRead(order, [charge("100.00", "20.00")]));
        const entry = await shopifyEntry(tx, order.saleId);
        expect(
          [entry!.cult_commons_share, entry!.bicii_yield_after_cc, entry!.shopify_fee].map(cents),
        ).toEqual([-1800, -200, 2000]);
        expect((await saleFees(tx, order.saleId))[0]).toMatchObject({
          shopify_fees_borne: "18.00",
          cult_commons_after_fees: "0.00",
        });
      }));

    it("a refunded sale still bears its fee; a voided sale bears none", () =>
      inTx(async (tx) => {
        const variant = await product(tx);
        const order = await deliverOrder(tx, [line(variant, "100.00")]);
        // A full refund through refunds/create.
        const refund = refundPayload({
          refundId: nextShopifyId(),
          orderId: order.orderId,
          amount: "100.00",
        });
        const raw = JSON.stringify(refund);
        await actAs(tx, SERVICE);
        const ev = await scalar<string>(
          tx,
          `select event_id from public.record_shopify_webhook('refunds/create', $1, null, $2, '2026-07', null,
           '{}'::jsonb, $3::jsonb, $4, $5, true, null, null)`,
          [
            `test-webhook-${randomUUID()}`,
            SHOPIFY_TEST_SHOP,
            raw,
            createHash("sha256").update(raw).digest("hex"),
            Buffer.byteLength(raw),
          ],
        );
        await tx.query("select * from public.process_shopify_event($1)", [ev]);
        expect(
          await readAsOwner(tx, () =>
            scalar<string>(tx, "select status::text from public.sales where id = $1", [
              order.saleId,
            ]),
          ),
        ).toBe("refunded");
        expect(
          await readFee(
            tx,
            order.saleId,
            orderRead(order, [charge("100.00", "3.00"), { kind: "REFUND", amount: "100.00" }]),
          ),
        ).toBe("shopify_fee_recorded");
        expect(cents((await shopifyEntry(tx, order.saleId))!.cult_commons_share)).toBe(-300);

        const voided = await deliverOrder(tx, [line(variant, "100.00")]);
        await readAsOwner(tx, () =>
          tx.query("update public.sales set status = 'voided' where id = $1", [voided.saleId]),
        );
        expect(await entries(tx, voided.saleId)).toEqual([]);
        expect(await due(tx, voided.saleId)).toEqual([]);
        expect(
          await readFee(tx, voided.saleId, orderRead(voided, [charge("100.00", "3.00")])),
        ).toBe("sale_not_eligible");
        expect(await saleFees(tx, voided.saleId)).toEqual([]);
      }));

    it("a consigned line keeps its snapshot, payout and liability (fees never reduce yield before the 30%)", () =>
      inTx(async (tx) => {
        const consignor = await createConsignor(tx);
        const item = await intakeUnique(tx, {
          consignorId: consignor,
          agreed: "500.00",
          asking: "1000.00",
        });
        const variant = await linkVariant(tx, item.product_id);
        const order = await deliverOrder(tx, [line(variant, "1000.00")]);
        const linesBefore = await saleLines(tx, order.saleId);
        const ledgerBefore = await itemLedger(tx, item.item_id);
        await readFee(tx, order.saleId, orderRead(order, [charge("1000.00", "30.00", "2.70")]));
        expect(await saleLines(tx, order.saleId)).toEqual(linesBefore);
        expect(await itemLedger(tx, item.item_id)).toEqual(ledgerBefore);
        expect(linesBefore[0]).toMatchObject({
          yield_total: "500.00",
          cult_commons_share: "150.00",
        });
        expect((await saleFees(tx, order.saleId))[0]).toMatchObject({
          cult_commons_share: "150.00",
          shopify_fees_borne: "30.00",
          cult_commons_after_fees: "120.00",
        });
      }));
  },
);

// ---------------------------------------------------------------------------
// 3. Build packages (D1 of the brief)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())(
  "D274: a build order's share comes off its job's Cult Commons",
  () => {
    it("a package bought alone: the job's share at completion, the sale keeps shipping's; unlinked shares are BICII's", () =>
      inTx(async (tx) => {
        const day = await shopToday(tx);
        const variant = await onlinePackage(tx, "390.00");
        const before = await summary(tx, day);
        const order = await deliverOrder(tx, [line(variant, "390.00")]);
        const { job } = await linkedBuild(tx, order);
        // Open, linked, unread: nothing on the job in reports; its totals already pending.
        expect(await shopifyEntry(tx, job.id)).toBeNull();
        expect((await totalsOf(tx, job.id)).shopify_fee_pending_count).toBe(1);
        await actAs(tx, ADMIN);
        const done = await completeJob(tx, job.id);
        expect(await shopifyEntry(tx, job.id)).toMatchObject({
          source: "work_order",
          shopify_fee_pending: true,
          recognized_at: done.completed_at,
        });
        expect(delta(before, await summary(tx, day))).toMatchObject({
          pendingJobs: 1,
          pendingSales: 1,
          sales: 0,
        });

        // 400.00 charged (390 + 10 shipping), fee 4.00: the build order's share
        // trunc(4.00 x 390 / 400, 2) = 3.90, the sale's the rest, 0.10.
        await readFee(tx, order.saleId, orderRead(order, [charge("400.00", "4.00", "0.36")]));
        const jobEntry = await shopifyEntry(tx, job.id);
        expect(jobEntry).toMatchObject({ shopify_fee_pending: false });
        expect([jobEntry!.shopify_fee, jobEntry!.cult_commons_share].map(cents)).toEqual([
          390, -390,
        ]);
        const saleEntry = await shopifyEntry(tx, order.saleId);
        // No lines: gross 0, so BICII bears the sale's share.
        expect(
          [
            saleEntry!.shopify_fee,
            saleEntry!.cult_commons_share,
            saleEntry!.bicii_yield_after_cc,
          ].map(cents),
        ).toEqual([10, 0, -10]);
        expect((await saleFees(tx, order.saleId))[0]).toMatchObject({
          shopify_fees: "0.10",
          build_order_fees: "3.90",
        });
        // A package-only sale is still not a counted sale (D9).
        expect(delta(before, await summary(tx, day))).toMatchObject({
          sales: 0,
          pendingJobs: 0,
          pendingSales: 0,
          fees: 400,
          borne: 390,
        });
        const t = await totalsOf(tx, job.id);
        expect(t).toMatchObject({
          shopify_fees: "3.90",
          shopify_fees_borne: "3.90",
          shopify_fee_pending_count: 0,
        });
        expect(cents(t.cult_commons_after_fees)).toBe(cents(t.cult_commons_share) - 390);
        expect(await yieldOf(tx, job.id)).toEqual(t);

        // An unlinked build order: its share is in no job and off every report.
        const lone = await deliverOrder(tx, [line(await onlinePackage(tx, "390.00"), "390.00")]);
        await readFee(tx, lone.saleId, orderRead(lone, [charge("390.00", "3.90")]));
        expect((await saleFees(tx, lone.saleId))[0]).toMatchObject({
          shopify_fees: "0.00",
          build_order_fees: "3.90",
        });
        expect(await shopifyEntry(tx, lone.saleId)).toBeNull();
      }));

    it("one floor per job over Stripe and Shopify fees: Shopify gets what Stripe left", () =>
      inTx(async (tx) => {
        const variant = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [line(variant, "390.00")]);
        const { job } = await linkedBuild(tx, order);
        const gross = cents((await totalsOf(tx, job.id)).cult_commons_share);
        expect(gross).toBeGreaterThan(200);
        // Stripe takes all but 1.00 of the job's share.
        await stripeFee(tx, job.id, gross - 100);
        await readFee(tx, order.saleId, orderRead(order, [charge("390.00", "3.90")]));
        await actAs(tx, ADMIN);
        await completeJob(tx, job.id);
        const t = await totalsOf(tx, job.id);
        expect(cents(t.stripe_fees_borne)).toBe(gross - 100);
        expect(t).toMatchObject({
          shopify_fees: "3.90",
          shopify_fees_borne: "1.00",
          cult_commons_after_fees: "0.00",
        });
        const e = await shopifyEntry(tx, job.id);
        expect([e!.cult_commons_share, e!.bicii_yield_after_cc].map(cents)).toEqual([-100, -290]);
        // The job's entries sum to the totals' net Cult Commons.
        const sum = await readAsOwner(tx, () =>
          scalar<string>(
            tx,
            "select sum(cult_commons_share)::numeric(12,2)::text from reporting.financial_lines where document_id = $1",
            [job.id],
          ),
        );
        expect(sum).toBe("0.00");
        expect(await yieldOf(tx, job.id)).toEqual(t);
      }));

    it("a mixed order (a frame line, two build orders, shipping): the shares and the sale's rest add up to the order's fee exactly", () =>
      inTx(async (tx) => {
        const frame = await product(tx, "150.00", "50.00"); // yield 100.00, Cult Commons 30.00
        const a = await onlinePackage(tx, "390.00");
        const b = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [
          line(frame, "150.00"),
          line(a, "390.00"),
          line(b, "390.00"),
        ]);
        // 940.00 charged (150 + 390 + 390 + 10 shipping), fee 7.91: each build
        // order's share trunc(7.91 x 390 / 940, 2) = 3.28 (3.2818…), the sale
        // keeps the rest, 7.91 - 6.56 = 1.35 (the residue included).
        await readFee(tx, order.saleId, orderRead(order, [charge("940.00", "7.91", "0.71")]));
        const shares = await readAsOwner(tx, async () => {
          const { rows } = await tx.query<{ shopify_fee: string; pending: boolean }>(
            `select shopify_fee::numeric(12,2)::text as shopify_fee, pending
               from reporting.build_order_shopify_fees where sale_id = $1 order by build_order_id`,
            [order.saleId],
          );
          return rows;
        });
        expect(shares).toEqual([
          { shopify_fee: "3.28", pending: false },
          { shopify_fee: "3.28", pending: false },
        ]);
        const exact = () =>
          readAsOwner(tx, () =>
            tx
              .query<{ total: string; fee: string; sale_share: string }>(
                `select ((select sum(bf.shopify_fee) from reporting.build_order_shopify_fees bf where bf.sale_id = $1)
                         + s.shopify_fees)::numeric(12,2)::text as total,
                        f.fee_ex_tax::numeric(12,2)::text as fee,
                        s.shopify_fees::numeric(12,2)::text as sale_share
                   from reporting.sale_shopify_fees s
                   join public.shopify_sale_fees f on f.sale_id = s.sale_id
                  where s.sale_id = $1`,
                [order.saleId],
              )
              .then((r) => r.rows[0]),
          );
        expect(await exact()).toEqual({ total: "7.91", fee: "7.91", sale_share: "1.35" });
        expect((await saleFees(tx, order.saleId))[0]).toEqual({
          cult_commons_share: "30.00",
          shopify_fees: "1.35",
          shopify_fees_borne: "1.35",
          cult_commons_after_fees: "28.65",
          shopify_fee_pending: false,
          build_order_fees: "6.56",
        });
        const saleEntry = await shopifyEntry(tx, order.saleId);
        expect([saleEntry!.shopify_fee, saleEntry!.cult_commons_share].map(cents)).toEqual([
          135, -135,
        ]);

        // Both jobs completed: their entries add up to the sale's build_order_fees.
        const first = await linkedBuild(tx, order, 0);
        const second = await linkedBuild(tx, order, 1);
        await actAs(tx, ADMIN);
        await completeJob(tx, first.job.id);
        await completeJob(tx, second.job.id);
        const jobFees = [
          (await shopifyEntry(tx, first.job.id))!,
          (await shopifyEntry(tx, second.job.id))!,
        ];
        expect(jobFees.map((e) => cents(e.shopify_fee))).toEqual([328, 328]);
        expect(jobFees.map((e) => cents(e.cult_commons_share))).toEqual([-328, -328]);
        expect(cents(saleEntry!.shopify_fee) + 328 + 328).toBe(791);
      }));

    it("the sale's share is never negative: shares are of the larger of the charge and the build orders' total", () =>
      inTx(async (tx) => {
        const a = await onlinePackage(tx, "390.00");
        const b = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [line(a, "390.00"), line(b, "390.00")]);
        // Charged less than the build orders' total (780.00): each share is
        // trunc(7.00 x 390 / 780, 2) = 3.50, never 7.00 x 390 / 700 = 3.90.
        await readFee(tx, order.saleId, orderRead(order, [charge("700.00", "7.00")]));
        expect((await saleFees(tx, order.saleId))[0]).toMatchObject({
          shopify_fees: "0.00",
          build_order_fees: "7.00",
        });
        expect(await shopifyEntry(tx, order.saleId)).toBeNull();
      }));

    it("a linked job that is cancelled deducts nothing (BICII bears its share); the sale's share is unchanged", () =>
      inTx(async (tx) => {
        const variant = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [line(variant, "390.00")]);
        const buildOrderId = await scalar<string>(
          tx,
          "select id from public.build_orders where sale_id = $1",
          [order.saleId],
        );
        const job = await newJob(tx, MECHANIC1);
        await tx.query("select public.link_build_order($1, $2, $3)", [
          buildOrderId,
          job.id,
          randomUUID(),
        ]);
        await readFee(tx, order.saleId, orderRead(order, [charge("400.00", "4.00")]));
        // A job is cancelled only once its lines are voided (work_order_has_lines).
        await actAs(tx, ADMIN);
        const { rows: live } = await tx.query<{ id: string }>(
          "select id from public.work_order_line_items where work_order_id = $1 and voided_at is null",
          [job.id],
        );
        for (const l of live) await voidLine(tx, l.id, "Customer withdrew");
        await setStatus(tx, job.id, "cancelled", "Customer withdrew");
        expect(await shopifyEntry(tx, job.id)).toBeNull();
        const t = await totalsOf(tx, job.id);
        expect(t).toMatchObject({ shopify_fees: "3.90", shopify_fees_borne: "0.00" });
        expect(t.cult_commons_after_fees).toBe(t.cult_commons_share);
        expect(await yieldOf(tx, job.id)).toEqual(t);
        expect((await saleFees(tx, order.saleId))[0]).toMatchObject({
          shopify_fees: "0.10",
          build_order_fees: "3.90",
        });
      }));

    it("a reopen takes the job's entry back; completing again on a later day puts it on that day", () =>
      inTx(async (tx) => {
        const today = await shopToday(tx);
        const earlier = addDays(today, -3);
        const beforeEarlier = await summary(tx, earlier);
        const variant = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [line(variant, "390.00")]);
        const { job } = await linkedBuild(tx, order);
        await readFee(tx, order.saleId, orderRead(order, [charge("400.00", "4.00")]));
        await actAs(tx, ADMIN);
        await completeJob(tx, job.id);
        // The first completion three shop days back (as the owner, triggers off).
        await ownerMode(tx);
        await tx.query("set local session_replication_role = replica");
        await tx.query(
          `update public.work_orders
              set checked_in_at = checked_in_at - interval '3 days',
                  status_changed_at = status_changed_at - interval '3 days',
                  started_at = started_at - interval '3 days',
                  completed_at = completed_at - interval '3 days'
            where id = $1`,
          [job.id],
        );
        await tx.query("set local session_replication_role = origin");
        await actAs(tx, ADMIN);
        const first = await readAsOwner(tx, () =>
          scalar<Date>(tx, "select completed_at from public.work_orders where id = $1", [job.id]),
        );
        expect((await shopifyEntry(tx, job.id))?.recognized_at).toEqual(first);
        expect(delta(beforeEarlier, await summary(tx, earlier))).toMatchObject({
          fees: 390,
          borne: 390,
          pendingJobs: 0,
        });

        await actAs(tx, ADMIN);
        await reopenJob(tx, job.id);
        expect(await shopifyEntry(tx, job.id)).toBeNull();
        expect(
          await readAsOwner(tx, () =>
            scalar<number>(
              tx,
              "select count(*)::int from reporting.report_lines where document_id = $1 and entry_kind = 'shopify_fee'",
              [job.id],
            ),
          ),
        ).toBe(0);
        expect(delta(beforeEarlier, await summary(tx, earlier))).toMatchObject({
          fees: 0,
          borne: 0,
        });

        const beforeToday = await summary(tx, today);
        await actAs(tx, ADMIN);
        const again = await completeJob(tx, job.id);
        expect((await shopifyEntry(tx, job.id))?.recognized_at).toEqual(again.completed_at);
        expect(delta(beforeToday, await summary(tx, today))).toMatchObject({
          fees: 390,
          borne: 390,
        });
        expect(delta(beforeEarlier, await summary(tx, earlier))).toMatchObject({ fees: 0 });
      }));

    it("off the sale basis: the job's entry on completion, collection and check-in; the sale's entry not at all", () =>
      inTx(async (tx) => {
        const day = await shopToday(tx);
        const bases = ["completion", "collection", "check_in"] as const;
        const before = {} as Record<(typeof bases)[number], Summary>;
        for (const basis of bases) before[basis] = await summary(tx, day, ADMIN, basis);
        const variant = await onlinePackage(tx, "390.00");
        const order = await deliverOrder(tx, [line(variant, "390.00")]);
        const { job } = await linkedBuild(tx, order);
        await actAs(tx, ADMIN);
        await completeJob(tx, job.id);
        await setStatus(tx, job.id, "collected");
        // Unread: the job is pending on every basis; the sale on none of these.
        for (const basis of bases) {
          expect(delta(before[basis], await summary(tx, day, ADMIN, basis)), basis).toMatchObject({
            fees: 0,
            pendingJobs: 1,
            pendingSales: 0,
          });
        }
        await readFee(tx, order.saleId, orderRead(order, [charge("400.00", "4.00")]));
        for (const basis of bases) {
          // 3.90 is the job's; the sale's 0.10 is on the sale basis only.
          expect(delta(before[basis], await summary(tx, day, ADMIN, basis)), basis).toMatchObject({
            fees: 390,
            borne: 390,
            pendingJobs: 0,
            pendingSales: 0,
          });
        }
        expect(
          await readAsOwner(tx, () =>
            scalar<number>(
              tx,
              "select count(*)::int from reporting.report_lines where document_id = $1 and entry_kind = 'shopify_fee'",
              [job.id],
            ),
          ),
        ).toBe(1);
      }));
  },
);
