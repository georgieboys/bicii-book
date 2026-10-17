import "server-only";

import { cache } from "react";

import { DbError, unwrap } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import type { ListPage } from "@/lib/domain/list";
import { toMoneyString } from "@/lib/money";
import {
  breakdownHref,
  type BreakdownCursor,
  type BreakdownRow,
  type LineCursor,
  type MechanicActivity,
  type PeriodActivity,
  type PeriodSummary,
  type ReportBasis,
  type ReportDimension,
  type ReportGrain,
  type ReportLine,
  type ReportParams,
  type SeriesBucket,
  type StockValueRow,
} from "@/lib/period-reports";
import { documentHref } from "@/lib/reports";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Reads for the period reports (Phase 9; SPEC §19.2; PLAN D30, D100–D105;
 * ADR-022). Each function takes the RLS-scoped client, calls ONE step 1
 * RPC, throws DbError on failure (map it with mapDbError) and returns the
 * DTOs of src/lib/period-reports.ts: money as fixed-2 strings with their
 * currency, counts as numbers.
 *
 * The database gates every figure (D30): a cost-derived column it returns
 * NULL stays null here, never recomputed or shown as 0. Nothing here adds
 * money up: totals come from report_period_summary. The export pagers
 * compare INTEGER line counts only, as a consistency check, never as a
 * displayed figure.
 */

/** A row as the RPC really returns it: the generated types call every column non-null. */
type Nullable<T> = { [K in keyof T]: T[K] | null };

type Fn = import("@/lib/database.types").Database["public"]["Functions"];

const money = (v: number | string | null | undefined, currency: string) =>
  toMoneyString(v ?? 0, currency);
const moneyOrNull = (v: number | string | null | undefined, currency: string) =>
  v === null || v === undefined ? null : toMoneyString(v, currency);
const int = (v: number | null | undefined) => v ?? 0;
const intOrNull = (v: number | null | undefined) => (v === null || v === undefined ? null : v);

/** The shop currency when a read has no row to carry it (an empty breakdown). */
const FALLBACK_CURRENCY = "SGD";

export type PeriodQuery = { from: string; to: string; basis: ReportBasis };

// ---------------------------------------------------------------------------
// Summary, series
// ---------------------------------------------------------------------------

async function readSummary(
  supabase: ServerSupabase,
  from: string,
  to: string,
  basis: ReportBasis,
): Promise<PeriodSummary> {
  const rows = unwrap(
    await supabase.rpc("report_period_summary", { p_from: from, p_to: to, p_basis: basis }),
  ) as Nullable<Fn["report_period_summary"]["Returns"][number]>[] | null;
  const r = rows?.[0];
  if (!r) throw new DbError({ code: "P0002", message: "report_period_summary returned no row" });
  const c = r.currency ?? FALLBACK_CURRENCY;
  return {
    basis: r.basis ?? basis,
    from: r.from_date ?? from,
    to: r.to_date ?? to,
    currency: c,
    lineCount: int(r.line_count),
    jobCount: int(r.job_count),
    saleCount: int(r.sale_count),
    saleTotal: money(r.sale_total, c),
    costTotal: moneyOrNull(r.cost_total, c),
    yieldTotal: moneyOrNull(r.yield_total, c),
    cultCommons: moneyOrNull(r.cult_commons_share, c),
    afterCc: moneyOrNull(r.yield_after_cc, c),
    lossLineCount: intOrNull(r.loss_line_count),
    costPendingLines: int(r.cost_pending_lines),
    refundsTotal: moneyOrNull(r.refunds_total, c),
    refundCount: intOrNull(r.refund_count),
    consignmentSales: intOrNull(r.consignment_sales),
    consignmentSalesTotal: moneyOrNull(r.consignment_sales_total, c),
    newConsignorLiability: moneyOrNull(r.new_consignor_liability, c),
    settlementsPaid: moneyOrNull(r.settlements_paid_total, c),
    purchasesReceived: moneyOrNull(r.purchases_received_total, c),
    excludedForeignLineCount: int(r.excluded_foreign_line_count),
  };
}

/**
 * The period's totals on a basis (view_financial_reports; cost-derived
 * figures need view_costs). Memoised per render: the tiles and the
 * breakdown's empty state read the same row.
 */
export const getPeriodSummary = cache(
  (supabase: ServerSupabase, from: string, to: string, basis: ReportBasis) =>
    readSummary(supabase, from, to, basis),
);

/** The period in buckets of `grain` (shop days, ISO weeks or calendar months). */
export async function getPeriodSeries(
  supabase: ServerSupabase,
  { from, to, basis, grain }: PeriodQuery & { grain: ReportGrain },
  currency: string,
): Promise<SeriesBucket[]> {
  const rows = (unwrap(
    await supabase.rpc("report_period_series", {
      p_from: from,
      p_to: to,
      p_basis: basis,
      p_grain: grain,
    }),
  ) ?? []) as Nullable<Fn["report_period_series"]["Returns"][number]>[];
  return rows.map((r) => ({
    start: r.bucket_start!,
    end: r.bucket_end!,
    partial: r.partial === true,
    lineCount: int(r.line_count),
    jobCount: int(r.job_count),
    saleCount: int(r.sale_count),
    saleTotal: money(r.sale_total, currency),
    costTotal: moneyOrNull(r.cost_total, currency),
    yieldTotal: moneyOrNull(r.yield_total, currency),
    cultCommons: moneyOrNull(r.cult_commons_share, currency),
    afterCc: moneyOrNull(r.yield_after_cc, currency),
    lossLineCount: intOrNull(r.loss_line_count),
    refundsTotal: moneyOrNull(r.refunds_total, currency),
    consignmentSales: intOrNull(r.consignment_sales),
    consignmentSalesTotal: moneyOrNull(r.consignment_sales_total, currency),
    newConsignorLiability: moneyOrNull(r.new_consignor_liability, currency),
    settlementsPaid: moneyOrNull(r.settlements_paid_total, currency),
    currency,
  }));
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

type BreakdownRpcRow = Nullable<Fn["report_breakdown"]["Returns"][number]>;

function toBreakdownRow(
  r: BreakdownRpcRow,
  q: Pick<ReportParams, "period" | "anchor" | "from" | "to" | "basis">,
  dimension: ReportDimension,
  currency: string,
): BreakdownRow {
  const row = {
    key: r.key!,
    entityType: r.entity_type,
    entityId: r.entity_id,
  };
  return {
    dimension,
    ...row,
    label: r.label ?? r.key!,
    detail: r.detail,
    lineCount: int(r.line_count),
    jobCount: int(r.job_count),
    saleCount: int(r.sale_count),
    quantity: r.quantity === null || r.quantity === undefined ? null : String(r.quantity),
    saleTotal: money(r.sale_total, currency),
    costTotal: moneyOrNull(r.cost_total, currency),
    yieldTotal: moneyOrNull(r.yield_total, currency),
    cultCommons: moneyOrNull(r.cult_commons_share, currency),
    afterCc: moneyOrNull(r.yield_after_cc, currency),
    firstAt: r.first_at,
    lastAt: r.last_at,
    currency,
    href: breakdownHref(q, dimension, row),
  };
}

export type BreakdownQuery = Pick<ReportParams, "period" | "anchor" | "from" | "to" | "basis"> & {
  dimension: ReportDimension;
  currency: string;
};

async function breakdownPage(
  supabase: ServerSupabase,
  q: Omit<BreakdownQuery, "currency">,
  maxRows: number,
  after: BreakdownCursor | null,
): Promise<BreakdownRpcRow[]> {
  return (unwrap(
    await supabase.rpc("report_breakdown", {
      p_from: q.from,
      p_to: q.to,
      p_basis: q.basis,
      p_dimension: q.dimension,
      p_max_rows: maxRows,
      // The keyset value goes back exactly as it came (never rounded).
      ...(after
        ? { p_after_sale_total: after.saleTotal as unknown as number, p_after_key: after.key }
        : {}),
    }),
  ) ?? []) as BreakdownRpcRow[];
}

/** The raw keyset value of a row (sale_total as PostgREST sent it). */
const cursorOf = (r: BreakdownRpcRow): BreakdownCursor => ({
  saleTotal: String(r.sale_total),
  key: r.key!,
});

/**
 * One page of the breakdown, largest gross first: at most `limit` groups,
 * `more` when there are further ones and `nextCursor` to ask for them.
 */
export async function getBreakdown(
  supabase: ServerSupabase,
  q: BreakdownQuery & { limit: number; after?: BreakdownCursor | null },
): Promise<ListPage<BreakdownRow> & { nextCursor: BreakdownCursor | null }> {
  const rows = await breakdownPage(supabase, q, q.limit + 1, q.after ?? null);
  const more = rows.length > q.limit;
  const shown = rows.slice(0, q.limit);
  return {
    items: shown.map((r) => toBreakdownRow(r, q, q.dimension, q.currency)),
    more,
    nextCursor: more && shown.length > 0 ? cursorOf(shown[shown.length - 1]) : null,
  };
}

/** One group of the breakdown (the drill-down header), or null for a key with no lines in the period. */
export const getBreakdownRow = cache(
  async (
    supabase: ServerSupabase,
    from: string,
    to: string,
    basis: ReportBasis,
    dimension: ReportDimension,
    key: string,
    currency: string,
    period: ReportParams["period"],
    anchor: string,
  ): Promise<BreakdownRow | null> => {
    const rows = (unwrap(
      await supabase.rpc("report_breakdown", {
        p_from: from,
        p_to: to,
        p_basis: basis,
        p_dimension: dimension,
        p_max_rows: 1,
        p_key: key,
      }),
    ) ?? []) as BreakdownRpcRow[];
    const r = rows[0];
    return r ? toBreakdownRow(r, { period, anchor, from, to, basis }, dimension, currency) : null;
  },
);

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

type LineRpcRow = Nullable<Fn["report_line_items"]["Returns"][number]>;

function toLine(r: LineRpcRow): ReportLine {
  const c = r.currency ?? FALLBACK_CURRENCY;
  return {
    sourceLineId: r.source_line_id!,
    source: r.source!,
    channel: r.channel ?? "",
    basisAt: r.basis_at!,
    documentId: r.document_id!,
    documentNumber: r.document_number ?? "",
    documentHref: documentHref({ source: r.source!, documentId: r.document_id! }),
    lineType: r.line_type ?? "",
    description: r.description ?? "",
    quantity: String(r.quantity ?? 0),
    unitSalePrice: money(r.unit_sale_price, c),
    saleTotal: money(r.sale_total, c),
    costTotal: moneyOrNull(r.cost_total, c),
    yieldTotal: moneyOrNull(r.yield_total, c),
    cultCommons: moneyOrNull(r.cult_commons_share, c),
    costPending: r.cost_pending === true,
    ownershipType: r.ownership_type,
    categoryName: r.category_name,
    mechanicName: r.mechanic_name,
    currency: c,
  };
}

export type LineQuery = PeriodQuery & { dimension?: ReportDimension | null; key?: string | null };

async function linePage(
  supabase: ServerSupabase,
  q: LineQuery,
  maxRows: number,
  after: LineCursor | null,
): Promise<LineRpcRow[]> {
  return (unwrap(
    await supabase.rpc("report_line_items", {
      p_from: q.from,
      p_to: q.to,
      p_basis: q.basis,
      ...(q.dimension && q.key ? { p_dimension: q.dimension, p_key: q.key } : {}),
      p_max_rows: maxRows,
      // The keyset goes back exactly as it came (microseconds kept).
      ...(after ? { p_after_at: after.at, p_after_id: after.id } : {}),
    }),
  ) ?? []) as LineRpcRow[];
}

/** One page of the lines, newest basis date first, and the cursor for the next page (null at the end). */
export async function getLineItems(
  supabase: ServerSupabase,
  q: LineQuery & { limit: number; after?: LineCursor | null },
): Promise<{ items: ReportLine[]; nextCursor: LineCursor | null }> {
  const rows = await linePage(supabase, q, q.limit + 1, q.after ?? null);
  const more = rows.length > q.limit;
  const shown = rows.slice(0, q.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(toLine),
    nextCursor: more && last ? { at: last.basis_at!, id: last.source_line_id! } : null,
  };
}

// ---------------------------------------------------------------------------
// Activity, mechanics, stock value
// ---------------------------------------------------------------------------

/** The period's workshop, appointment and stock counts (any active staff; no money). */
export async function getActivity(
  supabase: ServerSupabase,
  { from, to }: { from: string; to: string },
): Promise<PeriodActivity> {
  const rows = unwrap(await supabase.rpc("report_activity", { p_from: from, p_to: to })) as
    Nullable<Fn["report_activity"]["Returns"][number]>[] | null;
  const r = rows?.[0];
  if (!r) throw new DbError({ code: "P0002", message: "report_activity returned no row" });
  const hours = (v: number | null) => (v === null ? null : Number(v));
  return {
    checkedIn: int(r.jobs_checked_in),
    started: int(r.jobs_started),
    completed: int(r.jobs_completed),
    readyForCollection: int(r.jobs_ready_for_collection),
    collected: int(r.jobs_collected),
    cancelled: int(r.jobs_cancelled),
    openAtEnd: int(r.jobs_open_at_end),
    medianHoursToComplete: hours(r.median_hours_to_complete),
    medianHoursToCollect: hours(r.median_hours_to_collect),
    appointments: {
      scheduled: int(r.appointments_scheduled),
      arrived: int(r.appointments_arrived),
      noShow: int(r.appointments_no_show),
      cancelled: int(r.appointments_cancelled),
    },
    stock: {
      partsConsumedQty: int(r.parts_consumed_qty),
      partsConsumedLines: int(r.parts_consumed_lines),
      partsReturnedQty: int(r.parts_returned_qty),
      adjustments: int(r.stock_adjustments),
      significantAdjustments: int(r.significant_stock_adjustments),
      deliveries: int(r.purchase_receipts),
      unitsReceived: int(r.purchase_units_received),
    },
  };
}

/** Per staff member: jobs checked in, completed and collected in the period as lead (D103), and open now. */
export async function getActivityByMechanic(
  supabase: ServerSupabase,
  { from, to }: { from: string; to: string },
): Promise<MechanicActivity[]> {
  const rows = (unwrap(
    await supabase.rpc("report_activity_by_mechanic", { p_from: from, p_to: to }),
  ) ?? []) as Nullable<Fn["report_activity_by_mechanic"]["Returns"][number]>[];
  // staff_id NULL is the jobs without a lead (D103): "Unassigned", never "inactive".
  return rows.map((r) => ({
    staffId: r.staff_id,
    name: r.staff_id === null ? "Unassigned" : (r.display_name ?? ""),
    active: r.staff_id === null || r.active === true,
    checkedIn: int(r.jobs_checked_in),
    completed: int(r.jobs_completed),
    collected: int(r.jobs_collected),
    openNow: int(r.jobs_open_now),
  }));
}

/** Stock now per ownership (D105): counts for every row, the shop-owned value with view_costs. */
export async function getStockValue(supabase: ServerSupabase): Promise<StockValueRow[]> {
  const rows = (unwrap(await supabase.rpc("report_stock_value")) ?? []) as Nullable<
    Fn["report_stock_value"]["Returns"][number]
  >[];
  return rows.map((r) => {
    const c = r.currency ?? FALLBACK_CURRENCY;
    return {
      ownership: r.ownership_type ?? "",
      quantityOnHand: int(r.quantity_on_hand),
      unitsInStock: int(r.units_in_stock),
      uncostedItems: int(r.uncosted_items),
      valueAtCost: moneyOrNull(r.value_at_cost, c),
      currency: c,
    };
  });
}

// ---------------------------------------------------------------------------
// Exports: every row, in pages, with a consistency check
// ---------------------------------------------------------------------------

/** No export holds more rows than this (RISKS R-057). */
export const EXPORT_MAX_ROWS = 50_000;
/** report_breakdown's p_max_rows ceiling. */
const BREAKDOWN_EXPORT_PAGE = 500;
/** PostgREST's max-rows and report_line_items' p_max_rows ceiling. */
const LINE_EXPORT_PAGE = 1000;

export const EXPORT_CHANGED_MESSAGE = "Figures changed while exporting. Try again.";
export const EXPORT_TOO_LARGE_MESSAGE = "Too many rows to export. Choose a shorter range.";

/** An export that cannot be written: the figures moved under it (409) or it is too large (413). */
export class ExportError extends DomainError {
  constructor(
    readonly reason: "changed" | "too_large",
    /** A message for this export kind (default: the period exports' wording). */
    message?: string,
  ) {
    super(message ?? (reason === "changed" ? EXPORT_CHANGED_MESSAGE : EXPORT_TOO_LARGE_MESSAGE));
    this.name = "ExportError";
  }
}

/**
 * Runs `attempt` and, when its line counts disagree (a concurrent change
 * between pages), once more; a second disagreement is ExportError
 * ('changed'). The payment list's export (src/lib/domain/payment-reports.ts)
 * uses it too.
 */
export async function withOneRetry<T>(attempt: () => Promise<T | "mismatch">): Promise<T> {
  for (let i = 0; i < 2; i++) {
    const result = await attempt();
    if (result !== "mismatch") return result;
  }
  throw new ExportError("changed");
}

/**
 * Every breakdown group of the period (pages of 500 by the keyset, at most
 * 50,000 groups) with the summary row they belong to, for the CSV and its
 * TOTAL row. The groups' integer line counts must add up to the summary's
 * line_count (every line is in exactly one group); otherwise it retries
 * once, then refuses.
 */
export async function getAllBreakdownForExport(
  supabase: ServerSupabase,
  q: Omit<BreakdownQuery, "currency">,
): Promise<{ rows: BreakdownRow[]; summary: PeriodSummary }> {
  return withOneRetry(async () => {
    const summary = await readSummary(supabase, q.from, q.to, q.basis);
    const raw: BreakdownRpcRow[] = [];
    let after: BreakdownCursor | null = null;
    for (;;) {
      const page = await breakdownPage(supabase, q, BREAKDOWN_EXPORT_PAGE, after);
      raw.push(...page);
      if (raw.length > EXPORT_MAX_ROWS) throw new ExportError("too_large");
      if (page.length < BREAKDOWN_EXPORT_PAGE) break;
      after = cursorOf(page[page.length - 1]);
    }
    const lines = raw.reduce((n, r) => n + int(r.line_count), 0);
    if (lines !== summary.lineCount) return "mismatch";
    return {
      rows: raw.map((r) => toBreakdownRow(r, q, q.dimension, summary.currency)),
      summary,
    };
  });
}

/**
 * Every line of the period, or of one breakdown group (pages of 1,000 by
 * the keyset, at most 50,000 lines). The count must equal the group's
 * line_count (report_breakdown with p_key) or the summary's; otherwise it
 * retries once, then refuses.
 */
export async function getAllLineItemsForExport(
  supabase: ServerSupabase,
  q: LineQuery,
): Promise<ReportLine[]> {
  return withOneRetry(async () => {
    let expected: number;
    if (q.dimension && q.key) {
      const rows = (unwrap(
        await supabase.rpc("report_breakdown", {
          p_from: q.from,
          p_to: q.to,
          p_basis: q.basis,
          p_dimension: q.dimension,
          p_max_rows: 1,
          p_key: q.key,
        }),
      ) ?? []) as BreakdownRpcRow[];
      expected = int(rows[0]?.line_count);
    } else {
      expected = (await readSummary(supabase, q.from, q.to, q.basis)).lineCount;
    }
    if (expected > EXPORT_MAX_ROWS) throw new ExportError("too_large");
    const raw: LineRpcRow[] = [];
    let after: LineCursor | null = null;
    for (;;) {
      const page = await linePage(supabase, q, LINE_EXPORT_PAGE, after);
      raw.push(...page);
      if (raw.length > EXPORT_MAX_ROWS) throw new ExportError("too_large");
      if (page.length < LINE_EXPORT_PAGE) break;
      const last = page[page.length - 1];
      after = { at: last.basis_at!, id: last.source_line_id! };
    }
    if (raw.length !== expected) return "mismatch";
    return raw.map(toLine);
  });
}
