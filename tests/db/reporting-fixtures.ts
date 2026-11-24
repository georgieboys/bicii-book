/**
 * The shared reporting DB fixture module (Phase 5), built on
 * tests/db/workshop-fixtures.ts and tests/db/inventory-fixtures.ts. Later
 * phases (6 sales, 9 reports) extend it rather than recreate it.
 *
 *   * TEST_DAY(n) names isolated past shop days no seed reaches
 *     (2025-06-01 + n), so a test can assert a whole day's figures.
 *   * insertJob() writes a job with an explicit history as the connection's
 *     owner inside the test transaction, the way Phase 3's seed does: every
 *     timestamp is honoured as given (checked_in_at on insert, created_at
 *     on lines and movements, status_changed_at on each status update), and
 *     P3's triggers stamp completed_at and the rest from status_changed_at.
 *     It restores the API role `tx` was acting as before it returns.
 *
 * Every insertJob takes a J- number (and a bike a B- number), so tests that
 * use it skip in existing-database mode (isolatedDatabase()).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { WorkOrderStatus } from "@/lib/workshop";

import { REPORT_JOB } from "../fixtures/ids";
import { makeLocation, makeProduct, readAsOwner } from "./inventory-fixtures";
import { makeCustomerWithBike, makeService, type WorkOrderRow } from "./workshop-fixtures";

const DAY_MS = 86_400_000;
const BASE_DAY = Date.UTC(2025, 5, 1); // 2025-06-01

/** An isolated shop day, 2025-06-01 + n, as 'YYYY-MM-DD'. */
export function TEST_DAY(n: number): string {
  return new Date(BASE_DAY + n * DAY_MS).toISOString().slice(0, 10);
}

/** The shop day `n` days after `day` ('YYYY-MM-DD'). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** An ISO timestamptz in Singapore time: sgt('2025-06-02', '09:30') → '2025-06-02T09:30:00+08:00'. */
export function sgt(day: string, time: string): string {
  const t = time.length === 5 ? `${time}:00` : time;
  return `${day}T${t}+08:00`;
}

const OPEN: ReadonlySet<WorkOrderStatus> = new Set([
  "received",
  "diagnosing",
  "awaiting_customer",
  "awaiting_parts",
  "ready_to_start",
  "in_progress",
  "paused",
]);

export type JobStep = { status: WorkOrderStatus; at: string; reason?: string };

export type LineSpec = {
  id?: string;
  type: "service" | "inventory" | "manual";
  quantity?: string | number;
  unitSale: string;
  unitCost: string;
  /** Snapshot rate, default "0.3000". */
  rate?: string;
  createdAt: string;
  voidedAt?: string;
  voidReason?: string;
  costPending?: boolean;
  description?: string;
  serviceId?: string;
  productId?: string;
  unitId?: string;
  locationId?: string;
};

export type InsertJobArgs = {
  customerId?: string;
  bikeId?: string;
  currency?: string;
  /** The job's lead mechanic (public.staff id); none by default (Phase 9). */
  leadMechanicId?: string | null;
  checkedInAt: string;
  requestedWork?: string;
  path?: JobStep[];
  lines?: LineSpec[];
};

export type InsertedLine = {
  id: string;
  type: LineSpec["type"];
  serviceId: string | null;
  productId: string | null;
  locationId: string | null;
  consumptionId: string | null;
  reversalId: string | null;
};

export type InsertedJob = { job: WorkOrderRow; lineIds: string[]; lines: InsertedLine[] };

type Event =
  | { at: number; order: number; kind: "line"; line: LineSpec; index: number }
  | { at: number; order: number; kind: "void"; line: LineSpec; index: number }
  | { at: number; order: number; kind: "status"; step: JobStep };

const REASON_NEEDED = (from: WorkOrderStatus, to: WorkOrderStatus) =>
  to === "cancelled" ||
  (to === "in_progress" && (from === "completed" || from === "ready_for_collection"));

/**
 * Inserts a job with an explicit timeline (owner writes; see the module
 * comment). Lines are inserted (and voided) while the job is open; a
 * timeline Phase 3 would refuse throws before anything is written.
 */
export async function insertJob(tx: pg.Client, a: InsertJobArgs): Promise<InsertedJob> {
  const path = a.path ?? [];
  const lines = a.lines ?? [];
  const checkedIn = Date.parse(a.checkedInAt);
  if (Number.isNaN(checkedIn)) throw new Error(`insertJob: bad checkedInAt ${a.checkedInAt}`);

  // Validate the timeline against P3's rules before writing anything.
  let previous = checkedIn;
  for (const step of path) {
    const at = Date.parse(step.at);
    if (Number.isNaN(at) || at < previous)
      throw new Error(`insertJob: status ${step.status} at ${step.at} goes back in time`);
    previous = at;
  }
  const events: Event[] = [];
  let order = 0;
  lines.forEach((line, index) => {
    const at = Date.parse(line.createdAt);
    if (Number.isNaN(at) || at < checkedIn)
      throw new Error(`insertJob: line ${index} created at ${line.createdAt} before check-in`);
    events.push({ at, order: order++, kind: "line", line, index });
    if (line.voidedAt) {
      const v = Date.parse(line.voidedAt);
      if (Number.isNaN(v) || v < at)
        throw new Error(`insertJob: line ${index} voided at ${line.voidedAt} before it was added`);
      events.push({ at: v, order: order++, kind: "void", line, index });
    }
    if (line.type === "inventory" && Number(line.quantity ?? 1) % 1 !== 0)
      throw new Error(`insertJob: inventory line ${index} needs a whole quantity`);
  });
  for (const step of path)
    events.push({ at: Date.parse(step.at), order: order++, kind: "status", step });
  // Same instant: lines first, then voids, then status changes.
  const rank = { line: 0, void: 1, status: 2 } as const;
  events.sort((x, y) => x.at - y.at || rank[x.kind] - rank[y.kind] || x.order - y.order);
  {
    let status: WorkOrderStatus = "received";
    for (const e of events) {
      if (e.kind === "status") {
        status = e.step.status;
      } else if (!OPEN.has(status)) {
        throw new Error(
          `insertJob: line ${e.index} ${e.kind === "line" ? "added" : "voided"} while the job is ${status} (Phase 3 freezes lines once a job leaves the open statuses)`,
        );
      }
    }
  }

  return readAsOwner(tx, async () => {
    const ids = a.customerId && a.bikeId ? null : await makeCustomerWithBike(tx);
    const customerId = a.customerId ?? ids!.customerId;
    const bikeId = a.bikeId ?? ids!.bikeId;
    const inserted = await tx.query<{ id: string; currency: string }>(
      `insert into public.work_orders (customer_id, bike_id, requested_work, checked_in_at, created_at, currency)
       values ($1, $2, $3, $4, $4, $5) returning id, currency`,
      [
        customerId,
        bikeId,
        a.requestedWork ?? "Reporting test job",
        a.checkedInAt,
        a.currency ?? "SGD",
      ],
    );
    const jobId = inserted.rows[0].id;
    const currency = inserted.rows[0].currency;
    if (a.leadMechanicId) {
      // The lead is set only through an assignment (Phase 3), at check-in.
      await tx.query(
        `insert into public.work_order_assignments (work_order_id, staff_id, role, assigned_at)
         values ($1, $2, 'lead', $3)`,
        [jobId, a.leadMechanicId, a.checkedInAt],
      );
    }

    let location: string | null = null;
    const results: InsertedLine[] = lines.map((l) => ({
      id: l.id ?? randomUUID(),
      type: l.type,
      serviceId: null,
      productId: null,
      locationId: null,
      consumptionId: null,
      reversalId: null,
    }));
    let status: WorkOrderStatus = "received";

    for (const e of events) {
      if (e.kind === "status") {
        const reason =
          e.step.reason ?? (REASON_NEEDED(status, e.step.status) ? "Test reason" : null);
        await tx.query("select private.set_change_reason($1)", [reason]);
        await tx.query(
          "update public.work_orders set status = $2, status_changed_at = $3 where id = $1",
          [jobId, e.step.status, e.step.at],
        );
        await tx.query("select private.set_change_reason(null)");
        status = e.step.status;
        continue;
      }
      const l = e.line;
      const r = results[e.index];
      const quantity = String(l.quantity ?? 1);
      if (e.kind === "line") {
        if (l.type === "service") {
          r.serviceId =
            l.serviceId ?? (await makeService(tx, { price: l.unitSale, cost: l.unitCost }));
        }
        if (l.type === "inventory") {
          r.productId =
            l.productId ??
            (await makeProduct(tx, {
              tracking: l.unitId ? "unique" : "quantity",
              price: l.unitSale,
              cost: l.unitCost,
            }));
          location = l.locationId ?? location ?? (await makeLocation(tx));
          r.locationId = l.locationId ?? location;
          if (l.unitId) {
            await tx.query(
              "update public.inventory_units set status = 'held_for_customer' where id = $1 and status <> 'held_for_customer'",
              [l.unitId],
            );
          }
        }
        await tx.query(
          `insert into public.work_order_line_items
             (id, work_order_id, line_type, source_service_id, source_product_id, source_inventory_unit_id,
              description_snapshot, quantity, unit_sale_price_snapshot, unit_direct_cost_snapshot,
              cost_pending, cult_commons_rate_snapshot, currency, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            r.id,
            jobId,
            l.type,
            r.serviceId,
            r.productId,
            l.unitId ?? null,
            l.description ?? `Test ${l.type} line ${e.index + 1}`,
            quantity,
            l.unitSale,
            l.unitCost,
            l.costPending ?? false,
            l.rate ?? "0.3000",
            currency,
            l.createdAt,
          ],
        );
        if (l.type === "inventory") {
          const m = await tx.query<{ id: string }>(
            `insert into public.inventory_movements
               (product_id, inventory_unit_id, location_id, quantity_delta, movement_type, work_order_id,
                work_order_line_item_id, unit_cost_snapshot, currency, created_at)
             values ($1, $2, $3, $4, 'job_consumption', $5, $6, $7, 'SGD', $8)
             returning id::text`,
            [
              r.productId,
              l.unitId ?? null,
              r.locationId,
              -Number(quantity),
              jobId,
              r.id,
              l.unitCost,
              l.createdAt,
            ],
          );
          r.consumptionId = m.rows[0].id;
        }
      } else {
        await tx.query(
          "update public.work_order_line_items set voided_at = $2, void_reason = $3 where id = $1",
          [r.id, l.voidedAt, l.voidReason ?? "Test void"],
        );
        if (l.type === "inventory") {
          const m = await tx.query<{ id: string }>(
            `insert into public.inventory_movements
               (product_id, inventory_unit_id, location_id, quantity_delta, movement_type, work_order_id,
                work_order_line_item_id, reversal_of_id, unit_cost_snapshot, currency, reason, created_at)
             values ($1, $2, $3, $4, 'reversal', $5, $6, $7, $8, 'SGD', $9, $10)
             returning id::text`,
            [
              r.productId,
              l.unitId ?? null,
              r.locationId,
              Number(quantity),
              jobId,
              r.id,
              r.consumptionId,
              l.unitCost,
              l.voidReason ?? "Test void",
              l.voidedAt,
            ],
          );
          r.reversalId = m.rows[0].id;
          if (l.unitId) {
            await tx.query("update public.inventory_units set status = 'available' where id = $1", [
              l.unitId,
            ]);
          }
        }
      }
    }

    const job = await tx.query<WorkOrderRow>("select * from public.work_orders where id = $1", [
      jobId,
    ]);
    return { job: job.rows[0], lineIds: results.map((r) => r.id), lines: results };
  });
}

/** received → in_progress → completed at the given instants (a common path). */
export function completedPath(startedAt: string, completedAt: string): JobStep[] {
  return [
    { status: "in_progress", at: startedAt },
    { status: "completed", at: completedAt },
  ];
}

export type DailyRow = Record<string, string | number | boolean | null> & { day: string };

/** public.daily_summary(from, to) as whoever `tx` is; day as 'YYYY-MM-DD', numerics as strings. */
export async function dailySummary(tx: pg.Client, from: string | null, to: string | null) {
  const { rows } = await tx.query<DailyRow>(
    "select to_char(day, 'YYYY-MM-DD') as day_key, * from public.daily_summary($1, $2)",
    [from, to],
  );
  return rows.map(({ day_key, ...rest }) => ({ ...rest, day: day_key as string }) as DailyRow);
}

/** The single daily_summary row of one day. */
export async function dayRow(tx: pg.Client, day: string): Promise<DailyRow> {
  return (await dailySummary(tx, day, day))[0];
}

/** Owner: one status change at an explicit instant (with a reason for reopen/cancel). */
export async function moveJob(
  tx: pg.Client,
  jobId: string,
  status: WorkOrderStatus,
  at: string,
  reason: string | null = null,
): Promise<WorkOrderRow> {
  return readAsOwner(tx, async () => {
    await tx.query("select private.set_change_reason($1)", [reason]);
    const { rows } = await tx.query<WorkOrderRow>(
      "update public.work_orders set status = $2, status_changed_at = $3 where id = $1 returning *",
      [jobId, status, at],
    );
    await tx.query("select private.set_change_reason(null)");
    return rows[0];
  });
}

/** Owner: a manual line on an open job at an explicit instant; returns its id. */
export async function insertManualLineAt(
  tx: pg.Client,
  jobId: string,
  l: { unitSale: string; unitCost: string; quantity?: string; createdAt: string; rate?: string },
): Promise<string> {
  const id = randomUUID();
  await readAsOwner(tx, () =>
    tx.query(
      `insert into public.work_order_line_items
         (id, work_order_id, line_type, description_snapshot, quantity, unit_sale_price_snapshot,
          unit_direct_cost_snapshot, cult_commons_rate_snapshot, currency, created_at)
       values ($1, $2, 'manual', 'Test manual line', $3, $4, $5, $6, 'SGD', $7)`,
      [id, jobId, l.quantity ?? "1", l.unitSale, l.unitCost, l.rate ?? "0.3000", l.createdAt],
    ),
  );
  return id;
}

/** Owner: void a line at an explicit instant (the job must be open). */
export async function voidLineAt(tx: pg.Client, lineId: string, at: string, reason = "Test void") {
  await readAsOwner(tx, () =>
    tx.query(
      "update public.work_order_line_items set voided_at = $2, void_reason = $3 where id = $1",
      [lineId, at, reason],
    ),
  );
}

// The documented result columns of the Phase 5 RPCs, in order (DATA-MODEL §16).
export const DAILY_SUMMARY_COLUMNS = [
  "day",
  "jobs_checked_in",
  "jobs_started",
  "jobs_completed",
  "jobs_ready_for_collection",
  "jobs_collected",
  "jobs_cancelled",
  "currency",
  "lines_recognised",
  "gross_sales",
  "cogs",
  "yield_total",
  "cult_commons_share",
  "bicii_yield_after_cc",
  "loss_lines",
  "loss_total",
  "parts_consumed_qty",
  "parts_consumed_lines",
  "parts_returned_qty",
  "stock_adjustments",
  "significant_stock_adjustments",
  "appointments_scheduled",
  "appointments_arrived",
  "appointments_no_show",
  "consignment_sales",
  "consignment_sales_total",
  "new_consignor_liability",
] as const;

/** Money columns of daily_summary that need view_financial_reports (D30). */
export const FIN_COLUMNS = [
  "currency",
  "lines_recognised",
  "gross_sales",
  "consignment_sales",
  "consignment_sales_total",
] as const;

/** Cost-derived columns of daily_summary that also need view_costs (D30). */
export const COST_COLUMNS = [
  "cogs",
  "yield_total",
  "cult_commons_share",
  "bicii_yield_after_cc",
  "loss_lines",
  "loss_total",
  "new_consignor_liability",
] as const;

export const TODAY_DASHBOARD_COLUMNS = [
  "day",
  "is_today",
  "generated_at",
  "can_see_financials",
  "can_see_costs",
  ...DAILY_SUMMARY_COLUMNS.slice(1),
  "received_now",
  "waiting_now",
  "ready_to_start_now",
  "in_progress_now",
  "awaiting_collection_now",
  "open_jobs_now",
  "overdue_now",
  "low_stock_now",
  "exceptions_now",
  "cost_pending_lines",
] as const;

export const SNAPSHOT_COLUMNS = TODAY_DASHBOARD_COLUMNS.filter((c) => c.endsWith("_now"));

export const WORK_ORDER_ACTIVITY_ON_COLUMNS = [
  "work_order_id",
  "job_number",
  "status",
  "customer_id",
  "customer_label",
  "bike_id",
  "bike_title",
  "lead_mechanic_name",
  "checked_in_at",
  "started_at",
  "completed_at",
  "ready_for_collection_at",
  "collected_at",
  "cancelled_at",
  "checked_in_on_day",
  "started_on_day",
  "completed_on_day",
  "ready_on_day",
  "collected_on_day",
  "cancelled_on_day",
  "is_open",
  "is_overdue",
  "age_days",
  "sale_total",
  "currency",
] as const;

export const STOCK_ADJUSTMENTS_ON_COLUMNS = [
  "movement_id",
  "created_at",
  "movement_type",
  "product_id",
  "product_short_id",
  "product_name",
  "inventory_unit_id",
  "unit_short_id",
  "location_name",
  "quantity_delta",
  "reason",
  "actor_name",
  "significant",
  "value_at_cost",
  "currency",
] as const;

export const OPERATIONAL_EXCEPTIONS_COLUMNS = [
  "kind",
  "severity",
  "entity_type",
  "entity_id",
  "entity_label",
  "subject_label",
  "days",
  "quantity",
  "since",
  // Phase 9 (D106-D108) appends these after Phase 5's nine (a documented
  // contract change: the first nine are unchanged).
  "issue",
  "short_id",
  "title",
  "detail",
  "amount",
  "currency",
] as const;

export const FINANCIAL_LINES_COLUMNS = [
  "entry_key",
  "source",
  "entry_kind",
  "source_line_id",
  "document_id",
  "document_number",
  "channel",
  "recognized_at",
  "recognized_day",
  "line_type",
  "service_id",
  "product_id",
  "inventory_unit_id",
  "category_id",
  "ownership_type",
  "consignment_item_id",
  "customer_id",
  "bike_id",
  "lead_mechanic_id",
  "description",
  "quantity",
  "unit_sale_price",
  "unit_direct_cost",
  "cult_commons_rate",
  "sale_total",
  "cost_total",
  "yield_total",
  "cult_commons_share",
  "bicii_yield_after_cc",
  "is_loss",
  "currency",
  "cost_pending",
] as const;

/** financial_lines columns that need view_costs (D30). */
export const FINANCIAL_LINES_COST_COLUMNS = [
  "unit_direct_cost",
  "cult_commons_rate",
  "cost_total",
  "yield_total",
  "cult_commons_share",
  "bicii_yield_after_cc",
  "is_loss",
] as const;

export const WORK_ORDER_YIELD_COLUMNS = [
  "work_order_id",
  "job_number",
  "status",
  "currency",
  "line_count",
  "sale_total",
  "cost_total",
  "yield_total",
  "cult_commons_share",
  "bicii_yield_after_cc",
  "loss_line_count",
  "loss_total",
  "cult_commons_rates",
  "recognized_at",
  "recognized_day",
  "cost_pending_count",
  // D273: the job's Stripe fees, appended
  "stripe_fees",
  "stripe_fees_borne",
  "cult_commons_after_fees",
  "bicii_yield_after_fees",
  "stripe_fee_pending_count",
] as const;

/** A money value as a fixed-2 string (null stays null), for comparing numerics of any scale. */
export function money(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return Number(v).toFixed(2);
}

/** The shop's today as 'YYYY-MM-DD', from the database (D35). */
export async function shopToday(tx: pg.Client): Promise<string> {
  const { rows } = await readAsOwner(tx, () =>
    tx.query<{ d: string }>("select to_char(private.shop_today(), 'YYYY-MM-DD') as d"),
  );
  return rows[0].d;
}

/**
 * The seed's anchor: the shop day `db:reset` ran, as 'YYYY-MM-DD'. Read
 * from T3's check-in (REPORT_JOB.todayReceived, checked in "today" by the
 * seed) without the functions under test. It need not be today: the test
 * template is built once per run, an existing database keeps an old seed,
 * and a run can cross Singapore midnight. Seed assertions count days back
 * from it (addDays(anchor, -n)); those that need anchor = today compare it
 * with shopToday() first and skip when they differ.
 */
export async function seedToday(tx: pg.Client): Promise<string> {
  const { rows } = await readAsOwner(tx, () =>
    tx.query<{ d: string }>(
      `select (checked_in_at at time zone 'Asia/Singapore')::date::text as d
         from public.work_orders where id = $1`,
      [REPORT_JOB.todayReceived],
    ),
  );
  if (rows.length === 0) {
    throw new Error(
      "seedToday: the seed's anchor job (REPORT_JOB.todayReceived) is missing; run `npm run db:reset`.",
    );
  }
  return rows[0].d;
}

/** The database's now() (this transaction's) shifted by `offset` (an interval), as a full-precision ISO string. */
export async function dbNow(tx: pg.Client, offset = "0 seconds"): Promise<string> {
  const { rows } = await tx.query<{ t: string }>(
    `select to_char((now() + $1::interval) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`,
    [offset],
  );
  return rows[0].t;
}
