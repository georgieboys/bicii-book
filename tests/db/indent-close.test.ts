/**
 * Closing indent items (PLAN D149a, D149b, D149c; ADR-024 amendment
 * 2026-10-15; DATA-MODEL §4, §5, §7, §16; RISKS R-082, R-084), migration
 * 20261014000900:
 *
 *   fit_part_bought_outside  D149a: an approved part never ordered in BICII
 *                       is recorded as bought outside BICII at the cost
 *                       staff enter (+quantity, outside_purchase) and fitted
 *                       at the same place (-quantity, job_consumption): the
 *                       count never moves, the product's cost becomes the
 *                       entered cost (D5, D63 extended) and the line and
 *                       its yield use it (D24 unchanged). View costs or
 *                       Manage purchasing.
 *   the settle guard    D149b, D149c(1): no move into completed, ready for
 *                       collection, collected or cancelled while a request
 *                       is approved or ordered, for every writer.
 *   the quote withdrawal  D149c(2): an open quote is withdrawn when its job
 *                       leaves the open statuses; D149c(6) withdrew those
 *                       left open on jobs already closed.
 *
 * Stock reconciliation, adjustments reporting, totals and Cult Commons stay
 * consistent (spec A7). Rolled-back transactions throughout; the races
 * commit, so they run only on this file's clone.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { isUnfitted, type PartRequestStatus } from "@/lib/indent";
import { WORK_ORDER_STATUSES, isOpenStatus, transitionRule } from "@/lib/workshop";

import { LOCATION, STAFF } from "../fixtures/ids";
import { intakeQuantity, createConsignor } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  answer,
  answerAll,
  beforeTheGuard,
  fit,
  orderParts,
  proposePart,
  proposeService,
  quoteByToken,
  quoted,
  sendQuote,
  setup,
} from "./indent-fixtures";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  addPart,
  addStock,
  assertLedgerConsistent,
  committed,
  completeJob,
  makeLocation,
  makeProduct,
  movements,
  newJob,
  onHand,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { race } from "./lock-race";
import { grantPurchasing, productCost, receive } from "./purchasing-fixtures";
import { shopToday } from "./reporting-fixtures";
import {
  events,
  eventTypes,
  failsWith,
  ownerMode,
  setStatus,
  tryAndUndo,
  voidLine,
  walkTo,
  workOrder,
} from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const p0001 = (message: string) => ({ code: "P0001", message });
const ANON: Claims = { role: "anon" };
const UNSETTLED = p0001("work_order_has_unfitted_requests");

/** public.fit_part_bought_outside as whoever `tx` is; returns the line id. */
const boughtOutside = (
  tx: pg.Client,
  requestId: string,
  {
    lineId = randomUUID() as string,
    cost = "30.00" as string | null,
    locationId = null as string | null,
    reference = null as string | null,
  } = {},
) =>
  scalar<string>(tx, "select public.fit_part_bought_outside($1, $2, $3, $4, $5)", [
    requestId,
    lineId,
    cost,
    locationId,
    reference,
  ]);

const requestRow = (tx: pg.Client, id: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      status: string;
      work_order_line_item_id: string | null;
      outside_purchase_movement_id: string | null;
    }>(
      `select status::text, work_order_line_item_id, outside_purchase_movement_id::text
         from public.job_part_requests where id = $1`,
      [id],
    );
    return rows[0];
  });

const requestStatus = async (tx: pg.Client, id: string) => (await requestRow(tx, id)).status;

/** A job line with its costs, as the owner reads it. */
const lineRow = (tx: pg.Client, lineId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query(
      `select unit_sale_price_snapshot::text as price, unit_direct_cost_snapshot::text as cost,
              cost_pending, sale_total::text, cost_total::text, yield_total::text,
              cult_commons_share::text,
              round(greatest(yield_total, 0) * cult_commons_rate_snapshot, 2)::text as cc_formula,
              voided_at is not null as voided
         from public.work_order_line_items where id = $1`,
      [lineId],
    );
    return rows[0];
  });

/** Rows a refused call must not have written: the product's ledger, the job's lines and events. */
const footprint = (tx: pg.Client, productId: string, workOrderId: string) =>
  readAsOwner(tx, async () => ({
    movements: await scalar<number>(
      tx,
      "select count(*)::int from public.inventory_movements where product_id = $1",
      [productId],
    ),
    lines: await scalar<number>(
      tx,
      "select count(*)::int from public.work_order_line_items where work_order_id = $1",
      [workOrderId],
    ),
    events: await scalar<number>(
      tx,
      "select count(*)::int from public.work_order_events where work_order_id = $1",
      [workOrderId],
    ),
    cost: await scalar<string | null>(
      tx,
      "select default_direct_cost::text from public.products where id = $1",
      [productId],
    ),
  }));

/** The product's cost_changed history (read as the owner). */
const costChanges = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      payload: Record<string, unknown>;
      reason: string | null;
      actor_staff_id: string | null;
    }>(
      `select payload, reason, actor_staff_id from public.product_events
        where product_id = $1 and event_type = 'cost_changed' order by created_at, id`,
      [productId],
    );
    return rows;
  });

/**
 * setup() plus one part (2 x 45.00 unless given) proposed, quoted and
 * approved by the link; acting as ADMIN.
 */
async function approvedPart(
  tx: pg.Client,
  {
    quantity = 2,
    price = "45.00",
    cost,
  }: { quantity?: number; price?: string; cost?: string | null } = {},
) {
  let s = await setup(tx);
  if (cost !== undefined) {
    // Its own product at that cost (null: none), created as the owner.
    await ownerMode(tx);
    s = { ...s, productId: await makeProduct(tx, { price: "120.00", cost }) };
    await actAs(tx, ADMIN);
  }
  const partId = await proposePart(tx, {
    workOrderId: s.job.id,
    productId: s.productId,
    quantity,
    price,
    cost: "28.00",
  });
  const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [partId] });
  await actAs(tx, ANON);
  await answerAll(tx, token);
  await actAs(tx, ADMIN);
  return { ...s, partId, token };
}

/** quoted() answered by the link (the part and the service approved); acting as ADMIN. */
async function approved(tx: pg.Client) {
  const q = await quoted(tx);
  await actAs(tx, ANON);
  await answerAll(tx, q.token);
  await actAs(tx, ADMIN);
  return q;
}

/** The job's newest quote (as the owner). */
const quoteOf = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ id: string; status: string; withdrawn_by: string | null }>(
      `select id, status::text, withdrawn_by from public.quotes
        where work_order_id = $1 order by sent_at desc limit 1`,
      [workOrderId],
    );
    return rows[0];
  });

// ---------------------------------------------------------------------------
// (a) Bought outside BICII (D149a)
// ---------------------------------------------------------------------------

describe("fit_part_bought_outside (D149a)", () => {
  it("records the purchase at the entered cost and fits it at the same place: the count never moves", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      await ownerMode(tx);
      const location = await makeLocation(tx);
      await actAs(tx, ADMIN);
      expect(await onHand(tx, a.productId, location)).toBe(0);
      const eventsBefore = (await events(tx, a.job.id)).length;

      const lineId = randomUUID();
      expect(
        await boughtOutside(tx, a.partId, {
          lineId,
          cost: "30.00",
          locationId: location,
          reference: "  Bike Hub receipt 4471  ",
        }),
      ).toBe(lineId);

      // Exactly two rows: the receipt, then the fit, both at 30.00 at L.
      const why = `Bought outside BICII for ${a.job.job_number} (Bike Hub receipt 4471)`;
      const rows = await movements(tx, a.productId);
      expect(rows.map((m) => [m.movement_type, m.quantity_delta, m.location_id])).toEqual([
        ["outside_purchase", 2, location],
        ["job_consumption", -2, location],
      ]);
      expect(rows[0]).toMatchObject({
        unit_cost_snapshot: "30.00",
        request_id: lineId,
        reason: why,
        work_order_line_item_id: null,
        inventory_unit_id: null,
        created_by: STAFF.admin,
      });
      expect(rows[1]).toMatchObject({
        unit_cost_snapshot: "30.00",
        work_order_line_item_id: lineId,
      });
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select work_order_id from public.inventory_movements where id = $1", [
            rows[0].id,
          ]),
        ),
      ).toBe(a.job.id);
      // On-hand at L never went below zero: 0, +2, -2.
      expect(await onHand(tx, a.productId, location)).toBe(0);

      // One ordinary line: the quoted price, the real cost, its yield.
      expect(await lineRow(tx, lineId)).toMatchObject({
        price: "45.00",
        cost: "30.00",
        cost_pending: false,
        sale_total: "90.00",
        cost_total: "60.00",
        yield_total: "30.00",
        voided: false,
      });
      const line = await lineRow(tx, lineId);
      expect(line.cult_commons_share).toBe(line.cc_formula);
      expect(
        await scalar<string>(
          tx,
          "select sale_total::text from public.work_order_totals where work_order_id = $1",
          [a.job.id],
        ),
      ).toBe("90.00");

      // The request is fitted and linked to its receipt.
      expect(await requestRow(tx, a.partId)).toEqual({
        status: "fitted",
        work_order_line_item_id: lineId,
        outside_purchase_movement_id: rows[0].id,
      });

      // The product's cost is the entered cost, with one cost_changed entry
      // (no figure in it) whose reason names the job and the reference.
      expect(await productCost(tx, a.productId)).toBe("30.00");
      expect(await costChanges(tx, a.productId)).toEqual([
        { payload: {}, reason: why, actor_staff_id: STAFF.admin },
      ]);

      // The timeline: part_fitted says bought outside, never a cost.
      await ownerMode(tx);
      const timeline = await events(tx, a.job.id);
      const fitted = timeline.filter((e) => e.event_type === "part_fitted");
      expect(fitted.map((e) => e.payload)).toEqual([
        {
          request_id: a.partId,
          line_id: lineId,
          description: expect.any(String),
          quantity: 2,
          bought_outside: true,
          reference: "Bike Hub receipt 4471",
        },
      ]);
      expect(timeline.slice(eventsBefore).map((e) => e.event_type)).toEqual(
        expect.arrayContaining(["line_added", "stock_consumed", "part_fitted"]),
      );
      const productEvents = await tx.query<{ payload: unknown }>(
        "select payload from public.product_events where product_id = $1",
        [a.productId],
      );
      for (const text of [
        JSON.stringify(timeline.map((e) => e.payload)),
        JSON.stringify(productEvents.rows),
        rows.map((m) => m.reason ?? "").join(" "),
      ]) {
        expect(text).not.toMatch(/30\.00|60\.00/);
      }
      await assertLedgerConsistent(tx);
    });
  });

  it("the new cost is the product's from now on; earlier lines and movements keep theirs", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx, { cost: "25.00" });
      // An earlier line of the same product at 25.00 (on another job).
      const other = await newJob(tx);
      await addStock(tx, a.productId, 1);
      const earlier = await addPart(tx, { workOrderId: other.id, productId: a.productId });
      expect((await lineRow(tx, earlier.line_id)).cost).toBe("25.00");

      const lineId = await boughtOutside(tx, a.partId, { cost: "30.00" });
      expect(await productCost(tx, a.productId)).toBe("30.00");
      expect((await lineRow(tx, lineId)).cost).toBe("30.00");
      expect((await lineRow(tx, earlier.line_id)).cost).toBe("25.00");
      const snapshots = (await movements(tx, a.productId)).map((m) => [
        m.movement_type,
        m.unit_cost_snapshot,
      ]);
      expect(snapshots.slice(1)).toEqual([
        ["job_consumption", "25.00"],
        ["outside_purchase", "30.00"],
        ["job_consumption", "30.00"],
      ]);
      await assertLedgerConsistent(tx);
    });
  });

  it("a product with no cost: Fit from stock is refused, bought outside sets the cost", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx, { cost: null });
      expect(await productCost(tx, a.productId)).toBeNull();
      await failsWith(tx, () => fit(tx, a.partId), p0001("part_cost_missing"));
      const lineId = await boughtOutside(tx, a.partId, { cost: "30.00" });
      expect(await productCost(tx, a.productId)).toBe("30.00");
      expect(await lineRow(tx, lineId)).toMatchObject({ cost: "30.00", cost_pending: false });
      expect(await costChanges(tx, a.productId)).toHaveLength(1);
    });
  });

  it("the same cost changes nothing on the product; 0.00 is a cost (D24)", async () => {
    await inTransaction(conn, async (tx) => {
      const same = await approvedPart(tx);
      await boughtOutside(tx, same.partId, { cost: "70.00" });
      expect(await productCost(tx, same.productId)).toBe("70.00");
      expect(await costChanges(tx, same.productId)).toEqual([]);

      const zero = await approvedPart(tx);
      const lineId = await boughtOutside(tx, zero.partId, { cost: "0.00" });
      expect(await productCost(tx, zero.productId)).toBe("0.00");
      expect(await lineRow(tx, lineId)).toMatchObject({
        cost: "0.00",
        cost_pending: false,
        yield_total: "90.00",
      });
    });
  });

  it("replays on its line id and writes nothing; another line id or a stock fit is part_request_fitted", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      const lineId = await boughtOutside(tx, a.partId);
      const after = await footprint(tx, a.productId, a.job.id);
      expect(await boughtOutside(tx, a.partId, { lineId, cost: "99.00" })).toBe(lineId);
      expect(await footprint(tx, a.productId, a.job.id)).toEqual(after);
      await failsWith(tx, () => boughtOutside(tx, a.partId), p0001("part_request_fitted"));

      // A request fitted from stock is not replayed as bought outside.
      const s = await approvedPart(tx);
      const stockLine = await fit(tx, s.partId);
      await failsWith(
        tx,
        () => boughtOutside(tx, s.partId, { lineId: stockLine }),
        p0001("part_request_fitted"),
      );
      // A form id already used for another line records nothing.
      const t = await approvedPart(tx);
      const before = await footprint(tx, t.productId, t.job.id);
      await failsWith(
        tx,
        () => boughtOutside(tx, t.partId, { lineId: stockLine }),
        p0001("part_request_conflict"),
      );
      expect(await footprint(tx, t.productId, t.job.id)).toEqual(before);
    });
  });

  it("refuses ordered parts, services, unapproved items, closed jobs and bad values, writing nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const refused = async (
        productId: string,
        workOrderId: string,
        call: () => Promise<unknown>,
        expected: Record<string, unknown>,
      ) => {
        const before = await footprint(tx, productId, workOrderId);
        await failsWith(tx, call, expected);
        expect(await footprint(tx, productId, workOrderId)).toEqual(before);
      };

      // Ordered, not arrived and arrived: received in Purchasing, then fitted.
      const o = await approvedPart(tx);
      const poId = await orderParts(tx, [o.partId], o.supplierId, randomUUID(), false);
      await refused(
        o.productId,
        o.job.id,
        () => boughtOutside(tx, o.partId),
        p0001("part_request_ordered"),
      );
      await tx.query("select public.submit_purchase_order($1)", [poId]);
      const poLine = await scalar<string>(
        tx,
        "select id from public.purchase_order_lines where purchase_order_id = $1",
        [poId],
      );
      await receive(tx, { poId, lines: [{ lineId: poLine, quantity: 2 }] });
      await refused(
        o.productId,
        o.job.id,
        () => boughtOutside(tx, o.partId),
        p0001("part_request_ordered"),
      );

      // An approved service; proposed, quoted, declined and cancelled items.
      const q = await approved(tx);
      await refused(
        q.productId,
        q.job.id,
        () => boughtOutside(tx, q.serviceRequestId),
        p0001("outside_purchase_part_only"),
      );
      const proposed = await proposePart(tx, { workOrderId: q.job.id, productId: q.productId });
      await refused(
        q.productId,
        q.job.id,
        () => boughtOutside(tx, proposed),
        p0001("part_request_not_approved"),
      );
      const onQuote = await proposePart(tx, { workOrderId: q.job.id, productId: q.productId });
      const declinedId = await proposePart(tx, { workOrderId: q.job.id, productId: q.productId });
      const token = await sendQuote(tx, { workOrderId: q.job.id, requestIds: [onQuote] });
      await refused(
        q.productId,
        q.job.id,
        () => boughtOutside(tx, onQuote),
        p0001("part_request_not_approved"),
      );
      await tx.query(
        "select public.withdraw_quote(id) from public.quotes where work_order_id = $1 and status = 'open'",
        [q.job.id],
      );
      const token2 = await sendQuote(tx, { workOrderId: q.job.id, requestIds: [declinedId] });
      await actAs(tx, ANON);
      await answerAll(tx, token2, () => false);
      await actAs(tx, ADMIN);
      await refused(
        q.productId,
        q.job.id,
        () => boughtOutside(tx, declinedId),
        p0001("part_request_not_approved"),
      );
      await tx.query("select public.cancel_part_request($1, 'Not needed')", [proposed]);
      await refused(
        q.productId,
        q.job.id,
        () => boughtOutside(tx, proposed),
        p0001("part_request_not_approved"),
      );
      expect(token).toHaveLength(43);

      // A job completed (before the guard) with the part approved.
      const c = await approvedPart(tx);
      await beforeTheGuard(tx, () => completeJob(tx, c.job.id));
      await refused(
        c.productId,
        c.job.id,
        () => boughtOutside(tx, c.partId),
        p0001("work_order_locked"),
      );

      // Values.
      const v = await approvedPart(tx);
      for (const cost of ["-0.01", "100000.00"]) {
        await refused(
          v.productId,
          v.job.id,
          () => boughtOutside(tx, v.partId, { cost }),
          p0001("outside_purchase_cost_invalid"),
        );
      }
      await refused(
        v.productId,
        v.job.id,
        () => boughtOutside(tx, v.partId, { reference: "x".repeat(101) }),
        p0001("outside_purchase_reference_too_long"),
      );
      await refused(v.productId, v.job.id, () => boughtOutside(tx, v.partId, { cost: null }), {
        code: "22004",
      });
      await refused(v.productId, v.job.id, () => boughtOutside(tx, randomUUID()), {
        code: "P0002",
      });
      await ownerMode(tx);
      const inactive = await makeLocation(tx, { active: false });
      await actAs(tx, ADMIN);
      await refused(
        v.productId,
        v.job.id,
        () => boughtOutside(tx, v.partId, { locationId: inactive }),
        p0001("location_inactive"),
      );
      await ownerMode(tx);
      await tx.query("update public.products set active = false where id = $1", [v.productId]);
      await actAs(tx, ADMIN);
      await refused(
        v.productId,
        v.job.id,
        () => boughtOutside(tx, v.partId),
        p0001("product_inactive"),
      );
      await ownerMode(tx);
      await tx.query(
        "update public.products set active = true, archived_at = now() where id = $1",
        [v.productId],
      );
      await actAs(tx, ADMIN);
      await refused(
        v.productId,
        v.job.id,
        () => boughtOutside(tx, v.partId),
        p0001("product_archived"),
      );
      expect(await requestStatus(tx, v.partId)).toBe("approved");
    });
  });

  it("needs View costs or Manage purchasing; the permission is checked before anything is read", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => boughtOutside(tx, a.partId), { code: "42501" });
      // Even for a request that does not exist (nothing is learnt).
      await failsWith(tx, () => boughtOutside(tx, randomUUID()), { code: "42501" });
      // view_costs (mechanic1's exception) is enough ...
      await actAs(tx, MECHANIC1);
      await boughtOutside(tx, a.partId);
      expect(await requestStatus(tx, a.partId)).toBe("fitted");
      // ... and so is manage_purchasing.
      await actAs(tx, ADMIN);
      const b = await approvedPart(tx);
      await ownerMode(tx);
      await grantPurchasing(tx, STAFF.mechanic2);
      await actAs(tx, MECHANIC2);
      await boughtOutside(tx, b.partId, { cost: "31.00" });
      expect(await productCost(tx, b.productId)).toBe("31.00");
      // Anonymous callers have no EXECUTE.
      await actAs(tx, ANON);
      await failsWith(tx, () => boughtOutside(tx, b.partId), { code: "42501" });
    });
  });

  it("is not a purchase receipt or an adjustment: reconciliation, Today and reports stay clean", async () => {
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      const counts = () =>
        tx
          .query<{
            stock_adjustments: number;
            significant_stock_adjustments: number;
            parts_consumed_qty: number;
          }>(
            "select stock_adjustments, significant_stock_adjustments, parts_consumed_qty from public.daily_summary($1, $1)",
            [today],
          )
          .then((r) => r.rows[0]);
      const activity = () =>
        tx
          .query<{
            stock_adjustments: number;
            purchase_receipts: number;
            purchase_units_received: number;
            parts_consumed_qty: number;
          }>(
            "select stock_adjustments, purchase_receipts, purchase_units_received, parts_consumed_qty from public.report_activity($1, $1)",
            [today],
          )
          .then((r) => r.rows[0]);
      const adjustmentsToday = () =>
        scalar<number>(tx, "select count(*)::int from public.stock_adjustments_on($1)", [today]);

      const a = await approvedPart(tx);
      await ownerMode(tx);
      const location = await makeLocation(tx);
      await actAs(tx, ADMIN);
      const [summary, report, adjustments] = [
        await counts(),
        await activity(),
        await adjustmentsToday(),
      ];

      await boughtOutside(tx, a.partId, { locationId: location });
      // Stock reconciliation: nothing to report for the product (net 0).
      expect(
        (
          await tx.query("select * from public.report_stock_reconciliation(true, $1, 1000)", [
            a.productId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await tx.query("select * from public.operational_exceptions(200) where entity_id = $1", [
            a.productId,
          ])
        ).rows,
      ).toEqual([]);
      // Not an adjustment (D33), not a purchase receipt (D105, R-084); the
      // fit is a part used on a job.
      expect(await adjustmentsToday()).toBe(adjustments);
      expect(await counts()).toEqual({
        ...summary,
        parts_consumed_qty: summary.parts_consumed_qty + 2,
      });
      expect(await activity()).toEqual({
        ...report,
        parts_consumed_qty: report.parts_consumed_qty + 2,
      });
      await ownerMode(tx);
      expect(
        await scalar<boolean>(
          tx,
          "select private.is_significant_adjustment('outside_purchase', 100000, false, 9999999)",
        ),
      ).toBe(false);

      // The control: fitting from stock that is not there still goes below
      // zero (D23) and is reported.
      await actAs(tx, ADMIN);
      const control = await approvedPart(tx);
      await fit(tx, control.partId, randomUUID(), location);
      expect(await onHand(tx, control.productId, location)).toBe(-2);
      expect(
        (
          await tx.query("select issue from public.report_stock_reconciliation(true, $1, 1000)", [
            control.productId,
          ])
        ).rows,
      ).toEqual([{ issue: "negative_on_hand" }]);
      expect(
        (
          await tx.query(
            "select kind from public.operational_exceptions(200) where entity_id = $1",
            [control.productId],
          )
        ).rows,
      ).toEqual([{ kind: "negative_stock" }]);
    });
  });

  it("voiding the line puts the part back in stock at its cost; the receipt stays; the request is approved again (D160)", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      const lineId = await boughtOutside(tx, a.partId, { locationId: LOCATION.shopFloor });
      await voidLine(tx, lineId, "Fitted the wrong size");
      const rows = await movements(tx, a.productId);
      expect(rows.map((m) => [m.movement_type, m.quantity_delta, m.unit_cost_snapshot])).toEqual([
        ["outside_purchase", 2, "30.00"],
        ["job_consumption", -2, "30.00"],
        ["reversal", 2, "30.00"],
      ]);
      expect(await onHand(tx, a.productId)).toBe(2);
      // D160 (R-083): back to approved, its line and receipt link cleared
      // (tests/db/indent-unfit.test.ts covers the rest).
      expect(await requestRow(tx, a.partId)).toEqual({
        status: "approved",
        work_order_line_item_id: null,
        outside_purchase_movement_id: null,
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("backstops for every writer: the row's shape, D50 and the request's link", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      await ownerMode(tx);
      const insert = (o: {
        productId?: string;
        delta?: number;
        job?: string | null;
        cost?: string | null;
        consignmentItemId?: string | null;
      }) =>
        tx.query(
          `insert into public.inventory_movements
             (product_id, location_id, quantity_delta, movement_type, work_order_id, request_id,
              unit_cost_snapshot, consignment_item_id)
           values ($1, $2, $3, 'outside_purchase', $4, $5, $6, $7) returning id::text`,
          [
            o.productId ?? a.productId,
            LOCATION.shopFloor,
            o.delta ?? 1,
            o.job === undefined ? a.job.id : o.job,
            randomUUID(),
            o.cost === undefined ? "30.00" : o.cost,
            o.consignmentItemId ?? null,
          ],
        );
      const shape = { code: "23514", constraint: "inventory_movements_outside_purchase_shape" };
      await failsWith(tx, () => insert({ delta: -1 }), shape);
      await failsWith(tx, () => insert({ job: null }), shape);
      await failsWith(tx, () => insert({ cost: null }), shape);

      // D50: consigned stock never takes the type.
      const consignorId = await createConsignor(tx);
      await actAs(tx, ADMIN);
      const item = await intakeQuantity(tx, { consignorId, agreed: "10.00", quantity: 1 });
      await ownerMode(tx);
      await failsWith(
        tx,
        () => insert({ productId: item.product_id, consignmentItemId: item.item_id }),
        p0001("consignment_stock_adjust_blocked"),
      );

      // The request's link: only a fitted part, and one request per receipt.
      const movementId = (await insert({})).rows[0].id;
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.job_part_requests set outside_purchase_movement_id = $2 where id = $1",
            [a.partId, movementId],
          ),
        { code: "23514", constraint: "job_part_requests_outside_purchase_shape" },
      );
      await actAs(tx, ADMIN);
      const first = await boughtOutside(tx, a.partId);
      const b = await approvedPart(tx);
      const second = await fit(tx, b.partId);
      await ownerMode(tx);
      const linked = (await requestRow(tx, a.partId)).outside_purchase_movement_id;
      expect(first).not.toBe(second);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.job_part_requests set outside_purchase_movement_id = $2 where id = $1",
            [b.partId, linked],
          ),
        { code: "23505", constraint: "job_part_requests_outside_purchase_key" },
      );
    });
  });

  it("staff read the link, never the cost; cost holders read the cost", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      await boughtOutside(tx, a.partId);
      const movementId = (await requestRow(tx, a.partId)).outside_purchase_movement_id!;
      await actAs(tx, MECHANIC2);
      expect(
        await scalar<string>(
          tx,
          "select outside_purchase_movement_id::text from public.job_part_requests where id = $1",
          [a.partId],
        ),
      ).toBe(movementId);
      await failsWith(
        tx,
        () =>
          tx.query("select unit_cost_snapshot from public.inventory_movements where id = $1", [
            movementId,
          ]),
        { code: "42501" },
      );
      expect(
        (
          await tx.query("select * from public.inventory_movement_costs where movement_id = $1", [
            movementId,
          ])
        ).rows,
      ).toEqual([]);
      for (const claims of [MECHANIC1, ADMIN]) {
        await actAs(tx, claims);
        expect(
          await scalar<string>(
            tx,
            "select unit_cost_snapshot::text from public.inventory_movement_costs where movement_id = $1",
            [movementId],
          ),
        ).toBe("30.00");
      }
      // Customers and anon read nothing of it.
      await actAs(tx, ANON);
      await failsWith(
        tx,
        () => tx.query("select outside_purchase_movement_id from public.job_part_requests"),
        { code: "42501" },
      );
    });
  });

  describe.skipIf(!isolatedDatabase())("concurrency (committed)", () => {
    /** An approved part on an in-progress job, committed; returns its ids. */
    const committedApproved = async (options?: Parameters<typeof approvedPart>[1]) => {
      const c = await connect();
      const result = await committed(c, (tx) => approvedPart(tx, options));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      await c.end();
      return result.value;
    };

    it("bought outside against ordering the same part: one wins, never both", async () => {
      const observer = await connect();
      // Bought outside first; the order waits on the job and finds it fitted.
      const a = await committedApproved();
      const [first, second] = await race(
        observer,
        { as: ADMIN, run: (tx) => boughtOutside(tx, a.partId) },
        { as: ADMIN, run: (tx) => orderParts(tx, [a.partId], a.supplierId) },
      );
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, error: p0001("part_request_not_approved") });
      // Ordered first; buying outside waits and is refused.
      const b = await committedApproved();
      const [ordered, outside] = await race(
        observer,
        { as: ADMIN, run: (tx) => orderParts(tx, [b.partId], b.supplierId) },
        { as: ADMIN, run: (tx) => boughtOutside(tx, b.partId) },
      );
      expect(ordered.ok).toBe(true);
      expect(outside).toMatchObject({ ok: false, error: p0001("part_request_ordered") });
      for (const id of [a.partId, b.partId]) {
        const both = await scalar<number>(
          observer,
          `select count(*)::int from public.job_part_requests
            where id = $1 and purchase_order_line_id is not null and outside_purchase_movement_id is not null`,
          [id],
        );
        expect(both).toBe(0);
      }
    });

    it("bought outside against a stock fit of the same part: exactly one line", async () => {
      const observer = await connect();
      const a = await committedApproved();
      const [first, second] = await race(
        observer,
        { as: ADMIN, run: (tx) => fit(tx, a.partId) },
        { as: ADMIN, run: (tx) => boughtOutside(tx, a.partId) },
      );
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, error: p0001("part_request_fitted") });
      expect(
        await scalar<number>(
          observer,
          "select count(*)::int from public.work_order_line_items where work_order_id = $1",
          [a.job.id],
        ),
      ).toBe(1);
      expect(
        await scalar<number>(
          observer,
          "select count(*)::int from public.inventory_movements where product_id = $1 and movement_type = 'outside_purchase'",
          [a.productId],
        ),
      ).toBe(0);
    });

    it("bought outside at the stored cost against a direct cost edit: the receipt, the line and its consumption keep one cost", async () => {
      const observer = await connect();
      try {
        // The product page's edit (manage_inventory and view_costs, no stock lock).
        const editCost = (tx: pg.Client, productId: string, cost: string) =>
          tx.query("update public.products set default_direct_cost = $2 where id = $1", [
            productId,
            cost,
          ]);
        const costs = async (lineId: string, productId: string) => {
          const { rows } = await observer.query(
            `select
               (select m.unit_cost_snapshot::text from public.inventory_movements m
                 where m.request_id = $1 and m.movement_type = 'outside_purchase') as receipt,
               (select m.unit_cost_snapshot::text from public.inventory_movements m
                 where m.work_order_line_item_id = $1 and m.movement_type = 'job_consumption') as consumption,
               (select li.unit_direct_cost_snapshot::text from public.work_order_line_items li
                 where li.id = $1) as line,
               (select p.default_direct_cost::text from public.products p where p.id = $2) as product`,
            [lineId, productId],
          );
          return rows[0];
        };
        // The outside purchase first, at the cost already stored (nothing to
        // write): it still holds the products row, so the edit waits for it.
        const a = await committedApproved({ cost: "30.00" });
        const lineA = randomUUID();
        const [fitted, edited] = await race(
          observer,
          { as: ADMIN, run: (tx) => boughtOutside(tx, a.partId, { lineId: lineA, cost: "30.00" }) },
          { as: ADMIN, run: (tx) => editCost(tx, a.productId, "35.00") },
        );
        expect(fitted.ok).toBe(true);
        expect(edited.ok).toBe(true);
        expect(await costs(lineA, a.productId)).toEqual({
          receipt: "30.00",
          consumption: "30.00",
          line: "30.00",
          product: "35.00",
        });
        // The edit first: the outside purchase waits on the products row,
        // reads the edited cost and sets its own (the later purchase).
        const b = await committedApproved({ cost: "30.00" });
        const lineB = randomUUID();
        const [editedFirst, fittedAfter] = await race(
          observer,
          { as: ADMIN, run: (tx) => editCost(tx, b.productId, "35.00") },
          { as: ADMIN, run: (tx) => boughtOutside(tx, b.partId, { lineId: lineB, cost: "30.00" }) },
        );
        expect(editedFirst.ok).toBe(true);
        expect(fittedAfter.ok).toBe(true);
        expect(await costs(lineB, b.productId)).toEqual({
          receipt: "30.00",
          consumption: "30.00",
          line: "30.00",
          product: "30.00",
        });
      } finally {
        await observer.end();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Settle before closing (D149b, D149c)
// ---------------------------------------------------------------------------

describe("the settle guard (D149b, D149c(1))", () => {
  /** One approved part request on the job, inserted as the owner (no guard on inserts). */
  const insertApproved = async (tx: pg.Client, workOrderId: string, productId: string) => {
    await tx.query(
      `insert into public.job_part_requests
         (id, work_order_id, kind, product_id, description, quantity, unit_sale_price, currency, status)
       values ($1, $2, 'part', $3, 'Approved part', 1, '10.00', 'SGD', 'approved')`,
      [randomUUID(), workOrderId, productId],
    );
  };

  it("set_work_order_status: every allowed move into a status that is not open is refused (110 pairs)", async () => {
    await inTransaction(conn, async (tx) => {
      const productId = await makeProduct(tx);
      let checked = 0;
      let refused = 0;
      for (const from of WORK_ORDER_STATUSES) {
        const job = await newJob(tx, MECHANIC2);
        await walkTo(tx, job.id, from);
        await ownerMode(tx);
        await insertApproved(tx, job.id, productId);
        await actAs(tx, MECHANIC2);
        for (const to of WORK_ORDER_STATUSES) {
          if (to === from) continue;
          checked++;
          const rule = transitionRule(from, to);
          if (rule === null) {
            await failsWith(
              tx,
              () => setStatus(tx, job.id, to, "A reason"),
              p0001("work_order_transition_invalid"),
            );
            continue;
          }
          if (rule === "reason_required") {
            await failsWith(tx, () => setStatus(tx, job.id, to, "   "), p0001("reason_required"));
          }
          if (isOpenStatus(to)) {
            expect((await tryAndUndo(tx, () => setStatus(tx, job.id, to, "A reason"))).status).toBe(
              to,
            );
          } else {
            refused++;
            await failsWith(tx, () => setStatus(tx, job.id, to, "A reason"), UNSETTLED);
          }
        }
      }
      expect(checked).toBe(110);
      // Into completed (from in_progress, paused), ready (from completed),
      // collected (from completed, ready) and cancelled (from the 7 open
      // statuses).
      expect(refused).toBe(2 + 1 + 2 + 7);
    });
  });

  it("the trigger refuses the same moves for direct writers (110 pairs)", async () => {
    await inTransaction(conn, async (tx) => {
      const productId = await makeProduct(tx);
      const direct = (id: string, to: string) =>
        tx.query("update public.work_orders set status = $2 where id = $1 returning status::text", [
          id,
          to,
        ]);
      let checked = 0;
      for (const from of WORK_ORDER_STATUSES) {
        const job = await newJob(tx, MECHANIC2);
        await walkTo(tx, job.id, from);
        await ownerMode(tx);
        await insertApproved(tx, job.id, productId);
        await tx.query("select private.set_change_reason('A reason')");
        for (const to of WORK_ORDER_STATUSES) {
          if (to === from) continue;
          checked++;
          const rule = transitionRule(from, to);
          if (rule === null) {
            await failsWith(tx, () => direct(job.id, to), p0001("work_order_transition_invalid"));
          } else if (isOpenStatus(to)) {
            expect((await tryAndUndo(tx, () => direct(job.id, to))).rows[0].status).toBe(to);
          } else {
            await failsWith(tx, () => direct(job.id, to), UNSETTLED);
          }
        }
        await tx.query("select private.set_change_reason(null)");
      }
      expect(checked).toBe(110);
    });
  });

  it("only approved and ordered requests block Complete, parts or services, arrived or not", async () => {
    await inTransaction(conn, async (tx) => {
      const statuses: PartRequestStatus[] = [
        "proposed",
        "quoted",
        "approved",
        "declined",
        "ordered",
        "fitted",
        "cancelled",
      ];
      const build = async (status: PartRequestStatus | "arrived" | "approved_service") => {
        const s = await setup(tx);
        const partId = await proposePart(tx, { workOrderId: s.job.id, productId: s.productId });
        const serviceId = await proposeService(tx, {
          workOrderId: s.job.id,
          serviceId: s.serviceId,
        });
        const kind = status === "approved_service" ? serviceId : partId;
        const other = kind === partId ? serviceId : partId;
        await tx.query("select public.cancel_part_request($1, 'Not needed')", [other]);
        if (status === "cancelled") {
          await tx.query("select public.cancel_part_request($1, 'Not needed')", [kind]);
        } else if (status !== "proposed") {
          const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [kind] });
          if (status !== "quoted") {
            await actAs(tx, ANON);
            await answerAll(tx, token, () => status !== "declined");
            await actAs(tx, ADMIN);
          }
          if (status === "ordered" || status === "arrived") {
            const poId = await orderParts(tx, [kind], s.supplierId, randomUUID(), false);
            if (status === "arrived") {
              await tx.query("select public.submit_purchase_order($1)", [poId]);
              const lineId = await scalar<string>(
                tx,
                "select id from public.purchase_order_lines where purchase_order_id = $1",
                [poId],
              );
              await receive(tx, { poId, lines: [{ lineId, quantity: 1 }] });
            }
          }
          if (status === "fitted") await fit(tx, kind);
        }
        await setStatus(tx, s.job.id, "in_progress");
        return { job: s.job, requestId: kind };
      };
      for (const status of [...statuses, "arrived", "approved_service"] as const) {
        const b = await build(status);
        const blocks = status === "arrived" || status === "approved_service" || isUnfitted(status);
        if (blocks) {
          await failsWith(tx, () => setStatus(tx, b.job.id, "completed"), {
            ...UNSETTLED,
            detail: "Fit or cancel each approved or ordered item first.",
          });
        } else {
          expect((await tryAndUndo(tx, () => setStatus(tx, b.job.id, "completed"))).status).toBe(
            "completed",
          );
        }
      }
    });
  });

  it("reports after the transition, reason and live-line checks; reopen and Waiting on parts are never blocked", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await approved(tx);
      // A live line and an approved item: work_order_has_lines first.
      await fit(tx, q.serviceRequestId);
      await failsWith(
        tx,
        () => setStatus(tx, q.job.id, "cancelled", "Customer withdrew"),
        p0001("work_order_has_lines"),
      );
      // A blank reason: reason_required first.
      await failsWith(
        tx,
        () => setStatus(tx, q.job.id, "cancelled", " "),
        p0001("reason_required"),
      );
      // Cancel without lines: the cancel sentence.
      const c = await approved(tx);
      await failsWith(tx, () => setStatus(tx, c.job.id, "cancelled", "Customer withdrew"), {
        ...UNSETTLED,
        detail: "Cancel the job's approved and ordered items before cancelling it.",
      });
      // Waiting on parts and back: open statuses.
      await setStatus(tx, c.job.id, "awaiting_parts");
      await setStatus(tx, c.job.id, "in_progress");
      // Ordering moves the job to Waiting on parts as before.
      await orderParts(tx, [c.partId], c.supplierId, randomUUID(), true);
      expect((await workOrder(tx, c.job.id)).status).toBe("awaiting_parts");
      // A job completed before the guard: invalid moves still report as
      // invalid, and the reopen works.
      const old = await approved(tx);
      await beforeTheGuard(tx, () => completeJob(tx, old.job.id));
      await failsWith(
        tx,
        () => setStatus(tx, old.job.id, "cancelled", "Too late"),
        p0001("work_order_transition_invalid"),
      );
      expect((await reopenJob(tx, old.job.id)).status).toBe("in_progress");
    });
  });

  it("a job completed before the guard: Ready and Collected wait until each item is fitted or cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await approved(tx);
      await beforeTheGuard(tx, () => completeJob(tx, q.job.id));
      await failsWith(tx, () => setStatus(tx, q.job.id, "ready_for_collection"), UNSETTLED);
      await failsWith(tx, () => setStatus(tx, q.job.id, "collected"), UNSETTLED);
      // Any staff member cancels them there (the job is not closed).
      await actAs(tx, MECHANIC2);
      await tx.query("select public.cancel_part_request($1, 'Customer no longer wants it')", [
        q.partId,
      ]);
      await failsWith(tx, () => setStatus(tx, q.job.id, "collected"), UNSETTLED);
      await tx.query("select public.cancel_part_request($1, 'Customer no longer wants it')", [
        q.serviceRequestId,
      ]);
      expect((await setStatus(tx, q.job.id, "collected")).status).toBe("collected");

      // Or reopen, fit, and complete.
      await actAs(tx, ADMIN);
      const r = await approved(tx);
      await beforeTheGuard(tx, () => completeJob(tx, r.job.id));
      await reopenJob(tx, r.job.id);
      await fit(tx, r.partId);
      await fit(tx, r.serviceRequestId);
      expect((await setStatus(tx, r.job.id, "completed")).status).toBe("completed");
    });
  });

  it("a job collected before the guard (J-000002): D149's admin or manager cancel still closes its item", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await approved(tx);
      await beforeTheGuard(tx, () => walkTo(tx, q.job.id, "collected"));
      await actAs(tx, MANAGER);
      await tx.query("select public.cancel_part_request($1, 'Live test: never supplied')", [
        q.partId,
      ]);
      await tx.query("select public.cancel_part_request($1, 'Live test: never supplied')", [
        q.serviceRequestId,
      ]);
      expect(await requestStatus(tx, q.partId)).toBe("cancelled");
      expect((await workOrder(tx, q.job.id)).status).toBe("collected");
    });
  });
});

describe("an open quote when its job leaves the open statuses (D149c(2), (6))", () => {
  it("Complete withdraws it after the status entry: the link says so and the answer is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      const decisions = (await quoteByToken(tx, q.token))!.items!.map((i) => ({
        item_id: i.id,
        approve: true,
      }));
      await actAs(tx, MECHANIC2);
      await completeJob(tx, q.job.id);
      expect(await quoteOf(tx, q.job.id)).toMatchObject({
        status: "withdrawn",
        withdrawn_by: STAFF.mechanic2,
      });
      expect(await requestStatus(tx, q.partId)).toBe("proposed");
      expect(await requestStatus(tx, q.serviceRequestId)).toBe("proposed");
      await ownerMode(tx);
      const tail = (await events(tx, q.job.id)).slice(-2);
      expect(tail.map((e) => [e.event_type, e.actor_staff_id])).toEqual([
        ["completed", STAFF.mechanic2],
        ["quote_withdrawn", STAFF.mechanic2],
      ]);
      await actAs(tx, ANON);
      expect(await quoteByToken(tx, q.token)).toEqual({
        status: "withdrawn",
        job_number: q.job.job_number,
      });
      await failsWith(tx, () => answer(tx, q.token, decisions), p0001("quote_not_open"));

      // A reopen leaves it withdrawn; the items can be quoted again.
      await actAs(tx, ADMIN);
      await reopenJob(tx, q.job.id);
      expect((await quoteOf(tx, q.job.id)).status).toBe("withdrawn");
      await sendQuote(tx, { workOrderId: q.job.id, requestIds: [q.partId] });
      expect((await quoteOf(tx, q.job.id)).status).toBe("open");
    });
  });

  it("Cancel job withdraws it too; answered quotes and jobs without one are untouched; an owner write has no actor", async () => {
    await inTransaction(conn, async (tx) => {
      const c = await quoted(tx);
      await setStatus(tx, c.job.id, "cancelled", "Customer withdrew");
      expect(await quoteOf(tx, c.job.id)).toMatchObject({
        status: "withdrawn",
        withdrawn_by: STAFF.admin,
      });

      // Answered (everything declined): Complete leaves it answered.
      const a = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, a.token, () => false);
      await actAs(tx, ADMIN);
      await completeJob(tx, a.job.id);
      expect((await quoteOf(tx, a.job.id)).status).toBe("answered");
      expect(await eventTypes(tx, a.job.id)).not.toContain("quote_withdrawn");

      // No quote: no entry.
      const n = await newJob(tx);
      await completeJob(tx, n.id);
      expect(await eventTypes(tx, n.id)).not.toContain("quote_withdrawn");

      // A direct owner write (no session): withdrawn, with no actor.
      const o = await quoted(tx);
      await setStatus(tx, o.job.id, "in_progress");
      await ownerMode(tx);
      await tx.query("select set_config('request.jwt.claims', '', true)");
      await tx.query("update public.work_orders set status = 'completed' where id = $1", [
        o.job.id,
      ]);
      expect(await quoteOf(tx, o.job.id)).toMatchObject({
        status: "withdrawn",
        withdrawn_by: null,
      });
    });
  });

  it("the one-off in 20261014000900 withdraws quotes left open on jobs already not open", async () => {
    await inTransaction(conn, async (tx) => {
      // Two jobs closed before the guard with their quote open, one open job.
      const done = await quoted(tx);
      await beforeTheGuard(tx, () => completeJob(tx, done.job.id));
      const collected = await quoted(tx);
      await beforeTheGuard(tx, () => walkTo(tx, collected.job.id, "collected"));
      const open = await quoted(tx);
      expect((await quoteOf(tx, done.job.id)).status).toBe("open");

      // The migration's own block, run again as the owner.
      const sql = readFileSync(
        path.join(
          process.cwd(),
          "supabase/migrations/20261014000900_indent_settle_and_outside_purchase.sql",
        ),
        "utf8",
      );
      const start = sql.indexOf("do $$");
      const end = sql.indexOf("end;\n$$;", start) + "end;\n$$;".length;
      expect(start).toBeGreaterThan(0);
      await ownerMode(tx);
      await tx.query("select set_config('request.jwt.claims', '', true)");
      await tx.query(sql.slice(start, end));

      for (const job of [done, collected]) {
        expect(await quoteOf(tx, job.job.id)).toMatchObject({
          status: "withdrawn",
          withdrawn_by: null,
        });
        expect(await requestStatus(tx, job.partId)).toBe("proposed");
      }
      expect((await quoteOf(tx, open.job.id)).status).toBe("open");
      expect((await workOrder(tx, collected.job.id)).status).toBe("collected");
    });
  });

  it.skipIf(!isolatedDatabase())(
    "the customer's answer against Complete: never a completed job with an approved item",
    async () => {
      const observer = await connect();
      const ready = async () => {
        const c = await connect();
        const result = await committed(c, async (tx) => {
          const q = await quoted(tx);
          await setStatus(tx, q.job.id, "in_progress");
          return q;
        });
        await c.end();
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value;
      };
      // The answer first: Complete waits, then is refused.
      const a = await ready();
      const [answered, completed] = await race(
        observer,
        { as: ANON, run: (tx) => answerAll(tx, a.token) },
        { as: ADMIN, run: (tx) => setStatus(tx, a.job.id, "completed") },
      );
      expect(answered.ok).toBe(true);
      expect(completed).toMatchObject({ ok: false, error: UNSETTLED });
      // Complete first: the answer waits, then finds the quote withdrawn.
      const b = await ready();
      const decisions = await inTransaction(observer, async (tx) => {
        await actAs(tx, ANON);
        return (await quoteByToken(tx, b.token))!.items!.map((i) => ({
          item_id: i.id,
          approve: true,
        }));
      });
      const [done, refused] = await race(
        observer,
        { as: ADMIN, run: (tx) => setStatus(tx, b.job.id, "completed") },
        { as: ANON, run: (tx) => answer(tx, b.token, decisions) },
      );
      expect(done.ok).toBe(true);
      expect(refused).toMatchObject({ ok: false, error: p0001("quote_not_open") });
      for (const job of [a.job.id, b.job.id]) {
        expect(
          await scalar<number>(
            observer,
            `select count(*)::int from public.work_orders w
               join public.job_part_requests r on r.work_order_id = w.id
              where w.id = $1 and w.status = 'completed' and r.status in ('approved', 'ordered')`,
            [job],
          ),
        ).toBe(0);
      }
    },
  );
});
