/**
 * Discounts and round-offs (PLAN D271; DATA-MODEL §5 "Discounts"): any
 * active staff member takes an amount off a job with a reason. It is spread
 * over the job's chargeable lines as new sale prices (largest line takes
 * the rounding remainder), so the total drops by exactly the amount and
 * each line's Cult Commons share is on what was charged. Consigned parts
 * keep their payout; stock does not move. Completed jobs are reopened and
 * completed again; collected ones are refused. Replay-safe by request id.
 *
 * Tests create jobs, services and products, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createConsignor } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  completeJob,
  movements,
  newJob,
  onHand,
  readAsOwner,
} from "./inventory-fixtures";
import {
  addManualLine,
  addServiceLine,
  eventTypes,
  failsWith,
  makeService,
  ownerMode,
  setStatus,
  walkTo,
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

type PlanLine = {
  line_id: string;
  description: string;
  quantity: string;
  from_price: string;
  to_price: string;
  from_total: string;
  to_total: string;
  below_consignor: boolean;
};

type Plan = {
  currency: string;
  total_before: string;
  amount: string;
  applied: string;
  total_after: string;
  lines: PlanLine[];
  reopens?: boolean;
  reopened?: boolean;
  replayed?: boolean;
  changed_count?: number;
};

const apply = (
  tx: pg.Client,
  a: { requestId?: string; workOrderId: string; amount: string; reason?: string | null },
) =>
  tx
    .query<{ r: Plan }>("select public.apply_job_discount($1, $2, $3, $4) as r", [
      a.requestId ?? randomUUID(),
      a.workOrderId,
      a.amount,
      a.reason === undefined ? "Regular customer" : a.reason,
    ])
    .then((r) => r.rows[0].r);

const preview = (tx: pg.Client, workOrderId: string, amount: string) =>
  tx
    .query<{ r: Plan }>("select public.preview_job_discount($1, $2) as r", [workOrderId, amount])
    .then((r) => r.rows[0].r);

/** Live lines as the owner sees them (Cult Commons and payout included). */
const lines = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      id: string;
      price: string;
      sale_total: string;
      cc: string;
      expected_cc: string;
      payout: string | null;
    }>(
      `select id, unit_sale_price_snapshot::text as price, sale_total::text,
              cult_commons_share::text as cc,
              round(greatest(sale_total - cost_total, 0) * cult_commons_rate_snapshot, 2)::text as expected_cc,
              consignor_payout_snapshot::text as payout
         from public.work_order_line_items
        where work_order_id = $1 and voided_at is null
        order by sale_total desc, id`,
      [workOrderId],
    );
    return rows;
  });

const jobTotal = (tx: pg.Client, workOrderId: string) =>
  scalar<string>(
    tx,
    `select coalesce(sum(sale_total), 0)::text from public.work_order_line_items
      where work_order_id = $1 and voided_at is null`,
    [workOrderId],
  );

/** A job with a service of 80.00, a manual line of 20.00 and 3 x 5.00 (total 115.00). */
async function threeLineJob(tx: pg.Client) {
  await ownerMode(tx);
  const serviceId = await makeService(tx, { price: "80.00" });
  await actAs(tx, ADMIN);
  const job = await newJob(tx);
  const service = await addServiceLine(tx, { workOrderId: job.id, serviceId, price: "80.00" });
  const manual = await addManualLine(tx, {
    workOrderId: job.id,
    description: "Bar tape",
    price: "20.00",
    cost: "8.00",
  });
  const triple = await addManualLine(tx, {
    workOrderId: job.id,
    description: "Valve cores",
    price: "5.00",
    quantity: 3,
    cost: "1.00",
  });
  return { job, service, manual, triple };
}

/** A consigned product counted by quantity (as the owner), with a consignor to receive from. */
async function consignedProduct(tx: pg.Client, price: string): Promise<string> {
  await createConsignor(tx);
  await ownerMode(tx);
  const id = randomUUID();
  await tx.query(
    `insert into public.products (id, name, tracking_type, ownership_type, default_sale_price, publication_status)
     values ($1, $2, 'quantity', 'consignment', $3, 'internal_only')`,
    [id, `Consigned saddle ${id.slice(0, 8)}`, price],
  );
  await actAs(tx, ADMIN);
  return id;
}

describe.skipIf(!isolatedDatabase())("job discounts (D271)", () => {
  it("takes exactly the amount off, spread by line total, the remainder on the largest line", async () => {
    await inTx(async (tx) => {
      const { job, service, manual, triple } = await threeLineJob(tx);
      expect(await jobTotal(tx, job.id)).toBe("115.00");

      await actAs(tx, MECHANIC1);
      const r = await apply(tx, { workOrderId: job.id, amount: "10.00" });
      expect(r).toMatchObject({
        total_before: "115.00",
        amount: "10.00",
        applied: "10.00",
        total_after: "105.00",
        reopened: false,
        replayed: false,
        changed_count: 3,
      });
      // 80 -> 73.04 and 20 -> 18.26 by share; 15 -> 13.70 is 4.57 each
      // (13.71); the cent over comes off the largest line: 73.03.
      const after = await lines(tx, job.id);
      expect(after.map((l) => [l.id, l.price, l.sale_total])).toEqual([
        [service, "73.03", "73.03"],
        [manual, "18.26", "18.26"],
        [triple, "4.57", "13.71"],
      ]);
      expect(await jobTotal(tx, job.id)).toBe("105.00");
      // D1 unchanged: each share is on what was charged.
      for (const l of after) expect(l.cc).toBe(l.expected_cc);
      expect(await eventTypes(tx, job.id)).toContain("discount_applied");
      const row = await scalar<string>(
        tx,
        "select reason from public.work_order_discounts where work_order_id = $1",
        [job.id],
      );
      expect(row).toBe("Regular customer");
    });
  });

  it("the preview is the same plan and writes nothing", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      const p = await preview(tx, job.id, "10.00");
      expect(p).toMatchObject({ applied: "10.00", total_after: "105.00", reopens: false });
      expect(p.lines.map((l) => l.to_price)).toEqual(["73.03", "18.26", "4.57"]);
      expect(await jobTotal(tx, job.id)).toBe("115.00");
    });
  });

  it("rounds to a total: the whole total can come off, never more", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      await failsWith(tx, () => apply(tx, { workOrderId: job.id, amount: "115.01" }), {
        code: "P0001",
        message: "discount_over_total",
      });
      await failsWith(tx, () => preview(tx, job.id, "115.01"), {
        message: "discount_over_total",
      });
      await failsWith(tx, () => apply(tx, { workOrderId: job.id, amount: "0" }), {
        message: "discount_not_positive",
      });
      await failsWith(tx, () => apply(tx, { workOrderId: job.id, amount: "5", reason: " " }), {
        message: "reason_required",
      });
      const r = await apply(tx, { workOrderId: job.id, amount: "115.00" });
      expect(r.total_after).toBe("0.00");
      expect(await jobTotal(tx, job.id)).toBe("0.00");
      // Nothing left to discount.
      await failsWith(tx, () => apply(tx, { workOrderId: job.id, amount: "0.01" }), {
        message: "discount_over_total",
      });
    });
  });

  it("a consigned part keeps its payout and its stock; the plan warns when it sells below it", async () => {
    await inTx(async (tx) => {
      const productId = await consignedProduct(tx, "40.00");
      const job = await newJob(tx);
      await tx.query("select public.add_part_to_job($1, $2, $3, 1, null, null)", [
        randomUUID(),
        job.id,
        productId,
      ]);
      const [line] = await lines(tx, job.id);
      // D268: never consigned before, so half the price is owed.
      expect(line).toMatchObject({ price: "40.00", payout: "20.00" });
      const before = await movements(tx, productId);
      const stock = await onHand(tx, productId);

      const p = await preview(tx, job.id, "30.00");
      expect(p.lines).toHaveLength(1);
      expect(p.lines[0]).toMatchObject({ to_price: "10.00", below_consignor: true });
      expect((await preview(tx, job.id, "5.00")).lines[0].below_consignor).toBe(false);

      await apply(tx, { workOrderId: job.id, amount: "30.00" });
      const [after] = await lines(tx, job.id);
      expect(after).toMatchObject({ id: line.id, price: "10.00", payout: "20.00" });
      expect(after.cc).toBe(after.expected_cc);
      // No reversal, no re-issue: the product history is unchanged.
      expect(await movements(tx, productId)).toEqual(before);
      expect(await onHand(tx, productId)).toBe(stock);
    });
  });

  it("is replay-safe by request id, and a reused id with other details is refused", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      const requestId = randomUUID();
      const first = await apply(tx, { requestId, workOrderId: job.id, amount: "10.00" });
      const again = await apply(tx, { requestId, workOrderId: job.id, amount: "10.00" });
      expect(again).toMatchObject({ ...first, replayed: true });
      expect(await jobTotal(tx, job.id)).toBe("105.00");
      expect((await eventTypes(tx, job.id)).filter((t) => t === "discount_applied")).toHaveLength(
        1,
      );
      await failsWith(tx, () => apply(tx, { requestId, workOrderId: job.id, amount: "11.00" }), {
        message: "discount_request_conflict",
      });
    });
  });

  it("a completed or ready job is reopened, discounted and put back where it was", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      await completeJob(tx, job.id);
      expect((await preview(tx, job.id, "15.00")).reopens).toBe(true);
      const r = await apply(tx, { workOrderId: job.id, amount: "15.00", reason: "Round to 100" });
      expect(r).toMatchObject({ reopened: true, total_after: "100.00" });
      expect((await workOrder(tx, job.id)).status).toBe("completed");
      expect(await jobTotal(tx, job.id)).toBe("100.00");
      const types = await eventTypes(tx, job.id);
      expect(types.slice(types.indexOf("discount_applied") - 1)).toEqual([
        "reopened",
        "discount_applied",
        "completed",
      ]);

      await setStatus(tx, job.id, "ready_for_collection");
      await apply(tx, { workOrderId: job.id, amount: "1.00" });
      expect((await workOrder(tx, job.id)).status).toBe("ready_for_collection");
      expect(await jobTotal(tx, job.id)).toBe("99.00");
    });
  });

  it("money already taken is not a block: the plan says how much would be above the new total", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      expect(await preview(tx, job.id, "15.00")).toMatchObject({
        paid: "0.00",
        paid_over: "0.00",
        withdraws_link: false,
      });
      await completeJob(tx, job.id);
      await tx.query(
        `select * from public.record_counter_payment($1, $2, null, $3, 'cash'::public.counter_payment_method, null, null, null)`,
        [randomUUID(), job.id, "115.00"],
      );
      expect(await preview(tx, job.id, "15.00")).toMatchObject({
        paid: "115.00",
        paid_over: "15.00",
        reopens: true,
      });
      const r = await apply(tx, { workOrderId: job.id, amount: "15.00" });
      expect(r).toMatchObject({ paid: "115.00", paid_over: "15.00", total_after: "100.00" });
      expect((await workOrder(tx, job.id)).status).toBe("completed");
    });
  });

  it("a collected job is refused: its money has been taken", async () => {
    await inTx(async (tx) => {
      const { job } = await threeLineJob(tx);
      await walkTo(tx, job.id, "collected");
      await failsWith(tx, () => apply(tx, { workOrderId: job.id, amount: "5.00" }), {
        code: "P0001",
        message: "discount_job_closed",
      });
      await failsWith(tx, () => preview(tx, job.id, "5.00"), {
        message: "discount_job_closed",
      });
      expect(await jobTotal(tx, job.id)).toBe("115.00");
    });
  });

  it("a build's package price and labour amount drop by what its lines gave", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const labourServiceId = await makeService(tx, { price: "180.00" });
      await actAs(tx, ADMIN);
      const packageId = randomUUID();
      await tx.query(
        `insert into public.build_packages (id, kind, name, price, labour_amount, labour_service_id)
         values ($1, 'full_build', $2, '390.00', '180.00', $3)`,
        [packageId, `Classic ${packageId.slice(0, 6)}`, labourServiceId],
      );
      const job = await newJob(tx);
      const labourLineId = randomUUID();
      await tx.query("select public.set_work_order_build($1, $2, $3, null)", [
        job.id,
        packageId,
        labourLineId,
      ]);
      await addManualLine(tx, { workOrderId: job.id, description: "Bottle cage", price: "20.00" });
      const difference = () =>
        scalar<string>(
          tx,
          "select difference::text from public.work_order_build_summary where work_order_id = $1",
          [job.id],
        );
      const before = await difference();

      // Total 200: the labour line gives 36.90, the cage 4.10.
      await apply(tx, { workOrderId: job.id, amount: "41.00" });
      const build = (
        await tx.query<{ price: string; labour: string }>(
          `select price::text, labour_amount::text as labour
             from public.work_order_builds where work_order_id = $1`,
          [job.id],
        )
      ).rows[0];
      expect(build).toEqual({ price: "353.10", labour: "143.10" });
      expect(await difference()).toBe(before);
      expect(await jobTotal(tx, job.id)).toBe("159.00");
    });
  });
});
