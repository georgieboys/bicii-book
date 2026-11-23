/**
 * Receive on use at the counter (PLAN D267, D268): a counter sale of a
 * consigned quantity item BICII holds too little of at that location is
 * recorded anyway. What the named consignment and then the oldest
 * consignments hold there is sold first, one sale line per consignment
 * (D54); the rest is received from the consignor at that moment
 * (received_on_use) and sold, in one transaction. Consigned stock never
 * goes below zero; shop stock is refused as before.
 *
 * Tests create products, consignments and sales, so the file runs only on
 * a per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import {
  createConsignor,
  intakeQuantity,
  itemStatus,
  recordSale,
  saleLines,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  addStock,
  assertLedgerConsistent,
  makeProduct,
  onHand,
  readAsOwner,
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

/** A consigned product counted by quantity with no consignment yet (as the owner). */
async function consignedProduct(
  tx: pg.Client,
  price = "40.00",
): Promise<{ id: string; name: string }> {
  // There is always a consignor to receive from.
  await createConsignor(tx);
  await ownerMode(tx);
  const id = randomUUID();
  const name = `Consigned bidon ${id.slice(0, 8)}`;
  await tx.query(
    `insert into public.products (id, name, tracking_type, ownership_type, default_sale_price, publication_status)
     values ($1, $2, 'quantity', 'consignment', $3, 'internal_only')`,
    [id, name, price],
  );
  await actAs(tx, ADMIN);
  return { id, name };
}

const items = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      id: string;
      consignor_id: string;
      quantity: number;
      agreed: string;
      asking: string | null;
      received_on_use: boolean;
      status: string;
      note: string | null;
      received_at: Date;
    }>(
      `select id, consignor_id, quantity, agreed_amount_owed::text as agreed, asking_price::text as asking,
              received_on_use, status::text, internal_notes as note, received_at
         from public.consignment_items where product_id = $1 order by received_at, short_id`,
      [productId],
    );
    return rows;
  });

/** What the sale sheet offers for `q` (any staff). */
const offers = (tx: pg.Client, q: string) =>
  tx
    .query<{
      product_id: string;
      location_id: string;
      on_hand: number;
      consignment_item_id: string | null;
      subtitle: string;
      unit_price: string;
    }>(
      `select product_id, location_id, on_hand, consignment_item_id, subtitle, unit_price::text
         from public.saleable_stock($1, 50)`,
      [q],
    )
    .then((r) => r.rows);

describe.skipIf(!isolatedDatabase())("counter sale receives on use (D267, D268)", () => {
  it("a consigned item with nothing recorded is offered, then received and sold", async () => {
    await inTx(async (tx) => {
      const product = await consignedProduct(tx, "40.00");
      await actAs(tx, MECHANIC1);
      const offered = (await offers(tx, product.name)).filter((o) => o.product_id === product.id);
      expect(offered).toHaveLength(1);
      expect(offered[0]).toMatchObject({
        on_hand: 0,
        consignment_item_id: null,
        unit_price: "40.00",
      });
      expect(offered[0].subtitle).toContain("Consigned · none recorded: received when sold");

      const sale = await recordSale(tx, {
        lines: [{ product_id: product.id, location_id: LOCATION.shopFloor, quantity: 2 }],
      });
      expect(sale.replayed).toBe(false);
      const received = await items(tx, product.id);
      expect(received).toHaveLength(1);
      // D268: never consigned before, so half the price is owed.
      expect(received[0]).toMatchObject({
        quantity: 2,
        agreed: "20.00",
        asking: "40.00",
        received_on_use: true,
        status: "sold",
        note: `Received on use for counter sale ${sale.sale_number}`,
      });
      const lines = await saleLines(tx, sale.sale_id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        consignment_item_id: received[0].id,
        quantity: "2.00",
        unit_sale_price_snapshot: "40.00",
        consignor_payout_snapshot: "20.00",
        sale_total: "80.00",
      });
      // Received first, so it never went below zero.
      expect(await onHand(tx, product.id)).toBe(0);
      await actAs(tx, ADMIN);
      await assertLedgerConsistent(tx);
    });
  });

  it("sells what the consignments hold there first (the named one, then the oldest), then receives the rest", async () => {
    await inTx(async (tx) => {
      const older = await createConsignor(tx, { displayName: "Older consignor" });
      const newer = await createConsignor(tx, { displayName: "Newer consignor" });
      const product = await consignedProduct(tx, "40.00");
      const a = await intakeQuantity(tx, {
        consignorId: older,
        productId: product.id,
        agreed: "15.00",
        asking: "40.00",
        quantity: 2,
        receivedAt: "2026-01-02T02:00:00Z",
      });
      const b = await intakeQuantity(tx, {
        consignorId: newer,
        productId: product.id,
        agreed: "18.00",
        asking: "45.00",
        quantity: 1,
        receivedAt: "2026-01-03T02:00:00Z",
      });
      // The sheet names b (its row); b has 1, a has 2: 4 needs one more.
      const sale = await recordSale(tx, {
        lines: [
          {
            product_id: product.id,
            location_id: LOCATION.shopFloor,
            quantity: 4,
            consignment_item_id: b.item_id,
          },
        ],
      });
      const all = await items(tx, product.id);
      const got = all.find((i) => i.received_on_use);
      expect(got).toMatchObject({
        consignor_id: newer,
        quantity: 1,
        agreed: "18.00",
        asking: "45.00",
      });
      const lines = await saleLines(tx, sale.sale_id);
      expect(
        lines.map((l) => [
          l.line_number,
          l.consignment_item_id,
          l.quantity,
          l.unit_sale_price_snapshot,
          l.consignor_payout_snapshot,
        ]),
      ).toEqual([
        [1, b.item_id, "1.00", "45.00", "18.00"],
        [2, a.item_id, "2.00", "40.00", "15.00"],
        [3, got!.id, "1.00", "45.00", "18.00"],
      ]);
      expect(await itemStatus(tx, a.item_id)).toBe("sold");
      expect(await itemStatus(tx, b.item_id)).toBe("sold");
      expect(await onHand(tx, product.id)).toBe(0);
      await assertLedgerConsistent(tx);
    });
  });

  it("a line one consignment covers is sold as before: one line, nothing received", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const product = await consignedProduct(tx);
      const a = await intakeQuantity(tx, {
        consignorId,
        productId: product.id,
        agreed: "10.00",
        asking: "30.00",
        quantity: 3,
      });
      const sale = await recordSale(tx, {
        lines: [{ product_id: product.id, location_id: LOCATION.shopFloor, quantity: 2 }],
      });
      expect((await saleLines(tx, sale.sale_id)).map((l) => l.consignment_item_id)).toEqual([
        a.item_id,
      ]);
      expect((await items(tx, product.id)).some((i) => i.received_on_use)).toBe(false);
      expect(await onHand(tx, product.id)).toBe(1);
    });
  });

  it("a sale dated earlier receives at the sale's time (D55 holds)", async () => {
    await inTx(async (tx) => {
      const product = await consignedProduct(tx);
      const at = await scalar<string>(
        tx,
        `select to_char(date_trunc('milliseconds', now() - interval '2 days') at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      );
      const sale = await recordSale(tx, {
        lines: [{ product_id: product.id, location_id: LOCATION.shopFloor, quantity: 1 }],
        recognizedAt: at,
      });
      const [item] = await items(tx, product.id);
      expect(item.received_on_use).toBe(true);
      expect(item.received_at.toISOString()).toBe(new Date(at).toISOString());
      expect(sale.recognized_at.toISOString()).toBe(new Date(at).toISOString());
    });
  });

  it("shop stock is unchanged: a sale never takes it below zero and nothing is received", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const productId = await makeProduct(tx, { price: "12.00", cost: "5.00" });
      await actAs(tx, ADMIN);
      await addStock(tx, productId, 1);
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, location_id: LOCATION.shopFloor, quantity: 2 }],
          }),
        { code: "P0001", message: "insufficient_stock" },
      );
      expect(await onHand(tx, productId)).toBe(1);
      expect(await items(tx, productId)).toHaveLength(0);
    });
  });

  it("is replay-safe by sale id: one receipt, the same lines; another payload is sale_conflict", async () => {
    await inTx(async (tx) => {
      const product = await consignedProduct(tx);
      const saleId = randomUUID();
      const lines = [{ product_id: product.id, location_id: LOCATION.shopFloor, quantity: 2 }];
      const first = await recordSale(tx, { saleId, lines });
      const again = await recordSale(tx, { saleId, lines });
      expect(again).toMatchObject({
        sale_id: first.sale_id,
        sale_number: first.sale_number,
        replayed: true,
      });
      expect(await items(tx, product.id)).toHaveLength(1);
      expect(await saleLines(tx, saleId)).toHaveLength(1);
      expect(await onHand(tx, product.id)).toBe(0);
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            saleId,
            lines: [{ product_id: product.id, location_id: LOCATION.shopFloor, quantity: 3 }],
          }),
        { code: "P0001", message: "sale_conflict" },
      );
      expect(await items(tx, product.id)).toHaveLength(1);
    });
  });
});
