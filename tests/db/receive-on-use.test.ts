/**
 * Receive on use (PLAN D267, D268): a consigned part BICII holds too little
 * of is still put on the job; the missing quantity is received from the
 * consignor at that moment (received_on_use) and used, in one transaction.
 * Consigned stock never goes below zero. Add part (add_part_to_job) and Fit
 * (fit_part_request) both do it; a manager checks the item afterwards.
 *
 * Tests create jobs, products and consignments, so the file runs only on a
 * per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import { createConsignor, intakeQuantity } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { answerAll, fit, proposePart, sendQuote } from "./indent-fixtures";
import { ADMIN, MECHANIC1, makeProduct, newJob, onHand, readAsOwner } from "./inventory-fixtures";
import { ANON } from "./payment-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

/** A consigned product counted by quantity with no consignment yet (as the owner). */
async function consignedProduct(tx: pg.Client, price = "40.00"): Promise<string> {
  // There is always a consignor to receive from.
  await createConsignor(tx);
  await ownerMode(tx);
  const id = randomUUID();
  await tx.query(
    `insert into public.products (id, name, tracking_type, ownership_type, default_sale_price, publication_status)
     values ($1, $2, 'quantity', 'consignment', $3, 'internal_only')`,
    [id, `Consigned part ${id.slice(0, 8)}`, price],
  );
  await actAs(tx, ADMIN);
  return id;
}

type AddResult = {
  line_id: string;
  line_count: number;
  received_quantity: number;
  replayed: boolean;
};

const addPart = (
  tx: pg.Client,
  a: { lineId?: string; workOrderId: string; productId: string; quantity: number },
) =>
  tx
    .query<AddResult>(
      `select (r).line_id, (r).line_count, (r).received_quantity, (r).replayed
         from (select public.add_part_to_job($1, $2, $3, $4, null, null) r) s`,
      [a.lineId ?? randomUUID(), a.workOrderId, a.productId, a.quantity],
    )
    .then((r) => r.rows[0]);

const received = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      consignor_id: string;
      quantity: number;
      agreed: string;
      asking: string | null;
      received_on_use: boolean;
      checked: boolean;
    }>(
      `select consignor_id, quantity, agreed_amount_owed::text as agreed, asking_price::text as asking,
              received_on_use, use_checked_at is not null as checked
         from public.consignment_items where product_id = $1 order by received_at, short_id`,
      [productId],
    );
    return rows;
  });

const jobLines = (tx: pg.Client, workOrderId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      quantity: string;
      consigned: boolean;
      payout: string | null;
    }>(
      `select quantity::text, consignment_item_id is not null as consigned,
              consignor_payout_snapshot::text as payout
         from public.work_order_line_items where work_order_id = $1 and voided_at is null
        order by created_at, id`,
      [workOrderId],
    );
    return rows;
  });

describe.skipIf(!isolatedDatabase())("receive on use (D267, D268)", () => {
  it("a mechanic adds a consigned part BICII has none of: it is received, then used", async () => {
    await inTx(async (tx) => {
      const productId = await consignedProduct(tx, "40.00");
      const job = await newJob(tx);
      await actAs(tx, MECHANIC1);
      const r = await addPart(tx, { workOrderId: job.id, productId, quantity: 1 });
      expect(r).toMatchObject({ line_count: 1, received_quantity: 1, replayed: false });
      // D268: never consigned before, so half the price is owed.
      const items = await received(tx, productId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        quantity: 1,
        agreed: "20.00",
        asking: "40.00",
        received_on_use: true,
        checked: false,
      });
      expect(await jobLines(tx, job.id)).toEqual([
        { quantity: "1.00", consigned: true, payout: "20.00" },
      ]);
      // Received first, so it never went below zero.
      expect(await onHand(tx, productId)).toBe(0);
    });
  });

  it("uses what BICII holds first, then receives the rest from the same consignor at its terms", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const productId = await consignedProduct(tx, "40.00");
      await intakeQuantity(tx, {
        consignorId,
        productId,
        agreed: "15.00",
        asking: "40.00",
        quantity: 1,
      });
      const job = await newJob(tx);
      const r = await addPart(tx, { workOrderId: job.id, productId, quantity: 3 });
      expect(r).toMatchObject({ line_count: 2, received_quantity: 2 });
      const items = await received(tx, productId);
      expect(items.map((i) => [i.consignor_id, i.quantity, i.agreed, i.received_on_use])).toEqual([
        [consignorId, 1, "15.00", false],
        [consignorId, 2, "15.00", true],
      ]);
      expect(await jobLines(tx, job.id)).toEqual([
        { quantity: "1.00", consigned: true, payout: "15.00" },
        { quantity: "2.00", consigned: true, payout: "30.00" },
      ]);
      expect(await onHand(tx, productId)).toBe(0);
    });
  });

  it("is replay-safe by line id, and the id can't be reused for another part", async () => {
    await inTx(async (tx) => {
      const productId = await consignedProduct(tx);
      const other = await consignedProduct(tx);
      const job = await newJob(tx);
      const lineId = randomUUID();
      await addPart(tx, { lineId, workOrderId: job.id, productId, quantity: 2 });
      const again = await addPart(tx, { lineId, workOrderId: job.id, productId, quantity: 2 });
      expect(again.replayed).toBe(true);
      expect(await received(tx, productId)).toHaveLength(1);
      expect(await jobLines(tx, job.id)).toHaveLength(1);
      await failsWith(
        tx,
        () => addPart(tx, { lineId, workOrderId: job.id, productId: other, quantity: 1 }),
        {
          message: "line_conflict",
        },
      );
    });
  });

  it("shop stock is unchanged: it may go below zero (D23) and nothing is received", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const productId = await makeProduct(tx, { price: "12.00", cost: "5.00" });
      await actAs(tx, ADMIN);
      const job = await newJob(tx);
      const r = await addPart(tx, { workOrderId: job.id, productId, quantity: 2 });
      expect(r).toMatchObject({ line_count: 1, received_quantity: 0 });
      expect(await onHand(tx, productId, LOCATION.shopFloor)).toBe(-2);
      expect(await received(tx, productId)).toHaveLength(0);
    });
  });

  it("Fit receives a quoted consigned part BICII has none of", async () => {
    await inTx(async (tx) => {
      const productId = await consignedProduct(tx, "50.00");
      const job = await newJob(tx);
      const partId = await proposePart(tx, {
        workOrderId: job.id,
        productId,
        quantity: 1,
        price: "60.00",
      });
      const token = await sendQuote(tx, { workOrderId: job.id, requestIds: [partId] });
      await actAs(tx, ANON);
      await answerAll(tx, token);
      await actAs(tx, MECHANIC1);
      await fit(tx, partId);
      const items = await received(tx, productId);
      // Received at the quoted price; half of it is owed (D268).
      expect(items[0]).toMatchObject({
        quantity: 1,
        agreed: "30.00",
        asking: "60.00",
        received_on_use: true,
      });
      expect(
        await readAsOwner(tx, () =>
          scalar<string>(tx, "select status::text from public.job_part_requests where id = $1", [
            partId,
          ]),
        ),
      ).toBe("fitted");
    });
  });

  it("a manager checks it off; others can't", async () => {
    await inTx(async (tx) => {
      const productId = await consignedProduct(tx);
      const job = await newJob(tx);
      await addPart(tx, { workOrderId: job.id, productId, quantity: 1 });
      const itemId = await readAsOwner(tx, () =>
        scalar<string>(tx, "select id from public.consignment_items where product_id = $1", [
          productId,
        ]),
      );
      await actAs(tx, MECHANIC1);
      await failsWith(tx, () => tx.query("select public.check_received_on_use($1)", [itemId]), {
        code: "42501",
      });
      await actAs(tx, ADMIN);
      await tx.query("select public.check_received_on_use($1)", [itemId]);
      await tx.query("select public.check_received_on_use($1)", [itemId]);
      expect((await received(tx, productId))[0].checked).toBe(true);
    });
  });
});
