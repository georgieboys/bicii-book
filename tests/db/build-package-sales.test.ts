/**
 * Selling full builds online (PLAN D252-D256): a Shopify order with a frame
 * and a build package records the frame as a sale and the package as a
 * build order (money held, not a sale line); linking it to the build's job
 * sets the package and counts the money as paid on the job, and reporting
 * keeps per job Σ movements = net_paid; the job's completion recognises
 * the build's revenue. Also the site's cart links (public_build_offers)
 * and recording a package's Shopify ids.
 *
 * Tests create products, jobs and sales, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import { orderPaidPayload, SHOPIFY_TEST_SHOP, type OrderLineInput } from "../fixtures/shopify";
import { actAs, connect, inTransaction, isolatedDatabase, type Claims } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  addPart,
  addStock,
  completeJob,
  makeProduct,
  newJob,
  readAsOwner,
} from "./inventory-fixtures";
import { failsWith, makeService, ownerMode } from "./workshop-fixtures";

const SERVICE: Claims = { role: "service_role" };
const ANON: Claims = { role: "anon" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

let sequence = 0;
const idBase = 8_900_000_000 + Math.floor(Math.random() * 90_000) * 10_000;
const nextShopifyId = () => idBase + ++sequence;

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

/** A full build pushed to Shopify (owner writes); returns its id and variant number. */
async function onlinePackage(
  tx: pg.Client,
  { price = "1075.00", name = `Restomod ${randomUUID().slice(0, 6)}` } = {},
): Promise<{ id: string; variant: number }> {
  await ownerMode(tx);
  const serviceId = await makeService(tx, {
    name: `Build labour ${randomUUID().slice(0, 6)}`,
    price: "180.00",
  });
  const variant = nextShopifyId();
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.build_packages
       (kind, name, price, labour_amount, labour_service_id, publish_online, shopify_product_id, shopify_variant_id)
     values ('full_build', $1, $2, 180, $3, true, $4, $5) returning id`,
    [
      name,
      price,
      serviceId,
      `gid://shopify/Product/${nextShopifyId()}`,
      `gid://shopify/ProductVariant/${variant}`,
    ],
  );
  await actAs(tx, ADMIN);
  return { id: rows[0].id, variant };
}

/** A shop-owned stocked product with a Shopify variant; ends as the admin. */
async function onlineProduct(
  tx: pg.Client,
  price = "470.00",
): Promise<{ productId: string; variant: number }> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price, cost: "200.00" });
  await actAs(tx, ADMIN);
  await addStock(tx, productId, 3, { locationId: LOCATION.shopFloor });
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
  return { productId, variant };
}

const line = (variantId: number, price: string, quantity = 1): OrderLineInput => ({
  lineItemId: nextShopifyId(),
  productId: null,
  variantId,
  title: "Test item",
  variantTitle: null,
  quantity,
  price,
});

/** Records and processes an orders/paid event as the service role; ends as the admin. */
async function deliverOrder(tx: pg.Client, lines: OrderLineInput[]) {
  const orderId = nextShopifyId();
  const payload = orderPaidPayload({ orderId, name: `#B${orderId}`, lines });
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
  const { rows } = await tx.query<{
    event_status: string;
    outcome: string | null;
    sale_id: string | null;
    error_code: string | null;
  }>(
    "select event_status::text, outcome, sale_id, error_code from public.process_shopify_order_paid($1)",
    [recorded.rows[0].event_id],
  );
  await actAs(tx, ADMIN);
  return { ...rows[0], eventId: recorded.rows[0].event_id };
}

async function buildOrdersOf(tx: pg.Client, saleId: string) {
  const { rows } = await tx.query<{
    id: string;
    amount: string;
    line_part: number;
    work_order_id: string | null;
  }>(
    "select id, amount::text, line_part, work_order_id from public.build_orders where sale_id = $1 order by line_part",
    [saleId],
  );
  return rows;
}

async function saleTotal(tx: pg.Client, saleId: string) {
  const { rows } = await tx.query<{ n: number; total: string }>(
    "select count(*)::int as n, coalesce(sum(sale_total), 0.00)::numeric(12,2)::text as total from public.sale_lines where sale_id = $1",
    [saleId],
  );
  return rows[0];
}

describe.skipIf(!isolatedDatabase())("selling full builds online (D252-D256)", () => {
  it("an order with a frame and a package records the frame as a sale and the package as a build order", () =>
    inTx(async (tx) => {
      const frame = await onlineProduct(tx);
      const pkg = await onlinePackage(tx);
      const result = await deliverOrder(tx, [
        line(frame.variant, "470.00"),
        line(pkg.variant, "1075.00"),
      ]);
      expect(result).toMatchObject({
        event_status: "processed",
        outcome: "sale_recorded",
        error_code: null,
      });
      expect(await saleTotal(tx, result.sale_id!)).toEqual({ n: 1, total: "470.00" });
      expect(await buildOrdersOf(tx, result.sale_id!)).toEqual([
        expect.objectContaining({ amount: "1075.00", line_part: 1, work_order_id: null }),
      ]);
    }));

  it("a package bought alone records an empty sale and its build order; two of one split the line total", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "390.00" });
      const result = await deliverOrder(tx, [{ ...line(pkg.variant, "390.01", 2) }]);
      expect(result.outcome).toBe("sale_recorded");
      expect(await saleTotal(tx, result.sale_id!)).toEqual({ n: 0, total: "0.00" });
      const orders = await buildOrdersOf(tx, result.sale_id!);
      expect(orders.map((o) => o.line_part)).toEqual([1, 2]);
      expect(orders.reduce((sum, o) => sum + Number(o.amount), 0)).toBeCloseTo(780.02, 2);
    }));

  it("linking puts the package on the job, counts the money as paid, and keeps movements equal to net_paid", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      const result = await deliverOrder(tx, [line(pkg.variant, "1075.00")]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      const job = await newJob(tx, MECHANIC1);
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        job.id,
        randomUUID(),
      ]);
      // Replay.
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        job.id,
        randomUUID(),
      ]);

      const build = await tx.query(
        "select price::text from public.work_order_builds where work_order_id = $1",
        [job.id],
      );
      expect(build.rows[0]).toEqual({ price: "1075.00" });
      const totals = await tx.query<{
        paid_shopify: string;
        net_paid: string;
        job_total: string;
        balance_due: string;
      }>(
        `select paid_shopify::text, net_paid::text, job_total::text, balance_due::text
           from public.work_order_payment_totals where work_order_id = $1`,
        [job.id],
      );
      expect(totals.rows[0]).toEqual({
        paid_shopify: "1075.00",
        net_paid: "1075.00",
        job_total: "180.00",
        balance_due: "0.00",
      });
      await ownerMode(tx);
      const moves = await tx.query<{ movement: string; total: string }>(
        `select movement, sum(signed_amount)::text as total from reporting.payment_movements
          where work_order_id = $1 group by movement`,
        [job.id],
      );
      expect(moves.rows).toEqual([{ movement: "shopify_payment", total: "1075.00" }]);
      await actAs(tx, ADMIN);

      const other = await newJob(tx, MECHANIC1);
      await failsWith(
        tx,
        () =>
          tx.query("select public.link_build_order($1, $2, $3)", [
            order.id,
            other.id,
            randomUUID(),
          ]),
        {
          message: "build_order_linked_elsewhere",
        },
      );
    }));

  it("refuses a job with another package; the completed build recognises labour and parts, not the held money", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "390.00" });
      const otherPkg = await onlinePackage(tx, { price: "785.00" });
      const result = await deliverOrder(tx, [line(pkg.variant, "390.00")]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      const job = await newJob(tx, MECHANIC1);
      await tx.query("select public.set_work_order_build($1, $2, $3)", [
        job.id,
        otherPkg.id,
        randomUUID(),
      ]);
      await failsWith(
        tx,
        () =>
          tx.query("select public.link_build_order($1, $2, $3)", [order.id, job.id, randomUUID()]),
        {
          message: "build_order_package_mismatch",
        },
      );

      const fresh = await newJob(tx, MECHANIC1);
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        fresh.id,
        randomUUID(),
      ]);
      await ownerMode(tx);
      const part = await makeProduct(tx, { price: "300.00", cost: "120.00" });
      await actAs(tx, ADMIN);
      await addStock(tx, part, 2);
      await addPart(tx, { workOrderId: fresh.id, productId: part });
      await tx.query("select public.fit_build_to_budget($1)", [fresh.id]);
      await completeJob(tx, fresh.id);
      await ownerMode(tx);
      const { rows } = await tx.query<{ line_type: string; total: string }>(
        `select line_type, sum(sale_total)::text as total from reporting.financial_lines
          where document_id = $1 group by line_type order by line_type`,
        [fresh.id],
      );
      expect(rows).toEqual([
        { line_type: "inventory", total: "210.00" },
        { line_type: "service", total: "180.00" },
      ]);
      const saleSide = await tx.query(
        "select 1 from reporting.financial_lines where document_id = $1",
        [result.sale_id],
      );
      expect(saleSide.rowCount).toBe(0);
      await actAs(tx, ADMIN);
    }));

  it("linking prices the build at what was paid, even for a package archived since", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "785.00" });
      // A Shopify discount: 785 charged as 700.
      const result = await deliverOrder(tx, [
        { ...line(pkg.variant, "785.00"), discount: "85.00" },
      ]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      expect(order.amount).toBe("700.00");
      await readAsOwner(tx, () =>
        tx.query("update public.build_packages set archived_at = now() where id = $1", [pkg.id]),
      );
      const job = await newJob(tx, MECHANIC1);
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        job.id,
        randomUUID(),
      ]);
      const { rows } = await tx.query(
        "select price::text, labour_amount::text from public.work_order_builds where work_order_id = $1",
        [job.id],
      );
      expect(rows[0]).toEqual({ price: "700.00", labour_amount: "180.00" });
    }));

  it("the payment reports count linked build orders: summary counts, held money", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "390.00" });
      const result = await deliverOrder(tx, [line(pkg.variant, "390.00")]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      const today = (
        await tx.query<{ d: string }>(
          "select (now() at time zone 'Asia/Singapore')::date::text as d",
        )
      ).rows[0].d;
      const summary = async () =>
        (
          await tx.query<{ shopify_count: number; shopify_total: string }>(
            "select shopify_count, shopify_total::text from public.report_payment_summary($1, $1)",
            [today],
          )
        ).rows[0];
      const before = await summary();
      const job = await newJob(tx, ADMIN);
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        job.id,
        randomUUID(),
      ]);
      const after = await summary();
      expect(after.shopify_count - before.shopify_count).toBe(1);
      expect(Number(after.shopify_total) - Number(before.shopify_total)).toBeCloseTo(390, 2);
      const held = await tx.query(
        "select grp, amount::text from public.report_payments_held() where work_order_id = $1",
        [job.id],
      );
      expect(held.rows).toEqual([{ grp: "open", amount: "390.00" }]);
    }));

  it("an order with an unlinked product lists only that line as unmapped, not the package", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      const unknownVariant = nextShopifyId();
      const result = await deliverOrder(tx, [
        line(pkg.variant, "1075.00"),
        line(unknownVariant, "20.00"),
      ]);
      expect(result.error_code).toBe("shopify_variant_unmapped");
      await ownerMode(tx);
      const { rows } = await tx.query<{ n: number }>(
        "select pg_catalog.jsonb_array_length(result -> 'unmapped_lines')::int as n from public.integration_events where id = $1",
        [result.eventId],
      );
      expect(rows[0].n).toBe(1);
      await actAs(tx, ADMIN);
    }));

  it("the site gets cart links only for an online frame and online full builds", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      await actAs(tx, ANON);
      const none = await tx.query("select * from public.public_build_offers('P-999999')");
      expect(none.rowCount).toBe(0);
      await actAs(tx, ADMIN);
      expect(pkg.id).toBeTruthy();
    }));

  it("only admins record a package's Shopify ids", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      await actAs(tx, MECHANIC1);
      await failsWith(
        tx,
        () =>
          tx.query("select public.record_build_package_push($1, $2, $3)", [
            pkg.id,
            `gid://shopify/Product/${nextShopifyId()}`,
            `gid://shopify/ProductVariant/${nextShopifyId()}`,
          ]),
        { code: "42501" },
      );
      await actAs(tx, ADMIN);
      const variant = `gid://shopify/ProductVariant/${nextShopifyId()}`;
      await tx.query("select public.record_build_package_push($1, $2, $3)", [
        pkg.id,
        `gid://shopify/Product/${nextShopifyId()}`,
        variant,
      ]);
      const { rows } = await tx.query(
        "select shopify_variant_id from public.build_packages where id = $1",
        [pkg.id],
      );
      expect(rows[0]).toEqual({ shopify_variant_id: variant });
    }));
});
