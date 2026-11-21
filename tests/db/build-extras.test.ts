/**
 * Build extras (PLAN D261; DATA-MODEL §5 "Build packages"): a part on a job
 * with a build package marked extra is charged on top of the package at its
 * own price. Fitting leaves it out, the summary counts it apart, marking a
 * fitted part puts it back to its shelf price, and it stays an ordinary
 * part for stock, consignment and revenue.
 *
 * Tests create jobs and products (the J and P sequences), so the file runs
 * only on a per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createConsignor, intakeUnique, itemPosition } from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase } from "./harness";
import {
  ADMIN,
  MECHANIC1,
  addPart,
  addStock,
  completeJob,
  makeProduct,
  newJob,
  reopenJob,
} from "./inventory-fixtures";
import {
  addManualLine,
  eventTypes,
  failsWith,
  makeService,
  ownerMode,
  voidLine,
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

/** A full build package (labour 180) as the admin; its service as the owner. */
async function makePackage(tx: pg.Client, price = "390.00"): Promise<string> {
  await ownerMode(tx);
  const serviceId = await makeService(tx, {
    name: `Build labour ${randomUUID().slice(0, 6)}`,
    price: "180.00",
  });
  await actAs(tx, ADMIN);
  const id = randomUUID();
  await tx.query(
    `insert into public.build_packages (id, kind, name, price, labour_amount, labour_service_id)
     values ($1, 'full_build', $2, $3, '180.00', $4)`,
    [id, `Classic ${randomUUID().slice(0, 6)}`, price, serviceId],
  );
  return id;
}

async function setBuild(tx: pg.Client, workOrderId: string, packageId: string): Promise<string> {
  const labourLineId = randomUUID();
  await tx.query("select public.set_work_order_build($1, $2, $3, null)", [
    workOrderId,
    packageId,
    labourLineId,
  ]);
  return labourLineId;
}

const fit = (tx: pg.Client, workOrderId: string) =>
  tx.query("select public.fit_build_to_budget($1)", [workOrderId]);

async function setExtra(tx: pg.Client, lineId: string, extra: boolean) {
  const { rows } = await tx.query<{ price: string; list: string | null }>(
    `select (r).unit_sale_price_snapshot::text as price, (r).unit_list_price_snapshot::text as list
       from (select public.set_build_line_extra($1, $2) r) s`,
    [lineId, extra],
  );
  return rows[0];
}

async function summary(tx: pg.Client, workOrderId: string) {
  const { rows } = await tx.query<Record<string, string | number>>(
    `select parts_count, parts_total::text, labour_total::text, package_total::text,
            difference::text, extras_count, extras_total::text
       from public.work_order_build_summary where work_order_id = $1`,
    [workOrderId],
  );
  return rows[0];
}

async function price(tx: pg.Client, lineId: string): Promise<string> {
  const { rows } = await tx.query<{ price: string }>(
    "select unit_sale_price_snapshot::text as price from public.work_order_line_items where id = $1",
    [lineId],
  );
  return rows[0].price;
}

async function jobTotal(tx: pg.Client, workOrderId: string): Promise<string> {
  const { rows } = await tx.query<{ total: string }>(
    `select coalesce(sum(sale_total), 0)::text as total
       from public.work_order_line_items where work_order_id = $1 and voided_at is null`,
    [workOrderId],
  );
  return rows[0].total;
}

const extraRows = async (tx: pg.Client, workOrderId: string) =>
  (
    await tx.query("select line_id from public.work_order_build_extras where work_order_id = $1", [
      workOrderId,
    ])
  ).rowCount;

/** A stocked part at `price` as the owner (product) and admin (stock). */
async function stockedPart(tx: pg.Client, salePrice: string, cost = "10.00"): Promise<string> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price: salePrice, cost });
  await actAs(tx, ADMIN);
  await addStock(tx, productId, 5);
  return productId;
}

describe.skipIf(!isolatedDatabase())("build extras (D261)", () => {
  it("an extra is left out of the fit and charged on top at its own price", () =>
    inTx(async (tx) => {
      // Classic S$390: labour 180, parts budget 210.
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "300.00");
      const b = await stockedPart(tx, "50.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg);
      const partA = await addPart(tx, { workOrderId: job.id, productId: a });
      const partB = await addPart(tx, { workOrderId: job.id, productId: b });
      await setExtra(tx, partB.line_id, true);
      await fit(tx, job.id);

      expect(await price(tx, partA.line_id)).toBe("210.00");
      expect(await price(tx, partB.line_id)).toBe("50.00");
      expect(await summary(tx, job.id)).toMatchObject({
        parts_count: 1,
        parts_total: "210.00",
        labour_total: "180.00",
        package_total: "390.00",
        difference: "0.00",
        extras_count: 1,
        extras_total: "50.00",
      });
      expect(await jobTotal(tx, job.id)).toBe("440.00");
      expect(await eventTypes(tx, job.id)).toContain("build_extra_marked");
    }));

  it("marking a fitted part puts it back to its shelf price; back in the package it is fitted again", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "300.00");
      const b = await stockedPart(tx, "100.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg);
      const partA = await addPart(tx, { workOrderId: job.id, productId: a });
      const partB = await addPart(tx, { workOrderId: job.id, productId: b });
      await fit(tx, job.id);
      // Budget 210 over a list of 400: factor 0.525.
      expect(await price(tx, partB.line_id)).toBe("52.50");

      expect(await setExtra(tx, partB.line_id, true)).toMatchObject({ price: "100.00" });
      // The package is short by what the extra used to cover until fitted.
      expect(await summary(tx, job.id)).toMatchObject({
        difference: "52.50",
        extras_total: "100.00",
      });
      await fit(tx, job.id);
      expect(await price(tx, partA.line_id)).toBe("210.00");
      expect((await summary(tx, job.id)).difference).toBe("0.00");

      // No change: no event.
      const marked = (await eventTypes(tx, job.id)).filter((e) => e === "build_extra_marked");
      await setExtra(tx, partB.line_id, true);
      expect((await eventTypes(tx, job.id)).filter((e) => e === "build_extra_marked")).toEqual(
        marked,
      );

      // Back in the package it keeps its price until the next fit.
      expect(await setExtra(tx, partB.line_id, false)).toMatchObject({ price: "100.00" });
      expect(await summary(tx, job.id)).toMatchObject({
        difference: "-100.00",
        extras_count: 0,
        extras_total: "0.00",
      });
      await fit(tx, job.id);
      expect(await price(tx, partB.line_id)).toBe("52.50");
      expect(await eventTypes(tx, job.id)).toContain("build_extra_unmarked");
    }));

  it("only a live part of an open job with a package can be an extra", () =>
    inTx(async (tx) => {
      const part = await stockedPart(tx, "50.00");
      const plain = await newJob(tx);
      const onPlain = await addPart(tx, { workOrderId: plain.id, productId: part });
      await failsWith(tx, () => setExtra(tx, onPlain.line_id, true), { message: "build_missing" });

      const pkg = await makePackage(tx);
      const job = await newJob(tx);
      const labourLineId = await setBuild(tx, job.id, pkg);
      await failsWith(tx, () => setExtra(tx, labourLineId, true), {
        message: "build_line_not_part",
      });
      const manual = await addManualLine(tx, {
        workOrderId: job.id,
        description: "Bell",
        price: "15.00",
      });
      await failsWith(tx, () => setExtra(tx, manual, true), { message: "build_line_not_part" });
      const voided = await addPart(tx, { workOrderId: job.id, productId: part });
      await voidLine(tx, voided.line_id, "Wrong part");
      await failsWith(tx, () => setExtra(tx, voided.line_id, true), {
        message: "build_line_voided",
      });

      // Any staff member may mark one; nobody writes the table directly.
      const extra = await addPart(tx, { workOrderId: job.id, productId: part });
      await actAs(tx, MECHANIC1);
      await setExtra(tx, extra.line_id, true);
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.work_order_build_extras where line_id = $1", [
            extra.line_id,
          ]),
        { code: "42501" },
      );
      await actAs(tx, ADMIN);

      // A completed job is locked; reopened, the extra can change again.
      await completeJob(tx, job.id);
      await failsWith(tx, () => setExtra(tx, extra.line_id, false), {
        message: "work_order_locked",
      });
      await reopenJob(tx, job.id);
      await setExtra(tx, extra.line_id, false);
    }));

  it("taking the package off keeps an extra's own price and drops the extras", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "300.00");
      const b = await stockedPart(tx, "100.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg);
      const partA = await addPart(tx, { workOrderId: job.id, productId: a });
      const partB = await addPart(tx, { workOrderId: job.id, productId: b });
      await setExtra(tx, partB.line_id, true);
      await tx.query("select public.reprice_build_line($1, $2)", [partB.line_id, "80.00"]);
      await fit(tx, job.id);
      await tx.query("select public.clear_work_order_build($1, 'Customer chose parts only')", [
        job.id,
      ]);
      expect(await price(tx, partA.line_id)).toBe("300.00");
      expect(await price(tx, partB.line_id)).toBe("80.00");
      expect(await extraRows(tx, job.id)).toBe(0);
    }));

  it("a consigned extra still owes its consignor, and the completed build adds up to the package plus the extra", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "300.00", "120.00");
      const consignorId = await createConsignor(tx);
      const item = await intakeUnique(tx, { consignorId, agreed: "60.00", asking: "120.00" });
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg);
      await addPart(tx, { workOrderId: job.id, productId: a });
      const saddle = await addPart(tx, {
        workOrderId: job.id,
        productId: item.product_id,
        unitId: item.inventory_unit_id,
      });
      await setExtra(tx, saddle.line_id, true);
      await fit(tx, job.id);
      expect(await price(tx, saddle.line_id)).toBe("120.00");
      await completeJob(tx, job.id);

      expect(await itemPosition(tx, item.item_id)).toMatchObject({
        job_sold_qty: 1,
        owed_qty: 1,
        liability: "60.00",
      });
      await ownerMode(tx);
      const { rows } = await tx.query<{ line_type: string; total: string }>(
        `select line_type, sum(sale_total)::text as total
           from reporting.financial_lines where document_id = $1 group by line_type order by line_type`,
        [job.id],
      );
      const byType = Object.fromEntries(rows.map((r) => [r.line_type, r.total]));
      expect(byType).toEqual({ inventory: "330.00", service: "180.00" });
      await actAs(tx, ADMIN);
    }));
});
