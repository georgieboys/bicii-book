/**
 * Reclassifying shop stock entered by mistake as consigned stock (PLAN
 * D162, DATA-MODEL §9 and §16; D45's exception). public.reclassify_as_consignment
 * turns a shop-owned quantity product whose only history is stock counts
 * (stock adjustments, damaged stock, transfers) into consigned stock of one
 * consignor: the shop's stock is counted out with a stock adjustment, the
 * product's owner becomes consignment, and the same quantity is taken in
 * through create_consignment_item on the same product, so its P- number and
 * printed labels stay valid. Anything with trading history (a sale, a job
 * part, a purchase, an indent request, a Shopify link) or unit tracking is
 * refused, and only an admin may run it.
 *
 * Tests create products, items and jobs (short-ID sequences), so the file
 * runs only on a per-file clone. Every test that writes stock ends with
 * assertLedgerConsistent().
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import {
  createConsignor,
  intakeQuantity,
  itemEvents,
  itemMovements,
  itemPosition,
  itemRow,
  sellingPrice,
  staffWith,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MANAGER,
  addPart,
  addStock,
  assertLedgerConsistent,
  makeProduct,
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

/** A rolled-back transaction acting as the admin. */
const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Reclassified = {
  product_id: string;
  consignment_item_id: string | null;
  consignment_item_short_id: string | null;
  quantity: number;
  location_id: string | null;
};

/** public.reclassify_as_consignment as whoever `tx` is. */
async function reclassify(
  tx: pg.Client,
  a: {
    itemId?: string;
    productId: string;
    consignorId: string;
    agreed: string | null;
    reason?: string | null;
    asking?: string | null;
    receivedAt?: string | null;
  },
): Promise<Reclassified> {
  const { rows } = await tx.query<Reclassified>(
    `select (r).product_id, (r).consignment_item_id, (r).consignment_item_short_id, (r).quantity,
            (r).location_id
       from (select public.reclassify_as_consignment(
               item_id => $1, product_id => $2, consignor_id => $3, agreed_amount_owed => $4,
               reason => $5, asking_price => $6, received_at => $7
             ) r) s`,
    [
      a.itemId ?? randomUUID(),
      a.productId,
      a.consignorId,
      a.agreed,
      a.reason === undefined ? "Entered as shop stock by mistake; the owner's own items" : a.reason,
      a.asking ?? null,
      a.receivedAt ?? null,
    ],
  );
  return rows[0];
}

/** The product's owner, short ID and default price (read as the owner). */
const productRow = (tx: pg.Client, productId: string) =>
  readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      ownership_type: string;
      short_id: string;
      default_sale_price: string;
    }>(
      "select ownership_type::text, short_id, default_sale_price::text from public.products where id = $1",
      [productId],
    );
    return rows[0];
  });

/** A consignor, inserted as the admin (a manage_consignments column grant). */
const consignor = (tx: pg.Client) => createConsignor(tx, { displayName: "The owner, consigning" });

/** A shop-owned product (an owner insert), then back to the admin. */
async function shopProduct(
  tx: pg.Client,
  o: Parameters<typeof makeProduct>[1] = {},
): Promise<string> {
  await ownerMode(tx);
  const id = await makeProduct(tx, o);
  await actAs(tx, ADMIN);
  return id;
}

describe.skipIf(!isolatedDatabase())("reclassify_as_consignment (D162)", () => {
  it("turns shop stock with only stock counts into consigned stock on the same product", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx, { price: "20.00", cost: "8.00" });
      const before = await productRow(tx, productId);
      await addStock(tx, productId, 5);
      await addStock(tx, productId, -1, { reason: "Recount" });
      const consignorId = await consignor(tx);

      const result = await reclassify(tx, { productId, consignorId, agreed: "8.00" });

      expect(result.product_id).toBe(productId);
      expect(result.quantity).toBe(4);
      expect(result.location_id).toBe(LOCATION.shopFloor);
      expect(result.consignment_item_short_id).toMatch(/^C-\d{6}$/);
      const after = await productRow(tx, productId);
      expect(after.ownership_type).toBe("consignment");
      expect(after.short_id).toBe(before.short_id);
      expect(await onHand(tx, productId)).toBe(4);

      const item = await itemRow(tx, result.consignment_item_id!);
      expect(item).toMatchObject({
        consignor_id: consignorId,
        product_id: productId,
        quantity: 4,
        agreed_amount_owed: "8.00",
        asking_price: "20.00",
        status: "active",
      });
      expect((await itemPosition(tx, item.id)).remaining_qty).toBe(4);
      expect(await sellingPrice(tx, productId)).toBe("20.00");

      const moves = await itemMovements(tx, productId);
      const [offset, received] = moves.slice(-2);
      expect(offset).toMatchObject({
        movement_type: "stock_adjustment",
        quantity_delta: -4,
        consignment_item_id: null,
      });
      expect(offset.reason).toMatch(
        /^Reclassified as consigned stock: Entered as shop stock by mistake/,
      );
      expect(received).toMatchObject({
        movement_type: "consignment_received",
        quantity_delta: 4,
        consignment_item_id: item.id,
        unit_cost_snapshot: "8.00",
      });
      expect((await itemEvents(tx, item.id)).map((e) => e.event_type)).toContain("received");

      const fields = await readAsOwner(tx, () =>
        scalar<string[]>(
          tx,
          `select array(select jsonb_array_elements_text(payload -> 'fields'))
             from public.product_events
            where product_id = $1 and event_type = 'details_changed'
            order by created_at desc, id desc limit 1`,
          [productId],
        ),
      );
      expect(fields).toContain("ownership_type");
      await assertLedgerConsistent(tx);
    });
  });

  it("takes an asking price and an intake date when given", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx, { price: "20.00" });
      await addStock(tx, productId, 3);
      const consignorId = await consignor(tx);
      const receivedAt = "2026-10-01T10:00:00+08:00";

      const result = await reclassify(tx, {
        productId,
        consignorId,
        agreed: "12.50",
        asking: "25.00",
        receivedAt,
      });

      const item = await itemRow(tx, result.consignment_item_id!);
      expect(item).toMatchObject({
        agreed_amount_owed: "12.50",
        asking_price: "25.00",
        quantity: 3,
      });
      const received = await readAsOwner(tx, () =>
        scalar<Date>(tx, "select received_at from public.consignment_items where id = $1", [
          item.id,
        ]),
      );
      expect(received.toISOString()).toBe(new Date(receivedAt).toISOString());
      expect(await sellingPrice(tx, productId)).toBe("25.00");
      await assertLedgerConsistent(tx);
    });
  });

  it("only changes the owner of a product that has no stock", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      const consignorId = await consignor(tx);

      const result = await reclassify(tx, { productId, consignorId, agreed: "8.00" });

      expect(result).toMatchObject({
        product_id: productId,
        consignment_item_id: null,
        consignment_item_short_id: null,
        quantity: 0,
        location_id: null,
      });
      expect((await productRow(tx, productId)).ownership_type).toBe("consignment");
      const items = await readAsOwner(tx, () =>
        scalar<number>(
          tx,
          "select count(*)::int from public.consignment_items where product_id = $1",
          [productId],
        ),
      );
      expect(items).toBe(0);
      // Its stock now comes in through intake like any consigned product.
      const intake = await intakeQuantity(tx, {
        consignorId,
        agreed: "5.00",
        quantity: 2,
        productId,
      });
      expect(intake.product_id).toBe(productId);
      await assertLedgerConsistent(tx);
    });
  });

  it("counts stock moved between locations, but refuses stock in two places", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 4);
      await transfer(tx, {
        productId,
        from: LOCATION.shopFloor,
        to: LOCATION.workshopStore,
        quantity: 1,
      });
      const consignorId = await consignor(tx);

      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: "8.00" }), {
        code: "P0001",
        message: "reclassify_several_locations",
      });

      await transfer(tx, {
        productId,
        from: LOCATION.workshopStore,
        to: LOCATION.shopFloor,
        quantity: 1,
      });
      const result = await reclassify(tx, { productId, consignorId, agreed: "8.00" });
      expect(result.quantity).toBe(4);
      await assertLedgerConsistent(tx);
    });
  });

  it("replays by item id, and refuses the same item id for another product", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 2);
      const consignorId = await consignor(tx);
      const itemId = randomUUID();

      const first = await reclassify(tx, { itemId, productId, consignorId, agreed: "8.00" });
      const again = await reclassify(tx, { itemId, productId, consignorId, agreed: "8.00" });
      expect(again).toEqual(first);
      expect(await onHand(tx, productId)).toBe(2);

      const other = await shopProduct(tx);
      await addStock(tx, other, 1);
      await failsWith(
        tx,
        () => reclassify(tx, { itemId, productId: other, consignorId, agreed: "8.00" }),
        {
          code: "P0001",
          message: "consignment_item_conflict",
        },
      );
      // A second reclassification of the same product is not a replay.
      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: "8.00" }), {
        code: "P0001",
        message: "product_not_shop_owned",
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses a product with trading history", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 3);
      const consignorId = await consignor(tx);
      const job = await newJob(tx);
      await addPart(tx, { workOrderId: job.id, productId, quantity: 1 });

      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: "8.00" }), {
        code: "P0001",
        message: "product_has_trading_history",
      });
      expect((await productRow(tx, productId)).ownership_type).toBe("shop_owned");
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses unique, archived and already consigned products", async () => {
    await inTx(async (tx) => {
      const consignorId = await consignor(tx);
      const unique = await shopProduct(tx, { tracking: "unique" });
      await failsWith(
        tx,
        () => reclassify(tx, { productId: unique, consignorId, agreed: "8.00" }),
        {
          code: "P0001",
          message: "reclassify_not_quantity",
        },
      );

      const archived = await shopProduct(tx);
      await ownerMode(tx);
      await tx.query("update public.products set archived_at = now() where id = $1", [archived]);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => reclassify(tx, { productId: archived, consignorId, agreed: "8.00" }),
        {
          code: "P0001",
          message: "product_archived",
        },
      );

      const consigned = await intakeQuantity(tx, { consignorId, agreed: "5.00", quantity: 2 });
      await failsWith(
        tx,
        () => reclassify(tx, { productId: consigned.product_id, consignorId, agreed: "5.00" }),
        { code: "P0001", message: "product_not_shop_owned" },
      );
      await assertLedgerConsistent(tx);
    });
  });

  it("needs a reason and an agreed amount", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 1);
      const consignorId = await consignor(tx);
      await failsWith(
        tx,
        () => reclassify(tx, { productId, consignorId, agreed: "8.00", reason: "  " }),
        {
          code: "P0001",
          message: "reason_required",
        },
      );
      await failsWith(
        tx,
        () => reclassify(tx, { productId, consignorId, agreed: "8.00", reason: "x".repeat(461) }),
        { code: "P0001", message: "reason_too_long" },
      );
      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: null }), {
        code: "22004",
      });
    });
  });

  it("is for admins only", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 1);
      const consignorId = await consignor(tx);
      await ownerMode(tx);
      const holder = await staffWith(tx, [
        "manage_consignments",
        "adjust_stock",
        "manage_inventory",
      ]);
      await actAs(tx, holder.claims);
      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: "8.00" }), {
        code: "42501",
      });
      await actAs(tx, MANAGER);
      await failsWith(tx, () => reclassify(tx, { productId, consignorId, agreed: "8.00" }), {
        code: "42501",
      });
    });
  });

  it("leaves D45 in force for everyone else", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx);
      await addStock(tx, productId, 1);
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.products set ownership_type = 'consignment' where id = $1", [
            productId,
          ]),
        { code: "P0001", message: "product_ownership_immutable" },
      );
    });
  });

  it("sells as consigned stock afterwards: the consignor is owed the agreed amount", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx, { price: "20.00", cost: "8.00" });
      await addStock(tx, productId, 2);
      const consignorId = await consignor(tx);
      const result = await reclassify(tx, { productId, consignorId, agreed: "6.00" });

      const job = await newJob(tx);
      const part = await addPart(tx, { workOrderId: job.id, productId, quantity: 1 });
      const line = await readAsOwner(tx, async () => {
        const { rows } = await tx.query<{
          consignment_item_id: string;
          consignor_payout_snapshot: string;
          unit_direct_cost_snapshot: string;
          unit_sale_price_snapshot: string;
        }>(
          `select consignment_item_id, consignor_payout_snapshot::text, unit_direct_cost_snapshot::text,
                  unit_sale_price_snapshot::text
             from public.work_order_line_items where id = $1`,
          [part.line_id],
        );
        return rows[0];
      });
      expect(line).toEqual({
        consignment_item_id: result.consignment_item_id,
        consignor_payout_snapshot: "6.00",
        unit_direct_cost_snapshot: "6.00",
        unit_sale_price_snapshot: "20.00",
      });
      expect(await onHand(tx, productId)).toBe(1);
      await assertLedgerConsistent(tx);
    });
  });
});
