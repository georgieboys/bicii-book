/**
 * Voiding a fitted indent line undoes the fit (PLAN D160, owner decision
 * 2026-10-15 SGT; ADR-024 amendment "D160"; DATA-MODEL §5 "Voiding a fitted
 * indent line"; RISKS R-083), migrations 20261014001000 (the timeline type
 * part_request_unfitted) and 20261014001100:
 *
 *   the un-fit         when a job line that a fitted request points at is
 *                      voided, by any writer, the request goes back to where
 *                      it was before Fit: ordered when it is on a purchase
 *                      order line, else approved. Its line, fitted_at,
 *                      fitted_by and outside_purchase_movement_id are
 *                      cleared and part_request_unfitted is recorded; the
 *                      void's own stock reversal, the totals and the
 *                      outside_purchase receipt are what they were before.
 *   the live-line guard  a request is never linked to a voided line, so a
 *                      stale Fit replay with the voided line's id is refused.
 *   the one-off        requests left fitted on a voided line before the
 *                      migration are un-fitted once, with a NOTICE.
 *
 * D149b's settle guard, work_order_unfitted_requests, the quote page and
 * payment_issues then see the item again, unchanged. Rolled-back
 * transactions throughout; the races commit, so they run only on this
 * file's clone.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import { sessionObject, stripeEvent, stripeWebhookHeaders } from "../fixtures/stripe";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  answerAll,
  beforeTheGuard,
  fit,
  proposePart,
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
  movements,
  onHand,
  readAsOwner,
  reopenJob,
} from "./inventory-fixtures";
import { race } from "./lock-race";
import { productCost, receive } from "./purchasing-fixtures";
import {
  addManualLine,
  addServiceLine,
  events,
  failsWith,
  ownerMode,
  setStatus,
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
const SERVICE: Claims = { role: "service_role" };
const UNSETTLED = p0001("work_order_has_unfitted_requests");
const MIGRATION = "supabase/migrations/20261014001100_indent_unfit_on_void.sql";
const TRIGGER = "work_order_line_items_unfit_part_request";
/** fit()'s line id type (randomUUID's), for ids read back as strings. */
type Uuid = ReturnType<typeof randomUUID>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RequestRow = {
  status: string;
  description: string;
  work_order_line_item_id: string | null;
  outside_purchase_movement_id: string | null;
  purchase_order_line_id: string | null;
  fitted_at: Date | null;
  fitted_by: string | null;
  ordered_at: Date | null;
  updated_at: Date;
};

/** The request as the owner reads it. */
const requestRow = (tx: pg.Client, id: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<RequestRow>(
      `select status::text, description, work_order_line_item_id,
              outside_purchase_movement_id::text, purchase_order_line_id, fitted_at, fitted_by,
              ordered_at, updated_at
         from public.job_part_requests where id = $1`,
      [id],
    );
    return rows[0];
  });

/** The job's part_request_unfitted entries, oldest first (read as the owner). */
const unfitEvents = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () =>
    (await events(tx, workOrderId))
      .filter((e) => e.event_type === "part_request_unfitted")
      .map((e) => ({ payload: e.payload, actor: e.actor_staff_id })),
  );

const eventCount = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => (await events(tx, workOrderId)).length);

/** public.work_order_unfitted_requests for one job (as whoever `tx` is), or null. */
const unfittedMemo = async (tx: pg.Client, workOrderId: string) => {
  const { rows } = await tx.query<{ item_count: number; quoted_total: string }>(
    `select item_count, quoted_total::text from public.work_order_unfitted_requests
      where work_order_id = $1`,
    [workOrderId],
  );
  return rows[0] ?? null;
};

/** The job's live-lines total and count (work_order_totals). */
const totals = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ sale_total: string; line_count: number }>(
      `select sale_total::text, line_count from public.work_order_totals where work_order_id = $1`,
      [workOrderId],
    );
    return rows[0];
  });

/** A job line's sale and cost, as the owner reads it. */
const lineRow = (tx: pg.Client, lineId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      sale_total: string;
      cost: string;
      cost_total: string;
      voided: boolean;
    }>(
      `select sale_total::text, unit_direct_cost_snapshot::text as cost, cost_total::text,
              voided_at is not null as voided
         from public.work_order_line_items where id = $1`,
      [lineId],
    );
    return rows[0];
  });

/** public.fit_part_bought_outside as whoever `tx` is; returns the line id. */
const boughtOutside = (
  tx: pg.Client,
  requestId: string,
  { lineId = randomUUID() as string, cost = "30.00", locationId = LOCATION.shopFloor } = {},
) =>
  scalar<string>(tx, "select public.fit_part_bought_outside($1, $2, $3, $4, null)", [
    requestId,
    lineId,
    cost,
    locationId,
  ]);

const cancelRequest = (tx: pg.Client, requestId: string, reason = "Customer changed their mind") =>
  tx.query("select public.cancel_part_request($1, $2)", [requestId, reason]);

/** Sets the shop's deposit percent as the owner, then acts as ADMIN again. */
async function withPercent(tx: pg.Client, percent: number): Promise<void> {
  await ownerMode(tx);
  await tx.query("update public.shop_settings set indent_deposit_percent = $1 where id = 1", [
    percent,
  ]);
  await actAs(tx, ADMIN);
}

/**
 * setup() plus one part (2 x 45.00) proposed, quoted and approved by the
 * link; acting as ADMIN. Its product costs 70.00 and has no stock.
 */
async function approvedPart(tx: pg.Client) {
  const s = await setup(tx);
  const partId = await proposePart(tx, {
    workOrderId: s.job.id,
    productId: s.productId,
    quantity: 2,
    price: "45.00",
    cost: "28.00",
  });
  const token = await sendQuote(tx, { workOrderId: s.job.id, requestIds: [partId] });
  await actAs(tx, ANON);
  await answerAll(tx, token);
  await actAs(tx, ADMIN);
  return { ...s, partId, token };
}

/** approvedPart() with 2 in stock at the shop floor, fitted from there; acting as ADMIN. */
async function fittedFromStock(tx: pg.Client) {
  const a = await approvedPart(tx);
  await addStock(tx, a.productId, 2);
  const lineId = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
  return { ...a, lineId };
}

/** The job's newest quote id (read as the owner). */
const quoteIdOf = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, () =>
    scalar<string>(
      tx,
      "select id from public.quotes where work_order_id = $1 order by sent_at desc limit 1",
      [workOrderId],
    ),
  );

/** The deposit object the quote page receives (as anon); leaves `tx` acting as ADMIN. */
async function pageDeposit(tx: pg.Client, token: string) {
  await actAs(tx, ANON);
  const deposit = await scalar<{
    status: string;
    parts_ordered?: boolean;
    job_closed?: boolean;
  } | null>(tx, "select public.quote_by_token($1) -> 'deposit'", [token]);
  await actAs(tx, ADMIN);
  return deposit;
}

const tag = () => randomUUID().replace(/-/g, "").slice(0, 24);

/**
 * Pays the deposit of the job's answered quote through Stripe's word only
 * (Phase 14): Checkout prepared and recorded as the service role, then
 * checkout.session.completed. Returns the payment id; leaves `tx` as ADMIN.
 */
async function payDeposit(tx: pg.Client, a: { token: string; job: { id: string } }) {
  const quoteId = await quoteIdOf(tx, a.job.id);
  await actAs(tx, SERVICE);
  const { rows: prepared } = await tx.query<{ outcome: string; payment_id: string; cents: number }>(
    "select outcome, payment_id, amount_cents::int as cents from public.prepare_deposit_checkout($1)",
    [a.token],
  );
  expect(prepared[0].outcome).toBe("create");
  const { payment_id: paymentId, cents } = prepared[0];
  const session = {
    id: `cs_test_${tag()}`,
    paymentId,
    workOrderId: a.job.id,
    quoteId,
    amountCents: cents,
  };
  const { rows: recorded } = await tx.query<{ outcome: string }>(
    "select outcome from public.record_deposit_checkout($1, $2, $3::jsonb)",
    [
      paymentId,
      quoteId,
      JSON.stringify(sessionObject({ ...session, status: "open", paymentStatus: "unpaid" })),
    ],
  );
  expect(recorded[0].outcome).toBe("created");
  const raw = JSON.stringify(
    stripeEvent({
      id: `evt_${tag()}`,
      type: "checkout.session.completed",
      object: sessionObject({ ...session, paymentIntent: `pi_${tag()}` }),
    }),
  );
  await tx.query(
    `select public.record_stripe_event($1::jsonb, $2::jsonb, $3, $4,
                                       null::public.stripe_rejection_reason, $5)`,
    [
      raw,
      JSON.stringify(stripeWebhookHeaders({ raw })),
      createHash("sha256").update(raw, "utf8").digest("hex"),
      Buffer.byteLength(raw),
      `corr-${tag()}`,
    ],
  );
  await actAs(tx, ADMIN);
  return paymentId;
}

/** The payment's issues with their words (read as the owner). */
const issueRows = (tx: pg.Client, paymentId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ issue: string; message: string }>(
      "select issue, message from public.payment_issues where payment_id = $1 order by issue",
      [paymentId],
    );
    return rows;
  });

/** Orders the request's part (2) and submits the purchase order; returns it and its line. */
async function orderPart(
  tx: pg.Client,
  a: { partId: string; supplierId: string },
  overrideReason: string | null = null,
) {
  const poId = await scalar<string>(
    tx,
    "select public.order_part_requests($1, $2, $3, false, $4)",
    [[a.partId], a.supplierId, randomUUID(), overrideReason],
  );
  await tx.query("select public.submit_purchase_order($1)", [poId]);
  const poLine = await scalar<string>(
    tx,
    "select id from public.purchase_order_lines where purchase_order_id = $1",
    [poId],
  );
  return { poId, poLine };
}

/** orderPart(), then receives the 2 at `locationId`; returns the PO line. */
async function orderAndReceive(
  tx: pg.Client,
  a: { partId: string; supplierId: string },
  locationId: string,
  overrideReason: string | null = null,
) {
  const { poId, poLine } = await orderPart(tx, a, overrideReason);
  await receive(tx, { poId, lines: [{ lineId: poLine, quantity: 2, locationId }] });
  return poLine;
}

/** The request's arrival as part_request_arrivals reports it (as whoever `tx` is). */
const arrivalOf = async (tx: pg.Client, workOrderId: string, requestId: string) =>
  (
    await tx.query<{ arrived: boolean; location_id: string | null }>(
      "select arrived, location_id from public.part_request_arrivals($1) where request_id = $2",
      [workOrderId, requestId],
    )
  ).rows;

/** indent_reservations for a product (as whoever `tx` is). */
const reservationsOf = async (tx: pg.Client, productId: string) =>
  (
    await tx.query<{ work_order_id: string; quantity: number }>(
      "select work_order_id, quantity from public.indent_reservations($1)",
      [productId],
    )
  ).rows;

/**
 * Voids a line by a direct UPDATE (no void_line: no checks, no stock
 * reversal), as whoever `tx` is; the owner in these tests.
 */
const directVoid = (tx: pg.Client, lineId: string, voidedBy: string | null) =>
  tx.query(
    `update public.work_order_line_items
        set voided_at = clock_timestamp(), voided_by = $2, void_reason = 'Voided directly'
      where id = $1`,
    [lineId, voidedBy],
  );

/** Runs `fn` with no request.jwt.claims (no session: a migration or a script), then restores them. */
async function withoutSession<T>(tx: pg.Client, fn: () => Promise<T>): Promise<T> {
  const claims = await scalar<string | null>(
    tx,
    "select current_setting('request.jwt.claims', true)",
  );
  await tx.query("select set_config('request.jwt.claims', '', true)");
  try {
    return await fn();
  } finally {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [claims ?? ""]);
  }
}

/** Runs `fn` with D160's trigger off, to build the state of a void before 20261014001100. */
async function beforeD160<T>(tx: pg.Client, fn: () => Promise<T>): Promise<T> {
  const toggle = async (on: boolean) => {
    const role = await scalar<string>(tx, "select current_user::text");
    await tx.query("reset role");
    const owner = await scalar<string>(tx, "select current_user::text");
    await tx.query(
      `alter table public.work_order_line_items ${on ? "enable" : "disable"} trigger ${TRIGGER}`,
    );
    if (role !== owner) await tx.query(`set local role ${role}`);
  };
  await toggle(false);
  const result = await fn();
  await toggle(true);
  return result;
}

/** The migration's one-off block, run again as the owner with no session; returns its NOTICEs. */
async function runOneOff(tx: pg.Client): Promise<string[]> {
  const sql = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  const start = sql.indexOf("do $$");
  const end = sql.indexOf("end;\n$$;", start) + "end;\n$$;".length;
  expect(start).toBeGreaterThan(0);
  const role = await scalar<string>(tx, "select current_user::text");
  await ownerMode(tx);
  const claims = await scalar<string>(tx, "select current_setting('request.jwt.claims', true)");
  await tx.query("select set_config('request.jwt.claims', '', true)");
  const notices: string[] = [];
  const listen = (n: { message?: string }) => notices.push(n.message ?? "");
  tx.on("notice", listen);
  try {
    await tx.query(sql.slice(start, end));
  } finally {
    tx.off("notice", listen);
  }
  await tx.query("select set_config('request.jwt.claims', $1, true)", [claims ?? ""]);
  if (role !== (await scalar<string>(tx, "select current_user::text"))) {
    await tx.query(`set local role ${role}`);
  }
  return notices;
}

// ---------------------------------------------------------------------------
// (a) The un-fit (D160)
// ---------------------------------------------------------------------------

describe("voiding a fitted indent line (D160)", () => {
  it("a part fitted from stock goes back to approved, unlinked, with a timeline entry; the void's reversal is the ordinary one", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "fitted",
        work_order_line_item_id: a.lineId,
        fitted_by: STAFF.admin,
      });
      expect(await totals(tx, a.job.id)).toEqual({ sale_total: "90.00", line_count: 1 });
      const before = await eventCount(tx, a.job.id);

      // Any active staff member may void a line (no permission needed).
      await actAs(tx, MECHANIC2);
      expect(await voidLine(tx, a.lineId, "Wrong size")).toBe(a.lineId);

      const row = await requestRow(tx, a.partId);
      expect(row).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
        outside_purchase_movement_id: null,
        purchase_order_line_id: null,
        fitted_at: null,
        fitted_by: null,
      });

      // The stock: the void's ordinary linked reversal at the line's cost.
      const rows = await movements(tx, a.productId);
      expect(
        rows.slice(1).map((m) => [m.movement_type, m.quantity_delta, m.unit_cost_snapshot]),
      ).toEqual([
        ["job_consumption", -2, "70.00"],
        ["reversal", 2, "70.00"],
      ]);
      expect(rows[2]).toMatchObject({
        reversal_of_id: rows[1].id,
        work_order_line_item_id: a.lineId,
      });
      expect(await onHand(tx, a.productId)).toBe(2);
      expect(await totals(tx, a.job.id)).toEqual({ sale_total: "0.00", line_count: 0 });
      expect((await lineRow(tx, a.lineId)).voided).toBe(true);

      // The timeline: the void, the request back, then the stock.
      const timeline = await readAsOwner(tx, () => events(tx, a.job.id));
      expect(timeline.slice(before).map((e) => e.event_type)).toEqual([
        "line_voided",
        "part_request_unfitted",
        "stock_reversed",
      ]);
      expect(await unfitEvents(tx, a.job.id)).toEqual([
        {
          payload: {
            request_id: a.partId,
            line_id: a.lineId,
            description: row.description,
            quantity: 2,
            status: "approved",
            bought_outside: false,
          },
          actor: STAFF.mechanic2,
        },
      ]);
      // Never a price or a cost.
      expect(JSON.stringify(timeline.slice(before).map((e) => e.payload))).not.toMatch(
        /45\.00|90\.00|70\.00|28\.00/,
      );
      await assertLedgerConsistent(tx);
    });
  });

  it("after the void it can be fitted again from stock, which bills it again, or cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      await voidLine(tx, a.lineId, "Wrong size");
      expect(await unfittedMemo(tx, a.job.id)).toEqual({ item_count: 1, quoted_total: "90.00" });

      // Fit again: a new line from stock, billed again.
      await addStock(tx, a.productId, 2);
      const again = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      expect(again).not.toBe(a.lineId);
      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "fitted",
        work_order_line_item_id: again,
        fitted_by: STAFF.admin,
      });
      expect(
        (await movements(tx, a.productId)).map((m) => [m.movement_type, m.quantity_delta]).slice(1),
      ).toEqual([
        ["job_consumption", -2],
        ["reversal", 2],
        ["stock_adjustment", 2],
        ["job_consumption", -2],
      ]);
      expect(await onHand(tx, a.productId)).toBe(2);
      expect(await totals(tx, a.job.id)).toEqual({ sale_total: "90.00", line_count: 1 });
      expect(await lineRow(tx, again)).toMatchObject({ sale_total: "90.00", cost: "70.00" });
      expect(await unfittedMemo(tx, a.job.id)).toBeNull();

      // Void the new line too, then cancel the item: the job completes.
      await voidLine(tx, again, "Customer changed their mind");
      expect((await requestRow(tx, a.partId)).status).toBe("approved");
      await cancelRequest(tx, a.partId);
      expect((await requestRow(tx, a.partId)).status).toBe("cancelled");
      expect(await unfittedMemo(tx, a.job.id)).toBeNull();
      expect((await completeJob(tx, a.job.id)).status).toBe("completed");
      expect(await unfitEvents(tx, a.job.id)).toHaveLength(2);
      await assertLedgerConsistent(tx);
    });
  });

  it("an ordered part goes back to ordered, still on its purchase order and arrived; Fit takes it from where it was received", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      await ownerMode(tx);
      const location = await makeLocation(tx);
      await actAs(tx, ADMIN);
      const poLine = await orderAndReceive(tx, a, location);
      const ordered = await requestRow(tx, a.partId);
      expect(ordered).toMatchObject({ status: "ordered", purchase_order_line_id: poLine });

      const lineId = await fit(tx, a.partId);
      expect(await onHand(tx, a.productId, location)).toBe(0);
      await voidLine(tx, lineId, "Damaged while fitting");

      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "ordered",
        purchase_order_line_id: poLine,
        ordered_at: ordered.ordered_at,
        work_order_line_item_id: null,
        fitted_at: null,
        fitted_by: null,
      });
      expect(await onHand(tx, a.productId, location)).toBe(2);
      // Arrived again, where it was received, and reserved for the job (D146).
      expect(await arrivalOf(tx, a.job.id, a.partId)).toEqual([
        { arrived: true, location_id: location },
      ]);
      expect(await reservationsOf(tx, a.productId)).toEqual([
        { work_order_id: a.job.id, quantity: 2 },
      ]);
      expect((await unfitEvents(tx, a.job.id)).map((e) => e.payload.status)).toEqual(["ordered"]);

      // Fit again: from the receiving location, and no longer reserved.
      const again = await fit(tx, a.partId);
      expect((await requestRow(tx, a.partId)).work_order_line_item_id).toBe(again);
      expect(await onHand(tx, a.productId, location)).toBe(0);
      expect(await reservationsOf(tx, a.productId)).toEqual([]);
      await assertLedgerConsistent(tx);
    });
  });

  it("an ordered part fitted before its order was received goes back to ordered and not arrived; arrived and reserved only once the order is received", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      const { poId, poLine } = await orderPart(tx, a);
      // Fitted from the shop floor's own stock before the receipt (the Fit
      // sheet warns; nothing refuses it).
      await addStock(tx, a.productId, 2);
      const lineId = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      expect(await arrivalOf(tx, a.job.id, a.partId)).toEqual([
        { arrived: false, location_id: null },
      ]);

      await voidLine(tx, lineId, "Wrong size");
      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "ordered",
        purchase_order_line_id: poLine,
        work_order_line_item_id: null,
      });
      expect(await onHand(tx, a.productId)).toBe(2);
      // Back in its purchase order line's queue, still not arrived: not reserved.
      expect(await arrivalOf(tx, a.job.id, a.partId)).toEqual([
        { arrived: false, location_id: null },
      ]);
      expect(await reservationsOf(tx, a.productId)).toEqual([]);

      // Its order received: arrived there and reserved for the job (D146).
      await receive(tx, {
        poId,
        lines: [{ lineId: poLine, quantity: 2, locationId: LOCATION.shopFloor }],
      });
      expect(await arrivalOf(tx, a.job.id, a.partId)).toEqual([
        { arrived: true, location_id: LOCATION.shopFloor },
      ]);
      expect(await reservationsOf(tx, a.productId)).toEqual([
        { work_order_id: a.job.id, quantity: 2 },
      ]);
      await assertLedgerConsistent(tx);
    });
  });

  it("a part bought outside BICII goes back to approved without its receipt link; the receipt stays and a re-fit takes the part from stock", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await approvedPart(tx);
      const lineId = await boughtOutside(tx, a.partId, { cost: "30.00" });
      const receipt = (await requestRow(tx, a.partId)).outside_purchase_movement_id!;
      expect(receipt).not.toBeNull();
      expect(await onHand(tx, a.productId)).toBe(0);

      await voidLine(tx, lineId, "Fitted the wrong size");
      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
        outside_purchase_movement_id: null,
        fitted_at: null,
        fitted_by: null,
      });
      // The receipt is kept; the void's reversal leaves the part in stock.
      const rows = await movements(tx, a.productId);
      expect(rows.map((m) => [m.movement_type, m.quantity_delta, m.unit_cost_snapshot])).toEqual([
        ["outside_purchase", 2, "30.00"],
        ["job_consumption", -2, "30.00"],
        ["reversal", 2, "30.00"],
      ]);
      expect(rows[0]).toMatchObject({ id: receipt, request_id: lineId });
      expect(await onHand(tx, a.productId)).toBe(2);
      expect(await productCost(tx, a.productId)).toBe("30.00");
      expect((await unfitEvents(tx, a.job.id)).map((e) => e.payload)).toEqual([
        expect.objectContaining({ status: "approved", bought_outside: true }),
      ]);

      // A re-fit takes it from stock: nothing is bought again.
      const again = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      const after = await movements(tx, a.productId);
      expect(
        after.slice(3).map((m) => [m.movement_type, m.quantity_delta, m.unit_cost_snapshot]),
      ).toEqual([["job_consumption", -2, "30.00"]]);
      expect(await onHand(tx, a.productId)).toBe(0);
      expect(await lineRow(tx, again)).toMatchObject({
        sale_total: "90.00",
        cost: "30.00",
        cost_total: "60.00",
      });
      expect(await requestRow(tx, a.partId)).toMatchObject({
        status: "fitted",
        work_order_line_item_id: again,
        outside_purchase_movement_id: null,
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("a fitting service goes back to approved too, and can be added again", async () => {
    await inTransaction(conn, async (tx) => {
      const q = await quoted(tx);
      await actAs(tx, ANON);
      await answerAll(tx, q.token);
      await actAs(tx, ADMIN);
      const before = await movements(tx, q.productId);
      const lineId = await fit(tx, q.serviceRequestId);
      await voidLine(tx, lineId, "Not needed after all");
      expect(await requestRow(tx, q.serviceRequestId)).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
        fitted_at: null,
      });
      expect((await unfitEvents(tx, q.job.id)).map((e) => e.payload)).toEqual([
        expect.objectContaining({
          request_id: q.serviceRequestId,
          line_id: lineId,
          status: "approved",
          bought_outside: false,
        }),
      ]);
      expect(await movements(tx, q.productId)).toEqual(before);
      const again = await fit(tx, q.serviceRequestId);
      expect((await requestRow(tx, q.serviceRequestId)).work_order_line_item_id).toBe(again);
    });
  });

  it("voiding any other line changes no request", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      const other = await fittedFromStock(tx);
      const before = await requestRow(tx, a.partId);
      const otherBefore = await requestRow(tx, other.partId);
      // The same part added by hand, a manual line and a service line.
      await addStock(tx, a.productId, 2);
      const byHand = await addPart(tx, {
        workOrderId: a.job.id,
        productId: a.productId,
        quantity: 2,
        locationId: LOCATION.shopFloor,
      });
      const manual = await addManualLine(tx, { workOrderId: a.job.id, price: "15.00" });
      const service = await addServiceLine(tx, { workOrderId: a.job.id, serviceId: a.serviceId });
      const eventsBefore = await eventCount(tx, a.job.id);

      await voidLine(tx, byHand.line_id, "Added twice");
      await voidLine(tx, manual, "Not needed");
      await voidLine(tx, service, "Not needed");

      expect(await requestRow(tx, a.partId)).toEqual(before);
      expect(await requestRow(tx, other.partId)).toEqual(otherBefore);
      expect(await unfitEvents(tx, a.job.id)).toEqual([]);
      const added = (await readAsOwner(tx, () => events(tx, a.job.id)))
        .slice(eventsBefore)
        .map((e) => e.event_type);
      expect(added).toEqual(["line_voided", "stock_reversed", "line_voided", "line_voided"]);
      // The hand-added part went back to stock the ordinary way.
      expect(await onHand(tx, a.productId)).toBe(2);
      await assertLedgerConsistent(tx);
    });
  });

  it("replays: a second void changes nothing; a stale Fit with the voided line is refused; the old void leaves a new fit alone", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      await voidLine(tx, a.lineId, "Wrong size");
      const after = await requestRow(tx, a.partId);
      const footprint = async () => ({
        events: await eventCount(tx, a.job.id),
        movements: (await movements(tx, a.productId)).length,
      });
      const counts = await footprint();

      // The void again: the line is returned, nothing is written.
      expect(await voidLine(tx, a.lineId, "Again")).toBe(a.lineId);
      expect(await requestRow(tx, a.partId)).toEqual(after);
      expect(await footprint()).toEqual(counts);

      // A stale Fit with the voided line's id (a retried form) is refused:
      // the request never points at a voided line again.
      await failsWith(
        tx,
        () => fit(tx, a.partId, a.lineId as Uuid, LOCATION.shopFloor),
        p0001("part_request_line_voided"),
      );
      await failsWith(
        tx,
        () => boughtOutside(tx, a.partId, { lineId: a.lineId }),
        p0001("part_request_conflict"),
      );
      expect(await requestRow(tx, a.partId)).toEqual(after);
      expect(await footprint()).toEqual(counts);

      // Fitted again on a new line: replaying the first void leaves it alone,
      // and a Fit replay with the new line still answers it.
      const again = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      const fitted = await requestRow(tx, a.partId);
      expect(await voidLine(tx, a.lineId, "Again")).toBe(a.lineId);
      expect(await requestRow(tx, a.partId)).toEqual(fitted);
      expect(await fit(tx, a.partId, again as Uuid)).toBe(again);
      expect(await unfitEvents(tx, a.job.id)).toHaveLength(1);
    });
  });

  it("a void written directly by the owner un-fits too (the trigger, not void_line), with or without a session, and writes no stock", async () => {
    await inTransaction(conn, async (tx) => {
      // With a staff session (ADMIN's claims kept): a part fitted from stock.
      const a = await fittedFromStock(tx);
      const stockBefore = await movements(tx, a.productId);
      const before = await eventCount(tx, a.job.id);
      await ownerMode(tx);
      await directVoid(tx, a.lineId, STAFF.admin);

      const row = await requestRow(tx, a.partId);
      expect(row).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
        outside_purchase_movement_id: null,
        purchase_order_line_id: null,
        fitted_at: null,
        fitted_by: null,
      });
      expect(await unfitEvents(tx, a.job.id)).toEqual([
        {
          payload: {
            request_id: a.partId,
            line_id: a.lineId,
            description: row.description,
            quantity: 2,
            status: "approved",
            bought_outside: false,
          },
          actor: STAFF.admin,
        },
      ]);
      expect(
        (await readAsOwner(tx, () => events(tx, a.job.id))).slice(before).map((e) => e.event_type),
      ).toEqual(["line_voided", "part_request_unfitted"]);
      // Only void_line's body reverses stock: a direct void writes none.
      expect(await movements(tx, a.productId)).toEqual(stockBefore);

      // With no session (a migration or a script): an ordered part, no actor.
      await actAs(tx, ADMIN);
      const b = await approvedPart(tx);
      const poLine = await orderAndReceive(tx, b, LOCATION.shopFloor);
      const bLine = await fit(tx, b.partId);
      const bStock = await movements(tx, b.productId);
      await ownerMode(tx);
      await withoutSession(tx, () => directVoid(tx, bLine, null));
      expect(await requestRow(tx, b.partId)).toMatchObject({
        status: "ordered",
        purchase_order_line_id: poLine,
        work_order_line_item_id: null,
        fitted_at: null,
        fitted_by: null,
      });
      expect(await unfitEvents(tx, b.job.id)).toEqual([
        {
          payload: expect.objectContaining({
            request_id: b.partId,
            line_id: bLine,
            status: "ordered",
            bought_outside: false,
          }),
          actor: null,
        },
      ]);
      expect(await movements(tx, b.productId)).toEqual(bStock);
    });
  });

  it("the link guard holds for every writer: a request is never linked to a voided line", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      await voidLine(tx, a.lineId, "Wrong size");
      await ownerMode(tx);
      // An UPDATE re-linking the request.
      await failsWith(
        tx,
        () =>
          tx.query(
            `update public.job_part_requests
                set status = 'fitted', work_order_line_item_id = $2, fitted_at = now()
              where id = $1`,
            [a.partId, a.lineId],
          ),
        p0001("part_request_line_voided"),
      );
      expect((await requestRow(tx, a.partId)).status).toBe("approved");
      // An INSERT of a request already linked to the voided line.
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.job_part_requests
               (id, work_order_id, kind, product_id, description, quantity, unit_sale_price,
                currency, status, work_order_line_item_id, fitted_at)
             select $1, w.id, 'part', $3, 'Inserted directly', 2, 45.00, w.currency, 'fitted', $4,
                    now()
               from public.work_orders w where w.id = $2`,
            [randomUUID(), a.job.id, a.productId, a.lineId],
          ),
        p0001("part_request_line_voided"),
      );
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.job_part_requests where work_order_line_item_id = $1",
          [a.lineId],
        ),
      ).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// (b) What sees the item again: the settle guard, the memo, the quote page
// and payment issues
// ---------------------------------------------------------------------------

describe("after the void the item is settled like any approved or ordered item", () => {
  it("Complete and Cancel job wait until it is fitted again or cancelled, for every writer (D149b)", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await fittedFromStock(tx);
      await setStatus(tx, a.job.id, "in_progress");
      await voidLine(tx, a.lineId, "Wrong size");
      await failsWith(tx, () => setStatus(tx, a.job.id, "completed"), UNSETTLED);
      await failsWith(
        tx,
        () => setStatus(tx, a.job.id, "cancelled", "Customer withdrew"),
        UNSETTLED,
      );
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.work_orders set status = 'completed' where id = $1", [a.job.id]),
        UNSETTLED,
      );
      await actAs(tx, ADMIN);
      // Fitted again: Complete goes through.
      await addStock(tx, a.productId, 2);
      await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      expect((await setStatus(tx, a.job.id, "completed")).status).toBe("completed");

      // Cancelled instead: Cancel job goes through (the voided line never blocks it).
      const b = await fittedFromStock(tx);
      await voidLine(tx, b.lineId, "Customer withdrew");
      await failsWith(
        tx,
        () => setStatus(tx, b.job.id, "cancelled", "Customer withdrew"),
        UNSETTLED,
      );
      await cancelRequest(tx, b.partId, "Customer withdrew");
      expect((await setStatus(tx, b.job.id, "cancelled", "Customer withdrew")).status).toBe(
        "cancelled",
      );
    });
  });

  it("the memo and the quote page count it again: not on the bill, and not ordered unless it was", async () => {
    await inTransaction(conn, async (tx) => {
      await withPercent(tx, 50);
      const a = await approvedPart(tx);
      expect(await pageDeposit(tx, a.token)).toMatchObject({
        status: "due",
        parts_ordered: false,
        job_closed: false,
      });
      await addStock(tx, a.productId, 2);
      const lineId = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      expect(await pageDeposit(tx, a.token)).toMatchObject({ status: "due", parts_ordered: true });
      expect(await unfittedMemo(tx, a.job.id)).toBeNull();

      await voidLine(tx, lineId, "Wrong size");
      expect(await pageDeposit(tx, a.token)).toMatchObject({ status: "due", parts_ordered: false });
      expect(await unfittedMemo(tx, a.job.id)).toEqual({ item_count: 1, quoted_total: "90.00" });
      // Any active staff member reads the memo; anon reads nothing.
      await actAs(tx, MECHANIC2);
      expect(await unfittedMemo(tx, a.job.id)).toEqual({ item_count: 1, quoted_total: "90.00" });
      await actAs(tx, ANON);
      await failsWith(tx, () => unfittedMemo(tx, a.job.id), { code: "42501" });
      await actAs(tx, ADMIN);

      // An ordered part stays ordered on the page after its void.
      const b = await approvedPart(tx);
      await orderAndReceive(tx, b, LOCATION.shopFloor, "Customer paid at the counter");
      const bLine = await fit(tx, b.partId);
      await voidLine(tx, bLine, "Wrong size");
      expect((await requestRow(tx, b.partId)).status).toBe("ordered");
      expect(await pageDeposit(tx, b.token)).toMatchObject({ status: "due", parts_ordered: true });
      expect(await unfittedMemo(tx, b.job.id)).toEqual({ item_count: 1, quoted_total: "90.00" });
    });
  });

  it("paid_parts_not_fitted flags a paid deposit whose part's line was voided, were the job closed anyway", async () => {
    await inTransaction(conn, async (tx) => {
      await withPercent(tx, 50);
      const a = await approvedPart(tx);
      const paymentId = await payDeposit(tx, a);
      expect(await issueRows(tx, paymentId)).toEqual([]);
      await addStock(tx, a.productId, 2);
      const lineId = await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      await voidLine(tx, lineId, "Wrong size");
      // The guard keeps the job open; closed without it, the deposit is flagged.
      await failsWith(tx, () => completeJob(tx, a.job.id), UNSETTLED);
      await beforeTheGuard(tx, () => completeJob(tx, a.job.id));
      expect(await issueRows(tx, paymentId)).toEqual([
        {
          issue: "paid_parts_not_fitted",
          message:
            "$45.00 is held for parts that are not on this job. Reopen the job to fit them, or cancel them and refund in Stripe.",
        },
      ]);
      // Reopened and fitted again: nothing is held for nothing.
      await reopenJob(tx, a.job.id);
      await addStock(tx, a.productId, 2);
      await fit(tx, a.partId, randomUUID(), LOCATION.shopFloor);
      await completeJob(tx, a.job.id);
      expect(await issueRows(tx, paymentId)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// (c) Who may do it, and what the API reaches
// ---------------------------------------------------------------------------

describe("permissions are the void's", () => {
  it("any active staff member who voids a fitted line un-fits it, bought outside included; anyone else voids nothing", async () => {
    await inTransaction(conn, async (tx) => {
      // Mechanic 2 holds neither View costs nor Manage purchasing.
      const a = await approvedPart(tx);
      const lineId = await boughtOutside(tx, a.partId);
      await actAs(tx, MECHANIC2);
      await voidLine(tx, lineId, "Wrong size");
      expect((await requestRow(tx, a.partId)).status).toBe("approved");
      expect((await unfitEvents(tx, a.job.id)).map((e) => e.actor)).toEqual([STAFF.mechanic2]);

      // A signed-in non-staff user and anon cannot void: the request stays fitted.
      await actAs(tx, ADMIN);
      const b = await fittedFromStock(tx);
      for (const claims of [
        { role: "authenticated", aud: "authenticated", sub: randomUUID() } as Claims,
        ANON,
      ]) {
        await actAs(tx, claims);
        await failsWith(tx, () => voidLine(tx, b.lineId, "Not mine"), { code: "42501" });
      }
      await actAs(tx, ADMIN);
      expect(await requestRow(tx, b.partId)).toMatchObject({
        status: "fitted",
        work_order_line_item_id: b.lineId,
      });
      // Nor can anyone write a request directly.
      await actAs(tx, MANAGER);
      await failsWith(
        tx,
        () =>
          tx.query("update public.job_part_requests set status = 'approved' where id = $1", [
            b.partId,
          ]),
        { code: "42501" },
      );

      // The new functions are private: no API role executes them.
      await ownerMode(tx);
      for (const fn of [
        "private.unfit_part_request(uuid)",
        "private.work_order_line_items_unfit_part_request()",
        "private.job_part_requests_require_live_line()",
      ]) {
        for (const role of ["anon", "authenticated", "service_role", "public"]) {
          expect(
            await scalar<boolean>(tx, "select has_function_privilege($1, $2, 'execute')", [
              role,
              fn,
            ]),
          ).toBe(false);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (d) The one-off correction
// ---------------------------------------------------------------------------

describe("the one-off in 20261014001100", () => {
  it("un-fits, once, the requests left fitted on a voided line before it", async () => {
    await inTransaction(conn, async (tx) => {
      // (1) An open job: fitted from stock, voided before D160, and the
      // part added again by hand (R-083's workaround).
      const open = await fittedFromStock(tx);
      await beforeD160(tx, () => voidLine(tx, open.lineId, "Wrong size"));
      expect((await requestRow(tx, open.partId)).status).toBe("fitted");
      await addStock(tx, open.productId, 2);
      await addPart(tx, {
        workOrderId: open.job.id,
        productId: open.productId,
        quantity: 2,
        locationId: LOCATION.shopFloor,
      });

      // (2) A completed job with a paid deposit: fitted, voided before D160,
      // completed (the settle guard saw a fitted request), unflagged (R-083).
      await withPercent(tx, 50);
      const done = await approvedPart(tx);
      const paymentId = await payDeposit(tx, done);
      await addStock(tx, done.productId, 2);
      const doneLine = await fit(tx, done.partId, randomUUID(), LOCATION.shopFloor);
      await beforeD160(tx, () => voidLine(tx, doneLine, "Wrong size"));
      await completeJob(tx, done.job.id);
      expect(await issueRows(tx, paymentId)).toEqual([]);

      // (3) A collected job: an ordered part, received, fitted, voided before
      // D160, collected.
      await withPercent(tx, 0);
      const gone = await approvedPart(tx);
      const poLine = await orderAndReceive(tx, gone, LOCATION.shopFloor);
      const goneLine = await fit(tx, gone.partId);
      await beforeD160(tx, () => voidLine(tx, goneLine, "Damaged"));
      await walkTo(tx, gone.job.id, "collected");

      // (4) The control: a fitted request on a live line.
      const live = await fittedFromStock(tx);
      const liveBefore = await requestRow(tx, live.partId);

      // (5) An open job with two requests for the same part and the part on
      // a line from before: the first fitted and voided before D160, the
      // second fitted after the void. Neither live line was added by hand
      // after the void (one is older, the other is the second request's),
      // so this job is not counted with (1).
      const twin = await setup(tx);
      await addStock(tx, twin.productId, 6);
      await addPart(tx, {
        workOrderId: twin.job.id,
        productId: twin.productId,
        quantity: 2,
        locationId: LOCATION.shopFloor,
      });
      const twins: string[] = [];
      for (let i = 0; i < 2; i++) {
        twins.push(
          await proposePart(tx, {
            workOrderId: twin.job.id,
            productId: twin.productId,
            quantity: 2,
            price: "45.00",
            cost: "28.00",
          }),
        );
      }
      const twinToken = await sendQuote(tx, { workOrderId: twin.job.id, requestIds: twins });
      await actAs(tx, ANON);
      await answerAll(tx, twinToken);
      await actAs(tx, ADMIN);
      const firstLine = await fit(tx, twins[0], randomUUID(), LOCATION.shopFloor);
      await beforeD160(tx, () => voidLine(tx, firstLine, "Wrong size"));
      const secondLine = await fit(tx, twins[1], randomUUID(), LOCATION.shopFloor);
      const secondBefore = await requestRow(tx, twins[1]);

      expect(await runOneOff(tx)).toEqual([
        "D160 one-off: 4 fitted indent request(s) whose line was voided went back to approved or ordered; 2 of them on jobs that are not open, 1 on a job with a live line of the same item added after the void (check whether it was added by hand).",
      ]);

      // (5) The first is back to approved; the second stays fitted on its line.
      expect(await requestRow(tx, twins[0])).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
      });
      expect(await requestRow(tx, twins[1])).toEqual(secondBefore);
      expect(secondBefore.work_order_line_item_id).toBe(secondLine);

      // (1) back to approved; the timeline says so, with no actor.
      expect(await requestRow(tx, open.partId)).toMatchObject({
        status: "approved",
        work_order_line_item_id: null,
        fitted_at: null,
      });
      expect(await unfitEvents(tx, open.job.id)).toEqual([
        {
          payload: expect.objectContaining({
            request_id: open.partId,
            line_id: open.lineId,
            status: "approved",
          }),
          actor: null,
        },
      ]);
      // On the open job it is settled like any approved item: cancelled here
      // (the part is on the job by hand).
      await cancelRequest(tx, open.partId, "Added by hand");

      // (2) The completed job: flagged now, in the memo, and Ready and
      // Collected wait until it is settled.
      expect((await requestRow(tx, done.partId)).status).toBe("approved");
      expect((await issueRows(tx, paymentId)).map((r) => r.issue)).toEqual([
        "paid_parts_not_fitted",
      ]);
      expect(await unfittedMemo(tx, done.job.id)).toEqual({ item_count: 1, quoted_total: "90.00" });
      await failsWith(tx, () => setStatus(tx, done.job.id, "ready_for_collection"), UNSETTLED);
      await failsWith(tx, () => setStatus(tx, done.job.id, "collected"), UNSETTLED);
      await actAs(tx, MECHANIC1);
      await cancelRequest(tx, done.partId, "Not fitted after all");
      expect((await setStatus(tx, done.job.id, "ready_for_collection")).status).toBe(
        "ready_for_collection",
      );
      expect((await issueRows(tx, paymentId)).map((r) => r.issue)).toEqual([
        "paid_parts_cancelled",
      ]);

      // (3) The collected job: back to ordered; only D149's admin or manager cancel closes it.
      await actAs(tx, ADMIN);
      expect(await requestRow(tx, gone.partId)).toMatchObject({
        status: "ordered",
        purchase_order_line_id: poLine,
        work_order_line_item_id: null,
      });
      expect((await workOrder(tx, gone.job.id)).status).toBe("collected");
      await actAs(tx, MECHANIC1);
      await failsWith(tx, () => cancelRequest(tx, gone.partId), p0001("work_order_closed"));
      await actAs(tx, MANAGER);
      await cancelRequest(tx, gone.partId, "Never fitted");
      expect((await requestRow(tx, gone.partId)).status).toBe("cancelled");

      // (4) Untouched.
      expect(await requestRow(tx, live.partId)).toEqual(liveBefore);

      // Once: run again, nothing left.
      await actAs(tx, ADMIN);
      const counts = await Promise.all(
        [open, done, gone, live, twin].map((j) => eventCount(tx, j.job.id)),
      );
      expect(await runOneOff(tx)).toEqual([
        "D160 one-off: 0 fitted indent request(s) whose line was voided went back to approved or ordered; 0 of them on jobs that are not open, 0 on a job with a live line of the same item added after the void (check whether it was added by hand).",
      ]);
      expect(
        await Promise.all([open, done, gone, live, twin].map((j) => eventCount(tx, j.job.id))),
      ).toEqual(counts);
    });
  });
});

// ---------------------------------------------------------------------------
// (e) Concurrency (committed)
// ---------------------------------------------------------------------------

describe.skipIf(!isolatedDatabase())("concurrency (committed)", () => {
  /** A part fitted from stock on an in-progress job, committed. */
  const committedFitted = async () => {
    const c = await connect();
    const result = await committed(c, async (tx) => {
      const a = await fittedFromStock(tx);
      await setStatus(tx, a.job.id, "in_progress");
      return a;
    });
    await c.end();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  /** Fitted requests on voided lines and closed jobs with unsettled items, for these jobs. */
  const broken = (observer: pg.Client, jobs: string[]) =>
    scalar<number>(
      observer,
      `select (select count(*) from public.job_part_requests r
                 join public.work_order_line_items li on li.id = r.work_order_line_item_id
                where r.work_order_id = any ($1) and li.voided_at is not null)
            + (select count(*) from public.job_part_requests r
                 join public.work_orders w on w.id = r.work_order_id
                where w.id = any ($1) and not private.work_order_status_is_open(w.status)
                  and r.status in ('approved', 'ordered'))`,
      [jobs],
    ).then(Number);

  it("a void against Complete: one waits for the other; never a fitted request on a voided line or a completed job with an approved item", async () => {
    const observer = await connect();
    // The void first: Complete waits, then finds the item approved.
    const a = await committedFitted();
    const [voided, completed] = await race(
      observer,
      { as: ADMIN, run: (tx) => voidLine(tx, a.lineId, "Wrong size") },
      { as: ADMIN, run: (tx) => setStatus(tx, a.job.id, "completed") },
    );
    expect(voided.ok).toBe(true);
    expect(completed).toMatchObject({ ok: false, error: UNSETTLED });
    // Complete first: the void waits, then finds the job locked.
    const b = await committedFitted();
    const [done, refused] = await race(
      observer,
      { as: ADMIN, run: (tx) => setStatus(tx, b.job.id, "completed") },
      { as: MECHANIC1, run: (tx) => voidLine(tx, b.lineId, "Wrong size") },
    );
    expect(done.ok).toBe(true);
    expect(refused).toMatchObject({ ok: false, error: p0001("work_order_locked") });
    expect(await broken(observer, [a.job.id, b.job.id])).toBe(0);
    await observer.end();
  });

  it("a void against cancelling the item: the cancel waits, then cancels the approved item", async () => {
    const observer = await connect();
    const a = await committedFitted();
    const [voided, cancelled] = await race(
      observer,
      { as: ADMIN, run: (tx) => voidLine(tx, a.lineId, "Wrong size") },
      { as: MECHANIC2, run: (tx) => cancelRequest(tx, a.partId, "Not needed") },
    );
    expect(voided.ok).toBe(true);
    expect(cancelled.ok).toBe(true);
    expect(
      await scalar<string>(
        observer,
        "select status::text from public.job_part_requests where id = $1",
        [a.partId],
      ),
    ).toBe("cancelled");
    expect(await broken(observer, [a.job.id])).toBe(0);
    await observer.end();
  });
});
