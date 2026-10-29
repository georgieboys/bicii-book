/**
 * A consigned product's cost on its page (D44, D162 follow-up): for a
 * consignment-owned product, public.product_costs reports the amount owed
 * on the consignment that sells next (the item private.selling_price
 * prices: the oldest active item with stock) as `effective_cost`, and its
 * expected yield and Cult Commons from it, so Edit terms changes the
 * product's cost too. The product's own default_direct_cost is left as it
 * is (a reclassified product keeps the cost it had as shop stock) and is no
 * longer what its page calls the cost. Shop products are unchanged.
 *
 * Tests create products and items (short-ID sequences), so the file runs
 * only on a per-file clone.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION } from "../fixtures/ids";
import {
  createConsignor,
  intakeQuantity,
  returnItem,
  sellingPrice,
  updateTerms,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import { ADMIN, addStock, makeProduct } from "./inventory-fixtures";
import { ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Costs = {
  default_direct_cost: string | null;
  effective_cost: string | null;
  expected_yield: string | null;
  expected_cult_commons: string | null;
};

const costs = async (tx: pg.Client, productId: string): Promise<Costs> => {
  const { rows } = await tx.query<Costs>(
    `select default_direct_cost::text, effective_cost::text, expected_yield::text,
            expected_cult_commons::text
       from public.product_costs where product_id = $1`,
    [productId],
  );
  return rows[0];
};

/** Cult Commons on a yield at today's rate, as product_costs rounds it. */
const share = (tx: pg.Client, yieldAmount: string) =>
  scalar<string>(
    tx,
    "select round(greatest($1::numeric, 0) * private.cult_commons_rate_at(now()), 2)::text",
    [yieldAmount],
  );

async function shopProduct(tx: pg.Client, o: Parameters<typeof makeProduct>[1]): Promise<string> {
  await ownerMode(tx);
  const id = await makeProduct(tx, o);
  await actAs(tx, ADMIN);
  return id;
}

describe.skipIf(!isolatedDatabase())("a consigned product's cost (product_costs)", () => {
  it("is the amount owed on the consignment that sells next, and follows Edit terms", async () => {
    await inTx(async (tx) => {
      const productId = await shopProduct(tx, { price: "20.00", cost: "4.00" });
      await addStock(tx, productId, 5);
      const consignorId = await createConsignor(tx, { displayName: "The owner" });
      const itemId = randomUUID();
      await tx.query(
        `select public.reclassify_as_consignment(
           item_id => $1, product_id => $2, consignor_id => $3, agreed_amount_owed => 8.00,
           reason => 'Entered as shop stock by mistake')`,
        [itemId, productId, consignorId],
      );

      expect(await costs(tx, productId)).toEqual({
        default_direct_cost: "4.00",
        effective_cost: "8.00",
        expected_yield: "12.00",
        expected_cult_commons: await share(tx, "12.00"),
      });

      await updateTerms(tx, itemId, { agreed: "6.00", reason: "Agreed with the owner" });
      expect(await costs(tx, productId)).toMatchObject({
        default_direct_cost: "4.00",
        effective_cost: "6.00",
        expected_yield: "14.00",
        expected_cult_commons: await share(tx, "14.00"),
      });

      // A later consignment of the same product: the first still sells first.
      const second = await intakeQuantity(tx, {
        consignorId,
        productId,
        quantity: 2,
        agreed: "10.00",
        asking: "30.00",
      });
      expect(await sellingPrice(tx, productId)).toBe("20.00");
      expect((await costs(tx, productId)).effective_cost).toBe("6.00");

      // The first goes back: the second is next, at its own price and cost.
      await returnItem(tx, { itemId, locationId: LOCATION.shopFloor });
      expect(await sellingPrice(tx, productId)).toBe("30.00");
      expect(await costs(tx, productId)).toMatchObject({
        effective_cost: "10.00",
        expected_yield: "20.00",
      });

      // Nothing left with the shop: no cost and no yield.
      await returnItem(tx, { itemId: second.item_id, locationId: LOCATION.shopFloor });
      expect(await costs(tx, productId)).toMatchObject({
        default_direct_cost: "4.00",
        effective_cost: null,
        expected_yield: null,
        expected_cult_commons: null,
      });
    });
  });

  it("is the product's own cost for shop stock, as before", async () => {
    await inTx(async (tx) => {
      const costed = await shopProduct(tx, { price: "20.00", cost: "8.00" });
      expect(await costs(tx, costed)).toEqual({
        default_direct_cost: "8.00",
        effective_cost: "8.00",
        expected_yield: "12.00",
        expected_cult_commons: await share(tx, "12.00"),
      });
      const uncosted = await shopProduct(tx, { price: "20.00", cost: null });
      expect(await costs(tx, uncosted)).toMatchObject({
        default_direct_cost: null,
        effective_cost: null,
        expected_yield: null,
      });
    });
  });
});
