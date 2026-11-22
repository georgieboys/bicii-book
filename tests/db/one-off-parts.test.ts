/**
 * One-off parts (PLAN D264): add_one_off_part makes a part that isn't in the
 * system yet, takes it into stock and puts it on an open job in one step,
 * consigned (the consignor is owed on completion, D44) or the shop's (at its
 * cost), with the rights of the separate pages. Replay-safe by line id.
 *
 * Tests create jobs, products and consignments, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createConsignor, itemPosition } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { ADMIN, MECHANIC1, completeJob, newJob, onHand, readAsOwner } from "./inventory-fixtures";
import { failsWith, makeService, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Args = {
  lineId?: string;
  workOrderId: string;
  name?: string;
  quantity?: number;
  price?: string;
  consigned: boolean;
  consignorId?: string | null;
  owed?: string | null;
  cost?: string | null;
  extra?: boolean;
};

async function oneOff(tx: pg.Client, a: Args) {
  const { rows } = await tx.query<{
    line_id: string;
    product_id: string;
    product_short_id: string;
    replayed: boolean;
  }>(
    `select (r).line_id, (r).product_id, (r).product_short_id, (r).replayed
       from (select public.add_one_off_part($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10) r) s`,
    [
      a.lineId ?? randomUUID(),
      a.workOrderId,
      a.name ?? "Vintage Motohandlebars",
      a.quantity ?? 1,
      a.price ?? "120.00",
      a.consigned,
      a.consignorId ?? null,
      a.owed ?? null,
      a.cost ?? null,
      a.extra ?? false,
    ],
  );
  return rows[0];
}

const lineOf = (tx: pg.Client, lineId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query(
      `select line_type::text, quantity::text, unit_sale_price_snapshot::text as price,
              unit_direct_cost_snapshot::text as cost, consignment_item_id is not null as consigned,
              consignor_payout_snapshot::text as payout
         from public.work_order_line_items where id = $1`,
      [lineId],
    );
    return rows[0];
  });

describe.skipIf(!isolatedDatabase())("one-off parts (D264)", () => {
  it("a consigned one-off is received and used at once; the consignor is owed on completion", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const job = await newJob(tx);
      const r = await oneOff(tx, {
        workOrderId: job.id,
        consigned: true,
        consignorId,
        owed: "60.00",
      });
      expect(r.replayed).toBe(false);
      expect(await lineOf(tx, r.line_id)).toEqual({
        line_type: "inventory",
        quantity: "1.00",
        price: "120.00",
        cost: "60.00",
        consigned: true,
        payout: "60.00",
      });
      expect(await onHand(tx, r.product_id)).toBe(0);
      const item = await readAsOwner(tx, () =>
        scalar<string>(tx, "select id from public.consignment_items where product_id = $1", [
          r.product_id,
        ]),
      );
      await completeJob(tx, job.id);
      expect(await itemPosition(tx, item)).toMatchObject({ owed_qty: 1, liability: "60.00" });
    });
  });

  it("the shop's one-off is taken in at its cost and used at once; a repeat adds nothing", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      const lineId = randomUUID();
      const r = await oneOff(tx, {
        lineId,
        workOrderId: job.id,
        name: "Bell",
        quantity: 2,
        price: "15.00",
        consigned: false,
        cost: "6.00",
      });
      expect(await lineOf(tx, r.line_id)).toMatchObject({
        quantity: "2.00",
        price: "15.00",
        cost: "6.00",
        consigned: false,
      });
      expect(await onHand(tx, r.product_id)).toBe(0);
      const again = await oneOff(tx, {
        lineId,
        workOrderId: job.id,
        name: "Bell",
        quantity: 2,
        price: "15.00",
        consigned: false,
        cost: "6.00",
      });
      expect(again).toMatchObject({ line_id: lineId, product_id: r.product_id, replayed: true });
      const counts = await readAsOwner(tx, async () => {
        const { rows } = await tx.query<{ lines: number; moves: number }>(
          `select (select count(*)::int from public.work_order_line_items where work_order_id = $1) as lines,
                  (select count(*)::int from public.inventory_movements
                    where product_id = $2 and movement_type = 'stock_adjustment') as moves`,
          [job.id, r.product_id],
        );
        return rows[0];
      });
      expect(counts).toEqual({ lines: 1, moves: 1 });
      // The same id for another quantity is a clash, not a replay.
      await failsWith(
        tx,
        () =>
          oneOff(tx, {
            lineId,
            workOrderId: job.id,
            name: "Bell",
            quantity: 3,
            price: "15.00",
            consigned: false,
            cost: "6.00",
          }),
        { message: "line_conflict" },
      );
    });
  });

  it("needs what each mode needs, and the rights of the separate pages", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const job = await newJob(tx);
      await failsWith(tx, () => oneOff(tx, { workOrderId: job.id, consigned: true, consignorId }), {
        message: "one_off_consignor_required",
      });
      await failsWith(tx, () => oneOff(tx, { workOrderId: job.id, consigned: false }), {
        message: "one_off_cost_required",
      });
      await failsWith(
        tx,
        () => oneOff(tx, { workOrderId: job.id, name: "  ", consigned: false, cost: "1.00" }),
        { message: "one_off_name_required" },
      );
      await actAs(tx, MECHANIC1);
      await failsWith(
        tx,
        () => oneOff(tx, { workOrderId: job.id, consigned: true, consignorId, owed: "1.00" }),
        { code: "42501" },
      );
      await failsWith(
        tx,
        () => oneOff(tx, { workOrderId: job.id, consigned: false, cost: "1.00" }),
        {
          code: "42501",
        },
      );
      await actAs(tx, ADMIN);
      await completeJob(tx, job.id);
      await failsWith(
        tx,
        () => oneOff(tx, { workOrderId: job.id, consigned: false, cost: "1.00" }),
        { message: "work_order_locked" },
      );
    });
  });

  it("on a build it can be charged on top of the package (D261)", async () => {
    await inTx(async (tx) => {
      const job = await newJob(tx);
      await ownerMode(tx);
      const serviceId = await makeService(tx, { price: "180.00" });
      await actAs(tx, ADMIN);
      const pkg = randomUUID();
      await tx.query(
        `insert into public.build_packages (id, kind, name, price, labour_amount, labour_service_id)
         values ($1, 'full_build', $2, 390, 180, $3)`,
        [pkg, `Classic ${randomUUID().slice(0, 6)}`, serviceId],
      );
      await tx.query("select public.set_work_order_build($1, $2, $3, null)", [
        job.id,
        pkg,
        randomUUID(),
      ]);
      const r = await oneOff(tx, {
        workOrderId: job.id,
        consigned: false,
        cost: "10.00",
        price: "40.00",
        extra: true,
      });
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.work_order_build_extras where line_id = $1",
          [r.line_id],
        ),
      ).toBe(1);
    });
  });

  it("a new one-off item can be proposed on the quote; consigned stock is proposable (D265)", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const job = await newJob(tx);
      const requestId = randomUUID();
      const propose = () =>
        tx.query(
          "select public.propose_one_off_part($1, $2, $3, $4, $5, true, $6, $7, null, null)",
          [requestId, job.id, "Vintage Motohandlebars", 1, "120.00", consignorId, "60.00"],
        );
      await propose();
      const req = await readAsOwner(tx, async () => {
        const { rows } = await tx.query<{
          status: string;
          product_id: string;
          ownership: string;
          price: string;
        }>(
          `select r.status::text, r.product_id, p.ownership_type::text as ownership,
                  r.unit_sale_price::text as price
             from public.job_part_requests r join public.products p on p.id = r.product_id
            where r.id = $1`,
          [requestId],
        );
        return rows[0];
      });
      expect(req).toMatchObject({ status: "proposed", ownership: "consignment", price: "120.00" });
      expect(await onHand(tx, req.product_id)).toBe(1);
      // A repeat proposes nothing new.
      await propose();
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(
            tx,
            "select count(*)::int from public.job_part_requests where work_order_id = $1",
            [job.id],
          ),
        ),
      ).toBe(1);
      // The existing consigned product can be proposed again on its own.
      await tx.query("select public.propose_part($1, $2, $3, 1)", [
        randomUUID(),
        job.id,
        req.product_id,
      ]);
    });
  });
});
