/**
 * The operational exceptions, extended by Phase 9 (SPEC §13, §19.1, §26;
 * DATA-MODEL §14, §15; PLAN D34 EXCEPTIONS, D104, D106, D107
 * UNSETTLED-CONSIGNMENT-ALERT, D108 EXCEPTION-VISIBILITY).
 *
 *   * Phase 5's nine columns and rows are unchanged: the first nine columns
 *     of every Phase 5 kind equal what Phase 5's own view definition (read
 *     from its migration) produces, and the appended columns are filled as
 *     DATA-MODEL §14 says.
 *   * unsettled_consignment appears after N shop days (N admin-set, replay
 *     safe, never directly writable) and clears when the money is settled
 *     or the sale restocked.
 *   * One visibility rule (private.exception_visible) for the list, the
 *     counts and Today's exceptions_now.
 *   * currency_mismatch covers sale lines: exactly the lines the period
 *     reports exclude on the sale basis.
 *
 * Everything here creates jobs, consignments or sales (short-ID
 * sequences), so the cases skip in existing-database mode.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createConsignor,
  intakeUnique,
  recordSale,
  restock,
  saleLines,
  settle,
  staffWith,
} from "./consignment-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  makeLocation,
  makeProduct,
  makeUniqueWithUnit,
} from "./inventory-fixtures";
import {
  OPERATIONAL_EXCEPTIONS_COLUMNS,
  TEST_DAY,
  addDays,
  completedPath,
  dbNow,
  insertJob,
  sgt,
  shopToday,
} from "./reporting-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const PHASE5_KINDS = [
  "overdue_job",
  "uncollected_job",
  "negative_stock",
  "unit_hold_stale",
  "currency_mismatch",
] as const;

const NINE = OPERATIONAL_EXCEPTIONS_COLUMNS.slice(0, 9).join(", ");

/** Phase 5's view body, exactly as its migration created it. */
function phase5ViewBody(): string {
  const file = path.join(process.cwd(), "supabase/migrations/20261004002500_daily_summary.sql");
  const sql = readFileSync(file, "utf8");
  const start = sql.indexOf("create view reporting.operational_exceptions");
  const asAt = sql.indexOf("\nas\n", start);
  const end = sql.indexOf(";\n\ncomment on view reporting.operational_exceptions", asAt);
  if (start < 0 || asAt < 0 || end < 0) throw new Error("Phase 5's view definition was not found");
  return sql.slice(asAt + 4, end);
}

type ExceptionRow = {
  kind: string;
  severity: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  subject_label: string | null;
  days: number | null;
  quantity: number | null;
  since: Date | null;
  issue: string;
  short_id: string | null;
  title: string | null;
  detail: string | null;
  amount: string | null;
  currency: string | null;
};

async function listed(tx: pg.Client): Promise<ExceptionRow[]> {
  return (await tx.query<ExceptionRow>("select * from public.operational_exceptions(200)")).rows;
}

const canonical = (rows: Record<string, unknown>[]) =>
  rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();

/** A consignment item sold `soldDaysAgo` shop days ago (received `receivedDaysAgo`). */
async function soldConsignment(
  tx: pg.Client,
  today: string,
  {
    consignorId,
    agreed = "300.00",
    receivedDaysAgo = 60,
    soldDaysAgo = 45,
  }: { consignorId: string; agreed?: string; receivedDaysAgo?: number; soldDaysAgo?: number },
) {
  await actAs(tx, ADMIN);
  const item = await intakeUnique(tx, {
    consignorId,
    agreed,
    asking: "800.00",
    receivedAt: sgt(addDays(today, -receivedDaysAgo), "10:00"),
  });
  const soldAt = sgt(addDays(today, -soldDaysAgo), "12:00");
  const sale = await recordSale(tx, {
    lines: [{ inventory_unit_id: item.inventory_unit_id! }],
    recognizedAt: soldAt,
  });
  return { item, sale, soldAt };
}

describe("Phase 5 exceptions are unchanged (D34)", () => {
  it("the first nine columns equal Phase 5's definition; the appended ones follow DATA-MODEL §14", async (ctx) => {
    if (!isolatedDatabase()) ctx.skip();
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      // One of each Phase 5 kind, as Phase 5's own test builds them.
      await insertJob(tx, { checkedInAt: await dbNow(tx, "-8 days") });
      await insertJob(tx, {
        checkedInAt: sgt(addDays(today, -9), "09:00"),
        path: [
          ...completedPath(sgt(addDays(today, -8), "09:00"), sgt(addDays(today, -7), "12:00")),
          { status: "ready_for_collection", at: sgt(addDays(today, -7), "13:00") },
        ],
      });
      const location = await makeLocation(tx);
      const negative = await makeProduct(tx);
      await tx.query(
        `insert into public.inventory_movements (product_id, location_id, quantity_delta, movement_type, reason)
         values ($1, $2, -3, 'stock_adjustment', 'Forced below zero by the test')`,
        [negative, location],
      );
      const stale = await makeProduct(tx, { tracking: "unique" });
      const staleUnit = (
        await tx.query<{ id: string }>(
          "insert into public.inventory_units (product_id, location_id) values ($1, $2) returning id",
          [stale, location],
        )
      ).rows[0].id;
      await tx.query(
        "update public.inventory_units set status = 'held_for_customer' where id = $1",
        [staleUnit],
      );
      await insertJob(tx, {
        currency: "USD",
        checkedInAt: sgt(TEST_DAY(130), "08:00"),
        path: completedPath(sgt(TEST_DAY(130), "08:30"), sgt(TEST_DAY(130), "15:00")),
        lines: [
          {
            type: "manual",
            unitSale: "25.00",
            unitCost: "0.00",
            createdAt: sgt(TEST_DAY(130), "09:00"),
          },
        ],
      });
      await ownerMode(tx);

      const phase5 = (await tx.query(`select ${NINE} from (${phase5ViewBody()}) p5`)).rows;
      expect(new Set(phase5.map((r) => r.kind))).toEqual(new Set(PHASE5_KINDS));
      const now = (
        await tx.query(
          `select ${NINE} from reporting.operational_exceptions
            where kind = any($1) and entity_type <> 'sale'`,
          [[...PHASE5_KINDS]],
        )
      ).rows;
      expect(canonical(now)).toEqual(canonical(phase5));

      // The appended columns of the Phase 5 rows.
      const full = (
        await tx.query<ExceptionRow>(
          "select * from reporting.operational_exceptions where kind = any($1) and entity_type <> 'sale'",
          [[...PHASE5_KINDS]],
        )
      ).rows;
      expect(full.length).toBe(phase5.length);
      for (const r of full) {
        expect(r.issue).toBe(r.kind === "negative_stock" ? "negative_on_hand" : r.kind);
        expect(r.short_id).toBe(r.entity_label);
        expect(r.short_id).toMatch(/^[JPU]-\d{6}$/);
        expect(r.title).toBe(r.entity_label);
        expect(r.detail).toBe(r.subject_label);
        expect(r.amount).toBeNull();
        expect(r.currency).toBeNull();
      }

      // The RPC keeps Phase 5's nine columns first, then the six appended.
      await actAs(tx, ADMIN);
      const res = await tx.query("select * from public.operational_exceptions(1)");
      expect(res.fields.map((f) => f.name)).toEqual([...OPERATIONAL_EXCEPTIONS_COLUMNS]);
    });
  });
});

describe("Unsettled consignments are raised after N days (D107)", () => {
  it("an item sold 45 days ago with money outstanding: threshold, replay, refusals, settlement and restock", async (ctx) => {
    if (!isolatedDatabase()) ctx.skip();
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      await actAs(tx, ADMIN);
      const consignorId = await createConsignor(tx, {
        displayName: `Late payee ${randomUUID().slice(0, 6)}`,
      });
      const a = await soldConsignment(tx, today, { consignorId });
      const rowOf = async (itemId: string) =>
        (await listed(tx)).filter((r) => r.entity_id === itemId);

      const [row] = await rowOf(a.item.item_id);
      expect(row).toMatchObject({
        kind: "unsettled_consignment",
        severity: "warning",
        entity_type: "consignment_item",
        entity_label: a.item.short_id,
        short_id: a.item.short_id,
        issue: "unsettled_consignment",
        days: 45,
        quantity: null,
        amount: "300.00",
        currency: "SGD",
      });
      expect(row.since?.toISOString()).toBe(new Date(a.soldAt).toISOString());
      const consignorName = await scalar<string>(
        tx,
        "select display_name from public.consignors where id = $1",
        [consignorId],
      );
      expect(row.subject_label).toContain(consignorName);
      expect(row.title).toContain(consignorName);
      expect(await rowOf(a.item.item_id)).toHaveLength(1);

      // The threshold (strictly more than N shop days).
      const setDays = (n: number | null) =>
        scalar<number>(tx, "select public.set_consignment_settlement_alert_days($1)", [n]);
      expect(await setDays(60)).toBe(60);
      expect(await rowOf(a.item.item_id)).toEqual([]);
      expect(await setDays(45)).toBe(45);
      expect(await rowOf(a.item.item_id)).toEqual([]);
      expect(await setDays(44)).toBe(44);
      expect(await rowOf(a.item.item_id)).toHaveLength(1);
      expect(await setDays(30)).toBe(30);
      expect(await rowOf(a.item.item_id)).toHaveLength(1);

      // Replaying the current value writes no history; a change writes one row.
      const history = () =>
        scalar<number>(
          tx,
          "select count(*)::int from public.schedule_events where entity = 'shop_settings'",
        );
      const before = await history();
      expect(await setDays(30)).toBe(30);
      expect(await history()).toBe(before);
      expect(await setDays(31)).toBe(31);
      expect(await history()).toBe(before + 1);
      const last = (
        await tx.query<{ payload: Record<string, unknown> }>(
          "select payload from public.schedule_events where entity = 'shop_settings' order by id desc limit 1",
        )
      ).rows[0];
      expect(last.payload).toEqual({ consignment_settlement_alert_days: { from: 30, to: 31 } });
      expect(await setDays(30)).toBe(30);

      // Out of range.
      for (const bad of [0, 366, null])
        await failsWith(tx, () => setDays(bad), {
          code: "P0001",
          message: "alert_days_out_of_range",
        });

      // Never directly writable, not even by an admin.
      await failsWith(
        tx,
        () =>
          tx.query(
            "update public.shop_settings set consignment_settlement_alert_days = 90 where id = 1",
          ),
        { code: "42501" },
      );
      expect(
        await scalar<number>(
          tx,
          "select consignment_settlement_alert_days from public.shop_settings",
        ),
      ).toBe(30);

      // Admins only, even with manage_consignments.
      await ownerMode(tx);
      const consignments = await staffWith(tx, ["manage_consignments"]);
      for (const claims of [consignments.claims, MECHANIC2, MECHANIC1, MANAGER]) {
        await ownerMode(tx);
        await actAs(tx, claims);
        await failsWith(tx, () => setDays(40), { code: "42501" });
      }
      await ownerMode(tx);
      await actAs(tx, ADMIN);

      // A partial settlement leaves the reduced outstanding; a full one clears it.
      await settle(tx, {
        consignorId,
        amount: "100.00",
        allocations: [{ consignment_item_id: a.item.item_id, amount: "100.00" }],
      });
      expect(await rowOf(a.item.item_id)).toMatchObject([{ amount: "200.00", days: 45 }]);
      await settle(tx, {
        consignorId,
        amount: "200.00",
        allocations: [{ consignment_item_id: a.item.item_id, amount: "200.00" }],
      });
      expect(await rowOf(a.item.item_id)).toEqual([]);

      // A restock removes the liability and with it the row.
      const b = await soldConsignment(tx, today, {
        consignorId,
        agreed: "150.00",
        soldDaysAgo: 40,
      });
      expect(await rowOf(b.item.item_id)).toMatchObject([{ amount: "150.00", days: 40 }]);
      const [line] = await saleLines(tx, b.sale.sale_id);
      await restock(tx, { unitId: b.item.inventory_unit_id!, saleLineId: line.id });
      expect(await rowOf(b.item.item_id)).toEqual([]);

      // A recent sale is not raised.
      const c = await soldConsignment(tx, today, {
        consignorId,
        receivedDaysAgo: 10,
        soldDaysAgo: 5,
      });
      expect(await rowOf(c.item.item_id)).toEqual([]);
    });
  });
});

describe("Exception visibility is one rule (D108)", () => {
  it("unsettled_consignment needs consignment money access; list, counts and exceptions_now agree for every caller", async (ctx) => {
    if (!isolatedDatabase()) ctx.skip();
    await inTransaction(conn, async (tx) => {
      const today = await shopToday(tx);
      await actAs(tx, ADMIN);
      const consignorId = await createConsignor(tx);
      const { item } = await soldConsignment(tx, today, { consignorId });
      // A unit_state_mismatch too, visible to every staff member.
      const u = await makeUniqueWithUnit(tx);
      await ownerMode(tx);
      await tx.query("set local session_replication_role = replica");
      await tx.query("update public.inventory_units set status = 'written_off' where id = $1", [
        u.unitId,
      ]);
      await tx.query("set local session_replication_role = origin");

      const consignments = await staffWith(tx, ["manage_consignments"]);
      const financialOnly = await staffWith(tx, ["view_financial_reports"]);
      const cases: Array<[string, Claims, boolean]> = [
        ["admin", ADMIN, true],
        ["manager (through the role)", MANAGER, true],
        ["mechanic1 (view_costs)", MECHANIC1, true],
        ["mechanic with manage_consignments only", consignments.claims, true],
        ["mechanic with view_financial_reports only", financialOnly.claims, false],
        ["mechanic2 (no exceptions)", MECHANIC2, false],
      ];
      for (const [who, claims, sees] of cases) {
        await ownerMode(tx);
        await actAs(tx, claims);
        const rows = await listed(tx);
        expect(
          rows.some((r) => r.entity_id === item.item_id),
          who,
        ).toBe(sees);
        expect(
          rows.some((r) => r.kind === "unsettled_consignment"),
          who,
        ).toBe(sees);
        expect(
          rows.some((r) => r.kind === "unit_state_mismatch" && r.entity_id === u.unitId),
          who,
        ).toBe(true);
        expect(rows.length, who).toBeLessThan(200);

        const perKind = new Map<string, number>();
        for (const r of rows) perKind.set(r.kind, (perKind.get(r.kind) ?? 0) + 1);
        const counts = (
          await tx.query<{ kind: string; severity: string; count: number }>(
            "select * from public.report_exception_counts()",
          )
        ).rows;
        const countsPerKind = new Map<string, number>();
        for (const c of counts)
          countsPerKind.set(c.kind, (countsPerKind.get(c.kind) ?? 0) + c.count);
        expect(Object.fromEntries(countsPerKind), who).toEqual(Object.fromEntries(perKind));

        const dash = (
          await tx.query<{ exceptions_now: number }>(
            "select exceptions_now from public.today_dashboard(null)",
          )
        ).rows[0];
        expect(dash.exceptions_now, who).toBe(rows.length);
      }
    });
  });

  it("integration_failed: private.integration_exceptions() keeps Phase 10's nine-column signature and no API grant; an admin sees each needs_attention job once, mechanic2 none (R-058)", async () => {
    await inTransaction(conn, async (tx) => {
      const { rows } = await tx.query<{
        result: string;
        args: string;
        definer: boolean;
        volatility: string;
        config: string[] | null;
      }>(
        `select pg_get_function_result(p.oid) as result,
                pg_get_function_identity_arguments(p.oid) as args,
                p.prosecdef as definer,
                p.provolatile::text as volatility,
                p.proconfig as config
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'integration_exceptions'`,
      );
      expect(rows).toEqual([
        {
          result:
            "TABLE(kind text, severity text, entity_type text, entity_id uuid, entity_label text, subject_label text, days integer, quantity integer, since timestamp with time zone)",
          args: "",
          definer: true,
          volatility: "s",
          config: ['search_path=""'],
        },
      ]);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(
          await scalar<boolean>(
            tx,
            "select has_function_privilege($1, 'private.integration_exceptions()', 'execute')",
            [role],
          ),
        ).toBe(false);
      }
      // Phase 10's body is the one in force (the Phase 9 placeholder is only
      // created where it is absent): the seed's unmapped #1002 leaves one
      // needs_attention job, which the admin sees once, with the appended
      // columns filled by this view (issue = kind, title = entity_label,
      // detail = subject_label), and mechanic2 does not see at all.
      const needsAttention = await scalar<number>(
        tx,
        "select count(*)::int from public.integration_retry_queue where status = 'needs_attention'",
      );
      expect(needsAttention).toBeGreaterThan(0);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN)]);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from private.integration_exceptions() where kind = 'integration_failed'",
        ),
      ).toBe(needsAttention);
      expect(
        await scalar<number>(
          tx,
          `select count(*)::int from reporting.operational_exceptions
            where kind = 'integration_failed' and issue = 'integration_failed'
              and entity_type = 'integration_job' and title = entity_label
              and detail is not distinct from subject_label
              and amount is null and currency is null`,
        ),
      ).toBe(needsAttention);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(MECHANIC2),
      ]);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from private.integration_exceptions() where kind = 'integration_failed'",
        ),
      ).toBe(0);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN)]);
      // The visibility rule per kind, as the admin and as mechanic2.
      const visible = (kind: string) =>
        scalar<boolean>(tx, "select private.exception_visible($1)", [kind]);
      expect(await visible("integration_failed")).toBe(true);
      expect(await visible("unsettled_consignment")).toBe(true);
      expect(await visible("unit_state_mismatch")).toBe(true);
      // Phase 14 step 2 (D159b): payment conditions for admins and
      // managers, Stripe event problems for admins only.
      expect(await visible("payment_attention")).toBe(true);
      expect(await visible("stripe_attention")).toBe(true);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(MANAGER),
      ]);
      expect(await visible("payment_attention")).toBe(true);
      expect(await visible("stripe_attention")).toBe(false);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(MECHANIC2),
      ]);
      expect(await visible("integration_failed")).toBe(false);
      expect(await visible("unsettled_consignment")).toBe(false);
      expect(await visible("payment_attention")).toBe(false);
      expect(await visible("stripe_attention")).toBe(false);
      for (const kind of [...PHASE5_KINDS, "unit_state_mismatch"])
        expect(await visible(kind)).toBe(true);
    });
  });

  it("report_exception_counts refuses customers and anon (42501)", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, { role: "anon" });
      await failsWith(tx, () => tx.query("select * from public.report_exception_counts()"), {
        code: "42501",
      });
      await failsWith(
        tx,
        () => tx.query("select public.set_consignment_settlement_alert_days(30)"),
        { code: "42501" },
      );
    });
  });
});

describe("currency_mismatch covers sale lines (D104)", () => {
  it("a work-order line and a sale line in another currency are listed, exactly as the period reports exclude them", async (ctx) => {
    if (!isolatedDatabase()) ctx.skip();
    await inTransaction(conn, async (tx) => {
      const jobDay = TEST_DAY(300);
      const saleDay = TEST_DAY(301);
      const usdJob = await insertJob(tx, {
        currency: "USD",
        checkedInAt: sgt(jobDay, "08:00"),
        path: completedPath(sgt(jobDay, "08:30"), sgt(jobDay, "15:00")),
        lines: [
          {
            type: "manual",
            unitSale: "40.00",
            unitCost: "0.00",
            createdAt: sgt(jobDay, "09:00"),
            description: "Imported labour",
          },
        ],
      });
      await ownerMode(tx);
      const product = await makeProduct(tx);
      const saleId = randomUUID();
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        `insert into public.sales (id, sale_number, source, recognized_at, status, currency)
         values ($1, 'S-900001', 'retail', $2, 'recorded', 'USD')`,
        [saleId, sgt(saleDay, "11:00")],
      );
      await tx.query(
        `insert into public.sale_lines
           (sale_id, line_number, product_id, description_snapshot, quantity, unit_sale_price_snapshot,
            unit_direct_cost_snapshot, cult_commons_rate_snapshot, currency)
         values ($1, 1, $2, 'Imported bell', 1, 12.00, 5.00, 0.3000, 'USD'),
                ($1, 2, $2, 'Imported horn', 1, 18.00, 6.00, 0.3000, 'USD')`,
        [saleId, product],
      );
      await tx.query("set local session_replication_role = origin");

      await actAs(tx, ADMIN);
      const rows = (await listed(tx)).filter((r) => r.kind === "currency_mismatch");
      expect(rows.filter((r) => r.entity_id === usdJob.lineIds[0])).toMatchObject([
        {
          entity_type: "work_order_line",
          entity_label: usdJob.job.job_number,
          issue: "currency_mismatch",
        },
      ]);
      const saleRows = rows.filter((r) => r.entity_id === saleId);
      expect(saleRows).toHaveLength(2);
      for (const r of saleRows) {
        expect(r).toMatchObject({
          severity: "danger",
          entity_type: "sale",
          entity_label: "S-900001",
          short_id: "S-900001",
          issue: "currency_mismatch",
        });
        expect(r.subject_label).toMatch(/^Imported (bell|horn) · USD$/);
        expect(r.since?.toISOString()).toBe(new Date(sgt(saleDay, "11:00")).toISOString());
      }

      const excluded = (from: string, to: string) =>
        scalar<number>(
          tx,
          "select excluded_foreign_line_count from public.report_period_summary($1, $2, 'sale')",
          [from, to],
        );
      expect(await excluded(jobDay, jobDay)).toBe(1);
      expect(await excluded(saleDay, saleDay)).toBe(2);
      expect(await excluded(jobDay, saleDay)).toBe(3);

      // Exactly the same lines, document by document.
      await ownerMode(tx);
      const reportDocs = (
        await tx.query<{ document_number: string }>(
          `select document_number from private.report_rows($1::date, $2::date, 'sale', null, null, null, true)`,
          [jobDay, saleDay],
        )
      ).rows
        .map((r) => r.document_number)
        .sort();
      const exceptionDocs = rows
        .filter((r) => {
          const t = r.since ? r.since.getTime() : NaN;
          return (
            t >= new Date(sgt(jobDay, "00:00")).getTime() &&
            t < new Date(sgt(addDays(saleDay, 1), "00:00")).getTime()
          );
        })
        .map((r) => r.entity_label)
        .sort();
      expect(exceptionDocs).toEqual(reportDocs);
      expect(reportDocs).toEqual([usdJob.job.job_number, "S-900001", "S-900001"].sort());
    });
  });
});
