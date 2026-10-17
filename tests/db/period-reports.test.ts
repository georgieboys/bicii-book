/**
 * Period reporting (Phase 9 step 1): date bases, report lines, the period
 * RPCs, purchases and stock value (SPEC §10, §19.2, §23, §24; DATA-MODEL
 * §14, §16; PLAN D1, D24 as amended, D30, D35, D100-D105).
 *
 * The figures come from the March 2025 scenario in
 * tests/db/period-report-fixtures.ts (literal expectations, never
 * recomputed with the code under test) and, for the reconciliation and
 * partition checks, from the seed's last week (days counted back from
 * seedToday()). Building the scenario takes short-ID sequence values, so
 * those tests skip in existing-database mode; the argument, access and
 * catalogue checks run everywhere. Every test rolls back.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { CUSTOMER, STAFF } from "../fixtures/ids";
import { intakeUnique, createConsignor, refund, restock, staffWith } from "./consignment-fixtures";
import { customerClaims, linkCustomerLogin } from "./customer-fixtures";
import { actAs, connect, inTransaction, isolatedDatabase, scalar, type Claims } from "./harness";
import {
  ADMIN,
  MANAGER,
  MECHANIC1,
  MECHANIC2,
  addStock,
  makeLocation,
  makeProduct,
  readAsOwner,
} from "./inventory-fixtures";
import {
  MAR,
  PERIOD_EXPECTED,
  buildPeriodScenario,
  type Money4,
  type PeriodScenario,
} from "./period-report-fixtures";
import { openPO, receive } from "./purchasing-fixtures";
import {
  addDays,
  dailySummary,
  insertJob,
  money,
  moveJob,
  seedToday,
  sgt,
  shopToday,
  voidLineAt,
} from "./reporting-fixtures";
import { failsWith, ownerMode } from "./workshop-fixtures";

let conn: pg.Client;
let anchor: string;

beforeAll(async () => {
  conn = await connect();
  anchor = await seedToday(conn);
});

const isolated = isolatedDatabase();

type Row = Record<string, unknown>;
type Basis = "sale" | "check_in" | "completion" | "collection";
const BASES: readonly Basis[] = ["sale", "check_in", "completion", "collection"];
const DIMENSIONS = [
  "job",
  "product",
  "category",
  "service",
  "mechanic",
  "ownership",
  "channel",
] as const;
type Dimension = (typeof DIMENSIONS)[number];

const WEEK = { from: MAR.mon3, to: MAR.sun9 };

async function q(tx: pg.Client, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await tx.query(sql, params)).rows as Row[];
}

const summary = async (tx: pg.Client, from: string, to: string, basis: Basis | null = "sale") =>
  (
    await q(tx, "select * from public.report_period_summary($1::date, $2::date, $3)", [
      from,
      to,
      basis,
    ])
  )[0];

const series = (tx: pg.Client, from: string, to: string, basis: Basis, grain: string) =>
  q(
    tx,
    `select to_char(bucket_start, 'YYYY-MM-DD') as bucket_start, to_char(bucket_end, 'YYYY-MM-DD') as bucket_end,
            partial, line_count, job_count, sale_count, sale_total, cost_total, yield_total,
            cult_commons_share, yield_after_cc, loss_line_count, refunds_total, consignment_sales,
            consignment_sales_total, new_consignor_liability, settlements_paid_total
       from public.report_period_series($1::date, $2::date, $3, $4)`,
    [from, to, basis, grain],
  );

const breakdown = (
  tx: pg.Client,
  from: string,
  to: string,
  basis: Basis,
  dimension: Dimension,
  opts: {
    max?: number;
    key?: string | null;
    afterTotal?: string | null;
    afterKey?: string | null;
  } = {},
) =>
  q(tx, "select * from public.report_breakdown($1::date, $2::date, $3, $4, $5, $6, $7, $8)", [
    from,
    to,
    basis,
    dimension,
    opts.max ?? 500,
    opts.key ?? null,
    opts.afterTotal ?? null,
    opts.afterKey ?? null,
  ]);

const lineItems = (
  tx: pg.Client,
  from: string,
  to: string,
  basis: Basis,
  opts: {
    dimension?: Dimension | null;
    key?: string | null;
    max?: number;
    afterAt?: string | null;
    afterId?: string | null;
  } = {},
) =>
  q(
    tx,
    `select *, to_char(basis_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as basis_at_iso
       from public.report_line_items($1::date, $2::date, $3, $4, $5, $6, $7::timestamptz, $8)`,
    [
      from,
      to,
      basis,
      opts.dimension ?? null,
      opts.key ?? null,
      opts.max ?? 1000,
      opts.afterAt ?? null,
      opts.afterId ?? null,
    ],
  );

const activity = async (tx: pg.Client, from: string, to: string) =>
  (await q(tx, "select * from public.report_activity($1::date, $2::date)", [from, to]))[0];

const m4 = (r: Row): Money4 => ({
  sale: money(r.sale_total)!,
  cost: money(r.cost_total)!,
  yield: money(r.yield_total)!,
  cc: money(r.cult_commons_share)!,
});

/** Every page of a breakdown at p_max_rows `size` (asks for size + 1, shows size). */
async function allPages(
  tx: pg.Client,
  from: string,
  to: string,
  basis: Basis,
  dimension: Dimension,
  size = 2,
): Promise<Row[]> {
  const out: Row[] = [];
  let after: { total: string; key: string } | null = null;
  for (let guard = 0; guard < 500; guard++) {
    const page = await breakdown(tx, from, to, basis, dimension, {
      max: size + 1,
      afterTotal: after?.total ?? null,
      afterKey: after?.key ?? null,
    });
    const shown = page.slice(0, size);
    out.push(...shown);
    if (page.length <= size) return out;
    const last = shown[shown.length - 1];
    after = { total: String(last.sale_total), key: String(last.key) };
  }
  throw new Error("allPages: too many pages");
}

/** Every line item of a group at p_max_rows `size`, following the keyset. */
async function allLines(
  tx: pg.Client,
  from: string,
  to: string,
  basis: Basis,
  dimension: Dimension | null,
  key: string | null,
  size = 2,
): Promise<Row[]> {
  const out: Row[] = [];
  let after: { at: string; id: string } | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    const page = await lineItems(tx, from, to, basis, {
      dimension,
      key,
      max: size,
      afterAt: after?.at ?? null,
      afterId: after?.id ?? null,
    });
    out.push(...page);
    if (page.length < size) return out;
    const last = page[page.length - 1];
    after = { at: String(last.basis_at_iso), id: String(last.source_line_id) };
  }
  throw new Error("allLines: too many pages");
}

/** Σ of a breakdown's money columns and counts, in SQL (exact numeric). */
async function breakdownSums(
  tx: pg.Client,
  from: string,
  to: string,
  basis: Basis,
  dimension: Dimension,
): Promise<Row> {
  return (
    await q(
      tx,
      `select count(*)::integer as groups, sum(line_count)::integer as line_count,
              sum(sale_total)::text as sale_total, sum(cost_total)::text as cost_total,
              sum(yield_total)::text as yield_total, sum(cult_commons_share)::text as cult_commons_share,
              sum(yield_after_cc)::text as yield_after_cc
         from public.report_breakdown($1::date, $2::date, $3, $4, 500)`,
      [from, to, basis, dimension],
    )
  )[0];
}

/** The channel keys a sale_source value maps to (financial_lines' CASE). */
function channelOf(source: string): string | null {
  switch (source) {
    case "retail":
      return "retail";
    case "online_shopify":
      return "online";
    // Reserved and never written; excluded from financial_lines (Phase 9
    // §1.3) because its lines would double-count the job's own lines.
    case "work_order":
      return null;
    default:
      throw new Error(
        `sale_source '${source}' has no channel: add an arm to reporting.financial_lines' CASE and to this test`,
      );
  }
}

describe("Report RPCs answer with the documented columns (DATA-MODEL §16)", () => {
  it("each of the seven RPCs returns exactly its columns, in order", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      const cols = async (sql: string) => (await tx.query(sql)).fields.map((f) => f.name);
      expect(
        await cols("select * from public.report_period_summary('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "basis",
        "from_date",
        "to_date",
        "currency",
        "line_count",
        "job_count",
        "sale_count",
        "loss_line_count",
        "sale_total",
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "yield_after_cc",
        "cost_pending_lines",
        "refunds_total",
        "refund_count",
        "consignment_sales",
        "consignment_sales_total",
        "new_consignor_liability",
        "settlements_paid_total",
        "purchases_received_total",
        "excluded_foreign_line_count",
      ]);
      expect(
        await cols("select * from public.report_period_series('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "bucket_start",
        "bucket_end",
        "partial",
        "line_count",
        "job_count",
        "sale_count",
        "sale_total",
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "yield_after_cc",
        "loss_line_count",
        "refunds_total",
        "consignment_sales",
        "consignment_sales_total",
        "new_consignor_liability",
        "settlements_paid_total",
      ]);
      expect(
        await cols("select * from public.report_breakdown('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "key",
        "entity_type",
        "entity_id",
        "label",
        "detail",
        "line_count",
        "job_count",
        "sale_count",
        "quantity",
        "sale_total",
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "yield_after_cc",
        "first_at",
        "last_at",
      ]);
      expect(
        await cols("select * from public.report_line_items('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "source_line_id",
        "source",
        "channel",
        "basis_at",
        "document_id",
        "document_number",
        "line_type",
        "description",
        "quantity",
        "unit_sale_price",
        "sale_total",
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "cost_pending",
        "ownership_type",
        "category_name",
        "mechanic_name",
        "currency",
      ]);
      expect(
        await cols("select * from public.report_activity('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "jobs_checked_in",
        "jobs_started",
        "jobs_completed",
        "jobs_ready_for_collection",
        "jobs_collected",
        "jobs_cancelled",
        "jobs_open_at_end",
        "median_hours_to_complete",
        "median_hours_to_collect",
        "appointments_scheduled",
        "appointments_arrived",
        "appointments_no_show",
        "appointments_cancelled",
        "parts_consumed_qty",
        "parts_consumed_lines",
        "parts_returned_qty",
        "stock_adjustments",
        "significant_stock_adjustments",
        "purchase_receipts",
        "purchase_units_received",
      ]);
      expect(
        await cols("select * from public.report_activity_by_mechanic('2025-03-01', '2025-03-02')"),
      ).toEqual([
        "staff_id",
        "display_name",
        "active",
        "jobs_checked_in",
        "jobs_completed",
        "jobs_collected",
        "jobs_open_now",
      ]);
      expect(await cols("select * from public.report_stock_value()")).toEqual([
        "ownership_type",
        "quantity_on_hand",
        "units_in_stock",
        "uncosted_items",
        "value_at_cost",
        "currency",
      ]);
    });
  });
});

describe("Report arguments (D100)", () => {
  const RANGED = [
    "select * from public.report_period_summary($1::date, $2::date)",
    "select * from public.report_period_series($1::date, $2::date)",
    "select * from public.report_breakdown($1::date, $2::date)",
    "select * from public.report_line_items($1::date, $2::date)",
    "select * from public.report_activity($1::date, $2::date)",
    "select * from public.report_activity_by_mechanic($1::date, $2::date)",
  ];

  it("from > to and NULL bounds raise report_range_invalid; 731 days pass and 732 raise report_range_too_long", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      for (const sql of RANGED) {
        for (const [from, to] of [
          ["2025-03-10", "2025-03-09"],
          [null, "2025-03-09"],
          ["2025-03-09", null],
          [null, null],
        ]) {
          await failsWith(tx, () => tx.query(sql, [from, to]), {
            code: "P0001",
            message: "report_range_invalid",
          });
        }
        await tx.query(sql, ["2024-01-01", "2025-12-31"]); // 731 days
        await failsWith(tx, () => tx.query(sql, ["2024-01-01", "2026-01-01"]), {
          code: "P0001",
          message: "report_range_too_long",
        });
      }
    });
  });

  it("a NULL basis means sale", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      const row = await summary(tx, "2025-03-01", "2025-03-02", null);
      expect(row.basis).toBe("sale");
    });
  });

  it("bad keys, keys of another dimension and half or conflicting cursors raise report_key_invalid", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, ADMIN);
      const bad = { code: "P0001", message: "report_key_invalid" };
      const b = (
        dimension: string,
        key: string | null,
        total: string | null,
        after: string | null,
      ) =>
        tx.query(
          "select * from public.report_breakdown('2025-03-01', '2025-03-07', 'sale', $1, 10, $2, $3, $4)",
          [dimension, key, total, after],
        );
      await failsWith(tx, () => b("product", "nonsense", null, null), bad);
      await failsWith(tx, () => b("product", "unassigned", null, null), bad);
      await failsWith(tx, () => b("job", "none", null, null), bad);
      await failsWith(tx, () => b("channel", randomUUID(), null, null), bad);
      await failsWith(tx, () => b("ownership", "workshop", null, null), bad);
      await failsWith(tx, () => b("job", null, "10.00", null), bad);
      await failsWith(tx, () => b("job", null, null, "abc"), bad);
      await failsWith(tx, () => b("channel", "workshop", "10.00", "retail"), bad);
      // Valid keys of every kind pass (and may simply find nothing).
      for (const [dimension, key] of [
        ["job", randomUUID()],
        ["product", "none"],
        ["category", "none"],
        ["service", "products"],
        ["service", "manual"],
        ["mechanic", "unassigned"],
        ["mechanic", "not_workshop"],
        ["ownership", "service"],
        ["channel", "online"],
      ]) {
        await b(dimension, key, null, null);
      }

      const l = (
        dimension: string | null,
        key: string | null,
        at: string | null,
        id: string | null,
      ) =>
        tx.query(
          "select * from public.report_line_items('2025-03-01', '2025-03-07', 'sale', $1, $2, 10, $3::timestamptz, $4)",
          [dimension, key, at, id],
        );
      await failsWith(tx, () => l("product", null, null, null), bad);
      await failsWith(tx, () => l(null, "none", null, null), bad);
      await failsWith(tx, () => l("mechanic", "nobody", null, null), bad);
      await failsWith(tx, () => l(null, null, "2025-03-05T00:00:00Z", null), bad);
      await failsWith(tx, () => l(null, null, null, randomUUID()), bad);
      await l("mechanic", "unassigned", "2025-03-05T00:00:00Z", randomUUID());
    });
  });
});

describe.skipIf(!isolated)("period reports on the March 2025 scenario", () => {
  /** Builds the scenario as the owner and acts as the admin. */
  async function scenario(tx: pg.Client, claims: Claims = ADMIN): Promise<PeriodScenario> {
    const s = await buildPeriodScenario(tx);
    await actAs(tx, claims);
    return s;
  }

  describe("Reports are built from source records only (SPEC §19.2)", () => {
    it("every daily_summary column equals its report RPC counterpart, every day of the scenario and of the seeded week", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const days = [
          ...Array.from({ length: 12 }, (_, i) => addDays(MAR.mon3, i)),
          ...Array.from({ length: 7 }, (_, i) => addDays(anchor, -i)),
        ];
        for (const d of days) {
          const [ds] = await dailySummary(tx, d, d);
          const s = await summary(tx, d, d, "sale");
          const a = await activity(tx, d, d);
          const lossTotal = await scalar<string>(
            tx,
            `select coalesce(sum(yield_total) filter (where yield_total < 0), 0)::text
               from public.report_line_items($1::date, $1::date, 'sale', null, null, 1000)`,
            [d],
          );
          expect({
            day: d,
            jobs_checked_in: ds.jobs_checked_in,
            jobs_started: ds.jobs_started,
            jobs_completed: ds.jobs_completed,
            jobs_ready_for_collection: ds.jobs_ready_for_collection,
            jobs_collected: ds.jobs_collected,
            jobs_cancelled: ds.jobs_cancelled,
            currency: ds.currency,
            lines_recognised: ds.lines_recognised,
            loss_lines: ds.loss_lines,
            parts_consumed_qty: ds.parts_consumed_qty,
            parts_consumed_lines: ds.parts_consumed_lines,
            parts_returned_qty: ds.parts_returned_qty,
            stock_adjustments: ds.stock_adjustments,
            significant_stock_adjustments: ds.significant_stock_adjustments,
            appointments_scheduled: ds.appointments_scheduled,
            appointments_arrived: ds.appointments_arrived,
            appointments_no_show: ds.appointments_no_show,
            consignment_sales: ds.consignment_sales,
          }).toEqual({
            day: d,
            jobs_checked_in: a.jobs_checked_in,
            jobs_started: a.jobs_started,
            jobs_completed: a.jobs_completed,
            jobs_ready_for_collection: a.jobs_ready_for_collection,
            jobs_collected: a.jobs_collected,
            jobs_cancelled: a.jobs_cancelled,
            currency: s.currency,
            lines_recognised: s.line_count,
            loss_lines: s.loss_line_count,
            parts_consumed_qty: a.parts_consumed_qty,
            parts_consumed_lines: a.parts_consumed_lines,
            parts_returned_qty: a.parts_returned_qty,
            stock_adjustments: a.stock_adjustments,
            significant_stock_adjustments: a.significant_stock_adjustments,
            appointments_scheduled: a.appointments_scheduled,
            appointments_arrived: a.appointments_arrived,
            appointments_no_show: a.appointments_no_show,
            consignment_sales: s.consignment_sales,
          });
          // Money compared at numeric value (an empty day is 0 in one, 0.00 in the other).
          expect({
            day: d,
            gross: money(ds.gross_sales),
            cogs: money(ds.cogs),
            yield: money(ds.yield_total),
            cc: money(ds.cult_commons_share),
            after: money(ds.bicii_yield_after_cc),
            loss: money(ds.loss_total),
            consTotal: money(ds.consignment_sales_total),
            liability: money(ds.new_consignor_liability),
          }).toEqual({
            day: d,
            gross: money(s.sale_total),
            cogs: money(s.cost_total),
            yield: money(s.yield_total),
            cc: money(s.cult_commons_share),
            after: money(s.yield_after_cc),
            loss: money(lossTotal),
            consTotal: money(s.consignment_sales_total),
            liability: money(s.new_consignor_liability),
          });

          // Job flows also equal independent counts over the jobs' own stamps.
          const own = await readAsOwner(tx, () =>
            q(
              tx,
              `select
                 count(*) filter (where (checked_in_at at time zone 'Asia/Singapore')::date = $1)::integer as ci,
                 count(*) filter (where (started_at at time zone 'Asia/Singapore')::date = $1)::integer as st,
                 count(*) filter (where (completed_at at time zone 'Asia/Singapore')::date = $1)::integer as co,
                 count(*) filter (where (ready_for_collection_at at time zone 'Asia/Singapore')::date = $1)::integer as re,
                 count(*) filter (where (collected_at at time zone 'Asia/Singapore')::date = $1)::integer as cl,
                 count(*) filter (where (cancelled_at at time zone 'Asia/Singapore')::date = $1)::integer as ca
               from public.work_orders`,
              [d],
            ),
          );
          expect(own[0]).toEqual({
            ci: a.jobs_checked_in,
            st: a.jobs_started,
            co: a.jobs_completed,
            re: a.jobs_ready_for_collection,
            cl: a.jobs_collected,
            ca: a.jobs_cancelled,
          });
        }
      });
    });

    it("the series summed over the week and over March 2025 equals the summary, for every grain and basis", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        for (const [from, to] of [
          [WEEK.from, WEEK.to],
          ["2025-03-01", "2025-03-31"],
          [addDays(anchor, -6), anchor],
        ]) {
          for (const basis of BASES) {
            const s = await summary(tx, from, to, basis);
            for (const grain of ["day", "week", "month"]) {
              const [sum] = await q(
                tx,
                `select sum(line_count)::integer as line_count, sum(job_count)::integer as job_count,
                        sum(sale_count)::integer as sale_count, sum(sale_total)::text as sale_total,
                        sum(cost_total)::text as cost_total, sum(yield_total)::text as yield_total,
                        sum(cult_commons_share)::text as cult_commons_share,
                        sum(yield_after_cc)::text as yield_after_cc,
                        sum(loss_line_count)::integer as loss_line_count,
                        sum(refunds_total)::text as refunds_total,
                        sum(consignment_sales)::integer as consignment_sales,
                        sum(consignment_sales_total)::text as consignment_sales_total,
                        sum(new_consignor_liability)::text as new_consignor_liability,
                        sum(settlements_paid_total)::text as settlements_paid_total
                   from public.report_period_series($1::date, $2::date, $3, $4)`,
                [from, to, basis, grain],
              );
              const pick = (r: Row) => ({
                line_count: r.line_count,
                job_count: r.job_count,
                sale_count: r.sale_count,
                loss_line_count: r.loss_line_count,
                consignment_sales: r.consignment_sales,
                sale_total: money(r.sale_total),
                cost_total: money(r.cost_total),
                yield_total: money(r.yield_total),
                cult_commons_share: money(r.cult_commons_share),
                yield_after_cc: money(r.yield_after_cc),
                refunds_total: money(r.refunds_total),
                consignment_sales_total: money(r.consignment_sales_total),
                new_consignor_liability: money(r.new_consignor_liability),
                settlements_paid_total: money(r.settlements_paid_total),
              });
              expect({ from, basis, grain, ...pick(sum) }).toEqual({
                from,
                basis,
                grain,
                ...pick(s),
              });
            }
          }
        }
      });
    });

    it("report_lines' recognised rows are exactly financial_lines; work-in-progress money equals the line's generated columns", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        await ownerMode(tx);
        const diff = await q(
          tx,
          `(select entry_key, source_line_id, sale_total, cost_total, yield_total, cult_commons_share, currency
              from reporting.report_lines where recognised
            except all
            select entry_key, source_line_id, sale_total, cost_total, yield_total, cult_commons_share, currency
              from reporting.financial_lines)
           union all
           (select entry_key, source_line_id, sale_total, cost_total, yield_total, cult_commons_share, currency
              from reporting.financial_lines
            except all
            select entry_key, source_line_id, sale_total, cost_total, yield_total, cult_commons_share, currency
              from reporting.report_lines where recognised)`,
        );
        expect(diff).toEqual([]);
        const wip = await q(
          tx,
          `select rl.source_line_id
             from reporting.report_lines rl
             join public.work_order_line_items l on l.id = rl.source_line_id
             join public.work_orders wo on wo.id = l.work_order_id
            where not rl.recognised
              and (rl.sale_total, rl.cost_total, rl.yield_total, rl.cult_commons_share, rl.cost_pending)
                  is distinct from
                  (l.sale_total::numeric, l.cost_total::numeric, l.yield_total::numeric,
                   l.cult_commons_share::numeric, l.cost_pending)
               or (not rl.recognised and (wo.completed_at is not null or wo.status = 'cancelled'
                   or l.voided_at is not null or rl.recognized_at is not null))`,
        );
        expect(wip).toEqual([]);
        // Every live line of an open job is in branch 2 (job C's SV120 included).
        expect(
          await scalar<number>(
            tx,
            `select count(*)::integer from public.work_order_line_items l
               join public.work_orders wo on wo.id = l.work_order_id
              where wo.completed_at is null and wo.status <> 'cancelled' and l.voided_at is null
                and not exists (select 1 from reporting.report_lines rl
                                 where rl.source_line_id = l.id and not rl.recognised)`,
          ),
        ).toBe(0);
      });
    });

    it("financial_lines has entry_kind 'line' only and no NULL channel; no sale of source work_order is written", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        await ownerMode(tx);
        expect(
          (await q(tx, "select distinct entry_kind from reporting.financial_lines")).map(
            (r) => r.entry_kind,
          ),
        ).toEqual(["line"]);
        expect(
          await scalar<number>(
            tx,
            "select count(*)::integer from reporting.financial_lines where channel is null",
          ),
        ).toBe(0);
        expect(
          await scalar<number>(
            tx,
            "select count(*)::integer from public.sales where source = 'work_order'",
          ),
        ).toBe(0);
      });
    });
  });

  describe("Completed and collected are different events: the date basis decides the day (SPEC §19.2, §23, D100)", () => {
    it("every day and the week, on all four bases", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        for (const basis of BASES) {
          for (const [day, expected] of Object.entries(PERIOD_EXPECTED.byDay[basis])) {
            const s = await summary(tx, day, day, basis);
            expect({ basis, day, ...m4(s) }).toEqual({ basis, day, ...expected });
          }
          const w = await summary(tx, WEEK.from, WEEK.to, basis);
          const e = PERIOD_EXPECTED.week[basis];
          expect({
            basis,
            ...m4(w),
            job_count: w.job_count,
            sale_count: w.sale_count,
            line_count: w.line_count,
            loss_line_count: w.loss_line_count,
          }).toEqual({
            basis,
            sale: e.sale,
            cost: e.cost,
            yield: e.yield,
            cc: e.cc,
            job_count: e.job_count,
            sale_count: e.sale_count,
            line_count: e.line_count,
            loss_line_count: e.loss_line_count,
          });
        }
        const w = await summary(tx, WEEK.from, WEEK.to, "sale");
        const e = PERIOD_EXPECTED.week.sale;
        expect({
          after: money(w.yield_after_cc),
          consignment_sales: w.consignment_sales,
          consignment_sales_total: money(w.consignment_sales_total),
          new_consignor_liability: money(w.new_consignor_liability),
          settlements_paid_total: money(w.settlements_paid_total),
          cost_pending_lines: w.cost_pending_lines,
          excluded: w.excluded_foreign_line_count,
        }).toEqual({
          after: e.yield_after_cc,
          consignment_sales: e.consignment_sales,
          consignment_sales_total: e.consignment_sales_total,
          new_consignor_liability: e.new_consignor_liability,
          settlements_paid_total: e.settlements_paid_total,
          cost_pending_lines: 0,
          excluded: 0,
        });
        // Settlement T1 is on Thu 6 March.
        expect(money((await summary(tx, MAR.thu6, MAR.thu6)).settlements_paid_total)).toBe(
          "200.00",
        );
        // Sale-basis-only figures are NULL on the other bases.
        for (const basis of ["check_in", "completion", "collection"] as const) {
          const o = await summary(tx, WEEK.from, WEEK.to, basis);
          expect([
            o.refunds_total,
            o.refund_count,
            o.consignment_sales,
            o.consignment_sales_total,
            o.new_consignor_liability,
            o.settlements_paid_total,
            o.purchases_received_total,
          ]).toEqual([null, null, null, null, null, null, null]);
        }
      });
    });

    it("retail only on sale, work in progress only on check_in, cancelled jobs never carry money", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        for (const basis of BASES) {
          const jobs = (await breakdown(tx, "2025-03-01", "2025-03-31", basis, "job")).map(
            (r) => r.key,
          );
          expect(jobs.includes(s.sale.id)).toBe(basis === "sale");
          expect(jobs.includes(s.jobs.C.job.id)).toBe(basis === "check_in");
          expect(jobs.includes(s.jobs.D.job.id)).toBe(false);
        }
      });
    });

    it("completion totals equal the workshop part of the sale basis, for any range", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        for (const [from, to] of [
          [WEEK.from, WEEK.to],
          [MAR.fri7, MAR.sat8],
          ["2025-03-01", "2025-03-31"],
          [addDays(anchor, -30), anchor],
        ]) {
          const c = await summary(tx, from, to, "completion");
          const [w] = await breakdown(tx, from, to, "sale", "channel", { key: "workshop" });
          expect({ from, ...m4(c), lines: c.line_count, jobs: c.job_count }).toEqual(
            w
              ? { from, ...m4(w), lines: w.line_count, jobs: w.job_count }
              : { from, sale: "0.00", cost: "0.00", yield: "0.00", cc: "0.00", lines: 0, jobs: 0 },
          );
        }
      });
    });
  });

  describe("Days are shop-local (SPEC §24, D35)", () => {
    it("23:59:30 counts on Friday and 00:00:00 on Saturday; ISO weeks start on Monday; months clip and flag partial buckets", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        expect(money((await summary(tx, MAR.fri7, MAR.fri7, "completion")).sale_total)).toBe(
          "300.00",
        );
        expect(money((await summary(tx, MAR.sat8, MAR.sat8, "completion")).sale_total)).toBe(
          "80.00",
        );
        const days = await series(tx, MAR.fri7, MAR.sat8, "completion", "day");
        expect(days.map((r) => [r.bucket_start, money(r.sale_total), r.partial])).toEqual([
          [MAR.fri7, "300.00", false],
          [MAR.sat8, "80.00", false],
        ]);

        // 1 March 2025 is a Saturday: the first ISO week is clipped.
        const weeks = await series(tx, "2025-03-01", "2025-03-16", "sale", "week");
        expect(
          weeks.map((r) => [r.bucket_start, r.bucket_end, r.partial, money(r.sale_total)]),
        ).toEqual([
          ["2025-03-01", "2025-03-02", true, "0.00"],
          ["2025-03-03", "2025-03-09", false, "1680.00"],
          ["2025-03-10", "2025-03-16", false, "0.00"],
        ]);
        const months = await series(tx, "2025-02-15", "2025-04-10", "sale", "month");
        expect(
          months.map((r) => [r.bucket_start, r.bucket_end, r.partial, money(r.sale_total)]),
        ).toEqual([
          ["2025-02-15", "2025-02-28", true, "0.00"],
          ["2025-03-01", "2025-03-31", false, "1680.00"],
          ["2025-04-01", "2025-04-10", true, "0.00"],
        ]);
        const full = await series(tx, "2025-03-01", "2025-03-31", "sale", "month");
        expect(full.map((r) => [r.bucket_start, r.bucket_end, r.partial])).toEqual([
          ["2025-03-01", "2025-03-31", false],
        ]);

        // The inline bucketing is private.shop_day's own definition.
        await ownerMode(tx);
        const instants = [
          sgt(MAR.fri7, "23:59:30"),
          sgt(MAR.sat8, "00:00:00"),
          sgt(MAR.sat8, "07:59:59"),
          sgt(MAR.sat8, "08:00:00"),
          "2025-03-07T15:59:59.999999Z",
          "2025-03-07T16:00:00Z",
        ];
        for (const t of instants) {
          expect(
            await scalar<boolean>(
              tx,
              "select ($1::timestamptz at time zone private.shop_timezone())::date = private.shop_day($1::timestamptz)",
              [t],
            ),
          ).toBe(true);
        }
      });
    });
  });

  describe("Cult Commons is 30% of positive yield per line (SPEC §10, D1)", () => {
    it("the period's Cult Commons is the sum of line shares (job B 60.00, not 45.00); a loss-only period has negative yield and 0.00", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const b = await summary(tx, MAR.fri7, MAR.fri7, "completion");
        expect([money(b.yield_total), money(b.cult_commons_share)]).toEqual(["150.00", "60.00"]);

        await ownerMode(tx);
        await insertJob(tx, {
          checkedInAt: sgt("2025-03-20", "09:00"),
          path: [
            { status: "in_progress", at: sgt("2025-03-20", "09:30") },
            { status: "completed", at: sgt("2025-03-20", "15:00") },
          ],
          lines: [
            {
              type: "manual",
              unitSale: "100.00",
              unitCost: "150.00",
              createdAt: sgt("2025-03-20", "10:00"),
            },
          ],
        });
        await actAs(tx, ADMIN);
        const loss = await summary(tx, "2025-03-20", "2025-03-20");
        expect({
          ...m4(loss),
          after: money(loss.yield_after_cc),
          losses: loss.loss_line_count,
        }).toEqual({
          sale: "100.00",
          cost: "150.00",
          yield: "-50.00",
          cc: "0.00",
          after: "-50.00",
          losses: 1,
        });
      });
    });
  });

  describe("Consignment sale yields correctly (SPEC §23)", () => {
    it("S1 is under ownership 'consignment' with 1000.00 / 500.00 / 500.00 / 150.00", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const rows = await breakdown(tx, WEEK.from, WEEK.to, "sale", "ownership");
        const c = rows.find((r) => r.key === "consignment")!;
        expect({ ...m4(c), lines: c.line_count, sales: c.sale_count, label: c.label }).toEqual({
          sale: "1000.00",
          cost: "500.00",
          yield: "500.00",
          cc: "150.00",
          lines: 1,
          sales: 1,
          label: "Consignment",
        });
        expect(rows.map((r) => r.key).sort()).toEqual(["consignment", "service", "shop_owned"]);
      });
    });
  });

  describe("Every breakdown partitions its period", () => {
    it("for every dimension and basis, on the scenario week and the seed's last 7 days: paging covers every group once and the groups sum to the summary", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        for (const [from, to] of [
          [WEEK.from, WEEK.to],
          [addDays(anchor, -6), anchor],
        ]) {
          for (const basis of BASES) {
            const s = await summary(tx, from, to, basis);
            for (const dimension of DIMENSIONS) {
              const full = await breakdown(tx, from, to, basis, dimension);
              const paged = await allPages(tx, from, to, basis, dimension, 2);
              const keys = paged.map((r) => r.key);
              expect(new Set(keys).size).toBe(keys.length);
              expect(keys).toEqual(full.map((r) => r.key));
              const sums = await breakdownSums(tx, from, to, basis, dimension);
              expect({
                from,
                basis,
                dimension,
                lines: sums.line_count ?? 0,
                sale: money(sums.sale_total ?? 0),
                cost: money(sums.cost_total ?? 0),
                yield: money(sums.yield_total ?? 0),
                cc: money(sums.cult_commons_share ?? 0),
                after: money(sums.yield_after_cc ?? 0),
              }).toEqual({
                from,
                basis,
                dimension,
                lines: s.line_count,
                sale: money(s.sale_total),
                cost: money(s.cost_total),
                yield: money(s.yield_total),
                cc: money(s.cult_commons_share),
                after: money(s.yield_after_cc),
              });
              for (const r of full) {
                const valid = await readAsOwner(tx, () =>
                  scalar<boolean>(tx, "select private.report_key_valid($1, $2)", [
                    dimension,
                    r.key,
                  ]),
                );
                expect({ dimension, key: r.key, valid }).toEqual({
                  dimension,
                  key: r.key,
                  valid: true,
                });
              }
            }
          }
        }
      });
    });

    it("the channel keys are derived from pg_enum's sale_source values plus 'workshop'", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const sources = (
          await q(
            tx,
            "select enumlabel from pg_enum where enumtypid = 'public.sale_source'::regtype order by enumsortorder",
          )
        ).map((r) => String(r.enumlabel));
        const allowed = new Set([
          "workshop",
          ...sources.map(channelOf).filter((c): c is string => c !== null),
        ]);
        expect([...allowed].sort()).toEqual(["online", "retail", "workshop"]);
        for (const [from, to] of [
          [WEEK.from, WEEK.to],
          [addDays(anchor, -30), anchor],
        ]) {
          for (const r of await breakdown(tx, from, to, "sale", "channel")) {
            expect(allowed.has(String(r.key))).toBe(true);
          }
        }
        const channels = await readAsOwner(tx, () =>
          q(tx, "select distinct channel from reporting.financial_lines"),
        );
        for (const r of channels) expect(allowed.has(String(r.channel))).toBe(true);
      });
    });

    it("job rows equal work_order_totals_staff; p_key returns the same row; a key's line items sum to its row and never include a voided line", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        const jobs = await breakdown(tx, WEEK.from, WEEK.to, "sale", "job");
        for (const r of jobs.filter((x) => x.entity_type === "work_order")) {
          const [t] = await q(
            tx,
            "select line_count, sale_total, cost_total, yield_total, cult_commons_share from public.work_order_totals_staff where work_order_id = $1",
            [r.entity_id],
          );
          expect({ lines: r.line_count, ...m4(r) }).toEqual({ lines: t.line_count, ...m4(t) });
        }

        for (const basis of BASES) {
          for (const dimension of DIMENSIONS) {
            const rows = await breakdown(tx, WEEK.from, WEEK.to, basis, dimension);
            for (const r of rows) {
              const one = await breakdown(tx, WEEK.from, WEEK.to, basis, dimension, {
                key: String(r.key),
              });
              expect(one).toEqual([r]);
              const lines = await allLines(
                tx,
                WEEK.from,
                WEEK.to,
                basis,
                dimension,
                String(r.key),
                2,
              );
              const ids = lines.map((l) => l.source_line_id);
              expect(new Set(ids).size).toBe(ids.length);
              expect(ids).not.toContain(s.lines.aVoided);
              expect(lines.length).toBe(r.line_count);
              const [sum] = await q(
                tx,
                `select sum(sale_total)::text as sale_total, sum(cost_total)::text as cost_total,
                        sum(yield_total)::text as yield_total, sum(cult_commons_share)::text as cult_commons_share
                   from public.report_line_items($1::date, $2::date, $3, $4, $5, 1000)`,
                [WEEK.from, WEEK.to, basis, dimension, r.key],
              );
              expect({ basis, dimension, key: r.key, ...m4(sum) }).toEqual({
                basis,
                dimension,
                key: r.key,
                ...m4(r),
              });
            }
          }
        }
      });
    });

    it("zero prices and costs are known values (D14, D24 as amended): the free line and the services' 0.00 cost come back as 0.00", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        const lines = await lineItems(tx, MAR.sat8, MAR.sat8, "sale");
        const free = lines.find((l) => l.source_line_id === s.lines.eFree)!;
        expect([
          free.unit_sale_price,
          free.sale_total,
          free.cost_total,
          free.yield_total,
          free.cult_commons_share,
        ]).toEqual(["0.00", "0.00", "0.00", "0.00", "0.00"]);
        const service = lines.find((l) => l.description === "SV80")!;
        expect([service.sale_total, service.cost_total]).toEqual(["80.00", "0.00"]);
        expect(lines).toHaveLength(2);
      });
    });

    it("line items without a key page through every line exactly once, in order, past tied instants and documents without a counted line", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        // A completed job whose only line is voided, at job A's completion instant,
        // and a second job completed at that instant too (ties across documents).
        await ownerMode(tx);
        await insertJob(tx, {
          checkedInAt: sgt(MAR.wed5, "09:00"),
          path: [
            { status: "in_progress", at: sgt(MAR.wed5, "09:30") },
            { status: "completed", at: sgt(MAR.wed5, "16:00") },
          ],
          lines: [
            {
              type: "manual",
              unitSale: "5.00",
              unitCost: "0.00",
              createdAt: sgt(MAR.wed5, "10:00"),
              voidedAt: sgt(MAR.wed5, "10:05"),
            },
          ],
        });
        await insertJob(tx, {
          checkedInAt: sgt(MAR.wed5, "09:00"),
          path: [
            { status: "in_progress", at: sgt(MAR.wed5, "09:30") },
            { status: "completed", at: sgt(MAR.wed5, "16:00") },
          ],
          lines: [
            {
              type: "manual",
              unitSale: "15.00",
              unitCost: "1.00",
              createdAt: sgt(MAR.wed5, "10:00"),
            },
            {
              type: "manual",
              unitSale: "25.00",
              unitCost: "2.00",
              createdAt: sgt(MAR.wed5, "10:10"),
            },
          ],
        });
        await actAs(tx, ADMIN);
        for (const [from, to] of [
          [WEEK.from, WEEK.to],
          [addDays(anchor, -30), anchor],
        ]) {
          for (const basis of BASES) {
            const all = await lineItems(tx, from, to, basis, { max: 1000 });
            for (const size of [1, 2, 3]) {
              const paged = await allLines(tx, from, to, basis, null, null, size);
              expect({ basis, size, ids: paged.map((l) => l.source_line_id) }).toEqual({
                basis,
                size,
                ids: all.map((l) => l.source_line_id),
              });
            }
          }
        }
      });
    });
  });

  describe("Historical snapshots do not change with catalog edits (SPEC §23, D21)", () => {
    it("new prices, costs and a new Cult Commons rate leave March 2025 unchanged; archived names still appear", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        const before: Row[] = [];
        for (const basis of BASES) before.push(await summary(tx, WEEK.from, WEEK.to, basis));

        await ownerMode(tx);
        await tx.query(
          "update public.services set default_sale_price = 999.00, default_direct_cost = 99.00, archived_at = now(), active = false where id = any($1)",
          [[s.services.sv200, s.services.sv120, s.services.sv80]],
        );
        // Archiving needs no stock on hand: return job A's two parts to the shelf first.
        await tx.query(
          `insert into public.inventory_movements
             (product_id, location_id, quantity_delta, movement_type, currency, reason)
           values ($1, $2, 2, 'stock_adjustment', 'SGD', 'Test: count before archiving')`,
          [s.productQP, s.locationId],
        );
        await tx.query(
          "update public.products set default_sale_price = 77.00, default_direct_cost = 66.00, archived_at = now(), active = false where id = $1",
          [s.productQP],
        );
        await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
        await actAs(tx, ADMIN);
        await tx.query("select public.schedule_cult_commons_rate($1, 0.5000, now())", [
          randomUUID(),
        ]);

        for (const [i, basis] of BASES.entries()) {
          expect(await summary(tx, WEEK.from, WEEK.to, basis)).toEqual(before[i]);
        }
        const services = await breakdown(tx, WEEK.from, WEEK.to, "sale", "service");
        expect(services.find((r) => r.key === s.services.sv200)!.label).toMatch(/^SV200 /);
        const products = await breakdown(tx, WEEK.from, WEEK.to, "sale", "product");
        expect(products.find((r) => r.key === s.productQP)!.label).toMatch(/^QP /);
        const mechanics = await breakdown(tx, WEEK.from, WEEK.to, "check_in", "mechanic");
        const nur = mechanics.find((r) => r.key === STAFF.mechanic2)!;
        expect([nur.label, nur.detail]).toEqual(["Nur Aisyah", "No longer active"]);
      });
    });
  });

  describe("Voids restate the period (D101, D15, D32)", () => {
    it("reopening job B, voiding its loss line and completing it again moves it to its new day", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        const B = s.jobs.B.job.id;
        await moveJob(tx, B, "in_progress", sgt("2025-03-10", "09:00"), "Customer asked again");
        await voidLineAt(tx, s.lines.bManual, sgt("2025-03-10", "09:30"), "Not needed after all");
        await moveJob(tx, B, "completed", sgt("2025-03-11", "10:00"));
        await actAs(tx, ADMIN);
        for (const basis of ["completion", "sale"] as const) {
          expect(m4(await summary(tx, MAR.fri7, MAR.fri7, basis))).toEqual({
            sale: "0.00",
            cost: "0.00",
            yield: "0.00",
            cc: "0.00",
          });
          expect(m4(await summary(tx, "2025-03-11", "2025-03-11", basis))).toEqual({
            sale: "200.00",
            cost: "0.00",
            yield: "200.00",
            cc: "60.00",
          });
        }
        for (const basis of BASES) {
          const ids = (await lineItems(tx, "2025-03-01", "2025-03-31", basis)).map(
            (l) => l.source_line_id,
          );
          expect(ids).not.toContain(s.lines.bManual);
          expect(ids).not.toContain(s.lines.aVoided);
        }
      });
    });
  });

  describe("Refunds are reported separately (D102)", () => {
    it("a refund counts on the day it is recorded, beside gross, never netted; a restocked line stays; other bases show NULL", async () => {
      await inTransaction(conn, async (tx) => {
        const s = await scenario(tx);
        const today = await shopToday(tx);
        const weekBefore = await summary(tx, WEEK.from, WEEK.to);
        const todayBefore = await summary(tx, today, today);

        await actAs(tx, MANAGER); // D94: a manager records refunds.
        await refund(tx, { saleId: s.sale.id, amount: "100.00" });
        await actAs(tx, ADMIN);
        const [saleLine] = await readAsOwner(tx, () =>
          q(tx, "select id from public.sale_lines where sale_id = $1", [s.sale.id]),
        );
        await restock(tx, { unitId: s.unitId, saleLineId: String(saleLine.id) });

        const todayAfter = await summary(tx, today, today);
        expect(money(Number(todayAfter.refunds_total) - Number(todayBefore.refunds_total))).toBe(
          "100.00",
        );
        expect(Number(todayAfter.refund_count) - Number(todayBefore.refund_count)).toBe(1);
        expect(m4(todayAfter)).toEqual(m4(todayBefore));
        // The March sale keeps its gross, cost, yield and Cult Commons (restocked line included).
        const weekAfter = await summary(tx, WEEK.from, WEEK.to);
        expect(weekAfter).toEqual(weekBefore);
        expect(money(weekAfter.refunds_total)).toBe("0.00");
        for (const basis of ["check_in", "completion", "collection"] as const) {
          expect((await summary(tx, today, today, basis)).refunds_total).toBeNull();
        }
      });
    });
  });

  describe("Totals are in the shop currency (D104)", () => {
    it("a line in another currency is left out of the totals and counted in excluded_foreign_line_count", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const before = await summary(tx, WEEK.from, WEEK.to);
        await ownerMode(tx);
        await insertJob(tx, {
          currency: "USD",
          checkedInAt: sgt(MAR.wed5, "09:00"),
          path: [
            { status: "in_progress", at: sgt(MAR.wed5, "09:30") },
            { status: "completed", at: sgt(MAR.wed5, "12:00") },
          ],
          lines: [
            {
              type: "manual",
              unitSale: "70.00",
              unitCost: "0.00",
              createdAt: sgt(MAR.wed5, "10:00"),
            },
          ],
        });
        await actAs(tx, ADMIN);
        for (const basis of ["sale", "completion", "check_in"] as const) {
          const after = await summary(tx, WEEK.from, WEEK.to, basis);
          expect(after.excluded_foreign_line_count).toBe(1);
        }
        const after = await summary(tx, WEEK.from, WEEK.to);
        expect({ ...after, excluded_foreign_line_count: 0 }).toEqual(before);
        expect(
          (await summary(tx, WEEK.from, WEEK.to, "collection")).excluded_foreign_line_count,
        ).toBe(0);
      });
    });
  });

  describe("Mechanic attribution (D103)", () => {
    it("the lead is credited; no lead is 'unassigned'; retail is 'not_workshop'", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const sale = await breakdown(tx, WEEK.from, WEEK.to, "sale", "mechanic");
        expect(
          sale.map((r) => [r.key, r.label, r.entity_type, money(r.sale_total), r.line_count]),
        ).toEqual([
          ["not_workshop", "Not workshop", null, "1000.00", 1],
          [STAFF.mechanic1, "Marcus Tan", "staff", "380.00", 4],
          ["unassigned", "Unassigned", null, "300.00", 2],
        ]);
        const checkIn = await breakdown(tx, WEEK.from, WEEK.to, "check_in", "mechanic");
        expect(checkIn.find((r) => r.key === STAFF.mechanic2)!.sale_total).toBe("120.00");

        const rows = await q(
          tx,
          "select * from public.report_activity_by_mechanic($1::date, $2::date)",
          [WEEK.from, WEEK.to],
        );
        const pick = (id: string | null) => {
          const r = rows.find((x) => x.staff_id === id)!;
          return [r.display_name, r.jobs_checked_in, r.jobs_completed, r.jobs_collected];
        };
        expect(pick(STAFF.mechanic1)).toEqual(["Marcus Tan", 2, 2, 1]);
        expect(pick(STAFF.mechanic2)).toEqual(["Nur Aisyah", 1, 0, 0]);
        expect(pick(null)).toEqual(["Unassigned", 2, 1, 0]);
        // jobs_open_now is the current open jobs per lead (seed included).
        const open = await readAsOwner(tx, () =>
          q(
            tx,
            `select lead_mechanic_id, count(*)::integer as n from public.work_orders
              where private.work_order_status_is_open(status) group by 1`,
          ),
        );
        for (const r of rows) {
          const n = open.find((o) => o.lead_mechanic_id === r.staff_id)?.n ?? 0;
          expect(r.jobs_open_now).toBe(n);
        }
        expect(open.find((o) => o.lead_mechanic_id === STAFF.mechanic2)!.n).toBeGreaterThan(0);
      });
    });

    it("report_activity for the week", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        const a = await activity(tx, WEEK.from, WEEK.to);
        const e = PERIOD_EXPECTED.activity;
        expect({
          jobs_checked_in: a.jobs_checked_in,
          jobs_started: a.jobs_started,
          jobs_completed: a.jobs_completed,
          jobs_ready_for_collection: a.jobs_ready_for_collection,
          jobs_collected: a.jobs_collected,
          jobs_cancelled: a.jobs_cancelled,
          jobs_open_at_end: a.jobs_open_at_end,
          median_hours_to_complete: a.median_hours_to_complete,
          median_hours_to_collect: a.median_hours_to_collect,
          parts_consumed_qty: a.parts_consumed_qty,
          parts_consumed_lines: a.parts_consumed_lines,
        }).toEqual(e);
      });
    });
  });

  describe("Purchases and stock value (D105)", () => {
    it("a receipt today adds to the receipt counts and, for cost viewers, to purchases_received_total", async () => {
      await inTransaction(conn, async (tx) => {
        const today = await shopToday(tx);
        await actAs(tx, ADMIN);
        const sBefore = await summary(tx, today, today);
        const aBefore = await activity(tx, today, today);
        const po = await openPO(tx, { quantity: 10, cost: "7.50" });
        await receive(tx, { poId: po.poId, lines: [{ lineId: po.lineId, quantity: 4 }] });
        const sAfter = await summary(tx, today, today);
        const aAfter = await activity(tx, today, today);
        expect(
          money(Number(sAfter.purchases_received_total) - Number(sBefore.purchases_received_total)),
        ).toBe("30.00");
        expect(Number(aAfter.purchase_receipts) - Number(aBefore.purchase_receipts)).toBe(1);
        expect(
          Number(aAfter.purchase_units_received) - Number(aBefore.purchase_units_received),
        ).toBe(4);
        // Receipts are operational counts for any staff member (D105).
        await actAs(tx, MECHANIC2);
        expect((await activity(tx, today, today)).purchase_receipts).toBe(aAfter.purchase_receipts);
      });
    });

    it("report_stock_value: last cost x positive on-hand, NULL cost uncounted in value, 0 valued, negative locations and consigned stock not valued", async () => {
      await inTransaction(conn, async (tx) => {
        await actAs(tx, ADMIN);
        const value = async () => {
          const rows = await q(tx, "select * from public.report_stock_value()");
          return Object.fromEntries(rows.map((r) => [r.ownership_type, r]));
        };
        const before = await value();
        expect(Object.keys(before)).toEqual(["shop_owned", "consignment", "customer_owned"]);

        await ownerMode(tx);
        const costed = await makeProduct(tx, { cost: "12.50" });
        const uncosted = await makeProduct(tx, { cost: null });
        const free = await makeProduct(tx, { cost: "0.00" });
        const split = await makeProduct(tx, { cost: "10.00" });
        const elsewhere = await makeLocation(tx);
        await actAs(tx, ADMIN);
        await addStock(tx, costed, 4);
        await addStock(tx, uncosted, 3);
        await addStock(tx, free, 2);
        await addStock(tx, split, 5);
        // A location below zero (D23 allows it only through jobs and sales; written as the owner).
        await readAsOwner(tx, () =>
          tx.query(
            `insert into public.inventory_movements
               (product_id, location_id, quantity_delta, movement_type, work_order_id, currency, reason)
             values ($1, $2, -3, 'stock_adjustment', null, 'SGD', 'Test: below zero')`,
            [split, elsewhere],
          ),
        );
        const consignorId = await createConsignor(tx);
        await intakeUnique(tx, { consignorId, agreed: "300.00" });

        const after = await value();
        const d = (own: string, col: string) => Number(after[own][col]) - Number(before[own][col]);
        expect({
          qty: d("shop_owned", "quantity_on_hand"),
          units: d("shop_owned", "units_in_stock"),
          uncosted: d("shop_owned", "uncosted_items"),
          value: money(d("shop_owned", "value_at_cost")),
        }).toEqual({ qty: 4 + 3 + 2 + 5, units: 0, uncosted: 1, value: "100.00" });
        expect({
          units: d("consignment", "units_in_stock"),
          value: after.consignment.value_at_cost,
          customer: after.customer_owned.value_at_cost,
          currency: after.shop_owned.currency,
        }).toEqual({ units: 1, value: null, customer: null, currency: "SGD" });
      });
    });
  });

  describe("Cost-derived figures need view_costs (D30)", () => {
    const COST_GATED: Record<string, string[]> = {
      summary: [
        "loss_line_count",
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "yield_after_cc",
        "new_consignor_liability",
        "settlements_paid_total",
        "purchases_received_total",
      ],
      series: [
        "cost_total",
        "yield_total",
        "cult_commons_share",
        "yield_after_cc",
        "loss_line_count",
        "new_consignor_liability",
        "settlements_paid_total",
      ],
      breakdown: ["cost_total", "yield_total", "cult_commons_share", "yield_after_cc"],
      lines: ["cost_total", "yield_total", "cult_commons_share"],
      stock: ["value_at_cost"],
    };

    async function readAll(tx: pg.Client) {
      return {
        summary: [await summary(tx, WEEK.from, WEEK.to)],
        series: await series(tx, WEEK.from, WEEK.to, "sale", "week"),
        breakdown: await breakdown(tx, WEEK.from, WEEK.to, "sale", "job"),
        lines: await lineItems(tx, WEEK.from, WEEK.to, "sale"),
        stock: (await q(tx, "select * from public.report_stock_value()")).filter(
          (r) => r.ownership_type === "shop_owned",
        ),
      };
    }

    it("view_financial_reports alone (an Extra access exception for a mechanic): gross and counts, every cost column NULL; with view_costs the full figures", async () => {
      await inTransaction(conn, async (tx) => {
        await scenario(tx);
        await ownerMode(tx);
        const person = await staffWith(tx, []);
        await actAs(tx, ADMIN);
        await tx.query("select public.grant_permission($1, 'view_financial_reports')", [
          person.staffId,
        ]);
        await actAs(tx, person.claims);
        const gross = await readAll(tx);
        for (const [rpc, rows] of Object.entries(gross)) {
          expect(rows.length).toBeGreaterThan(0);
          for (const r of rows) {
            for (const col of COST_GATED[rpc])
              expect({ rpc, col, v: r[col] }).toEqual({ rpc, col, v: null });
          }
        }
        const s = gross.summary[0];
        expect([
          money(s.sale_total),
          s.line_count,
          money(s.refunds_total),
          s.consignment_sales,
          money(s.consignment_sales_total),
        ]).toEqual(["1680.00", 7, "0.00", 1, "1000.00"]);
        expect(gross.lines.every((l) => l.sale_total !== null)).toBe(true);

        await actAs(tx, ADMIN);
        await tx.query("select public.grant_permission($1, 'view_costs')", [person.staffId]);
        for (const claims of [person.claims, MANAGER, ADMIN]) {
          await actAs(tx, claims);
          const full = await readAll(tx);
          for (const [rpc, rows] of Object.entries(full)) {
            for (const r of rows) {
              for (const col of COST_GATED[rpc])
                expect({ rpc, col, set: r[col] !== null }).toEqual({ rpc, col, set: true });
            }
          }
          expect(money(full.summary[0].cult_commons_share)).toBe("306.00");
        }
      });
    });
  });
});

describe("Customers cannot read costs, yield or Cult Commons (SPEC §23); mechanic permission boundaries", () => {
  const FINANCIAL = [
    "select * from public.report_period_summary('2025-03-03', '2025-03-09')",
    "select * from public.report_period_series('2025-03-03', '2025-03-09')",
    "select * from public.report_breakdown('2025-03-03', '2025-03-09')",
    "select * from public.report_line_items('2025-03-03', '2025-03-09')",
    "select * from public.report_stock_value()",
  ];
  const ACTIVITY = [
    "select * from public.report_activity('2025-03-03', '2025-03-09')",
    "select * from public.report_activity_by_mechanic('2025-03-03', '2025-03-09')",
  ];
  const SIGNATURES = [
    "public.report_period_summary(date, date, public.report_date_basis)",
    "public.report_period_series(date, date, public.report_date_basis, public.report_grain)",
    "public.report_breakdown(date, date, public.report_date_basis, public.report_dimension, integer, text, numeric, text)",
    "public.report_line_items(date, date, public.report_date_basis, public.report_dimension, text, integer, timestamptz, uuid)",
    "public.report_activity(date, date)",
    "public.report_activity_by_mechanic(date, date)",
    "public.report_stock_value()",
  ];

  it("anon has no EXECUTE on any report RPC", async () => {
    for (const sig of SIGNATURES) {
      expect(
        await scalar<boolean>(conn, "select has_function_privilege('anon', $1, 'EXECUTE')", [sig]),
      ).toBe(false);
    }
  });

  it("a signed-in customer gets 42501 from all seven", async () => {
    await inTransaction(conn, async (tx) => {
      const authUserId = await linkCustomerLogin(tx, CUSTOMER.tan);
      await actAs(tx, customerClaims(authUserId));
      for (const sql of [...FINANCIAL, ...ACTIVITY]) {
        await failsWith(tx, () => tx.query(sql), { code: "42501" });
      }
    });
  });

  it("mechanic2 (no permissions) and mechanic1 (view_costs only) get 42501 from the financial RPCs; both may read activity", async () => {
    await inTransaction(conn, async (tx) => {
      for (const claims of [MECHANIC2, MECHANIC1]) {
        await actAs(tx, claims);
        for (const sql of FINANCIAL) await failsWith(tx, () => tx.query(sql), { code: "42501" });
        for (const sql of ACTIVITY) await tx.query(sql);
      }
    });
  });

  it("no report RPC returns a float column", async () => {
    for (const sig of SIGNATURES) {
      const floats = await scalar<number>(
        conn,
        `select count(*)::integer
           from pg_proc p, unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t(oid)
          where p.oid = $1::regprocedure and t.oid in ('float4'::regtype, 'float8'::regtype)`,
        [sig],
      );
      expect({ sig, floats }).toEqual({ sig, floats: 0 });
    }
  });
});

describe("Report queries are indexed", () => {
  it("each period-report column leads a valid index", async () => {
    for (const [table, column] of [
      ["work_orders", "checked_in_at"],
      ["work_orders", "completed_at"],
      ["work_orders", "collected_at"],
      ["work_orders", "cancelled_at"],
      ["sales", "recognized_at"],
      ["sale_refunds", "created_at"],
      ["consignment_settlements", "paid_at"],
      ["inventory_movements", "created_at"],
      ["purchase_receipts", "received_at"],
      ["appointments", "starts_at"],
      // D154 payment reports (20261014001500): Stripe's paid_at, a refund's
      // stripe_created_at or (without it) created_at, a counter payment's
      // received_at and a void's voided_at.
      ["payments", "paid_at"],
      ["payment_refunds", "stripe_created_at"],
      ["payment_refunds", "created_at"],
      ["counter_payments", "received_at"],
      ["counter_payment_voids", "voided_at"],
    ]) {
      const n = await scalar<number>(
        conn,
        `select count(*)::integer
           from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
          where i.indrelid = ('public.' || $1)::regclass and i.indisvalid and a.attname = $2`,
        [table, column],
      );
      expect({ table, column, indexed: n > 0 }).toEqual({ table, column, indexed: true });
    }
  });
});
