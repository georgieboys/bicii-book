/**
 * Job lines, their economics and who may see them (SPEC §2, §4.2, §9, §10,
 * §23; DATA-MODEL §5, §15; PLAN D1, D14, D15, D16, D21):
 *
 *   * the generated columns compute sale, cost, yield and Cult Commons per
 *     line exactly as src/lib/cult-commons.ts does (shared fixture table),
 *     and a job's totals are the sums of its live lines (D1);
 *   * a line snapshots price, cost and the Cult Commons rate when it is
 *     added; catalog edits, archiving and new rates never change it;
 *   * any staff member may set a sale price; a cost needs view_costs (D14);
 *     a manual line added without a cost is marked cost_pending and counted
 *     in the totals, so its placeholder 0 is never taken for a real cost;
 *     staff without view_costs never read a cost, yield or Cult Commons,
 *     not even through an error's DETAIL;
 *   * lines change only while the job is open; they are voided with a
 *     reason, never edited or deleted; adds are replay-safe by line id.
 *
 * Inserting jobs consumes private.seq_short_id_j, so the file only runs on a
 * per-file clone (TESTING.md).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import { JOB_FIXTURES, LINE_FIXTURES } from "../fixtures/cult-commons";
import { archiveCustomerUnguarded } from "./customer-fixtures";
import {
  actAs,
  asAnon,
  connect,
  inTransaction,
  isolatedDatabase,
  scalar,
  staffClaims,
} from "./harness";
import {
  addManualLine,
  addServiceLine,
  createWorkOrder,
  eventTypes,
  failsWith,
  makeBike,
  makeCustomerWithBike,
  makeService,
  ownerMode,
  setStatus,
  voidLine,
  walkTo,
} from "./workshop-fixtures";
import { addPart, addStock, makeProduct, movements, onHand } from "./inventory-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ADMIN = staffClaims(AUTH_USER.admin);
const MECHANIC1 = staffClaims(AUTH_USER.mechanic1);
const MECHANIC2 = staffClaims(AUTH_USER.mechanic2);

type Claims = ReturnType<typeof staffClaims>;

/** Owner setup (a customer, bike and `setup`), then a job created as `claims`. */
async function withJob<T>(
  claims: Claims,
  fn: (tx: pg.Client, jobId: string, extra: Record<string, string>) => Promise<T>,
  setup: (tx: pg.Client) => Promise<Record<string, string>> = async () => ({}),
): Promise<T> {
  return inTransaction(conn, async (tx) => {
    const ids = await makeCustomerWithBike(tx);
    const extra = { ...(await setup(tx)), ...ids };
    await actAs(tx, claims);
    const job = await createWorkOrder(tx, ids);
    return fn(tx, job.id, extra);
  });
}

/** A line as the owner sees it (every column). */
async function line(tx: pg.Client, id: string) {
  await ownerMode(tx);
  const { rows } = await tx.query(
    `select quantity::text, unit_sale_price_snapshot::text as price,
            unit_direct_cost_snapshot::text as cost, cult_commons_rate_snapshot::text as rate,
            sale_total::text as sale, cost_total::text as cost_total, yield_total::text as yield,
            cult_commons_share::text as cc, description_snapshot as description, cost_pending,
            voided_at, voided_by, void_reason, created_by, currency, source_service_id
       from public.work_order_line_items where id = $1`,
    [id],
  );
  return rows[0];
}

describe.skipIf(!isolatedDatabase())(
  "Cult Commons is 30% of positive yield after direct costs (SPEC §10)",
  () => {
    it.each(LINE_FIXTURES)("generated columns: $name", async (f) => {
      await inTransaction(conn, async (tx) => {
        const ids = await makeCustomerWithBike(tx);
        if (Number(f.rate) !== 0.3) {
          await tx.query(
            "insert into public.cult_commons_rates (rate, effective_from) values ($1, clock_timestamp())",
            [f.rate],
          );
        }
        await actAs(tx, ADMIN);
        const job = await createWorkOrder(tx, ids);
        const id = await addManualLine(tx, {
          workOrderId: job.id,
          price: f.unitSalePrice,
          cost: f.unitDirectCost,
          quantity: f.quantity,
        });
        const { rows } = await tx.query(
          `select sale_total::text as sale, cost_total::text as cost, yield_total::text as yield,
                  cult_commons_share::text as cc, (yield_total - cult_commons_share)::text as after_cc,
                  cult_commons_rate_snapshot as rate
             from public.work_order_line_items_staff where id = $1`,
          [id],
        );
        expect(Number(rows[0].rate)).toBe(Number(f.rate));
        expect(rows[0]).toMatchObject({
          sale: f.sale,
          cost: f.cost,
          yield: f.yield,
          cc: f.cc,
          after_cc: f.afterCc,
        });
      });
    });

    it.each(JOB_FIXTURES)("work_order_totals_staff (D1): $name", async (job) => {
      await withJob(ADMIN, async (tx, jobId) => {
        for (const i of job.lines) {
          const f = LINE_FIXTURES[i];
          await addManualLine(tx, {
            workOrderId: jobId,
            price: f.unitSalePrice,
            cost: f.unitDirectCost,
            quantity: f.quantity,
          });
        }
        const { rows } = await tx.query(
          `select line_count, sale_total::text as sale, cost_total::text as cost,
                  yield_total::text as yield, cult_commons_share::text as cc,
                  bicii_yield_after_cc::text as after_cc
             from public.work_order_totals_staff where work_order_id = $1`,
          [jobId],
        );
        expect(rows[0]).toEqual({
          line_count: job.lines.length,
          sale: job.sale,
          cost: job.cost,
          yield: job.yield,
          cc: job.cc,
          after_cc: job.afterCc,
        });
        expect(
          await scalar(
            tx,
            "select sale_total::text from public.work_order_totals where work_order_id = $1",
            [jobId],
          ),
        ).toBe(job.sale);
      });
    });
  },
);

const createService = (tx: pg.Client, name: string, price: string, cost: string) =>
  scalar<string>(tx, "select public.create_service($1, $2, $3, null, null, $4)", [
    randomUUID(),
    name,
    price,
    cost,
  ]);

describe.skipIf(!isolatedDatabase())("snapshots", () => {
  it("historical line price/cost/yield snapshots do not change with catalog edits", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      const serviceId = await createService(tx, "Race Prep", "180.00", "20.00");
      const before = await addServiceLine(tx, { workOrderId: jobId, serviceId });
      await tx.query(
        "select public.update_service($1, 'Race Prep Plus', 220, null, null, true, false, 35)",
        [serviceId],
      );
      const after = await addServiceLine(tx, { workOrderId: jobId, serviceId });
      expect(await line(tx, before)).toMatchObject({
        description: "Race Prep",
        price: "180.00",
        cost: "20.00",
        sale: "180.00",
        yield: "160.00",
        cc: "48.00",
      });
      expect(await line(tx, after)).toMatchObject({
        description: "Race Prep Plus",
        price: "220.00",
        cost: "35.00",
        yield: "185.00",
        cc: "55.50",
      });
    });
  });

  it("archived entities remain available to historical references", async () => {
    await withJob(ADMIN, async (tx, jobId, ids) => {
      const serviceId = await createService(tx, "Headset Service", "60.00", "8.00");
      const lineId = await addServiceLine(tx, { workOrderId: jobId, serviceId });
      await tx.query("select public.set_service_archived($1, true)", [serviceId]);
      await ownerMode(tx);
      await tx.query("update public.bikes set archived_at = now() where id = $1", [ids.bikeId]);
      // The job is still open, so only the owner can archive (A-22).
      await archiveCustomerUnguarded(tx, ids.customerId);
      await actAs(tx, MECHANIC2);
      const { rows } = await tx.query(
        `select s.name as service, s.archived_at is not null as service_archived,
                b.archived_at is not null as bike_archived, c.archived_at is not null as customer_archived
           from public.work_order_line_items li
           join public.services s on s.id = li.source_service_id
           join public.work_orders w on w.id = li.work_order_id
           join public.bikes b on b.id = w.bike_id
           join public.customers c on c.id = w.customer_id
          where li.id = $1`,
        [lineId],
      );
      expect(rows).toEqual([
        {
          service: "Headset Service",
          service_archived: true,
          bike_archived: true,
          customer_archived: true,
        },
      ]);
      // ... but an archived service is not offered for new lines.
      await failsWith(tx, () => addServiceLine(tx, { workOrderId: jobId, serviceId }), {
        code: "P0001",
        message: "service_unavailable",
      });
    });
  });

  it("Cult Commons rate snapshot: a new rate applies to later lines only", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      const a = await addManualLine(tx, { workOrderId: jobId, price: "100.00", cost: "20.00" });
      // Scheduled for tomorrow: today's lines still use 0.30.
      await tx.query(
        "select public.schedule_cult_commons_rate($1, 0.1, now() + interval '1 day')",
        [randomUUID()],
      );
      const today = await addManualLine(tx, { workOrderId: jobId, price: "100.00", cost: "20.00" });
      await ownerMode(tx);
      await tx.query(
        "insert into public.cult_commons_rates (rate, effective_from) values (0.25, clock_timestamp())",
      );
      await actAs(tx, ADMIN);
      const b = await addManualLine(tx, { workOrderId: jobId, price: "100.00", cost: "20.00" });
      expect(await line(tx, a)).toMatchObject({ rate: "0.3000", cc: "24.00" });
      expect(await line(tx, today)).toMatchObject({ rate: "0.3000", cc: "24.00" });
      expect(await line(tx, b)).toMatchObject({ rate: "0.2500", cc: "20.00" });
    });
  });
});

describe.skipIf(!isolatedDatabase())("line pricing (D14)", () => {
  const setup = async (tx: pg.Client) => ({
    serviceId: await makeService(tx, { name: "Hub Overhaul", price: "35.00", cost: "5.00" }),
  });

  it("any staff member overrides the sale price; a cost needs view_costs", async () => {
    await withJob(
      MECHANIC2,
      async (tx, jobId, { serviceId }) => {
        const cheaper = await addServiceLine(tx, {
          workOrderId: jobId,
          serviceId,
          price: "30.00",
          description: "Wheel true (front only)",
        });
        await failsWith(
          tx,
          () => addServiceLine(tx, { workOrderId: jobId, serviceId, cost: "1.00" }),
          { code: "42501" },
        );
        await failsWith(
          tx,
          () => addManualLine(tx, { workOrderId: jobId, price: "10.00", cost: "1.00" }),
          { code: "42501" },
        );
        const manual = await addManualLine(tx, { workOrderId: jobId, price: "10.00" });
        expect(await line(tx, cheaper)).toMatchObject({
          price: "30.00",
          cost: "5.00",
          description: "Wheel true (front only)",
          created_by: STAFF.mechanic2,
        });
        // No cost entered: 0 is a placeholder, and the line says so (D14).
        expect(await line(tx, manual)).toMatchObject({
          cost: "0.00",
          rate: "0.3000",
          cost_pending: true,
        });
        expect(await line(tx, cheaper)).toMatchObject({ cost_pending: false });

        await actAs(tx, MECHANIC1);
        const withCost = await addServiceLine(tx, { workOrderId: jobId, serviceId, cost: "6.50" });
        expect(await line(tx, withCost)).toMatchObject({ price: "35.00", cost: "6.50" });
      },
      setup,
    );
  });

  it("inactive, archived and unknown services cannot be added", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      await ownerMode(tx);
      const inactive = await makeService(tx, { active: false });
      const archived = await makeService(tx);
      await tx.query("update public.services set archived_at = now() where id = $1", [archived]);
      await actAs(tx, ADMIN);
      for (const serviceId of [inactive, archived]) {
        await failsWith(tx, () => addServiceLine(tx, { workOrderId: jobId, serviceId }), {
          code: "P0001",
          message: "service_unavailable",
        });
      }
      await failsWith(
        tx,
        () => addServiceLine(tx, { workOrderId: jobId, serviceId: randomUUID() }),
        {
          code: "P0002",
        },
      );
      await failsWith(tx, () => addManualLine(tx, { workOrderId: randomUUID(), price: "1.00" }), {
        code: "P0002",
      });
    });
  });

  it("refuses zero, too large and NaN quantities, negative prices and overflowing totals", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      for (const [quantity, price, expected] of [
        ["0", "10.00", { code: "23514", constraint: "work_order_line_items_quantity_check" }],
        ["10000", "10.00", { code: "23514", constraint: "work_order_line_items_quantity_check" }],
        ["-1", "10.00", { code: "23514", constraint: "work_order_line_items_quantity_check" }],
        [
          "1",
          "-0.01",
          { code: "23514", constraint: "work_order_line_items_unit_sale_price_check" },
        ],
        ["NaN", "10.00", { code: "23514" }],
        ["9999", "9999999999.99", { code: "22003" }],
      ] as const) {
        await failsWith(
          tx,
          () => addManualLine(tx, { workOrderId: jobId, quantity, price }),
          expected,
        );
      }
      await failsWith(
        tx,
        () => addManualLine(tx, { workOrderId: jobId, description: "  ", price: "1" }),
        {
          code: "23514",
          constraint: "work_order_line_items_description_check",
        },
      );
      await failsWith(
        tx,
        () => tx.query("select public.add_manual_line($1, $2, 'x', null)", [randomUUID(), jobId]),
        { code: "22004" },
      );
    });
  });
});

describe.skipIf(!isolatedDatabase())("a manual line with no cost entered (D14)", () => {
  const totals = (tx: pg.Client, jobId: string) =>
    tx
      .query(
        `select cost_pending_count, cost_total::text as cost, cult_commons_share::text as cc
           from public.work_order_totals_staff where work_order_id = $1`,
        [jobId],
      )
      .then((r) => r.rows[0]);

  it("is marked cost pending and counted in the totals until it is voided and re-added", async () => {
    await withJob(MECHANIC2, async (tx, jobId) => {
      const spoke = await addManualLine(tx, {
        workOrderId: jobId,
        description: "Spoke",
        price: "10.00",
      });
      // The adder sees that a cost is still to be entered, never a cost.
      expect(
        await scalar(tx, "select cost_pending from public.work_order_line_items where id = $1", [
          spoke,
        ]),
      ).toBe(true);

      await actAs(tx, ADMIN);
      const labour = await addManualLine(tx, { workOrderId: jobId, price: "50.00", cost: "0" });
      const sundry = await addManualLine(tx, { workOrderId: jobId, price: "20.00" });
      expect(await line(tx, labour)).toMatchObject({ cost: "0.00", cost_pending: false });
      expect(await line(tx, sundry)).toMatchObject({ cost: "0.00", cost_pending: true });
      await actAs(tx, ADMIN);
      // 30% of the whole 80.00: provisional while two lines have no cost.
      expect(await totals(tx, jobId)).toEqual({ cost_pending_count: 2, cost: "0.00", cc: "24.00" });

      // The correction: void it and add it again with the real cost.
      await voidLine(tx, spoke, "Cost not known when it was added");
      await addManualLine(tx, {
        workOrderId: jobId,
        description: "Spoke",
        price: "10.00",
        cost: "4.00",
      });
      expect(await totals(tx, jobId)).toEqual({ cost_pending_count: 1, cost: "4.00", cc: "22.80" });

      // Immutable like every other snapshot, for the owner too.
      await ownerMode(tx);
      await failsWith(
        tx,
        () =>
          tx.query("update public.work_order_line_items set cost_pending = false where id = $1", [
            sundry,
          ]),
        { code: "P0001", message: "line_immutable" },
      );
    });
  });

  it("only a manual line with a zero placeholder can be pending (CHECK)", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      await ownerMode(tx);
      const serviceId = await makeService(tx, { name: "Pending Probe" });
      const insert = (lineType: string, service: string | null, cost: string) =>
        tx.query(
          `insert into public.work_order_line_items
             (id, work_order_id, line_type, source_service_id, description_snapshot, quantity,
              unit_sale_price_snapshot, unit_direct_cost_snapshot, cost_pending,
              cult_commons_rate_snapshot, currency)
           values ($1, $2, $3, $4, 'x', 1, 10, $5, true, 0.3, 'SGD')`,
          [randomUUID(), jobId, lineType, service, cost],
        );
      for (const [lineType, service, cost] of [
        ["service", serviceId, "0"],
        ["manual", null, "5.00"],
      ] as const) {
        await failsWith(tx, () => insert(lineType, service, cost), {
          code: "23514",
          constraint: "work_order_line_items_cost_pending_shape",
        });
      }
    });
  });
});

describe.skipIf(!isolatedDatabase())("errors never print a line's cost (SPEC §4.2)", () => {
  // A check violation inside a security definer function would otherwise
  // carry DETAIL "Failing row contains (...)", built with the owner's
  // privileges: every column, the cost, rate, yield and Cult Commons too.
  const setup = async (tx: pg.Client) => ({
    serviceId: await makeService(tx, { name: "Secret Cost Bleed", price: "45.00", cost: "8.37" }),
  });

  const leakFree = (err: unknown, constraint: string) => {
    const e = err as { code?: string; constraint?: string; detail?: string; message?: string };
    expect(e).toMatchObject({ code: "23514", constraint });
    expect(e.detail).toBeUndefined();
    expect(JSON.stringify(e)).not.toMatch(/8\.37|Failing row/);
  };

  it("add_service_line, add_manual_line and create_work_order refuse bad values without the row", async () => {
    await withJob(
      MECHANIC2,
      async (tx, jobId, { serviceId, customerId }) => {
        const attempts: Array<[() => Promise<unknown>, string]> = [
          [
            () => addServiceLine(tx, { workOrderId: jobId, serviceId, quantity: "10000" }),
            "work_order_line_items_quantity_check",
          ],
          [
            () => addServiceLine(tx, { workOrderId: jobId, serviceId, price: "-1" }),
            "work_order_line_items_unit_sale_price_check",
          ],
          [
            () => addServiceLine(tx, { workOrderId: jobId, serviceId, quantity: "0" }),
            "work_order_line_items_quantity_check",
          ],
          [
            () => addManualLine(tx, { workOrderId: jobId, price: "1", description: " " }),
            "work_order_line_items_description_check",
          ],
          [
            async () => {
              await ownerMode(tx);
              const bikeId = await makeBike(tx, customerId);
              await actAs(tx, MECHANIC2);
              return createWorkOrder(tx, {
                customerId,
                bikeId,
                services: [{ line_id: randomUUID(), service_id: serviceId, quantity: 10000 }],
              });
            },
            "work_order_line_items_quantity_check",
          ],
        ];
        for (const [attempt, constraint] of attempts) {
          await tx.query("savepoint probe");
          const err = await attempt().then(
            () => null,
            (e: unknown) => e,
          );
          await tx.query("rollback to savepoint probe");
          await actAs(tx, MECHANIC2);
          expect(err, constraint).not.toBeNull();
          leakFree(err, constraint);
        }
      },
      setup,
    );
  });
});

describe.skipIf(!isolatedDatabase())("mechanic permission boundaries (SPEC §4.2)", () => {
  it("staff without view_costs read the sale side only; view_costs holders read everything", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      await addManualLine(tx, { workOrderId: jobId, price: "95.00", cost: "62.00" });
      await actAs(tx, MECHANIC2);
      for (const sql of [
        "select cost_total from public.work_order_line_items",
        "select unit_direct_cost_snapshot from public.work_order_line_items",
        "select cult_commons_share from public.work_order_line_items",
        "select * from public.work_order_line_items",
      ]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
      expect(
        (
          await tx.query(
            "select description_snapshot, sale_total from public.work_order_line_items where work_order_id = $1",
            [jobId],
          )
        ).rows,
      ).toEqual([{ description_snapshot: "Labour", sale_total: "95.00" }]);
      expect(await scalar(tx, "select count(*)::int from public.work_order_line_items_staff")).toBe(
        0,
      );
      expect(await scalar(tx, "select count(*)::int from public.work_order_totals_staff")).toBe(0);
      const totals = await tx.query(
        "select * from public.work_order_totals where work_order_id = $1",
        [jobId],
      );
      expect(totals.rows).toEqual([
        { work_order_id: jobId, currency: "SGD", line_count: 1, sale_total: "95.00" },
      ]);

      await actAs(tx, MECHANIC1);
      expect(
        (
          await tx.query(
            "select cost_total, cult_commons_share from public.work_order_line_items_staff where work_order_id = $1",
            [jobId],
          )
        ).rows,
      ).toEqual([{ cost_total: "62.00", cult_commons_share: "9.90" }]);
      expect(
        await scalar(
          tx,
          "select bicii_yield_after_cc::text from public.work_order_totals_staff where work_order_id = $1",
          [jobId],
        ),
      ).toBe("23.10");
    });
  });

  it("line and service RPCs return ids, never rows (rows carry costs)", async () => {
    const { rows } = await conn.query(
      `select p.proname, p.prorettype::regtype::text as returns
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('add_service_line', 'add_manual_line', 'void_line',
                            'create_service', 'update_service', 'set_service_archived')
        order by 1`,
    );
    expect(rows.map((r) => r.returns)).toEqual(Array(6).fill("uuid"));
  });

  it("nobody writes lines directly", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      const id = await addManualLine(tx, { workOrderId: jobId, price: "10.00" });
      for (const sql of [
        "update public.work_order_line_items set void_reason = 'x', voided_at = now() where id = $1",
        "delete from public.work_order_line_items where id = $1",
      ]) {
        await failsWith(tx, () => tx.query(sql, [id]), { code: "42501" });
      }
    });
  });
});

describe.skipIf(!isolatedDatabase())("lines change only while the job is open (D15)", () => {
  it("locks lines once completed, and unlocks them after a reopen", async () => {
    await withJob(
      MECHANIC2,
      async (tx, jobId, { serviceId }) => {
        const kept = await addManualLine(tx, { workOrderId: jobId, price: "10.00" });
        await walkTo(tx, jobId, "completed");
        for (const add of [
          () => addServiceLine(tx, { workOrderId: jobId, serviceId }),
          () => addManualLine(tx, { workOrderId: jobId, price: "5.00" }),
          () => voidLine(tx, kept, "Not done"),
        ]) {
          await failsWith(tx, add, { code: "P0001", message: "work_order_locked" });
        }
        await setStatus(tx, jobId, "in_progress", "Missed a part");
        await addServiceLine(tx, { workOrderId: jobId, serviceId });
        expect(await voidLine(tx, kept, "Not done")).toBe(kept);
      },
      async (tx) => ({ serviceId: await makeService(tx) }),
    );
  });

  it("replays of add_service_line and add_manual_line still return the line after completion", async () => {
    await withJob(
      MECHANIC2,
      async (tx, jobId, { serviceId }) => {
        const serviceLine = randomUUID();
        const manualLine = randomUUID();
        await addServiceLine(tx, { lineId: serviceLine, workOrderId: jobId, serviceId });
        await addManualLine(tx, { lineId: manualLine, workOrderId: jobId, price: "12.00" });
        await walkTo(tx, jobId, "collected");
        const before = await eventTypes(tx, jobId);
        expect(
          await addServiceLine(tx, { lineId: serviceLine, workOrderId: jobId, serviceId }),
        ).toBe(serviceLine);
        expect(
          await addManualLine(tx, { lineId: manualLine, workOrderId: jobId, price: "12.00" }),
        ).toBe(manualLine);
        expect(await eventTypes(tx, jobId)).toEqual(before);
      },
      async (tx) => ({ serviceId: await makeService(tx) }),
    );
  });
});

describe.skipIf(!isolatedDatabase())("voiding and replays", () => {
  it("void needs a reason, keeps the row, is replay-safe, and leaves the totals", async () => {
    await withJob(MECHANIC2, async (tx, jobId) => {
      const keep = await addManualLine(tx, { workOrderId: jobId, price: "40.00" });
      const drop = await addManualLine(tx, { workOrderId: jobId, price: "15.00" });
      for (const reason of [null, "", "   "]) {
        await failsWith(tx, () => voidLine(tx, drop, reason), {
          code: "P0001",
          message: "reason_required",
        });
      }
      expect(await voidLine(tx, drop, "  Customer declined  ")).toBe(drop);
      expect(await voidLine(tx, drop, "Again")).toBe(drop);
      expect((await eventTypes(tx, jobId)).filter((t) => t === "line_voided")).toHaveLength(1);
      await failsWith(tx, () => voidLine(tx, randomUUID(), "Gone"), { code: "P0002" });

      const voided = await line(tx, drop);
      expect(voided).toMatchObject({
        void_reason: "Customer declined",
        voided_by: STAFF.mechanic2,
      });
      expect(voided.voided_at).not.toBeNull();
      expect((await line(tx, keep)).voided_at).toBeNull();

      await actAs(tx, MECHANIC2);
      expect(
        (
          await tx.query(
            "select line_count, sale_total from public.work_order_totals where work_order_id = $1",
            [jobId],
          )
        ).rows,
      ).toEqual([{ line_count: 1, sale_total: "40.00" }]);
      const { rows } = await tx.query(
        "select payload from public.work_order_events where work_order_id = $1 and event_type = 'line_voided'",
        [jobId],
      );
      expect(rows[0].payload).toEqual({
        line_id: drop,
        description: "Labour",
        quantity: 1,
        sale_total: 15,
        reason: "Customer declined",
      });
    });
  });

  it("lines are immutable for the owner too: no edits, no un-void, no deletes", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      const id = await addManualLine(tx, { workOrderId: jobId, price: "40.00" });
      const voided = await addManualLine(tx, { workOrderId: jobId, price: "10.00" });
      await voidLine(tx, voided, "Wrong part");
      await ownerMode(tx);
      for (const [sql, target] of [
        ["update public.work_order_line_items set unit_sale_price_snapshot = 1 where id = $1", id],
        ["update public.work_order_line_items set description_snapshot = 'Typo' where id = $1", id],
        [
          "update public.work_order_line_items set voided_at = null, voided_by = null, void_reason = null where id = $1",
          voided,
        ],
        ["delete from public.work_order_line_items where id = $1", id],
      ] as const) {
        await failsWith(tx, () => tx.query(sql, [target]), {
          code: "P0001",
          message: "line_immutable",
        });
      }
    });
  });

  it("voiding an inventory line writes its linked stock reversal (Phase 4)", async () => {
    await withJob(ADMIN, async (tx, jobId) => {
      await ownerMode(tx);
      const productId = await makeProduct(tx, {
        name: "Brake pads",
        price: "25.00",
        cost: "12.00",
      });
      await actAs(tx, ADMIN);
      await addStock(tx, productId, 5);
      const part = await addPart(tx, { workOrderId: jobId, productId, quantity: 2 });
      expect(part).toMatchObject({ on_hand_after: 3, replayed: false });
      expect(await voidLine(tx, part.line_id, "Wrong pads")).toBe(part.line_id);
      await ownerMode(tx);
      const rows = await movements(tx, productId);
      expect(rows.map((m) => [m.movement_type, m.quantity_delta])).toEqual([
        ["stock_adjustment", 5],
        ["job_consumption", -2],
        ["reversal", 2],
      ]);
      expect(rows[2].reversal_of_id).toBe(rows[1].id);
      expect(await onHand(tx, productId)).toBe(5);
      expect(await eventTypes(tx, jobId)).toEqual(
        expect.arrayContaining(["line_added", "stock_consumed", "line_voided", "stock_reversed"]),
      );
    });
  });

  it("adds are replay-safe by line id; the same id elsewhere is a conflict", async () => {
    await inTransaction(conn, async (tx) => {
      const a = await makeCustomerWithBike(tx);
      const serviceId = await makeService(tx);
      await actAs(tx, MECHANIC2);
      const jobA = (await createWorkOrder(tx, a)).id;
      const jobB = (await createWorkOrder(tx, a)).id;
      const serviceLine = randomUUID();
      const manualLine = randomUUID();
      for (let i = 0; i < 2; i++) {
        expect(
          await addServiceLine(tx, { lineId: serviceLine, workOrderId: jobA, serviceId }),
        ).toBe(serviceLine);
        expect(
          await addManualLine(tx, { lineId: manualLine, workOrderId: jobA, price: "9.00" }),
        ).toBe(manualLine);
      }
      expect((await eventTypes(tx, jobA)).filter((t) => t === "line_added")).toHaveLength(2);
      for (const attempt of [
        () => addServiceLine(tx, { lineId: serviceLine, workOrderId: jobB, serviceId }),
        () => addManualLine(tx, { lineId: manualLine, workOrderId: jobB, price: "9.00" }),
        () => addServiceLine(tx, { lineId: manualLine, workOrderId: jobA, serviceId }),
        () => addManualLine(tx, { lineId: serviceLine, workOrderId: jobA, price: "9.00" }),
      ]) {
        await failsWith(tx, attempt, { code: "P0001", message: "line_conflict" });
      }
    });
  });
});

describe("anonymous and signed-out access", () => {
  it("anon reaches no workshop table or view", async () => {
    for (const rel of [
      "work_order_line_items",
      "work_order_line_items_staff",
      "work_order_totals",
      "work_order_totals_staff",
      "services",
      "services_staff",
      "cult_commons_rates",
      "categories",
      "work_orders",
      "work_order_events",
      "work_order_assignments",
    ]) {
      await expect(
        asAnon(conn, (tx) => tx.query(`select 1 from public.${rel} limit 1`)),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
