/**
 * The Phase 7 seed is coherent (DATA-MODEL §18 "Phase 7 part";
 * tests/fixtures/ids.ts SUPPLIER, PURCHASE_ORDER, PURCHASE_ORDER_LINE,
 * RECEIPT_KEY; PLAN D63 D-LASTCOST, D64 D-RECEIPT-TIME, D66 D-REORDER):
 *
 *   * five POs PO-000001 .. PO-000005, one per interesting status, built
 *     through the RPCs as the admin;
 *   * every PO's created_at < submitted_at < each receipt's received_at
 *     (back-dated), while the movements keep seed time; the PO history is
 *     dated to match (created, submitted, received at those instants);
 *   * SPEC §14's partial receipt: ordered 20, received 18, 2 outstanding,
 *     overdue; replaying its receipt key returns the seeded receipt;
 *   * the fences: receipt costs equal the products' costs, no low-stock
 *     product is received, so reporting.low_stock is unchanged;
 *   * the archived supplier has no POs.
 *
 * Seeded days are counted from the seed's anchor (seedToday, the shop day
 * the template was built), never from the wall clock, so a run that crosses
 * Singapore midnight reads the same (DATA-MODEL §18, TESTING.md).
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  LOCATION,
  PO_NUMBER,
  PRODUCT,
  PURCHASE_ORDER,
  PURCHASE_ORDER_LINE,
  RECEIPT_KEY,
  STAFF,
  SUPPLIER,
} from "../fixtures/ids";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { ADMIN } from "./inventory-fixtures";
import { progress, receive } from "./purchasing-fixtures";
import { seedToday, shopToday } from "./reporting-fixtures";

let conn: pg.Client;
let anchor: string;
let anchorIsToday: boolean;

beforeAll(async () => {
  conn = await connect();
  anchor = await seedToday(conn);
  anchorIsToday = anchor === (await shopToday(conn));
});

const it7 = it.skipIf(!isolatedDatabase());

const shopDay = (sql: string, params: unknown[] = []) =>
  scalar<string>(conn, `select (${sql})::text`, params);

describe("Phase 7 seed: suppliers and purchase orders", () => {
  it("has five POs with their numbers, suppliers and statuses, created by the admin in the shop currency", async () => {
    const { rows } = await conn.query<{
      id: string;
      po_number: string;
      supplier_id: string;
      status: string;
      currency: string;
      created_by: string;
      cancellation_reason: string | null;
      ok_currency: boolean;
    }>(
      `select id, po_number, supplier_id, status::text, currency, created_by, cancellation_reason,
              currency = private.shop_currency() as ok_currency
         from public.purchase_orders order by po_number`,
    );
    expect(rows.map((r) => [r.id, r.po_number, r.supplier_id, r.status])).toEqual([
      [PURCHASE_ORDER.receivedInFull, PO_NUMBER.receivedInFull, SUPPLIER.veloParts, "received"],
      [PURCHASE_ORDER.partial, PO_NUMBER.partial, SUPPLIER.veloParts, "partially_received"],
      [
        PURCHASE_ORDER.awaitingDelivery,
        PO_NUMBER.awaitingDelivery,
        SUPPLIER.tropicTyre,
        "submitted",
      ],
      [PURCHASE_ORDER.draft, PO_NUMBER.draft, SUPPLIER.veloParts, "draft"],
      [PURCHASE_ORDER.cancelled, PO_NUMBER.cancelled, SUPPLIER.tropicTyre, "cancelled"],
    ]);
    for (const r of rows) {
      expect(r.ok_currency).toBe(true);
      expect(r.created_by).toBe(STAFF.admin);
    }
    expect(rows[4].cancellation_reason).toBe("Supplier out of stock until next quarter");
  });

  it("has the lines of the fixture, at the products' costs", async () => {
    const { rows } = await conn.query<{
      id: string;
      purchase_order_id: string;
      product_id: string;
      quantity_ordered: number;
      unit_cost: string;
      product_cost: string;
    }>(
      `select l.id, l.purchase_order_id, l.product_id, l.quantity_ordered, l.unit_cost::text,
              p.default_direct_cost::text as product_cost
         from public.purchase_order_lines l join public.products p on p.id = l.product_id
        order by l.id`,
    );
    expect(
      rows.map((r) => [r.id, r.purchase_order_id, r.product_id, r.quantity_ordered, r.unit_cost]),
    ).toEqual([
      [
        PURCHASE_ORDER_LINE.receivedInFullCassette,
        PURCHASE_ORDER.receivedInFull,
        PRODUCT.cassette,
        4,
        "68.00",
      ],
      [PURCHASE_ORDER_LINE.partialChain, PURCHASE_ORDER.partial, PRODUCT.chainX11, 20, "24.00"],
      [PURCHASE_ORDER_LINE.partialLube, PURCHASE_ORDER.partial, PRODUCT.chainLube, 10, "7.00"],
      [
        PURCHASE_ORDER_LINE.awaitingTyres,
        PURCHASE_ORDER.awaitingDelivery,
        PRODUCT.gp5000Tyre,
        6,
        "52.00",
      ],
      [PURCHASE_ORDER_LINE.draftCableKit, PURCHASE_ORDER.draft, PRODUCT.cableKit, 6, "16.00"],
      [PURCHASE_ORDER_LINE.draftHose, PURCHASE_ORDER.draft, PRODUCT.hydraulicHose, 9, "12.00"],
      [PURCHASE_ORDER_LINE.cancelledTubes, PURCHASE_ORDER.cancelled, PRODUCT.roadTube, 20, "3.80"],
    ]);
    for (const r of rows) expect(r.unit_cost, r.id).toBe(r.product_cost);
  });

  it("reads true in time: created < submitted < every receipt, receipts on their days, movements at seed time", async () => {
    const { rows } = await conn.query<{
      id: string;
      created_at: Date;
      submitted_at: Date | null;
      cancelled_at: Date | null;
    }>(
      "select id, created_at, submitted_at, cancelled_at from public.purchase_orders order by po_number",
    );
    for (const r of rows) {
      if (r.submitted_at)
        expect(r.created_at.getTime(), r.id).toBeLessThan(r.submitted_at.getTime());
      if (r.cancelled_at)
        expect(r.submitted_at!.getTime(), r.id).toBeLessThan(r.cancelled_at.getTime());
    }
    // Numbers follow creation.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].created_at.getTime()).toBeLessThan(rows[i].created_at.getTime());
    }
    const bad = await conn.query(
      `select pr.id from public.purchase_receipts pr
         join public.purchase_orders po on po.id = pr.purchase_order_id
        where not (po.created_at < po.submitted_at and po.submitted_at < pr.received_at)
           or pr.received_at > now()`,
    );
    expect(bad.rows).toEqual([]);

    // Shop days before the reset day: PO-000001 created 12, submitted 11,
    // received 9; PO-000002 created 6, submitted 5, received 3; PO-000003
    // created and submitted 2.
    const daysAgo = (column: string, id: string) =>
      shopDay(
        `select $2::date - private.shop_day(${column}) from public.purchase_orders where id = $1`,
        [id, anchor],
      );
    expect(await daysAgo("created_at", PURCHASE_ORDER.receivedInFull)).toBe("12");
    expect(await daysAgo("submitted_at", PURCHASE_ORDER.receivedInFull)).toBe("11");
    expect(await daysAgo("received_at", PURCHASE_ORDER.receivedInFull)).toBe("9");
    expect(await daysAgo("created_at", PURCHASE_ORDER.partial)).toBe("6");
    expect(await daysAgo("submitted_at", PURCHASE_ORDER.partial)).toBe("5");
    expect(await daysAgo("created_at", PURCHASE_ORDER.awaitingDelivery)).toBe("2");
    expect(await daysAgo("submitted_at", PURCHASE_ORDER.awaitingDelivery)).toBe("2");

    const { rows: receipts } = await conn.query<{
      idempotency_key: string;
      reference: string;
      days_ago: number;
      received_by: string;
    }>(
      `select idempotency_key, reference, $1::date - private.shop_day(received_at) as days_ago,
              received_by
         from public.purchase_receipts order by received_at`,
      [anchor],
    );
    expect(receipts).toEqual([
      {
        idempotency_key: RECEIPT_KEY.receivedInFull,
        reference: "DN-5402",
        days_ago: 9,
        received_by: STAFF.admin,
      },
      {
        idempotency_key: RECEIPT_KEY.partial,
        reference: "DN-5531",
        days_ago: 3,
        received_by: STAFF.admin,
      },
    ]);

    // D64: the movements keep seed time; their reason names the delivery day.
    const { rows: movements } = await conn.query<{
      product_id: string;
      quantity_delta: number;
      reason: string;
      today: boolean;
    }>(
      `select product_id, quantity_delta, reason, private.shop_day(created_at) = $1::date as today
         from public.inventory_movements where movement_type = 'purchase_received' order by product_id`,
      [anchor],
    );
    expect(movements.map((m) => [m.product_id, m.quantity_delta, m.today])).toEqual([
      [PRODUCT.chainX11, 18, true],
      [PRODUCT.cassette, 4, true],
      [PRODUCT.chainLube, 10, true],
    ]);
    expect(movements[0].reason).toMatch(/^PO-000002 received \d{1,2} [A-Z][a-z]{2} \d{4} 11:30$/);
    expect(movements[1].reason).toMatch(/^PO-000001 received \d{1,2} [A-Z][a-z]{2} \d{4} 14:00$/);
  });

  it("each seeded PO's history reads true next to its dates; the history stays append-only", async () => {
    const { rows } = await conn.query<{
      po: string;
      event_type: string;
      at: Date;
      created_at: Date;
      submitted_at: Date | null;
      receipt_at: Date | null;
    }>(
      `select o.id as po, e.event_type::text, e.created_at as at, o.created_at, o.submitted_at,
              r.received_at as receipt_at
         from public.purchase_order_events e
         join public.purchase_orders o on o.id = e.purchase_order_id
         left join public.purchase_receipts r on r.id = e.purchase_receipt_id
        where o.id = any ($1::uuid[])
        order by o.po_number, e.created_at, e.id`,
      [Object.values(PURCHASE_ORDER)],
    );
    expect(rows.length).toBeGreaterThan(0);
    const types = (po: string) => rows.filter((r) => r.po === po).map((r) => r.event_type);
    // History order is the business order.
    expect(types(PURCHASE_ORDER.receivedInFull)).toEqual([
      "created",
      "line_added",
      "submitted",
      "received",
      "status_changed",
    ]);
    expect(types(PURCHASE_ORDER.partial)).toEqual([
      "created",
      "line_added",
      "line_added",
      "submitted",
      "received",
      "status_changed",
    ]);
    expect(types(PURCHASE_ORDER.cancelled)).toEqual([
      "created",
      "line_added",
      "submitted",
      "cancelled",
    ]);
    for (const r of rows) {
      const label = `${r.po} ${r.event_type}`;
      expect(r.at.getTime(), label).toBeGreaterThanOrEqual(r.created_at.getTime());
      if (r.event_type === "created") expect(r.at.getTime(), label).toBe(r.created_at.getTime());
      if (r.event_type === "line_added" && r.submitted_at)
        expect(r.at.getTime(), label).toBeLessThan(r.submitted_at.getTime());
      if (r.event_type === "submitted")
        expect(r.at.getTime(), label).toBe(r.submitted_at!.getTime());
      if (r.event_type === "received") expect(r.at.getTime(), label).toBe(r.receipt_at!.getTime());
    }
    // The seed lifted the append-only trigger for its one UPDATE only.
    expect(
      await scalar<string>(
        conn,
        `select tgenabled::text from pg_catalog.pg_trigger
          where tgname = 'purchase_order_events_append_only'`,
      ),
    ).toBe("O");
  });

  it("PO-000002 is SPEC §14's partial receipt: 20 ordered, 18 received, 2 outstanding, overdue", async () => {
    const rows = await progress(conn, PURCHASE_ORDER.partial);
    expect(
      rows.map((r) => [
        r.purchase_order_line_id,
        r.po_status,
        r.quantity_ordered,
        r.quantity_received,
        r.quantity_outstanding,
        r.is_overdue,
      ]),
    ).toEqual([
      [PURCHASE_ORDER_LINE.partialChain, "partially_received", 20, 18, 2, true],
      [PURCHASE_ORDER_LINE.partialLube, "partially_received", 10, 10, 0, false],
    ]);
    expect(
      await shopDay("select $2::date - expected_at from public.purchase_orders where id = $1", [
        PURCHASE_ORDER.partial,
        anchor,
      ]),
    ).toBe("1");

    // The others: received in full and cancelled.
    expect((await progress(conn, PURCHASE_ORDER.receivedInFull))[0]).toMatchObject({
      quantity_received: 4,
      quantity_outstanding: 0,
      is_overdue: false,
    });
    expect((await progress(conn, PURCHASE_ORDER.cancelled))[0]).toMatchObject({
      quantity_outstanding: 0,
      quantity_cancelled: 20,
    });
  });

  it("PO-000003 is awaiting delivery, expected after the anchor, not overdue", async (ctx) => {
    // is_overdue reads the live shop day: on a database seeded days ago
    // (existing-database mode) its expected day may have passed.
    if (!anchorIsToday)
      ctx.skip(
        `the seed's anchor (${anchor}) is not the shop's today: run \`npm run db:reset\` to re-anchor it`,
      );
    expect((await progress(conn, PURCHASE_ORDER.awaitingDelivery))[0]).toMatchObject({
      quantity_received: 0,
      quantity_outstanding: 6,
      is_overdue: false,
    });
  });

  it("on order: 6 tyres and 2 chains (submitted and partially received only)", async () => {
    const { rows } = await conn.query<{ product_id: string; quantity_on_order: number }>(
      "select product_id, quantity_on_order from reporting.product_on_order order by product_id",
    );
    expect(rows).toEqual([
      { product_id: PRODUCT.gp5000Tyre, quantity_on_order: 6 },
      { product_id: PRODUCT.chainX11, quantity_on_order: 2 },
    ]);
  });

  it7(
    "replaying the partial receipt's key with its lines returns the seeded receipt and writes nothing",
    async () => {
      await inTransaction(conn, async (tx) => {
        const before = await scalar<number>(
          tx,
          "select count(*)::int from public.inventory_movements",
        );
        const seeded = await scalar<string>(
          tx,
          "select id from public.purchase_receipts where idempotency_key = $1",
          [RECEIPT_KEY.partial],
        );
        await actAs(tx, ADMIN);
        const replay = await receive(tx, {
          poId: PURCHASE_ORDER.partial,
          key: RECEIPT_KEY.partial,
          reference: "DN-5531",
          lines: [
            {
              lineId: PURCHASE_ORDER_LINE.partialChain,
              quantity: 18,
              locationId: LOCATION.shopFloor,
            },
            {
              lineId: PURCHASE_ORDER_LINE.partialLube,
              quantity: 10,
              locationId: LOCATION.shopFloor,
            },
          ],
        });
        expect(replay.id).toBe(seeded);
        await tx.query("reset role");
        expect(
          await scalar<number>(tx, "select count(*)::int from public.inventory_movements"),
        ).toBe(before);
      });
    },
  );

  it("the fences: receipt costs equal the products' costs, and no cost was changed by a receipt", async () => {
    const { rows } = await conn.query<{
      product_id: string;
      actual: string;
      product_cost: string;
      last: string;
    }>(
      `select rl.product_id, rl.unit_cost_actual::text as actual, p.default_direct_cost::text as product_cost,
              sp.last_unit_cost::text as last
         from public.purchase_receipt_lines rl
         join public.purchase_receipts pr on pr.id = rl.purchase_receipt_id
         join public.purchase_orders po on po.id = pr.purchase_order_id
         join public.products p on p.id = rl.product_id
         join public.supplier_products sp on sp.supplier_id = po.supplier_id and sp.product_id = rl.product_id
        order by rl.product_id`,
    );
    expect(rows).toEqual([
      { product_id: PRODUCT.chainX11, actual: "24.00", product_cost: "24.00", last: "24.00" },
      { product_id: PRODUCT.cassette, actual: "68.00", product_cost: "68.00", last: "68.00" },
      { product_id: PRODUCT.chainLube, actual: "7.00", product_cost: "7.00", last: "7.00" },
    ]);
    const costEvents = await scalar<number>(
      conn,
      `select count(*)::int from public.product_events
        where event_type = 'cost_changed' and reason like 'Received on PO-%'`,
    );
    expect(costEvents).toBe(0);
  });

  it("the fences: on-hand moves only for the received products; low stock is still cableKit, hydraulicHose and sealant", async () => {
    const { rows } = await conn.query<{ product_id: string; on_hand: number }>(
      "select product_id, on_hand from reporting.product_stock where product_id = any($1::uuid[])",
      [
        [
          PRODUCT.cassette,
          PRODUCT.chainX11,
          PRODUCT.chainLube,
          PRODUCT.gp5000Tyre,
          PRODUCT.roadTube,
        ],
      ],
    );
    expect(Object.fromEntries(rows.map((r) => [r.product_id, r.on_hand]))).toEqual({
      [PRODUCT.cassette]: 7,
      [PRODUCT.chainX11]: 26,
      [PRODUCT.chainLube]: 28,
      [PRODUCT.gp5000Tyre]: 12,
      [PRODUCT.roadTube]: 60,
    });
    const low = await conn.query<{ product_id: string }>(
      "select product_id from reporting.low_stock order by product_id",
    );
    expect(low.rows.map((r) => r.product_id)).toEqual(
      [PRODUCT.cableKit, PRODUCT.hydraulicHose, PRODUCT.sealant].sort(),
    );
  });

  it("the archived supplier has no POs and no links; sealant has no supplier", async () => {
    expect(
      await scalar<boolean>(
        conn,
        "select archived_at is not null from public.suppliers where id = $1",
        [SUPPLIER.oldSpoke],
      ),
    ).toBe(true);
    expect(
      await scalar<number>(
        conn,
        "select count(*)::int from public.purchase_orders where supplier_id = $1",
        [SUPPLIER.oldSpoke],
      ),
    ).toBe(0);
    expect(
      await scalar<number>(
        conn,
        "select count(*)::int from public.supplier_products where supplier_id = $1",
        [SUPPLIER.oldSpoke],
      ),
    ).toBe(0);
    const { rows } = await conn.query<{ supplier_id: string; preferred: boolean }>(
      "select supplier_id, preferred from public.supplier_products where product_id = $1 order by supplier_id",
      [PRODUCT.gp5000Tyre],
    );
    expect(rows).toEqual([
      { supplier_id: SUPPLIER.veloParts, preferred: false },
      { supplier_id: SUPPLIER.tropicTyre, preferred: true },
    ]);
    expect(
      await scalar<number>(
        conn,
        "select count(*)::int from public.supplier_products where product_id = $1",
        [PRODUCT.sealant],
      ),
    ).toBe(0);
  });
});
