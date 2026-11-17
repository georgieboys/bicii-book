/**
 * Build packages (PLAN D246-D251; DATA-MODEL §5 "Build packages"): a full
 * build sold at one price, its labour amount as a service line and the
 * rest as the parts budget, the parts priced to fit it. Who writes
 * packages, the public list, setting a job's package, repricing, fitting
 * to the budget above and under the list price, clearing, the line
 * immutability that stays, and the revenue the completed job recognises.
 *
 * Tests create jobs and products (the J and P sequences), so the file runs
 * only on a per-file clone, in rolled-back transactions.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { actAs, connect, inTransaction, isolatedDatabase, type Claims } from "./harness";
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
import { eventTypes, failsWith, makeService, ownerMode } from "./workshop-fixtures";

const ANON: Claims = { role: "anon" };

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const inTx = <T>(fn: (tx: pg.Client) => Promise<T>) =>
  inTransaction(conn, async (tx) => {
    await actAs(tx, ADMIN);
    return fn(tx);
  });

type Pkg = { id: string; serviceId: string };

/** A package as the admin; its labour service is made as the owner. */
async function makePackage(
  tx: pg.Client,
  o: {
    kind?: "full_build" | "build_only";
    name?: string;
    price?: string;
    labour?: string;
    from?: boolean;
    isPublic?: boolean;
  } = {},
): Promise<Pkg> {
  await ownerMode(tx);
  const serviceId = await makeService(tx, {
    name: `Build labour ${randomUUID().slice(0, 6)}`,
    price: "180.00",
  });
  await actAs(tx, ADMIN);
  const id = randomUUID();
  await tx.query(
    `insert into public.build_packages
       (id, kind, name, price, price_is_from, labour_amount, labour_service_id, public)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      o.kind ?? "full_build",
      o.name ?? `Restomod ${randomUUID().slice(0, 6)}`,
      o.price ?? "1075.00",
      o.from ?? false,
      o.labour ?? "180.00",
      serviceId,
      o.isPublic ?? true,
    ],
  );
  return { id, serviceId };
}

async function setBuild(
  tx: pg.Client,
  workOrderId: string,
  packageId: string,
  o: { labourLineId?: string; price?: string | null } = {},
) {
  const { rows } = await tx.query<{
    work_order_id: string;
    price: string;
    labour_amount: string;
    labour_line_id: string;
  }>(
    `select (r).work_order_id, (r).price::text, (r).labour_amount::text, (r).labour_line_id
       from (select public.set_work_order_build($1, $2, $3, $4) r) s`,
    [workOrderId, packageId, o.labourLineId ?? randomUUID(), o.price ?? null],
  );
  return rows[0];
}

async function fit(tx: pg.Client, workOrderId: string) {
  const { rows } = await tx.query<{ r: Record<string, unknown> }>(
    "select public.fit_build_to_budget($1) r",
    [workOrderId],
  );
  return rows[0].r;
}

async function summary(tx: pg.Client, workOrderId: string) {
  const { rows } = await tx.query<Record<string, string>>(
    `select parts_budget::text, parts_list_total::text, parts_total::text, labour_total::text,
            package_total::text, difference::text
       from public.work_order_build_summary where work_order_id = $1`,
    [workOrderId],
  );
  return rows[0];
}

async function lines(tx: pg.Client, workOrderId: string) {
  const { rows } = await tx.query<{
    id: string;
    line_type: string;
    price: string;
    list: string | null;
    total: string;
    voided: boolean;
  }>(
    `select id, line_type::text, unit_sale_price_snapshot::text as price,
            unit_list_price_snapshot::text as list, sale_total::text as total,
            voided_at is not null as voided
       from public.work_order_line_items where work_order_id = $1 order by created_at, id`,
    [workOrderId],
  );
  return rows;
}

/** A stocked part at `price` as the owner (product) and admin (stock). */
async function stockedPart(tx: pg.Client, price: string, cost = "10.00"): Promise<string> {
  await ownerMode(tx);
  const productId = await makeProduct(tx, { price, cost });
  await actAs(tx, ADMIN);
  await addStock(tx, productId, 5);
  return productId;
}

describe.skipIf(!isolatedDatabase())("build packages: the catalogue (D246)", () => {
  it("admins write packages, other staff only read, and the public list hides the labour split", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { name: "Classic test", price: "390.00" });
      await makePackage(tx, { name: "Hidden test", isPublic: false });

      await actAs(tx, MECHANIC1);
      const seen = await tx.query("select id from public.build_packages where id = $1", [pkg.id]);
      expect(seen.rowCount).toBe(1);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.build_packages (kind, name, price, labour_amount, labour_service_id)
             values ('full_build', 'Mechanic package', 500, 180, $1)`,
            [pkg.serviceId],
          ),
        { code: "42501" },
      );

      await actAs(tx, ANON);
      const { rows } = await tx.query<Record<string, unknown>>(
        "select * from public.public_build_packages()",
      );
      const names = rows.map((r) => r.name);
      expect(names).toContain("Classic test");
      expect(names).not.toContain("Hidden test");
      expect(Object.keys(rows[0])).not.toContain("labour_amount");
      await actAs(tx, ADMIN);
    }));

  it("refuses labour above the price and an archived labour service", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.build_packages set labour_amount = 2000 where id = $1", [pkg.id]),
        { constraint: "build_packages_labour_within_price" },
      );
      await ownerMode(tx);
      await tx.query("update public.services set archived_at = now() where id = $1", [
        pkg.serviceId,
      ]);
      await actAs(tx, ADMIN);
      await failsWith(
        tx,
        () =>
          tx.query(
            `insert into public.build_packages (kind, name, price, labour_amount, labour_service_id)
             values ('full_build', 'Archived labour', 500, 180, $1)`,
            [pkg.serviceId],
          ),
        { message: "build_labour_service_invalid" },
      );
    }));
});

describe.skipIf(!isolatedDatabase())("build packages: a job's package (D247, D251)", () => {
  it("adds the labour line at the labour amount, replays, and refuses another price for a fixed package", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      const job = await newJob(tx);
      const labourLineId = randomUUID();
      const build = await setBuild(tx, job.id, pkg.id, { labourLineId });
      expect(build).toMatchObject({
        price: "1075.00",
        labour_amount: "180.00",
        labour_line_id: labourLineId,
      });
      expect(await setBuild(tx, job.id, pkg.id, { labourLineId: randomUUID() })).toMatchObject({
        labour_line_id: labourLineId,
      });
      const ls = await lines(tx, job.id);
      expect(ls).toEqual([
        expect.objectContaining({ id: labourLineId, line_type: "service", price: "180.00" }),
      ]);
      expect(await eventTypes(tx, job.id)).toContain("build_set");

      await failsWith(tx, () => setBuild(tx, job.id, pkg.id, { price: "900.00" }), {
        message: "build_price_fixed",
      });
    }));

  it("a 'from' price above the base is labour, and below the base is refused", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, {
        kind: "build_only",
        name: "Clean Slate test",
        price: "325.00",
        labour: "325.00",
        from: true,
      });
      const job = await newJob(tx);
      await failsWith(tx, () => setBuild(tx, job.id, pkg.id, { price: "300.00" }), {
        message: "build_price_below_from",
      });
      const build = await setBuild(tx, job.id, pkg.id, { price: "400.00" });
      expect(build).toMatchObject({ price: "400.00", labour_amount: "400.00" });
    }));

  it("clearing voids the labour line and puts repriced parts back to their list prices", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { price: "390.00" });
      const part = await stockedPart(tx, "300.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      await addPart(tx, { workOrderId: job.id, productId: part });
      await fit(tx, job.id);
      await failsWith(
        tx,
        () => tx.query("select public.clear_work_order_build($1, '')", [job.id]),
        {
          message: "reason_required",
        },
      );
      await tx.query("select public.clear_work_order_build($1, 'Customer chose build only')", [
        job.id,
      ]);
      const ls = await lines(tx, job.id);
      expect(ls.find((l) => l.line_type === "service")?.voided).toBe(true);
      expect(ls.find((l) => l.line_type === "inventory")).toMatchObject({
        price: "300.00",
        voided: false,
      });
      const left = await tx.query(
        "select 1 from public.work_order_builds where work_order_id = $1",
        [job.id],
      );
      expect(left.rowCount).toBe(0);
      expect(await eventTypes(tx, job.id)).toContain("build_cleared");
    }));
});

describe.skipIf(!isolatedDatabase())("build packages: repricing and fitting (D248, D249)", () => {
  it("parts above the budget are scaled to it and labour takes the rest, so the package adds up to its price", () =>
    inTx(async (tx) => {
      // Restomod S$1,075: labour 180, parts budget 895. Parts list 1,000.
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "600.00");
      const b = await stockedPart(tx, "133.33");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      await addPart(tx, { workOrderId: job.id, productId: a });
      await addPart(tx, { workOrderId: job.id, productId: b, quantity: 3 });

      const before = await summary(tx, job.id);
      expect(before).toMatchObject({
        parts_budget: "895.00",
        parts_list_total: "999.99",
        package_total: "1179.99",
      });

      const result = await fit(tx, job.id);
      expect(result).toMatchObject({ price: 1075, parts_budget: 895, parts_list_total: 999.99 });
      const after = await summary(tx, job.id);
      expect(after.package_total).toBe("1075.00");
      expect(after.difference).toBe("0.00");
      expect(Math.abs(Number(after.parts_total) - 895)).toBeLessThan(0.05);
      expect(Math.abs(Number(after.labour_total) - 180)).toBeLessThan(0.05);

      const ls = await lines(tx, job.id);
      const partA = ls.find((l) => l.list === "600.00");
      expect(partA).toMatchObject({ price: "537.01" });
      expect(ls.filter((l) => l.line_type === "inventory").every((l) => l.list !== null)).toBe(
        true,
      );
      expect(await eventTypes(tx, job.id)).toContain("build_fitted");

      // Fitting again changes nothing and writes no event.
      const count = (await eventTypes(tx, job.id)).filter((e) => e === "build_fitted").length;
      await fit(tx, job.id);
      expect((await eventTypes(tx, job.id)).filter((e) => e === "build_fitted").length).toBe(count);
    }));

  it("parts under the budget stay at list and the difference is labour (service revenue)", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { price: "390.00" });
      const part = await stockedPart(tx, "150.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      await addPart(tx, { workOrderId: job.id, productId: part });
      await fit(tx, job.id);
      const ls = await lines(tx, job.id);
      expect(ls.find((l) => l.line_type === "inventory")).toMatchObject({ price: "150.00" });
      expect(ls.find((l) => l.line_type === "service")).toMatchObject({
        price: "240.00",
        list: "180.00",
      });
      expect((await summary(tx, job.id)).difference).toBe("0.00");
    }));

  it("a fit after parts change starts again from the list prices", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { price: "390.00" });
      const a = await stockedPart(tx, "300.00");
      const b = await stockedPart(tx, "100.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      const first = await addPart(tx, { workOrderId: job.id, productId: a });
      await fit(tx, job.id);
      await addPart(tx, { workOrderId: job.id, productId: b });
      await fit(tx, job.id);
      const ls = await lines(tx, job.id);
      // Budget 210 over a list of 400: factor 0.525.
      expect(ls.find((l) => l.id === first.line_id)).toMatchObject({
        price: "157.50",
        list: "300.00",
      });
      expect((await summary(tx, job.id)).package_total).toBe("390.00");
    }));

  it("reprices one part or the labour line, and nothing else", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { price: "390.00" });
      const part = await stockedPart(tx, "300.00");
      const job = await newJob(tx);
      const build = await setBuild(tx, job.id, pkg.id);
      const added = await addPart(tx, { workOrderId: job.id, productId: part });
      await tx.query("select public.reprice_build_line($1, 199.50)", [added.line_id]);
      let ls = await lines(tx, job.id);
      expect(ls.find((l) => l.id === added.line_id)).toMatchObject({
        price: "199.50",
        list: "300.00",
      });
      expect(await eventTypes(tx, job.id)).toContain("line_repriced");
      await tx.query("select public.reprice_build_line($1, 190.50)", [build.labour_line_id]);
      ls = await lines(tx, job.id);
      expect((await summary(tx, job.id)).difference).toBe("0.00");

      await ownerMode(tx);
      const otherSvc = await makeService(tx, { price: "25.00" });
      await actAs(tx, ADMIN);
      const extra = randomUUID();
      await tx.query("select public.add_service_line($1, $2, $3)", [extra, job.id, otherSvc]);
      await failsWith(tx, () => tx.query("select public.reprice_build_line($1, 1)", [extra]), {
        message: "build_line_not_repriceable",
      });
    }));

  it("a job without a package refuses repricing and fitting; lines stay immutable outside the RPCs", () =>
    inTx(async (tx) => {
      const part = await stockedPart(tx, "50.00");
      const job = await newJob(tx);
      const added = await addPart(tx, { workOrderId: job.id, productId: part });
      await failsWith(
        tx,
        () => tx.query("select public.reprice_build_line($1, 10)", [added.line_id]),
        {
          message: "build_missing",
        },
      );
      await failsWith(tx, () => fit(tx, job.id), { message: "build_missing" });
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.work_order_line_items set unit_sale_price_snapshot = 1 where id = $1",
            [added.line_id],
          ),
        { message: "line_immutable" },
      );
      await actAs(tx, ADMIN);
    }));

  it("a completed job is locked; reopened, it can be fitted again", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx, { price: "390.00" });
      const part = await stockedPart(tx, "300.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      await addPart(tx, { workOrderId: job.id, productId: part });
      await completeJob(tx, job.id);
      await failsWith(tx, () => fit(tx, job.id), { message: "work_order_locked" });
      await reopenJob(tx, job.id);
      await fit(tx, job.id);
      expect((await summary(tx, job.id)).difference).toBe("0.00");
    }));
});

describe.skipIf(!isolatedDatabase())("build packages: revenue (D250)", () => {
  it("the completed build recognises the labour as service revenue and the parts as product revenue, adding up to the package price", () =>
    inTx(async (tx) => {
      const pkg = await makePackage(tx);
      const a = await stockedPart(tx, "700.00", "400.00");
      const b = await stockedPart(tx, "400.00", "150.00");
      const job = await newJob(tx);
      await setBuild(tx, job.id, pkg.id);
      await addPart(tx, { workOrderId: job.id, productId: a });
      await addPart(tx, { workOrderId: job.id, productId: b });
      await fit(tx, job.id);
      await completeJob(tx, job.id);

      await ownerMode(tx);
      const { rows } = await tx.query<{ line_type: string; total: string }>(
        `select line_type, sum(sale_total)::text as total
           from reporting.financial_lines where document_id = $1 group by line_type order by line_type`,
        [job.id],
      );
      const byType = Object.fromEntries(rows.map((r) => [r.line_type, Number(r.total)]));
      expect(byType.service).toBeCloseTo(180, 1);
      expect(byType.inventory).toBeCloseTo(895, 1);
      expect(byType.service + byType.inventory).toBeCloseTo(1075, 2);
      await actAs(tx, ADMIN);
    }));
});
