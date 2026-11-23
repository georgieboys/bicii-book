/**
 * Where each consignor's stock is (SPEC §13, §23; DATA-MODEL §7, §9; PLAN
 * D44, D45 CONS-QTY-FIFO, D50 CONS-STOCK-MOVES, D54 CONS-ITEM-LOCATION):
 * every movement of a consigned product names its consignment item, so a
 * quantity item's stock is known per location
 * (private.consignment_item_on_hand). A sale, a job part, a return and a
 * transfer take an item's stock only where that item has it, and the sale
 * sheet (saleable_stock) offers each consignor only where their stock is.
 * The scenario is the one the Phase 6 review reproduced: two consignors'
 * identical jerseys on one product, the older consignor's at the Workshop
 * store and the newer one's on the Shop floor.
 *
 * Tests create products, items, jobs and sales (short-ID sequences), so the
 * file runs only on a per-file clone. Every test that writes stock ends with
 * assertLedgerConsistent() and the per-location invariant below.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import {
  createConsignor,
  intakeQuantity,
  intakeUnique,
  itemLedger,
  itemPosition,
  recordSale,
  returnItem,
  saleLines,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase } from "./harness";
import {
  ADMIN,
  MECHANIC2,
  addPart,
  assertLedgerConsistent,
  newJob,
  onHand,
  readAsOwner,
  transfer,
} from "./inventory-fixtures";
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

/** private.consignment_item_on_hand (owner: private is not exposed). */
const itemHere = (tx: pg.Client, itemId: string, locationId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{ n: number }>(
      "select private.consignment_item_on_hand($1, $2) as n",
      [itemId, locationId],
    );
    return rows[0].n;
  });

/**
 * D54's invariant for a product: every movement names its item, and at
 * every location the items' on-hand sums to the product's.
 */
async function assertItemsAddUp(tx: pg.Client, productId: string): Promise<void> {
  await readAsOwner(tx, async () => {
    const { rows: unnamed } = await tx.query(
      "select id from public.inventory_movements where product_id = $1 and consignment_item_id is null",
      [productId],
    );
    expect(unnamed).toEqual([]);
    const { rows } = await tx.query<{ location_id: string; product: number; items: number }>(
      `select m.location_id, sum(m.quantity_delta)::integer as product,
              (select coalesce(sum(private.consignment_item_on_hand(i.id, m.location_id)), 0)::integer
                 from public.consignment_items i where i.product_id = $1) as items
         from public.inventory_movements m
        where m.product_id = $1
        group by m.location_id`,
      [productId],
    );
    for (const r of rows) expect(r.items).toBe(r.product);
  });
}

type Offer = {
  kind: string;
  location_id: string;
  on_hand: number;
  consignment_item_id: string | null;
  unit_price: string;
};

/** What the sale sheet offers for `name`, as whoever `tx` is. */
async function offers(tx: pg.Client, name: string): Promise<Offer[]> {
  const { rows } = await tx.query<Offer>(
    `select kind, location_id, on_hand, consignment_item_id, unit_price::text
       from public.saleable_stock($1, 50) order by location_id, consignment_item_id`,
    [name],
  );
  return rows;
}

/**
 * Alpha (the older intake) has 5 jerseys at the Workshop store, Beta 5 on
 * the Shop floor, on one product, each at its own price.
 */
async function twoConsignorsTwoLocations(tx: pg.Client) {
  const name = `Jersey ${randomUUID().slice(0, 8)}`;
  const alphaConsignor = await createConsignor(tx, { displayName: "Alpha" });
  const betaConsignor = await createConsignor(tx, { displayName: "Beta" });
  const alpha = await intakeQuantity(tx, {
    consignorId: alphaConsignor,
    agreed: "20.00",
    asking: "40.00",
    quantity: 5,
    productName: name,
    locationId: LOCATION.workshopStore,
    receivedAt: "2026-01-02T02:00:00Z",
  });
  const productId = alpha.product_id;
  const beta = await intakeQuantity(tx, {
    consignorId: betaConsignor,
    agreed: "25.00",
    asking: "50.00",
    quantity: 5,
    productId,
    locationId: LOCATION.shopFloor,
    receivedAt: "2026-01-03T02:00:00Z",
  });
  return { name, productId, alpha: alpha.item_id, beta: beta.item_id };
}

describe.skipIf(!isolatedDatabase())("each consignor's stock where it is (D54)", () => {
  it("the sale sheet offers each consignor only at the location that holds their stock", async () => {
    await inTx(async (tx) => {
      const s = await twoConsignorsTwoLocations(tx);
      await actAs(tx, MECHANIC2);
      const rows = await offers(tx, s.name);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            kind: "product",
            location_id: LOCATION.workshopStore,
            on_hand: 5,
            consignment_item_id: s.alpha,
            unit_price: "40.00",
          },
          {
            kind: "product",
            location_id: LOCATION.shopFloor,
            on_hand: 5,
            consignment_item_id: s.beta,
            unit_price: "50.00",
          },
        ]),
      );
      // 10 jerseys exist; 10 are offered, never 20.
      expect(rows.reduce((n, r) => n + r.on_hand, 0)).toBe(10);
      await assertItemsAddUp(tx, s.productId);
    });
  });

  it("a sale with no item named takes the consignor whose stock is at that location, at their price and payout", async () => {
    await inTx(async (tx) => {
      const s = await twoConsignorsTwoLocations(tx);
      await actAs(tx, MECHANIC2);
      const sale = await recordSale(tx, {
        lines: [{ product_id: s.productId, location_id: LOCATION.shopFloor, quantity: 1 }],
      });
      await actAs(tx, ADMIN);
      expect(await saleLines(tx, sale.sale_id)).toMatchObject([
        {
          consignment_item_id: s.beta,
          unit_sale_price_snapshot: "50.00",
          consignor_payout_snapshot: "25.00",
        },
      ]);
      // The liability is Beta's, whose jersey left; Alpha's stock is untouched.
      expect(await itemLedger(tx, s.beta)).toMatchObject({ remaining_qty: 4, liability: "25.00" });
      expect(await itemLedger(tx, s.alpha)).toMatchObject({ remaining_qty: 5, liability: "0.00" });
      expect(await itemHere(tx, s.beta, LOCATION.shopFloor)).toBe(4);
      expect(await itemHere(tx, s.alpha, LOCATION.workshopStore)).toBe(5);

      // Naming Alpha's item where Alpha has nothing sells Beta's stock there
      // instead (D267); Alpha's at the Workshop store never answers for it.
      const named = await recordSale(tx, {
        lines: [
          {
            product_id: s.productId,
            location_id: LOCATION.shopFloor,
            quantity: 1,
            consignment_item_id: s.alpha,
          },
        ],
      });
      expect((await saleLines(tx, named.sale_id)).map((l) => l.consignment_item_id)).toEqual([
        s.beta,
      ]);
      // More than Beta has there (3), although the product has 8 in all:
      // Beta's 3, then 2 received on use from Beta, the latest consignor.
      const more = await recordSale(tx, {
        lines: [{ product_id: s.productId, location_id: LOCATION.shopFloor, quantity: 5 }],
      });
      const moreLines = await saleLines(tx, more.sale_id);
      expect(moreLines.map((l) => l.quantity)).toEqual(["3.00", "2.00"]);
      expect(moreLines[0].consignment_item_id).toBe(s.beta);
      expect([s.alpha, s.beta]).not.toContain(moreLines[1].consignment_item_id);
      expect(await itemHere(tx, s.alpha, LOCATION.workshopStore)).toBe(5);
      await assertItemsAddUp(tx, s.productId);
      await assertLedgerConsistent(tx);
    });
  });

  it("a job part draws FIFO only among the items with stock at the part's location", async () => {
    await inTx(async (tx) => {
      const s = await twoConsignorsTwoLocations(tx);
      const job = await newJob(tx);
      const part = await addPart(tx, {
        workOrderId: job.id,
        productId: s.productId,
        quantity: 2,
        locationId: LOCATION.shopFloor,
      });
      const { rows } = await readAsOwner(tx, () =>
        tx.query<{ consignment_item_id: string; consignor_payout_snapshot: string }>(
          `select consignment_item_id, consignor_payout_snapshot::text
             from public.work_order_line_items where id = $1`,
          [part.line_id],
        ),
      );
      expect(rows[0]).toEqual({ consignment_item_id: s.beta, consignor_payout_snapshot: "25.00" });
      const older = await addPart(tx, {
        workOrderId: job.id,
        productId: s.productId,
        quantity: 1,
        locationId: LOCATION.workshopStore,
      });
      const { rows: olderRows } = await readAsOwner(tx, () =>
        tx.query<{ consignment_item_id: string }>(
          "select consignment_item_id from public.work_order_line_items where id = $1",
          [older.line_id],
        ),
      );
      expect(olderRows[0].consignment_item_id).toBe(s.alpha);
      expect(await itemPosition(tx, s.beta)).toMatchObject({ job_held_qty: 2, remaining_qty: 3 });
      await assertItemsAddUp(tx, s.productId);
      await assertLedgerConsistent(tx);
    });
  });

  it("a transfer moves one consignor's stock, the oldest with that much there, and names it", async () => {
    await inTx(async (tx) => {
      const s = await twoConsignorsTwoLocations(tx);
      const rows = await transfer(tx, {
        productId: s.productId,
        from: LOCATION.workshopStore,
        to: LOCATION.shopFloor,
        quantity: 2,
        reason: "To the shop floor",
      });
      expect(rows.map((r) => r.quantity_delta)).toEqual([-2, 2]);
      const { rows: moved } = await readAsOwner(tx, () =>
        tx.query<{ consignment_item_id: string }>(
          `select consignment_item_id from public.inventory_movements
            where movement_type = 'transfer' and product_id = $1`,
          [s.productId],
        ),
      );
      expect(moved.map((m) => m.consignment_item_id)).toEqual([s.alpha, s.alpha]);
      expect(await itemHere(tx, s.alpha, LOCATION.shopFloor)).toBe(2);
      expect(await itemHere(tx, s.alpha, LOCATION.workshopStore)).toBe(3);

      // Alpha is now older and on the Shop floor: FIFO takes Alpha there.
      const sale = await recordSale(tx, {
        lines: [{ product_id: s.productId, location_id: LOCATION.shopFloor, quantity: 2 }],
      });
      expect((await saleLines(tx, sale.sale_id))[0].consignment_item_id).toBe(s.alpha);
      // 3 needs one consignor's stock: Beta has 5 on the Shop floor.
      const next = await recordSale(tx, {
        lines: [{ product_id: s.productId, location_id: LOCATION.shopFloor, quantity: 3 }],
      });
      expect((await saleLines(tx, next.sale_id))[0].consignment_item_id).toBe(s.beta);

      // No single consignor has 4 at the Workshop store (Alpha 3): one at a time.
      await failsWith(
        tx,
        () =>
          transfer(tx, {
            productId: s.productId,
            from: LOCATION.workshopStore,
            to: LOCATION.shopFloor,
            quantity: 4,
          }),
        { code: "P0001", message: "insufficient_stock" },
      );
      await transfer(tx, {
        productId: s.productId,
        from: LOCATION.shopFloor,
        to: LOCATION.workshopStore,
        quantity: 2,
      });
      // Workshop store: Alpha 3 + Beta 2; 4 in one go would mix consignors.
      await failsWith(
        tx,
        () =>
          transfer(tx, {
            productId: s.productId,
            from: LOCATION.workshopStore,
            to: LOCATION.shopFloor,
            quantity: 4,
          }),
        { code: "P0001", message: "consignment_quantity_unavailable" },
      );
      await assertItemsAddUp(tx, s.productId);
      await assertLedgerConsistent(tx);
    });
  });

  it("a return gives back only that consignor's stock at that location, never another's", async () => {
    await inTx(async (tx) => {
      const s = await twoConsignorsTwoLocations(tx);
      // Alpha has nothing on the Shop floor, although Beta has 5 there.
      await failsWith(
        tx,
        () => returnItem(tx, { itemId: s.alpha, quantity: 2, locationId: LOCATION.shopFloor }),
        { code: "P0001", message: "insufficient_stock" },
      );
      await transfer(tx, {
        productId: s.productId,
        from: LOCATION.workshopStore,
        to: LOCATION.shopFloor,
        quantity: 2,
      });
      // By default, all of Alpha's stock at that location.
      await returnItem(tx, { itemId: s.alpha, locationId: LOCATION.workshopStore });
      expect(await itemHere(tx, s.alpha, LOCATION.workshopStore)).toBe(0);
      expect(await itemPosition(tx, s.alpha)).toMatchObject({ returned_qty: 3, remaining_qty: 2 });
      expect(await onHand(tx, s.productId, LOCATION.shopFloor)).toBe(7);
      await returnItem(tx, { itemId: s.alpha, locationId: LOCATION.shopFloor });
      expect(await itemPosition(tx, s.alpha)).toMatchObject({ returned_qty: 5, remaining_qty: 0 });
      // Beta's five are still there and still Beta's.
      expect(await itemHere(tx, s.beta, LOCATION.shopFloor)).toBe(5);
      expect(await onHand(tx, s.productId, LOCATION.shopFloor)).toBe(5);
      await assertItemsAddUp(tx, s.productId);
      await assertLedgerConsistent(tx);
    });
  });

  it("a consigned unit's movements take its item; a consigned movement without one is refused", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const item = await intakeUnique(tx, { consignorId, agreed: "500.00" });
      await transfer(tx, {
        productId: item.product_id,
        from: LOCATION.shopFloor,
        to: LOCATION.workshopStore,
        unitId: item.inventory_unit_id,
      });
      await assertItemsAddUp(tx, item.product_id);
      expect(await itemHere(tx, item.item_id, LOCATION.workshopStore)).toBe(1);

      const s = await twoConsignorsTwoLocations(tx);
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.inventory_movements
               (product_id, location_id, quantity_delta, movement_type, request_id)
             values ($1, $2, -1, 'transfer', gen_random_uuid())`,
            [s.productId, LOCATION.shopFloor],
          ),
        { code: "P0001", message: "movement_invalid" },
      );
      await assertLedgerConsistent(tx);
    });
  });
});
