/**
 * Add after complete (PLAN D269): a part, service or manual line added to
 * a completed (or ready) job. Completed on today's shop day, the job is
 * reopened with the reason filled in, the line added and the job completed
 * again, back to the status it was in. Completed on an earlier shop day,
 * the original job is untouched and the line goes on a follow-up job for
 * the same customer and bike. Collected and cancelled jobs stay closed.
 *
 * Tests create jobs, products and services, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  addStock,
  completeJob,
  makeProduct,
  newJob,
  onHand,
} from "./inventory-fixtures";
import {
  eventTypes,
  events,
  failsWith,
  makeService,
  ownerMode,
  setStatus,
  workOrder,
} from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Placed = {
  line_id: string;
  work_order_id: string;
  job_number: string;
  follow_up: boolean;
  recompleted: boolean;
  received_quantity: number;
  replayed: boolean;
};

const COLUMNS = `(r).line_id, (r).work_order_id, (r).job_number, (r).follow_up, (r).recompleted,
                 (r).received_quantity, (r).replayed`;

const addManual = (
  tx: pg.Client,
  a: { lineId?: string; workOrderId: string; description?: string; price?: string },
) =>
  tx
    .query<Placed>(
      `select ${COLUMNS} from (select public.add_manual_after_complete($1, $2, $3, $4, 1, null) r) s`,
      [a.lineId ?? randomUUID(), a.workOrderId, a.description ?? "Labour", a.price ?? "30.00"],
    )
    .then((r) => r.rows[0]);

const addService = (
  tx: pg.Client,
  a: { lineId?: string; workOrderId: string; serviceId: string },
) =>
  tx
    .query<Placed>(
      `select ${COLUMNS}
         from (select public.add_service_after_complete($1, $2, $3, 1, null, null, null) r) s`,
      [a.lineId ?? randomUUID(), a.workOrderId, a.serviceId],
    )
    .then((r) => r.rows[0]);

const addPart = (
  tx: pg.Client,
  a: { lineId?: string; workOrderId: string; productId: string; quantity: number },
) =>
  tx
    .query<Placed>(
      `select ${COLUMNS}
         from (select public.add_part_after_complete($1, $2, $3, $4, null, null, null) r) s`,
      [a.lineId ?? randomUUID(), a.workOrderId, a.productId, a.quantity],
    )
    .then((r) => r.rows[0]);

const liveLines = (tx: pg.Client, workOrderId: string) =>
  scalar<number>(
    tx,
    "select count(*)::int from public.work_order_line_items where work_order_id = $1 and voided_at is null",
    [workOrderId],
  );

/** Moves the job's stamps `days` shop days back (as the owner, triggers off). */
async function backdate(tx: pg.Client, workOrderId: string, days = 3): Promise<void> {
  await ownerMode(tx);
  await tx.query("set local session_replication_role = replica");
  await tx.query(
    `update public.work_orders
        set checked_in_at = checked_in_at - make_interval(days => $2),
            status_changed_at = status_changed_at - make_interval(days => $2),
            started_at = started_at - make_interval(days => $2),
            completed_at = completed_at - make_interval(days => $2),
            ready_for_collection_at = ready_for_collection_at - make_interval(days => $2)
      where id = $1`,
    [workOrderId, days],
  );
  await tx.query("set local session_replication_role = origin");
  await actAs(tx, ADMIN);
}

describe.skipIf(!isolatedDatabase())("add after complete (D269)", () => {
  it("same day: reopens with the reason filled in, adds the line and completes the job again", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      await completeJob(tx, job.id);
      const before = await eventTypes(tx, job.id);

      await actAs(tx, MECHANIC1);
      const r = await addManual(tx, { workOrderId: job.id, description: "Chain lube" });
      expect(r).toMatchObject({
        work_order_id: job.id,
        job_number: job.job_number,
        follow_up: false,
        recompleted: true,
        replayed: false,
      });

      const after = await workOrder(tx, job.id);
      expect(after.status).toBe("completed");
      expect(after.completed_at).not.toBeNull();
      expect(await liveLines(tx, job.id)).toBe(1);

      const added = (await events(tx, job.id)).slice(before.length);
      expect(added.map((e) => e.event_type)).toEqual(["reopened", "line_added", "completed"]);
      expect(added[0].payload).toMatchObject({
        from: "completed",
        to: "in_progress",
        note: "Added after completion: Chain lube",
      });

      // A replay adds nothing and reopens nothing.
      const count = (await eventTypes(tx, job.id)).length;
      const again = await addManual(tx, { lineId: r.line_id, workOrderId: job.id });
      expect(again).toMatchObject({ line_id: r.line_id, work_order_id: job.id, replayed: true });
      expect((await eventTypes(tx, job.id)).length).toBe(count);
      expect(await liveLines(tx, job.id)).toBe(1);
    });
  });

  it("same day: a ready job goes back to ready for collection", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      await completeJob(tx, job.id);
      await setStatus(tx, job.id, "ready_for_collection");
      await ownerMode(tx);
      const serviceId = await makeService(tx, { name: "Brake bleed", price: "45.00" });
      await actAs(tx, ADMIN);

      const r = await addService(tx, { workOrderId: job.id, serviceId });
      expect(r).toMatchObject({ follow_up: false, recompleted: true });
      const after = await workOrder(tx, job.id);
      expect(after.status).toBe("ready_for_collection");
      expect(after.ready_for_collection_at).not.toBeNull();
      expect((await eventTypes(tx, job.id)).slice(-4)).toEqual([
        "reopened",
        "line_added",
        "completed",
        "ready_for_collection",
      ]);
    });
  });

  it("same day: a part is taken from stock and the job is completed again", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const productId = await makeProduct(tx, { price: "20.00", cost: "8.00" });
      await actAs(tx, ADMIN);
      await addStock(tx, productId, 5);
      const job = await newJob(tx);
      await completeJob(tx, job.id);

      const r = await addPart(tx, { workOrderId: job.id, productId, quantity: 2 });
      expect(r).toMatchObject({ follow_up: false, recompleted: true, received_quantity: 0 });
      expect((await workOrder(tx, job.id)).status).toBe("completed");
      expect(await onHand(tx, productId)).toBe(3);
      expect(await liveLines(tx, job.id)).toBe(1);
    });
  });

  it("earlier day: the line goes on a follow-up job for the same bike; the original is untouched", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      await completeJob(tx, job.id);
      await backdate(tx, job.id);
      const original = await workOrder(tx, job.id);
      const originalEvents = await eventTypes(tx, job.id);

      const r = await addManual(tx, { workOrderId: job.id, description: "Bar tape" });
      expect(r.follow_up).toBe(true);
      expect(r.recompleted).toBe(false);
      expect(r.work_order_id).not.toBe(job.id);
      expect(r.job_number).toMatch(/^J-/);

      const followUp = await workOrder(tx, r.work_order_id);
      expect(followUp).toMatchObject({
        customer_id: job.customer_id,
        bike_id: job.bike_id,
        status: "received",
        job_number: r.job_number,
      });
      expect(followUp.requested_work).toBe(`Follow-up to ${job.job_number}: Bar tape`);
      expect(await liveLines(tx, r.work_order_id)).toBe(1);

      // The original job: same status, same completion, no new events or lines.
      expect(await workOrder(tx, job.id)).toEqual(original);
      expect(await eventTypes(tx, job.id)).toEqual(originalEvents);
      expect(await liveLines(tx, job.id)).toBe(0);

      // A second line the same day joins the same follow-up.
      const second = await addManual(tx, { workOrderId: job.id, description: "Bottle cage" });
      expect(second).toMatchObject({ work_order_id: r.work_order_id, follow_up: true });
      expect(await liveLines(tx, r.work_order_id)).toBe(2);

      // A replay returns the follow-up.
      const again = await addManual(tx, { lineId: r.line_id, workOrderId: job.id });
      expect(again).toMatchObject({
        work_order_id: r.work_order_id,
        follow_up: true,
        replayed: true,
      });
      expect(await liveLines(tx, r.work_order_id)).toBe(2);
    });
  });

  it("an open job takes the line as usual", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      const r = await addManual(tx, { workOrderId: job.id });
      expect(r).toMatchObject({ work_order_id: job.id, follow_up: false, recompleted: false });
      expect((await workOrder(tx, job.id)).status).toBe("received");
    });
  });

  it("a collected job is refused", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      await completeJob(tx, job.id);
      await setStatus(tx, job.id, "collected");
      await failsWith(tx, () => addManual(tx, { workOrderId: job.id }), {
        code: "P0001",
        message: "work_order_closed",
      });
      expect(await liveLines(tx, job.id)).toBe(0);
    });
  });
});
