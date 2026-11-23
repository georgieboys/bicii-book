/**
 * In-store sales, restocks and retail refunds (SPEC §2 "Financial
 * snapshots", "Idempotent ... mutations", §10, §12, §13, §23, §27.2; DATA-MODEL
 * §7, §8, §9, §16; PLAN D1, D7, D9, D14, D24 (amended), D26, D29, D44, D45
 * CONS-QTY-FIFO, D46 CONS-RESTOCK, D48 SALES-ACCESS, D49 RETAIL-REFUND, D50,
 * D53 PRICE-OVERRIDE).
 *
 * Tests create products, units, items and sales (the P, U, C and S
 * sequences), so the file runs only on a per-file clone. They assert only on
 * rows they created and never on exact S- or C- numbers (format only).
 * Every test that writes stock ends with assertLedgerConsistent().
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { LOCATION, STAFF } from "../fixtures/ids";
import {
  addCharge,
  createConsignor,
  intakeQuantity,
  intakeUnique,
  itemEvents,
  itemLedger,
  itemStatus,
  recordSale,
  refund,
  restock,
  returnItem,
  saleLines,
  sellingPrice,
  settle,
  staffWith,
  updateTerms,
} from "./consignment-fixtures";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar } from "./harness";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  addPart,
  addPublicPhoto,
  addStock,
  assertLedgerConsistent,
  completeJob,
  makeLocation,
  makeProduct,
  makeUniqueWithUnit,
  makeUnit,
  newJob,
  onHand,
  publication,
  publishProduct,
  readAsOwner,
  unit,
} from "./inventory-fixtures";
import { failsWith, makeBike, makeCustomer, ownerMode } from "./workshop-fixtures";

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

/** A shop-owned quantity product with `stock` at the Shop floor; ends acting as the admin. */
async function quantityProduct(
  tx: pg.Client,
  {
    price = "20.00",
    cost = "8.00",
    stock = 10,
    name,
  }: { price?: string | null; cost?: string | null; stock?: number; name?: string } = {},
): Promise<string> {
  await ownerMode(tx);
  const id = await makeProduct(tx, { price, cost, name });
  await actAs(tx, ADMIN);
  if (stock > 0) await addStock(tx, id, stock);
  return id;
}

/** A product's movements with their sale-line and item links (owner). */
async function saleMovements(tx: pg.Client, productId: string) {
  const { rows } = await readAsOwner(tx, () =>
    tx.query<{
      movement_type: string;
      quantity_delta: number;
      location_id: string;
      inventory_unit_id: string | null;
      sale_line_id: string | null;
      consignment_item_id: string | null;
      unit_cost_snapshot: string | null;
      reason: string | null;
    }>(
      `select movement_type::text, quantity_delta, location_id, inventory_unit_id, sale_line_id,
              consignment_item_id, unit_cost_snapshot::text, reason
         from public.inventory_movements where product_id = $1 order by id`,
      [productId],
    ),
  );
  return rows;
}

/** A unit's sale columns (owner: sold_sale_line_id is granted, read with the rest). */
async function unitSale(tx: pg.Client, unitId: string) {
  return readAsOwner(tx, async () => {
    const { rows } = await tx.query<{
      status: string;
      sold_at: Date | null;
      sold_sale_line_id: string | null;
      location_id: string;
    }>(
      "select status::text, sold_at, sold_sale_line_id, location_id from public.inventory_units where id = $1",
      [unitId],
    );
    return rows[0];
  });
}

const saleStatus = (tx: pg.Client, saleId: string) =>
  scalar<string>(tx, "select status::text from public.sales where id = $1", [saleId]);

/** `h` hours ago as an ISO string (millisecond precision, as a JS Date), from the database clock. */
const hoursAgo = (tx: pg.Client, h: number) =>
  scalar<string>(
    tx,
    `select to_char(date_trunc('milliseconds', now() - make_interval(hours => $1)) at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    [h],
  );

describe.skipIf(!isolatedDatabase())("record_retail_sale: units (D9, D24, D26)", () => {
  it("a shop-owned unit sale: an S- number, the selling price and cost snapshotted with their totals, one linked retail_sale movement, the unit sold at recognized_at", async () => {
    await inTx(async (tx) => {
      const { productId, unitId, unitShortId } = await makeUniqueWithUnit(tx, {
        name: "Trek Emonda SL 5",
        price: "1200.00",
        cost: "700.00",
      });
      await ownerMode(tx);
      await addPublicPhoto(tx, "product", productId);
      await actAs(tx, ADMIN);
      await publishProduct(tx, productId);
      expect(await sellingPrice(tx, productId, unitId)).toBe("1200.00");

      const at = await hoursAgo(tx, 2);
      const sale = await recordSale(tx, {
        lines: [{ inventory_unit_id: unitId }],
        recognizedAt: at,
      });
      expect(sale.sale_number).toMatch(/^S-\d{6}$/);
      expect(sale).toMatchObject({ status: "recorded", replayed: false });
      expect(sale.recognized_at.toISOString()).toBe(at);

      const [line] = await saleLines(tx, sale.sale_id);
      expect(line).toMatchObject({
        line_number: 1,
        product_id: productId,
        inventory_unit_id: unitId,
        consignment_item_id: null,
        description_snapshot: `Trek Emonda SL 5 · ${unitShortId}`,
        quantity: "1.00",
        unit_sale_price_snapshot: "1200.00",
        unit_direct_cost_snapshot: "700.00",
        consignor_payout_snapshot: null,
        cult_commons_rate_snapshot: "0.3000",
        sale_total: "1200.00",
        cost_total: "700.00",
        yield_total: "500.00",
        cult_commons_share: "150.00",
        shopify_line_item_id: null,
        restocked_at: null,
      });
      expect(await saleMovements(tx, productId)).toEqual([
        expect.objectContaining({ movement_type: "stock_adjustment", quantity_delta: 1 }),
        {
          movement_type: "retail_sale",
          quantity_delta: -1,
          location_id: LOCATION.shopFloor,
          inventory_unit_id: unitId,
          sale_line_id: line.id,
          consignment_item_id: null,
          unit_cost_snapshot: "700.00",
          reason: null,
        },
      ]);
      const u = await unitSale(tx, unitId);
      expect(u).toMatchObject({ status: "sold", sold_sale_line_id: line.id });
      expect(u.sold_at?.toISOString()).toBe(at);
      // A public unique product with no other unit in stock is sold (D26).
      expect(await publication(tx, productId)).toBe("sold");

      // shopify_line_item_id is written at insert only.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.sale_lines set shopify_line_item_id = 'gid://x' where id = $1", [
            line.id,
          ]),
        { code: "P0001", message: "sale_lines_immutable" },
      );
      await actAs(tx, ADMIN);
      await assertLedgerConsistent(tx);
    });
  });

  it("a unit already sold is refused (unit_already_sold), a held or written-off one is not available, a customer's is not saleable", async () => {
    await inTx(async (tx) => {
      const { productId, unitId } = await makeUniqueWithUnit(tx, { cost: "100.00" });
      await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      await failsWith(tx, () => recordSale(tx, { lines: [{ inventory_unit_id: unitId }] }), {
        code: "P0001",
        message: "unit_already_sold",
      });

      // A unit held on an open job cannot be sold (D25).
      const held = await makeUnit(tx, productId);
      const job = await newJob(tx);
      await addPart(tx, { workOrderId: job.id, productId, unitId: held.unit_id });
      await failsWith(tx, () => recordSale(tx, { lines: [{ inventory_unit_id: held.unit_id }] }), {
        code: "P0001",
        message: "unit_not_available",
      });

      // Customer-owned stock is never sold.
      await ownerMode(tx);
      const customerUnit = randomUUID();
      await tx.query(
        `select private.register_unit($1, $2, $3, 'customer_owned', null, null, null, 100.00, null, null)`,
        [customerUnit, productId, LOCATION.shopFloor],
      );
      await tx.query(
        `select private.record_movement($1, $2, $3, 1, 'stock_adjustment', 'Left with the shop', 100.00, null, null, null, null)`,
        [productId, customerUnit, LOCATION.shopFloor],
      );
      await actAs(tx, ADMIN);
      await failsWith(tx, () => recordSale(tx, { lines: [{ inventory_unit_id: customerUnit }] }), {
        code: "P0001",
        message: "ownership_not_saleable",
      });
      await failsWith(tx, () => recordSale(tx, { lines: [{ inventory_unit_id: randomUUID() }] }), {
        code: "P0002",
      });
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("record_retail_sale: quantities (D24, D53)", () => {
  it("a quantity sale takes its stock and never below zero (insufficient_stock)", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx, { stock: 5, name: "Bar end plugs" });
      const sale = await recordSale(tx, { lines: [{ product_id: productId, quantity: 3 }] });
      expect(await onHand(tx, productId)).toBe(2);
      const [line] = await saleLines(tx, sale.sale_id);
      expect(line).toMatchObject({
        description_snapshot: "Bar end plugs",
        quantity: "3.00",
        unit_sale_price_snapshot: "20.00",
        unit_direct_cost_snapshot: "8.00",
        sale_total: "60.00",
        cost_total: "24.00",
        yield_total: "36.00",
        cult_commons_share: "10.80",
      });
      expect(
        (await saleMovements(tx, productId)).filter((m) => m.movement_type === "retail_sale"),
      ).toEqual([
        expect.objectContaining({
          quantity_delta: -3,
          sale_line_id: line.id,
          unit_cost_snapshot: "8.00",
        }),
      ]);
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: productId, quantity: 3 }] }),
        { code: "P0001", message: "insufficient_stock" },
      );
      expect(await onHand(tx, productId)).toBe(2);
      // At another location there is none.
      const store = await makeLocation(tx);
      await failsWith(
        tx,
        () =>
          recordSale(tx, { lines: [{ product_id: productId, quantity: 1, location_id: store }] }),
        { code: "P0001", message: "insufficient_stock" },
      );
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses a unique product, customer-owned stock, an inactive or archived product, a missing price (sale_price_required) and a missing cost (sale_cost_missing)", async () => {
    await inTx(async (tx) => {
      const { productId: uniqueProduct } = await makeUniqueWithUnit(tx);
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: uniqueProduct, quantity: 1 }] }),
        { code: "P0001", message: "sale_product_is_unique" },
      );

      // Ownership is fixed once a product has stock (D45), so this one is
      // made customer-owned before any; the refusal comes before the stock
      // check.
      await ownerMode(tx);
      const customerProduct = await makeProduct(tx);
      await tx.query("update public.products set ownership_type = 'customer_owned' where id = $1", [
        customerProduct,
      ]);
      const inactive = await makeProduct(tx, { active: false });
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: customerProduct, quantity: 1 }] }),
        { code: "P0001", message: "ownership_not_saleable" },
      );
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: inactive, quantity: 1 }] }),
        { code: "P0001", message: "product_inactive" },
      );

      const noPrice = await quantityProduct(tx, { price: null });
      await failsWith(tx, () => recordSale(tx, { lines: [{ product_id: noPrice, quantity: 1 }] }), {
        code: "P0001",
        message: "sale_price_required",
      });
      // An override supplies the missing price (D53).
      await recordSale(tx, {
        lines: [{ product_id: noPrice, quantity: 1, unit_sale_price: "12" }],
      });

      const noCost = await quantityProduct(tx, { cost: null });
      await failsWith(tx, () => recordSale(tx, { lines: [{ product_id: noCost, quantity: 1 }] }), {
        code: "P0001",
        message: "sale_cost_missing",
      });
      expect(await onHand(tx, noCost)).toBe(10);
      await assertLedgerConsistent(tx);
    });
  });

  it("D24 (amended): a price of 0 and a cost of 0 are known values, snapshotted as 0", async () => {
    await inTx(async (tx) => {
      const freebie = await quantityProduct(tx, { price: "0.00", cost: "0.00" });
      const sale = await recordSale(tx, { lines: [{ product_id: freebie, quantity: 2 }] });
      expect((await saleLines(tx, sale.sale_id))[0]).toMatchObject({
        unit_sale_price_snapshot: "0.00",
        unit_direct_cost_snapshot: "0.00",
        sale_total: "0.00",
        cost_total: "0.00",
        yield_total: "0.00",
        cult_commons_share: "0.00",
      });
      // An override to 0 on a priced unit (any staff member, D53), cost 0 known.
      const { unitId } = await makeUniqueWithUnit(tx, { price: "50.00", cost: "0.00" });
      await actAs(tx, MECHANIC2);
      const gift = await recordSale(tx, {
        lines: [{ inventory_unit_id: unitId, unit_sale_price: 0 }],
      });
      await actAs(tx, ADMIN);
      expect((await saleLines(tx, gift.sale_id))[0]).toMatchObject({
        unit_sale_price_snapshot: "0.00",
        unit_direct_cost_snapshot: "0.00",
        yield_total: "0.00",
      });
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("consigned stock on a sale (D44, D45, D46)", () => {
  it("Consignment sale creates correct liability and yield: $1,000.00 against $500.00 owed (SPEC §27.2)", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx, { displayName: "Daniel Ong" });
      const item = await intakeUnique(tx, { consignorId, agreed: "500.00", asking: "1000.00" });
      const settlementsBefore = await readAsOwner(tx, () =>
        scalar<number>(tx, "select count(*)::int from public.settlement_lines"),
      );
      const sale = await recordSale(tx, {
        lines: [{ inventory_unit_id: item.inventory_unit_id! }],
      });
      const [line] = await saleLines(tx, sale.sale_id);
      expect(line).toMatchObject({
        consignment_item_id: item.item_id,
        unit_sale_price_snapshot: "1000.00",
        unit_direct_cost_snapshot: "500.00",
        consignor_payout_snapshot: "500.00",
        sale_total: "1000.00",
        cost_total: "500.00",
        yield_total: "500.00",
        cult_commons_share: "150.00",
      });
      expect(await itemLedger(tx, item.item_id)).toMatchObject({
        sold_qty: 1,
        remaining_qty: 0,
        owed_qty: 1,
        liability: "500.00",
        owed: "500.00",
        paid: "0.00",
        outstanding: "500.00",
        status: "sold",
      });
      const events = await itemEvents(tx, item.item_id);
      expect(events.map((e) => e.event_type)).toEqual(["received", "status_changed"]);
      expect(events[1].payload).toMatchObject({ from: "active", to: "sold" });
      // Liability is a fact of the sale; nothing is settled, charged or
      // stored as owed (D46).
      expect(
        await readAsOwner(tx, () =>
          scalar<number>(tx, "select count(*)::int from public.settlement_lines"),
        ),
      ).toBe(settlementsBefore);
      expect(
        (await saleMovements(tx, item.product_id)).filter((m) => m.movement_type === "retail_sale"),
      ).toEqual([
        expect.objectContaining({
          sale_line_id: line.id,
          consignment_item_id: item.item_id,
          unit_cost_snapshot: "500.00",
        }),
      ]);
      await assertLedgerConsistent(tx);
    });
  });

  it("a 120.00 shop-borne charge adds to the cost (620.00 / 380.00 / 114.00); a 45.00 consignor-borne charge leaves the line alone and lowers what is owed (D4)", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const shopBorne = await intakeUnique(tx, {
        consignorId,
        agreed: "500.00",
        asking: "1000.00",
      });
      await addCharge(tx, { itemId: shopBorne.item_id, amount: "120.00", bearer: "shop" });
      const a = await recordSale(tx, {
        lines: [{ inventory_unit_id: shopBorne.inventory_unit_id! }],
      });
      expect((await saleLines(tx, a.sale_id))[0]).toMatchObject({
        unit_direct_cost_snapshot: "620.00",
        consignor_payout_snapshot: "500.00",
        yield_total: "380.00",
        cult_commons_share: "114.00",
      });
      expect(await itemLedger(tx, shopBorne.item_id)).toMatchObject({
        liability: "500.00",
        owed: "500.00",
      });

      const consignorBorne = await intakeUnique(tx, {
        consignorId,
        agreed: "500.00",
        asking: "1000.00",
      });
      await addCharge(tx, { itemId: consignorBorne.item_id, amount: "45.00", bearer: "consignor" });
      const b = await recordSale(tx, {
        lines: [{ inventory_unit_id: consignorBorne.inventory_unit_id! }],
      });
      expect((await saleLines(tx, b.sale_id))[0]).toMatchObject({
        unit_direct_cost_snapshot: "500.00",
        yield_total: "500.00",
        cult_commons_share: "150.00",
      });
      expect(await itemLedger(tx, consignorBorne.item_id)).toMatchObject({
        liability: "500.00",
        consignor_charges: "45.00",
        owed: "455.00",
        outstanding: "455.00",
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("D45: a quantity line draws from one item, the oldest that covers it (FIFO) at its own price, or the item named", async () => {
    await inTx(async (tx) => {
      const older = await createConsignor(tx, { displayName: "Older consignor" });
      const newer = await createConsignor(tx, { displayName: "Newer consignor" });
      const a = await intakeQuantity(tx, {
        consignorId: older,
        agreed: "10.00",
        asking: "30.00",
        quantity: 2,
        receivedAt: await hoursAgo(tx, 240),
      });
      const b = await intakeQuantity(tx, {
        consignorId: newer,
        agreed: "12.00",
        asking: "40.00",
        quantity: 3,
        productId: a.product_id,
        receivedAt: await hoursAgo(tx, 120),
      });
      expect(await sellingPrice(tx, a.product_id)).toBe("30.00");

      const fifo = await recordSale(tx, { lines: [{ product_id: a.product_id, quantity: 1 }] });
      expect((await saleLines(tx, fifo.sale_id))[0]).toMatchObject({
        consignment_item_id: a.item_id,
        unit_sale_price_snapshot: "30.00",
        unit_direct_cost_snapshot: "10.00",
        consignor_payout_snapshot: "10.00",
      });
      // 4 are on hand (1 + 3), but no single consignment has 4 left: such a
      // line is split and the rest received on use (D267,
      // counter-receive-on-use.test.ts).
      expect(await onHand(tx, a.product_id)).toBe(4);
      const named = await recordSale(tx, {
        lines: [{ product_id: a.product_id, quantity: 1, consignment_item_id: b.item_id }],
      });
      expect((await saleLines(tx, named.sale_id))[0]).toMatchObject({
        consignment_item_id: b.item_id,
        unit_sale_price_snapshot: "40.00",
        consignor_payout_snapshot: "12.00",
      });
      // The older item has 1 left, so 2 come from the newer one.
      const two = await recordSale(tx, { lines: [{ product_id: a.product_id, quantity: 2 }] });
      expect((await saleLines(tx, two.sale_id))[0]).toMatchObject({
        consignment_item_id: b.item_id,
        quantity: "2.00",
        sale_total: "80.00",
      });
      expect(await itemStatus(tx, b.item_id)).toBe("sold");
      // A named item no longer with the shop is still refused.
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: a.product_id, quantity: 1, consignment_item_id: b.item_id }],
          }),
        { code: "P0001", message: "consignment_item_not_active" },
      );
      expect(await itemLedger(tx, a.item_id)).toMatchObject({
        remaining_qty: 1,
        liability: "10.00",
      });
      expect(await itemLedger(tx, b.item_id)).toMatchObject({
        remaining_qty: 0,
        liability: "36.00",
      });
      expect(await onHand(tx, a.product_id)).toBe(1);
      await assertLedgerConsistent(tx);
    });
  });

  it("a partly sold, partly returned quantity item stays sold and owed, whichever came first (no returned status)", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      for (const order of ["sell first", "return first"] as const) {
        const item = await intakeQuantity(tx, { consignorId, agreed: "10.00", quantity: 6 });
        const sell = () =>
          recordSale(tx, { lines: [{ product_id: item.product_id, quantity: 4 }] });
        const ret = () =>
          returnItem(tx, { itemId: item.item_id, quantity: 2, locationId: LOCATION.shopFloor });
        if (order === "sell first") {
          await sell();
          await ret();
        } else {
          await ret();
          await sell();
        }
        expect({ order, status: await itemStatus(tx, item.item_id) }).toEqual({
          order,
          status: "sold",
        });
        expect(await itemLedger(tx, item.item_id)).toMatchObject({
          sold_qty: 4,
          returned_qty: 2,
          remaining_qty: 0,
          owed_qty: 4,
          liability: "40.00",
        });
        const statuses = (await itemEvents(tx, item.item_id))
          .filter((e) => e.event_type === "status_changed")
          .map((e) => (e.payload as { to: string }).to);
        expect({ order, statuses }).toEqual({ order, statuses: ["sold"] });
      }
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())(
  "Historical line price/cost/yield snapshots do not change with catalog edits",
  () => {
    it("product price and cost edits, new terms on a partly sold item and a new Cult Commons rate leave recorded lines as they were", async () => {
      await inTx(async (tx) => {
        const productId = await quantityProduct(tx);
        const shop = await recordSale(tx, { lines: [{ product_id: productId, quantity: 2 }] });
        const consignorId = await createConsignor(tx);
        const item = await intakeQuantity(tx, {
          consignorId,
          agreed: "10.00",
          asking: "30.00",
          quantity: 6,
        });
        const consigned = await recordSale(tx, {
          lines: [{ product_id: item.product_id, quantity: 2 }],
        });
        const before = [
          ...(await saleLines(tx, shop.sale_id)),
          ...(await saleLines(tx, consigned.sale_id)),
        ];

        await ownerMode(tx);
        await tx.query(
          "update public.products set default_sale_price = 25.00, default_direct_cost = 9.00 where id = $1",
          [productId],
        );
        // A new rate from tomorrow.
        await tx.query(
          "insert into public.cult_commons_rates (rate, effective_from) values (0.2500, now() + interval '1 day')",
        );
        await actAs(tx, ADMIN);
        await updateTerms(tx, item.item_id, {
          agreed: "12.00",
          asking: "35.00",
          reason: "Consignor asked for more",
        });

        const after = [
          ...(await saleLines(tx, shop.sale_id)),
          ...(await saleLines(tx, consigned.sale_id)),
        ];
        expect(after).toEqual(before);
        expect(before[1]).toMatchObject({
          unit_sale_price_snapshot: "30.00",
          unit_direct_cost_snapshot: "10.00",
          consignor_payout_snapshot: "10.00",
          cult_commons_rate_snapshot: "0.3000",
        });
        // The next sale of the item takes the new terms; the liability
        // keeps each line's own snapshot.
        const next = await recordSale(tx, {
          lines: [{ product_id: item.product_id, quantity: 1 }],
        });
        expect((await saleLines(tx, next.sale_id))[0]).toMatchObject({
          unit_sale_price_snapshot: "35.00",
          consignor_payout_snapshot: "12.00",
          cult_commons_rate_snapshot: "0.3000",
        });
        expect((await itemLedger(tx, item.item_id)).liability).toBe("32.00");
        await assertLedgerConsistent(tx);
      });
    });

    it("a backdated sale takes the Cult Commons rate in force at its recognized_at", async () => {
      await inTx(async (tx) => {
        const productId = await quantityProduct(tx, { price: "100.00", cost: "0.00" });
        await ownerMode(tx);
        await tx.query(
          "insert into public.cult_commons_rates (rate, effective_from) values (0.2000, now() - interval '10 days')",
        );
        await actAs(tx, ADMIN);
        const old = await recordSale(tx, {
          lines: [{ product_id: productId, quantity: 1 }],
          recognizedAt: await hoursAgo(tx, 20 * 24),
        });
        const recent = await recordSale(tx, {
          lines: [{ product_id: productId, quantity: 1 }],
          recognizedAt: await hoursAgo(tx, 5 * 24),
        });
        expect((await saleLines(tx, old.sale_id))[0]).toMatchObject({
          cult_commons_rate_snapshot: "0.3000",
          cult_commons_share: "30.00",
        });
        expect((await saleLines(tx, recent.sale_id))[0]).toMatchObject({
          cult_commons_rate_snapshot: "0.2000",
          cult_commons_share: "20.00",
        });
        await assertLedgerConsistent(tx);
      });
    });
  },
);

describe.skipIf(!isolatedDatabase())("idempotency and validation", () => {
  it('a replay by sale id returns the recorded sale: "1000", 1000 and "1000.00" are one request; another payload is sale_conflict', async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const saleId = randomUUID();
      const lines = (price: string | number, quantity = 1) => [
        { product_id: productId, quantity, unit_sale_price: price },
      ];
      const first = await recordSale(tx, { saleId, lines: lines("1000") });
      for (const price of [1000, "1000.00"]) {
        const again = await recordSale(tx, { saleId, lines: lines(price) });
        expect(again).toEqual({ ...first, replayed: true });
      }
      expect(await saleLines(tx, saleId)).toHaveLength(1);
      expect(await onHand(tx, productId)).toBe(9);
      await failsWith(tx, () => recordSale(tx, { saleId, lines: lines("1000", 2) }), {
        code: "P0001",
        message: "sale_conflict",
      });
      // recognized_at as given: NULL replays match although the sale was
      // stamped with now().
      expect(first.recognized_at).toBeInstanceOf(Date);
      await assertLedgerConsistent(tx);
    });
  });

  it("a replay still returns the sale after its customer was archived and after its unit was sold by it", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const customerId = await makeCustomer(tx);
      await actAs(tx, ADMIN);
      const { unitId } = await makeUniqueWithUnit(tx, { cost: "10.00" });
      const saleId = randomUUID();
      const request = { saleId, lines: [{ inventory_unit_id: unitId }], customerId };
      const first = await recordSale(tx, request);
      await ownerMode(tx);
      await tx.query("update public.customers set archived_at = now() where id = $1", [customerId]);
      await actAs(tx, ADMIN);
      expect(await recordSale(tx, request)).toEqual({ ...first, replayed: true });
      // A new sale to the archived customer is refused.
      const productId = await quantityProduct(tx);
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }], customerId }),
        { code: "P0001", message: "customer_archived" },
      );
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses an empty or oversized sale, a unit twice, a future date, a NaN or malformed price and a malformed line", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const { unitId } = await makeUniqueWithUnit(tx, { cost: "10.00" });
      for (const lines of [[], null, {}]) {
        await failsWith(tx, () => recordSale(tx, { lines }), {
          code: "P0001",
          message: "sale_lines_required",
        });
      }
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: Array.from({ length: 51 }, () => ({ product_id: productId, quantity: 1 })),
          }),
        { code: "P0001", message: "sale_too_many_lines" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ inventory_unit_id: unitId }, { inventory_unit_id: unitId.toUpperCase() }],
          }),
        { code: "P0001", message: "sale_duplicate_unit" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1 }],
            recognizedAt: new Date(Date.now() + 3_600_000),
          }),
        { code: "P0001", message: "sale_recognized_in_future" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1, unit_sale_price: "NaN" }],
          }),
        { code: "23514" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1, unit_sale_price: "12,50" }],
          }),
        { code: "22P02" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1, unit_sale_price: "-1" }],
          }),
        { code: "23514", constraint: "sale_lines_unit_sale_price_check" },
      );
      for (const line of [
        { foo: 1 },
        { inventory_unit_id: unitId, product_id: productId },
        { inventory_unit_id: unitId, quantity: 1 },
        { product_id: productId, quantity: 1, colour: "red" },
      ]) {
        await failsWith(tx, () => recordSale(tx, { lines: [line] }), {
          code: "P0001",
          message: "sale_line_invalid",
        });
      }
      for (const quantity of [0, 1000, "two"]) {
        await failsWith(
          tx,
          () => recordSale(tx, { lines: [{ product_id: productId, quantity }] }),
          { code: quantity === "two" ? "22P02" : "P0001" },
        );
      }
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1, location_id: undefined }],
          }),
        { code: "22004" },
      );
      await failsWith(
        tx,
        () =>
          recordSale(tx, {
            lines: [{ product_id: productId, quantity: 1 }],
            customerId: randomUUID(),
          }),
        { code: "P0002" },
      );
      await failsWith(
        tx,
        () =>
          tx.query("select public.record_retail_sale(null, $1::jsonb)", [
            JSON.stringify([{ product_id: productId, quantity: 1 }]),
          ]),
        { code: "22004" },
      );
      expect(await onHand(tx, productId)).toBe(10);
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("who may sell (D48)", () => {
  it("any active staff member records a sale; a customer and an anonymous visitor are refused (42501)", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      await actAs(tx, MECHANIC2);
      const sale = await recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] });
      expect(
        await scalar<string>(tx, "select created_by from public.sales where id = $1", [
          sale.sale_id,
        ]),
      ).toBe(STAFF.mechanic2);
      await ownerMode(tx);
      const customerId = await makeCustomer(tx);
      const login = await linkCustomerLogin(tx, customerId);
      await actAs(tx, customerClaims(login));
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] }),
        {
          code: "42501",
        },
      );
      await actAs(tx, { role: "anon" });
      await failsWith(
        tx,
        () => recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] }),
        {
          code: "42501",
        },
      );
      await actAs(tx, ADMIN);
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())(
  "A unique inventory unit cannot be sold twice (SPEC §23, D46)",
  () => {
    it("a second sale is unit_already_sold with one movement; a second live line is refused by sale_lines_unit_sells_once; resale only after a restock", async () => {
      await inTx(async (tx) => {
        const { productId, unitId } = await makeUniqueWithUnit(tx, { cost: "300.00" });
        const first = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
        await failsWith(tx, () => recordSale(tx, { lines: [{ inventory_unit_id: unitId }] }), {
          code: "P0001",
          message: "unit_already_sold",
        });
        const sold = () =>
          saleMovements(tx, productId).then((ms) =>
            ms.filter((m) => m.movement_type === "retail_sale"),
          );
        expect(await sold()).toHaveLength(1);

        // Even the owner cannot add a second live line for the unit.
        await ownerMode(tx);
        await failsWith(
          tx,
          () =>
            tx.query(
              `insert into public.sale_lines
               (sale_id, line_number, product_id, inventory_unit_id, description_snapshot, quantity,
                unit_sale_price_snapshot, unit_direct_cost_snapshot, cult_commons_rate_snapshot, currency)
             values ($1, 2, $2, $3, 'Again', 1, 10, 5, 0.3, 'SGD')`,
              [first.sale_id, productId, unitId],
            ),
          { code: "23505", constraint: "sale_lines_unit_sells_once" },
        );
        await actAs(tx, ADMIN);

        const [line] = await saleLines(tx, first.sale_id);
        await restock(tx, { unitId, saleLineId: line.id });
        const again = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
        expect(await sold()).toHaveLength(2);
        const [line2] = await saleLines(tx, again.sale_id);
        expect((await unitSale(tx, unitId)).sold_sale_line_id).toBe(line2.id);
        await assertLedgerConsistent(tx);
      });
    });
  },
);

describe.skipIf(!isolatedDatabase())("records are immutable", () => {
  it("a sale changes only its status; lines only their restock, once; refunds never; nothing is deleted", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const sale = await recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] });
      const [line] = await saleLines(tx, sale.sale_id);
      const r = await refund(tx, { saleId: sale.sale_id, amount: "5.00" });
      await ownerMode(tx);
      const cases: [string, unknown[], string][] = [
        [
          "update public.sales set notes = 'edited' where id = $1",
          [sale.sale_id],
          "sale_immutable",
        ],
        [
          "update public.sales set recognized_at = recognized_at - interval '1 hour' where id = $1",
          [sale.sale_id],
          "sale_immutable",
        ],
        [
          "update public.sales set sale_number = 'S-999999' where id = $1",
          [sale.sale_id],
          "sale_number_immutable",
        ],
        ["delete from public.sales where id = $1", [sale.sale_id], "sale_immutable"],
        [
          "update public.sale_lines set unit_sale_price_snapshot = 1 where id = $1",
          [line.id],
          "sale_lines_immutable",
        ],
        [
          "update public.sale_lines set restocked_by = $2 where id = $1",
          [line.id, STAFF.admin],
          "sale_lines_immutable",
        ],
        ["delete from public.sale_lines where id = $1", [line.id], "sale_lines_immutable"],
        [
          "update public.sale_refunds set amount = 1 where id = $1",
          [r.id],
          "sale_refund_immutable",
        ],
        ["delete from public.sale_refunds where id = $1", [r.id], "sale_refund_immutable"],
      ];
      for (const [sql, params, message] of cases) {
        await failsWith(tx, () => tx.query(sql, params), { code: "P0001", message });
      }
      // Only a unit's line is ever restocked (this is a quantity line).
      await failsWith(
        tx,
        () =>
          tx.query("update public.sale_lines set restocked_at = now() where id = $1", [line.id]),
        { code: "23514", constraint: "sale_lines_restock_unit_only" },
      );
      // The status may change (refunds do it).
      await tx.query("update public.sales set status = 'refunded' where id = $1", [sale.sale_id]);
      await actAs(tx, ADMIN);
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("restock_unit (D46, D29, D44)", () => {
  it("adjust_stock restocks with a reason: a return movement linked to the line, the unit available at the chosen location, the product public again, the line restocked; a replay writes nothing", async () => {
    await inTx(async (tx) => {
      const { productId, unitId } = await makeUniqueWithUnit(tx, {
        price: "900.00",
        cost: "400.00",
      });
      await ownerMode(tx);
      await addPublicPhoto(tx, "product", productId);
      await actAs(tx, ADMIN);
      await publishProduct(tx, productId);
      const sale = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      const [line] = await saleLines(tx, sale.sale_id);
      expect(await publication(tx, productId)).toBe("sold");

      await actAs(tx, MECHANIC2);
      await failsWith(tx, () => restock(tx, { unitId, saleLineId: line.id }), { code: "42501" });
      await actAs(tx, ADMIN);
      for (const reason of [null, "   "]) {
        await failsWith(tx, () => restock(tx, { unitId, saleLineId: line.id, reason }), {
          code: "P0001",
          message: "reason_required",
        });
      }

      const store = await makeLocation(tx);
      const result = await restock(tx, {
        unitId,
        saleLineId: line.id,
        locationId: store,
        reason: "Customer returned it unused",
      });
      expect(result).toEqual({ unit_id: unitId, status: "available" });
      const moves = await saleMovements(tx, productId);
      expect(moves.filter((m) => m.sale_line_id === line.id)).toEqual([
        expect.objectContaining({ movement_type: "retail_sale", quantity_delta: -1 }),
        expect.objectContaining({
          movement_type: "return",
          quantity_delta: 1,
          location_id: store,
          unit_cost_snapshot: "400.00",
          reason: "Customer returned it unused",
        }),
      ]);
      expect(await unitSale(tx, unitId)).toEqual({
        status: "available",
        sold_at: null,
        sold_sale_line_id: null,
        location_id: store,
      });
      expect(await publication(tx, productId)).toBe("public");
      const [after] = await saleLines(tx, sale.sale_id);
      expect(after.restocked_at).not.toBeNull();
      expect(after.restocked_by).toBe(STAFF.admin);
      // The sale itself is untouched (D7).
      expect(await saleStatus(tx, sale.sale_id)).toBe("recorded");

      // A replay of the same line writes nothing.
      expect(await restock(tx, { unitId, saleLineId: line.id })).toEqual({
        unit_id: unitId,
        status: "available",
      });
      expect(await saleMovements(tx, productId)).toHaveLength(moves.length);
      await assertLedgerConsistent(tx);
    });
  });

  it("A delayed restock never restocks a later sale", async () => {
    await inTx(async (tx) => {
      const { productId, unitId } = await makeUniqueWithUnit(tx, { cost: "50.00" });
      const first = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      const [line1] = await saleLines(tx, first.sale_id);
      await restock(tx, { unitId, saleLineId: line1.id });
      const second = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      const [line2] = await saleLines(tx, second.sale_id);
      const count = (await saleMovements(tx, productId)).length;
      // The first restock's request arrives again: a no-op.
      expect(await restock(tx, { unitId, saleLineId: line1.id })).toEqual({
        unit_id: unitId,
        status: "sold",
      });
      expect(await saleMovements(tx, productId)).toHaveLength(count);
      expect((await unitSale(tx, unitId)).sold_sale_line_id).toBe(line2.id);
      expect((await saleLines(tx, second.sale_id))[0].restocked_at).toBeNull();
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses another unit's line and a unit sold by a job (restock_line_mismatch), and a unit that is not sold (unit_not_sold)", async () => {
    await inTx(async (tx) => {
      const { productId, unitId } = await makeUniqueWithUnit(tx, { cost: "50.00" });
      const other = await makeUnit(tx, productId);
      const sale = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      const [line] = await saleLines(tx, sale.sale_id);
      await failsWith(tx, () => restock(tx, { unitId: other.unit_id, saleLineId: line.id }), {
        code: "P0001",
        message: "restock_line_mismatch",
      });

      // A unit sold through a job (D44): its sold_sale_line_id is null, so a
      // line for it (written here by the owner) is never the one it sold on.
      const job = await newJob(tx);
      await addPart(tx, { workOrderId: job.id, productId, unitId: other.unit_id });
      await completeJob(tx, job.id);
      expect((await unit(tx, other.unit_id)).status).toBe("sold");
      const insertLine = async (unitIdForLine: string) => {
        await ownerMode(tx);
        const { rows } = await tx.query<{ id: string }>(
          `insert into public.sale_lines
             (sale_id, line_number, product_id, inventory_unit_id, description_snapshot, quantity,
              unit_sale_price_snapshot, unit_direct_cost_snapshot, cult_commons_rate_snapshot, currency)
           values ($1, (select coalesce(max(line_number), 0) + 1 from public.sale_lines where sale_id = $1),
                   $2, $3, 'Owner line', 1, 10, 5, 0.3, 'SGD')
           returning id`,
          [sale.sale_id, productId, unitIdForLine],
        );
        await actAs(tx, ADMIN);
        return rows[0].id;
      };
      const jobLine = await insertLine(other.unit_id);
      await failsWith(tx, () => restock(tx, { unitId: other.unit_id, saleLineId: jobLine }), {
        code: "P0001",
        message: "restock_line_mismatch",
      });

      const available = await makeUnit(tx, productId);
      const stray = await insertLine(available.unit_id);
      await failsWith(tx, () => restock(tx, { unitId: available.unit_id, saleLineId: stray }), {
        code: "P0001",
        message: "unit_not_sold",
      });
      await failsWith(tx, () => restock(tx, { unitId, saleLineId: randomUUID() }), {
        code: "P0002",
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("a consigned unit also needs manage_consignments; the item goes back to active with the reason, its liability to 0.00, and it sells again", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const item = await intakeUnique(tx, { consignorId, agreed: "500.00", asking: "1000.00" });
      const unitId = item.inventory_unit_id!;
      const sale = await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      const [line] = await saleLines(tx, sale.sale_id);
      await ownerMode(tx);
      const stockOnly = await staffWith(tx, ["adjust_stock"]);
      const both = await staffWith(tx, ["adjust_stock", "manage_consignments"]);
      await actAs(tx, stockOnly.claims);
      await failsWith(tx, () => restock(tx, { unitId, saleLineId: line.id }), { code: "42501" });
      await actAs(tx, both.claims);
      await restock(tx, { unitId, saleLineId: line.id, reason: "Buyer's partner vetoed it" });
      await actAs(tx, ADMIN);
      expect(await itemLedger(tx, item.item_id)).toMatchObject({
        status: "active",
        sold_qty: 1,
        restocked_qty: 1,
        remaining_qty: 1,
        liability: "0.00",
        outstanding: "0.00",
      });
      const last = (await itemEvents(tx, item.item_id)).at(-1)!;
      expect(last).toMatchObject({
        event_type: "status_changed",
        reason: "Buyer's partner vetoed it",
        actor_staff_id: both.staffId,
      });
      expect(last.payload).toMatchObject({ from: "sold", to: "active" });
      expect(
        (await saleMovements(tx, item.product_id)).find((m) => m.movement_type === "return"),
      ).toMatchObject({ consignment_item_id: item.item_id, sale_line_id: line.id });

      await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      expect(await itemLedger(tx, item.item_id)).toMatchObject({
        status: "sold",
        liability: "500.00",
      });
      await assertLedgerConsistent(tx);
    });
  });

  it("refuses a unit whose bike a customer now owns (bike_with_customer, D29)", async () => {
    await inTx(async (tx) => {
      await ownerMode(tx);
      const productId = await makeProduct(tx, { tracking: "unique" });
      const bikeId = await makeBike(tx, null);
      const buyer = await makeCustomer(tx);
      await actAs(tx, ADMIN);
      const u = await makeUnit(tx, productId, { bikeId, cost: "800.00" });
      const sale = await recordSale(tx, {
        lines: [{ inventory_unit_id: u.unit_id }],
        customerId: buyer,
      });
      const [line] = await saleLines(tx, sale.sale_id);
      // Ownership is not transferred by the sale; staff do it.
      await tx.query("select public.transfer_bike_ownership($1, $2, 'Sold to the buyer')", [
        bikeId,
        buyer,
      ]);
      await failsWith(tx, () => restock(tx, { unitId: u.unit_id, saleLineId: line.id }), {
        code: "P0001",
        message: "bike_with_customer",
      });
      expect((await unit(tx, u.unit_id)).status).toBe("sold");
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("Refunds are financial only (D7, D49, D94)", () => {
  it("partially refunded, then refunded; stock and units untouched; capped at the sale total (refund_exceeds_sale); a reason is required", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const { unitId } = await makeUniqueWithUnit(tx, { price: "100.00", cost: "40.00" });
      const sale = await recordSale(tx, {
        lines: [{ product_id: productId, quantity: 2 }, { inventory_unit_id: unitId }],
      });
      const movesBefore = (await saleMovements(tx, productId)).length;
      const onHandBefore = await onHand(tx, productId);
      for (const reason of [null, "  "]) {
        await failsWith(tx, () => refund(tx, { saleId: sale.sale_id, amount: "10.00", reason }), {
          code: "P0001",
          message: "reason_required",
        });
      }
      await failsWith(tx, () => refund(tx, { saleId: sale.sale_id, amount: "140.01" }), {
        code: "P0001",
        message: "refund_exceeds_sale",
      });
      const r1 = await refund(tx, { saleId: sale.sale_id, amount: "40.00" });
      expect(r1).toMatchObject({ amount: "40.00", restocked: false, recorded_by: STAFF.admin });
      expect(await saleStatus(tx, sale.sale_id)).toBe("partially_refunded");
      await failsWith(tx, () => refund(tx, { saleId: sale.sale_id, amount: "100.01" }), {
        code: "P0001",
        message: "refund_exceeds_sale",
      });
      await refund(tx, { saleId: sale.sale_id, amount: "100" });
      expect(await saleStatus(tx, sale.sale_id)).toBe("refunded");
      await failsWith(tx, () => refund(tx, { saleId: sale.sale_id, amount: "0.01" }), {
        code: "P0001",
        message: "refund_exceeds_sale",
      });
      expect(await saleMovements(tx, productId)).toHaveLength(movesBefore);
      expect(await onHand(tx, productId)).toBe(onHandBefore);
      expect((await unit(tx, unitId)).status).toBe("sold");
      expect((await saleLines(tx, sale.sale_id)).every((l) => l.restocked_at === null)).toBe(true);
      await assertLedgerConsistent(tx);
    });
  });

  it("only admins and managers refund (D94 amends D49): mechanics are refused, even with view_financial_reports or every permission as exceptions; a replay returns the refund; another payload is sale_refund_conflict", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const sale = await recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] });
      await ownerMode(tx);
      const reports = await staffWith(tx, ["view_financial_reports"]);
      const everything = await staffWith(tx, [
        "view_costs",
        "manage_inventory",
        "adjust_stock",
        "manage_consignments",
        "manage_purchasing",
        "manage_staff",
        "view_financial_reports",
      ]);
      for (const claims of [MECHANIC1, MECHANIC2, reports.claims, everything.claims]) {
        await actAs(tx, claims);
        await failsWith(tx, () => refund(tx, { saleId: sale.sale_id, amount: "5.00" }), {
          code: "42501",
        });
      }
      await actAs(tx, ADMIN);
      const refundId = randomUUID();
      const first = await refund(tx, {
        refundId,
        saleId: sale.sale_id,
        amount: "5",
        reason: " Scratched ",
      });
      expect(first).toMatchObject({ amount: "5.00", reason: "Scratched" });
      expect(
        await refund(tx, { refundId, saleId: sale.sale_id, amount: "5.00", reason: "Scratched" }),
      ).toEqual(first);
      await failsWith(
        tx,
        () => refund(tx, { refundId, saleId: sale.sale_id, amount: "6.00", reason: "Scratched" }),
        { code: "P0001", message: "sale_refund_conflict" },
      );
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.sale_refunds where sale_id = $1",
          [sale.sale_id],
        ),
      ).toBe(1);
      await failsWith(tx, () => refund(tx, { saleId: randomUUID(), amount: "1.00" }), {
        code: "P0002",
      });
      // A manager records a refund by role (D94), within the same cap.
      await actAs(tx, MANAGER);
      expect(
        await refund(tx, { saleId: sale.sale_id, amount: "1.00", reason: "Goodwill" }),
      ).toMatchObject({ amount: "1.00", recorded_by: STAFF.manager });
      expect(await saleStatus(tx, sale.sale_id)).toBe("partially_refunded");
    });
  });
});

describe.skipIf(!isolatedDatabase())("when a sale may be dated (D55 SALE-DATE)", () => {
  it("never before a consigned item came in: mechanic2's sale dated 400 days back is refused (sale_before_stock); at or after intake it is recorded", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const receivedAt = await hoursAgo(tx, 48);
      const item = await intakeUnique(tx, { consignorId, agreed: "500.00", receivedAt });
      await actAs(tx, MECHANIC2);
      for (const at of [await hoursAgo(tx, 400 * 24), await hoursAgo(tx, 49)]) {
        await failsWith(
          tx,
          () =>
            recordSale(tx, {
              lines: [{ inventory_unit_id: item.inventory_unit_id! }],
              recognizedAt: at,
            }),
          { code: "P0001", message: "sale_before_stock" },
        );
      }
      expect(await itemStatus(tx, item.item_id)).toBe("active");
      const sale = await recordSale(tx, {
        lines: [{ inventory_unit_id: item.inventory_unit_id! }],
        recognizedAt: receivedAt,
      });
      expect(sale.recognized_at.toISOString()).toBe(receivedAt);
      await assertLedgerConsistent(tx);
    });
  });

  it("a consigned quantity line is not dated before its item's intake, named or FIFO", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const item = await intakeQuantity(tx, {
        consignorId,
        agreed: "20.00",
        quantity: 3,
        receivedAt: await hoursAgo(tx, 24),
      });
      for (const named of [null, item.item_id]) {
        await failsWith(
          tx,
          async () =>
            recordSale(tx, {
              lines: [{ product_id: item.product_id, quantity: 1, consignment_item_id: named }],
              recognizedAt: await hoursAgo(tx, 30),
            }),
          { code: "P0001", message: "sale_before_stock" },
        );
      }
      await recordSale(tx, {
        lines: [{ product_id: item.product_id, quantity: 1 }],
        recognizedAt: await hoursAgo(tx, 2),
      });
      expect((await itemLedger(tx, item.item_id)).remaining_qty).toBe(2);
      await assertLedgerConsistent(tx);
    });
  });

  it("a restocked unit is not sold again before its restock; shop stock entered after the fact may still be dated back", async () => {
    await inTx(async (tx) => {
      const { unitId } = await makeUniqueWithUnit(tx, { price: "300.00", cost: "100.00" });
      await actAs(tx, ADMIN);
      // Registered now, sold two days ago: shop stock has no lower bound.
      const first = await recordSale(tx, {
        lines: [{ inventory_unit_id: unitId }],
        recognizedAt: await hoursAgo(tx, 48),
      });
      const [line] = await saleLines(tx, first.sale_id);
      await restock(tx, { unitId, saleLineId: line.id });
      await failsWith(
        tx,
        async () =>
          recordSale(tx, {
            lines: [{ inventory_unit_id: unitId }],
            recognizedAt: await hoursAgo(tx, 1),
          }),
        { code: "P0001", message: "sale_before_stock" },
      );
      await recordSale(tx, { lines: [{ inventory_unit_id: unitId }] });
      expect((await unit(tx, unitId)).status).toBe("sold");
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("an in-store sale carries no Shopify reference", () => {
  it("mechanic2 cannot claim a Shopify line id on a retail sale (sale_line_invalid), for a quantity or a unit", async () => {
    await inTx(async (tx) => {
      const productId = await quantityProduct(tx);
      const { unitId } = await makeUniqueWithUnit(tx);
      await actAs(tx, MECHANIC2);
      for (const line of [
        { product_id: productId, quantity: 1, shopify_line_item_id: "gid://shopify/LineItem/123" },
        { inventory_unit_id: unitId, shopify_line_item_id: "gid://shopify/LineItem/124" },
      ]) {
        await failsWith(tx, () => recordSale(tx, { lines: [line] }), {
          code: "P0001",
          message: "sale_line_invalid",
        });
      }
      await ownerMode(tx);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::integer from public.sale_lines where shopify_line_item_id like 'gid://shopify/LineItem/12%'",
        ),
      ).toBe(0);
      await actAs(tx, MECHANIC2);
      await recordSale(tx, { lines: [{ product_id: productId, quantity: 1 }] });
      await assertLedgerConsistent(tx);
    });
  });
});

describe.skipIf(!isolatedDatabase())("an archived consignor (D47)", () => {
  it("restock refuses a unit whose consignor is archived (consignor_archived): the consignor keeps no stock and a 0 balance", async () => {
    await inTx(async (tx) => {
      const consignorId = await createConsignor(tx);
      const item = await intakeUnique(tx, { consignorId, agreed: "500.00", asking: "1000.00" });
      const sale = await recordSale(tx, {
        lines: [{ inventory_unit_id: item.inventory_unit_id! }],
      });
      const [line] = await saleLines(tx, sale.sale_id);
      await settle(tx, {
        consignorId,
        amount: "500.00",
        allocations: [{ consignment_item_id: item.item_id, amount: "500.00" }],
      });
      await tx.query("update public.consignors set archived_at = now() where id = $1", [
        consignorId,
      ]);
      await failsWith(
        tx,
        () => restock(tx, { unitId: item.inventory_unit_id!, saleLineId: line.id }),
        { code: "P0001", message: "consignor_archived" },
      );
      expect(await itemStatus(tx, item.item_id)).toBe("sold");
      expect((await unit(tx, item.inventory_unit_id!)).status).toBe("sold");
      // Unarchived, the restock goes through.
      await tx.query("update public.consignors set archived_at = null where id = $1", [
        consignorId,
      ]);
      await restock(tx, { unitId: item.inventory_unit_id!, saleLineId: line.id });
      expect(await itemStatus(tx, item.item_id)).toBe("active");
      await assertLedgerConsistent(tx);
    });
  });
});
