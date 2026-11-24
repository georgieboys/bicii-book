import "server-only";

import { DbError, unwrap } from "@/lib/db-errors";
import { toDecimal, toMoneyString } from "@/lib/money";
import {
  toTodayDashboard,
  type ActivityRow,
  type AdjustmentRow,
  type DailySummary,
  type FinancialEntry,
  type LowStockItem,
  type OperationalException,
  type TodayDashboard,
  type TodayDashboardRow,
  type WorkOrderYield,
} from "@/lib/reports";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Reads for the Today dashboard and the job yield panel (SPEC §19.1, §22;
 * DATA-MODEL §14-§16; PLAN D30-D35; ADR-001 A2). Each function takes the
 * RLS-scoped client, calls ONE Phase 5 read RPC (or P4's
 * reporting.low_stock), throws DbError on failure and returns DTOs from
 * src/lib/reports.ts: money as fixed-2 strings with their currency.
 *
 * The database gates every figure (D30): a column it returns NULL stays
 * null here, never recomputed, so a screen can only say it is hidden.
 * Days are "YYYY-MM-DD" shop days; null asks the database for its today
 * (D35). The Phase 5 reporting views themselves are granted to no API role:
 * this module reads only through the RPCs.
 *
 * Phase 9 adds period reads beside these without changing them.
 */

/** PostgREST returns numeric as a JSON number; everything leaves here as a fixed-2 string. */
const money = (v: number | string | null | undefined, currency?: string | null) =>
  toMoneyString(v ?? 0, currency ?? undefined);
const moneyOrNull = (v: number | string | null | undefined, currency?: string | null) =>
  v === null || v === undefined ? null : toMoneyString(v, currency ?? undefined);

/** financial_lines is read in pages of this many rows (PostgREST caps a response at 1,000). */
const ENTRY_PAGE = 500;

/**
 * Today (or an earlier shop day): flows, the current snapshot (today only),
 * money for view_financial_reports holders (costs only with view_costs) and
 * stock. `day` null or omitted: the database's today. A future day raises
 * DbError P0001 report_range_invalid.
 */
export async function getTodayDashboard(
  supabase: ServerSupabase,
  day?: string | null,
): Promise<TodayDashboard> {
  const rows = unwrap(
    await supabase.rpc("today_dashboard", day ? { on_day: day } : {}),
  ) as unknown as TodayDashboardRow[] | null;
  const row = rows?.[0];
  if (!row) throw new DbError({ code: "P0002", message: "today_dashboard returned no row" });
  return toTodayDashboard(row);
}

/** One summary per shop day from `from` to `to` inclusive, zero-filled (at most 366 days). */
export async function getDailySummaries(
  supabase: ServerSupabase,
  { from, to }: { from: string; to: string },
): Promise<DailySummary[]> {
  const rows = unwrap(await supabase.rpc("daily_summary", { from_day: from, to_day: to })) ?? [];
  return rows.map((r) => {
    // NULL without view_financial_reports / view_costs (D30).
    const n = r as { [K in keyof typeof r]: (typeof r)[K] | null };
    return {
      day: r.day,
      jobsCheckedIn: n.jobs_checked_in ?? 0,
      jobsStarted: n.jobs_started ?? 0,
      jobsCompleted: n.jobs_completed ?? 0,
      jobsReadyForCollection: n.jobs_ready_for_collection ?? 0,
      jobsCollected: n.jobs_collected ?? 0,
      jobsCancelled: n.jobs_cancelled ?? 0,
      currency: n.currency,
      linesRecognised: n.lines_recognised,
      grossSales: moneyOrNull(n.gross_sales, n.currency),
      cogs: moneyOrNull(n.cogs, n.currency),
      yield: moneyOrNull(n.yield_total, n.currency),
      cultCommons: moneyOrNull(n.cult_commons_share, n.currency),
      biciiAfterCc: moneyOrNull(n.bicii_yield_after_cc, n.currency),
      lossLines: n.loss_lines,
      lossTotal: moneyOrNull(n.loss_total, n.currency),
      partsConsumedQty: n.parts_consumed_qty ?? 0,
      stockAdjustments: n.stock_adjustments ?? 0,
      significantAdjustments: n.significant_stock_adjustments ?? 0,
    };
  });
}

/** The jobs with a current stamp on `day` (by job number), with which stamps fall that day. */
export async function getWorkOrderActivityOn(
  supabase: ServerSupabase,
  day: string,
): Promise<ActivityRow[]> {
  const rows = unwrap(await supabase.rpc("work_order_activity_on", { on_day: day })) ?? [];
  return rows.map((r) => ({
    workOrderId: r.work_order_id,
    jobNumber: r.job_number,
    status: r.status,
    customerLabel: r.customer_label,
    bikeTitle: r.bike_title,
    leadName: (r.lead_mechanic_name as string | null) ?? null,
    on: {
      checkedIn: r.checked_in_on_day,
      started: r.started_on_day,
      completed: r.completed_on_day,
      readyForCollection: r.ready_on_day,
      collected: r.collected_on_day,
      cancelled: r.cancelled_on_day,
    },
    isOpen: r.is_open,
    isOverdue: r.is_overdue,
    ageDays: r.age_days ?? 0,
    saleTotal: money(r.sale_total, r.currency),
    currency: r.currency,
  }));
}

/** The stock adjustments and damaged stock of `day`, newest first (D33 flag for all; value at cost with view_costs). */
export async function getStockAdjustmentsOn(
  supabase: ServerSupabase,
  day: string,
): Promise<AdjustmentRow[]> {
  const rows = unwrap(await supabase.rpc("stock_adjustments_on", { on_day: day })) ?? [];
  return rows.map((r) => {
    const n = r as { [K in keyof typeof r]: (typeof r)[K] | null };
    return {
      movementId: r.movement_id,
      createdAt: r.created_at,
      movementType: r.movement_type,
      productId: r.product_id,
      productShortId: r.product_short_id,
      productName: r.product_name,
      unitId: n.inventory_unit_id,
      unitShortId: n.unit_short_id,
      locationName: r.location_name,
      quantityDelta: r.quantity_delta,
      reason: n.reason,
      actorName: n.actor_name,
      significant: r.significant === true,
      valueAtCost: moneyOrNull(n.value_at_cost, r.currency),
      currency: r.currency,
    };
  });
}

/** The first `max` low-stock products, largest shortfall first (P4's reporting.low_stock order). */
export async function getLowStockItems(
  supabase: ServerSupabase,
  max: number,
): Promise<LowStockItem[]> {
  const rows =
    unwrap(
      await supabase
        .schema("reporting")
        .from("low_stock")
        .select(
          "product_id, short_id, name, sku, on_hand, reorder_point, negative_locations, shortfall",
        )
        .limit(max),
    ) ?? [];
  return rows
    .filter((r) => r.product_id !== null)
    .map((r) => ({
      productId: r.product_id!,
      shortId: r.short_id ?? "",
      name: r.name ?? "",
      sku: r.sku,
      onHand: r.on_hand ?? 0,
      reorderPoint: r.reorder_point,
      negativeLocations: r.negative_locations ?? 0,
      shortfall: r.shortfall ?? 0,
    }));
}

/**
 * Operational exceptions (D34; extended by Phase 9, D106-D108) the caller
 * may see (D108), danger first then oldest; at most `max` (the RPC clamps
 * to 1..200). The one mapper of public.operational_exceptions.
 */
export async function getOperationalExceptions(
  supabase: ServerSupabase,
  max: number,
): Promise<OperationalException[]> {
  const rows = unwrap(await supabase.rpc("operational_exceptions", { max_rows: max })) ?? [];
  return rows.map((r) => {
    const n = r as { [K in keyof typeof r]: (typeof r)[K] | null };
    return {
      kind: r.kind,
      severity: r.severity,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityLabel: n.entity_label,
      subjectLabel: n.subject_label,
      days: n.days,
      quantity: n.quantity,
      since: n.since,
      // Phase 9's appended columns (D106-D108); the amount is the database's.
      issue: n.issue,
      shortId: n.short_id,
      title: n.title,
      detail: n.detail,
      amount: moneyOrNull(n.amount, n.currency),
      currency: n.currency,
    };
  });
}

/**
 * The recognised entries of one shop day (D32). Only for
 * view_financial_reports holders (42501 otherwise); cost-derived fields are
 * null without view_costs. Read in pages of ENTRY_PAGE until a short page,
 * since PostgREST caps one response.
 */
export async function getFinancialEntriesOn(
  supabase: ServerSupabase,
  day: string,
): Promise<FinancialEntry[]> {
  const out: FinancialEntry[] = [];
  for (let offset = 0; ; offset += ENTRY_PAGE) {
    const rows =
      unwrap(
        await supabase
          .rpc("financial_lines", { from_day: day, to_day: day })
          .range(offset, offset + ENTRY_PAGE - 1),
      ) ?? [];
    for (const r of rows) {
      const n = r as { [K in keyof typeof r]: (typeof r)[K] | null };
      out.push({
        entryKey: r.entry_key,
        source: r.source,
        documentId: r.document_id,
        documentNumber: r.document_number,
        channel: r.channel,
        recognizedAt: r.recognized_at,
        lineType: n.line_type,
        description: r.description,
        quantity: toDecimal(r.quantity).toFixed(2),
        unitSalePrice: money(r.unit_sale_price, r.currency),
        saleTotal: money(r.sale_total, r.currency),
        costTotal: moneyOrNull(n.cost_total, r.currency),
        yield: moneyOrNull(n.yield_total, r.currency),
        cultCommons: moneyOrNull(n.cult_commons_share, r.currency),
        ccRate: n.cult_commons_rate === null ? null : toDecimal(n.cult_commons_rate).toFixed(4),
        isLoss: n.is_loss,
        costPending: r.cost_pending === true,
        currency: r.currency,
        entryKind: r.entry_kind === "stripe_fee" ? "stripe_fee" : "line",
        stripeFee: moneyOrNull(n.stripe_fee, r.currency),
        stripeFeePending: n.stripe_fee_pending === true,
      });
    }
    if (rows.length < ENTRY_PAGE) return out;
  }
}

/**
 * One job's economics and recognition (view_costs only; 42501 otherwise),
 * or null when the job does not exist (P0002).
 */
export async function getWorkOrderYield(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<WorkOrderYield | null> {
  const { data, error } = await supabase.rpc("work_order_yield", {
    target_work_order_id: workOrderId,
  });
  if (error?.code === "P0002") return null;
  const r = unwrap({ data, error })?.[0];
  if (!r) return null;
  const n = r as { [K in keyof typeof r]: (typeof r)[K] | null };
  return {
    workOrderId: r.work_order_id,
    jobNumber: r.job_number,
    status: r.status,
    currency: r.currency,
    lineCount: r.line_count ?? 0,
    saleTotal: money(r.sale_total, r.currency),
    costTotal: money(r.cost_total, r.currency),
    yieldTotal: money(r.yield_total, r.currency),
    cultCommons: money(r.cult_commons_share, r.currency),
    biciiAfterCc: money(r.bicii_yield_after_cc, r.currency),
    lossLineCount: r.loss_line_count ?? 0,
    lossTotal: money(r.loss_total, r.currency),
    ccRates: (r.cult_commons_rates ?? []).map((rate) => toDecimal(rate).toFixed(4)),
    recognizedAt: n.recognized_at,
    recognizedDay: n.recognized_day,
    costPendingCount: r.cost_pending_count ?? 0,
    stripeFees: money(r.stripe_fees, r.currency),
    stripeFeesBorne: money(r.stripe_fees_borne, r.currency),
    ccAfterFees: money(r.cult_commons_after_fees ?? r.cult_commons_share, r.currency),
    biciiAfterFees: money(r.bicii_yield_after_fees ?? r.bicii_yield_after_cc, r.currency),
    stripeFeePendingCount: r.stripe_fee_pending_count ?? 0,
  };
}
