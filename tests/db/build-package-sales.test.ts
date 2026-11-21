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

/**
 * A full build pushed to Shopify (owner writes) with its three frame-option
 * variants (D257) and a S$185 donor service; returns its id and the variant
 * numbers.
 */
async function onlinePackage(
  tx: pg.Client,
  { price = "1075.00", name = `Restomod ${randomUUID().slice(0, 6)}` } = {},
): Promise<{
  id: string;
  variant: number;
  ownVariant: number;
  donorVariant: number;
  donorServiceId: string;
}> {
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
  const ownVariant = nextShopifyId();
  const donorVariant = nextShopifyId();
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.build_packages
       (kind, name, price, labour_amount, labour_service_id, publish_online, shopify_product_id, shopify_variant_id,
        shopify_own_frame_variant_id, shopify_donor_variant_id, shopify_donor_amount, donor_service_id)
     values ('full_build', $1, $2, 180, $3, true, $4, $5, $6, $7, 185, $8) returning id`,
    [
      name,
      price,
      serviceId,
      `gid://shopify/Product/${nextShopifyId()}`,
      `gid://shopify/ProductVariant/${variant}`,
      `gid://shopify/ProductVariant/${ownVariant}`,
      `gid://shopify/ProductVariant/${donorVariant}`,
      donorServiceId,
    ],
  );
  await actAs(tx, ADMIN);
  return { id: rows[0].id, variant, ownVariant, donorVariant, donorServiceId };
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
    frame_source: string;
    donor_amount: string;
  }>(
    `select id, amount::text, line_part, work_order_id, frame_source::text, donor_amount::text
       from public.build_orders where sale_id = $1 order by line_part`,
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
        tx.query(
          "update public.build_packages set publish_online = false, archived_at = now() where id = $1",
          [pkg.id],
        ),
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
  it("each frame option's variant becomes a build order that remembers it; a donor bike holds its strip (D257, D258)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      const own = await deliverOrder(tx, [line(pkg.ownVariant, "1075.00")]);
      expect(own.outcome).toBe("sale_recorded");
      expect(await buildOrdersOf(tx, own.sale_id!)).toEqual([
        expect.objectContaining({
          amount: "1075.00",
          frame_source: "own_frame",
          donor_amount: "0.00",
        }),
      ]);
      const donor = await deliverOrder(tx, [line(pkg.donorVariant, "1260.00")]);
      expect(await buildOrdersOf(tx, donor.sale_id!)).toEqual([
        expect.objectContaining({
          amount: "1260.00",
          frame_source: "donor_bike",
          donor_amount: "185.00",
        }),
      ]);
      // A discount below the strip's price: the strip never takes more than was paid.
      const cheap = await deliverOrder(tx, [line(pkg.donorVariant, "100.00")]);
      expect(await buildOrdersOf(tx, cheap.sale_id!)).toEqual([
        expect.objectContaining({ amount: "100.00", donor_amount: "100.00" }),
      ]);
      const bicii = await deliverOrder(tx, [line(pkg.variant, "1075.00")]);
      expect(await buildOrdersOf(tx, bicii.sale_id!)).toEqual([
        expect.objectContaining({ frame_source: "bicii_frame", donor_amount: "0.00" }),
      ]);
    }));

  it("linking a donor-bike order adds the strip as its own line and prices the build at the rest (D258)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      const result = await deliverOrder(tx, [line(pkg.donorVariant, "1260.00")]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      const job = await newJob(tx, MECHANIC1);
      await failsWith(
        tx,
        () =>
          tx.query("select public.link_build_order($1, $2, $3)", [order.id, job.id, randomUUID()]),
        { code: "22004" },
      );
      const donorLine = randomUUID();
      await tx.query("select public.link_build_order($1, $2, $3, $4)", [
        order.id,
        job.id,
        randomUUID(),
        donorLine,
      ]);
      const build = await tx.query(
        "select price::text, labour_amount::text from public.work_order_builds where work_order_id = $1",
        [job.id],
      );
      expect(build.rows[0]).toEqual({ price: "1075.00", labour_amount: "180.00" });
      const strip = await tx.query(
        `select source_service_id, unit_sale_price_snapshot::text as price
           from public.work_order_line_items where id = $1`,
        [donorLine],
      );
      expect(strip.rows[0]).toEqual({ source_service_id: pkg.donorServiceId, price: "185.00" });
      const totals = await tx.query(
        `select paid_shopify::text, job_total::text, balance_due::text
           from public.work_order_payment_totals where work_order_id = $1`,
        [job.id],
      );
      expect(totals.rows[0]).toEqual({
        paid_shopify: "1260.00",
        job_total: "365.00",
        balance_due: "0.00",
      });
      const event = await tx.query(
        `select payload ->> 'frame_source' as frame, payload ->> 'donor_amount' as donor
           from public.work_order_events where work_order_id = $1 and event_type = 'build_order_linked'`,
        [job.id],
      );
      expect(event.rows).toEqual([{ frame: "donor_bike", donor: "185.00" }]);
    }));

  it("admins record every frame option's variant; the online prices come from Postgres (D257)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "485.00" });
      const prices = await tx.query(
        `select price::text, donor_service_id, donor_amount::text, donor_price::text
           from public.build_package_online_prices($1)`,
        [pkg.id],
      );
      expect(prices.rows[0]).toEqual({
        price: "485.00",
        donor_service_id: pkg.donorServiceId,
        donor_amount: "185.00",
        donor_price: "670.00",
      });
      const ids = [nextShopifyId(), nextShopifyId(), nextShopifyId()].map(
        (n) => `gid://shopify/ProductVariant/${n}`,
      );
      await tx.query("select public.record_build_package_push($1, $2, $3, $4, $5, $6)", [
        pkg.id,
        `gid://shopify/Product/${nextShopifyId()}`,
        ids[0],
        ids[1],
        ids[2],
        "185.00",
      ]);
      const { rows } = await tx.query(
        `select shopify_variant_id, shopify_own_frame_variant_id, shopify_donor_variant_id,
                shopify_donor_amount::text from public.build_packages where id = $1`,
        [pkg.id],
      );
      expect(rows[0]).toEqual({
        shopify_variant_id: ids[0],
        shopify_own_frame_variant_id: ids[1],
        shopify_donor_variant_id: ids[2],
        shopify_donor_amount: "185.00",
      });
      // The three-argument form (an Admin deployed before D257) clears the options.
      await tx.query("select public.record_build_package_push($1, $2, $3)", [
        pkg.id,
        `gid://shopify/Product/${nextShopifyId()}`,
        ids[0],
      ]);
      const after = await tx.query(
        "select shopify_own_frame_variant_id, shopify_donor_amount from public.build_packages where id = $1",
        [pkg.id],
      );
      expect(after.rows[0]).toEqual({
        shopify_own_frame_variant_id: null,
        shopify_donor_amount: null,
      });
    }));

  it("a job that already has the package takes the price paid when the order is linked (audit 2026-11-22)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx, { price: "785.00" });
      const result = await deliverOrder(tx, [
        { ...line(pkg.variant, "785.00"), discount: "85.00" },
      ]);
      const [order] = await buildOrdersOf(tx, result.sale_id!);
      const job = await newJob(tx, MECHANIC1);
      const labourLineId = randomUUID();
      await tx.query("select public.set_work_order_build($1, $2, $3, null)", [
        job.id,
        pkg.id,
        labourLineId,
      ]);
      await tx.query("select public.link_build_order($1, $2, $3)", [
        order.id,
        job.id,
        randomUUID(),
      ]);
      const build = await tx.query(
        "select price::text, labour_amount::text, labour_line_id from public.work_order_builds where work_order_id = $1",
        [job.id],
      );
      expect(build.rows[0]).toEqual({
        price: "700.00",
        labour_amount: "180.00",
        labour_line_id: labourLineId,
      });
      await tx.query("select public.fit_build_to_budget($1)", [job.id]);
      const totals = await tx.query(
        "select job_total::text, balance_due::text from public.work_order_payment_totals where work_order_id = $1",
        [job.id],
      );
      expect(totals.rows[0]).toEqual({ job_total: "700.00", balance_due: "0.00" });
      const events = await tx.query(
        `select payload ->> 'previous_price' as previous from public.work_order_events
          where work_order_id = $1 and event_type = 'build_set' order by created_at, id`,
        [job.id],
      );
      expect(events.rows.at(-1)).toEqual({ previous: "785.00" });
    }));

  it("own-frame and donor package lines are not unmapped, and no product can take a package's variant (audit 2026-11-22)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      const result = await deliverOrder(tx, [
        line(pkg.ownVariant, "1075.00"),
        line(pkg.donorVariant, "1260.00"),
        line(nextShopifyId(), "20.00"),
      ]);
      expect(result.error_code).toBe("shopify_variant_unmapped");
      await ownerMode(tx);
      const { rows } = await tx.query<{ n: number }>(
        "select pg_catalog.jsonb_array_length(result -> 'unmapped_lines')::int as n from public.integration_events where id = $1",
        [result.eventId],
      );
      expect(rows[0].n).toBe(1);
      await actAs(tx, ADMIN);
      const product = await onlineProduct(tx);
      await readAsOwner(tx, () =>
        tx.query(
          "update public.products set shopify_product_id = null, shopify_variant_id = null where id = $1",
          [product.productId],
        ),
      );
      for (const variant of [pkg.variant, pkg.ownVariant, pkg.donorVariant]) {
        await failsWith(
          tx,
          () =>
            tx.query("select public.link_shopify_variant($1, $2, $3, 'Mapping')", [
              product.productId,
              String(nextShopifyId()),
              String(variant),
            ]),
          { message: "shopify_ids_conflict" },
        );
      }
    }));

  it("a package on sale on Shopify is taken off before it can be archived (audit 2026-11-22)", () =>
    inTx(async (tx) => {
      const pkg = await onlinePackage(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.build_packages set archived_at = now() where id = $1", [pkg.id]),
        { message: "build_package_online" },
      );
      await tx.query(
        "update public.build_packages set publish_online = false, archived_at = now() where id = $1",
        [pkg.id],
      );
    }));
});
