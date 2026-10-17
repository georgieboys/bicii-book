/**
 * The CSV exports of the period reports (Phase 9; SPEC §19.2 "exportable",
 * §22; ADR-001 A7; PLAN D30, D100–D105): which kinds exist, the permission
 * each needs and the columns each writes. Pure: the Route Handler
 * (src/app/(staff)/reports/export/route.ts) authorizes the caller with this
 * table and fetches the rows with src/lib/domain/report-exports.ts, whose
 * fetcher table is typed against EXPORT_KINDS, so adding a kind is one
 * entry here and one fetcher there.
 *
 * Phase 9 step 4 adds three snapshot kinds for any active staff member:
 * `exceptions` (D108 filters the rows per caller in the database), and the
 * stock reconciliation's `stock` and `units` (D106; `all=1` and
 * `product=<uuid>` as on the screen). None has a cost column.
 *
 * Phase 14 step 3 (D154) adds the Customer payments kinds, both for View
 * financial reports and with no cost column: `payments` (the period's
 * movements, newest first; not driven by the date basis, so its file is
 * named by the range only) and `payments_held` (a snapshot of the money
 * held on jobs now, D154c). Neither writes a total row: the summary's
 * figures are on the screen, and the held lists have no grand total.
 *
 * Cost-gated columns (`costs: true`, D30) are OMITTED from the header and
 * the rows when the caller lacks view_costs: the database already returns
 * NULL for them, and an empty column would read like a figure of nothing.
 */
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permissions";
import type { CsvColumn } from "@/lib/csv";
import type {
  BreakdownRow,
  MechanicActivity,
  PeriodSummary,
  ReportLine,
  ReportParams,
  SeriesBucket,
  StockValueRow,
} from "@/lib/period-reports";
import type { HeldJob, PaymentItem } from "@/lib/payment-reports";
import type { StockReconciliationRow, UnitReconciliationRow } from "@/lib/reconciliation";
import type { OperationalException } from "@/lib/reports";

/** A CSV column, marked when it is cost-derived (view_costs, D30). */
export type ExportColumn<T> = CsvColumn<T> & { costs?: true };

/** A breakdown CSV row: a group, or the TOTAL row taken from report_period_summary. */
export type BreakdownCsvRow = Pick<
  BreakdownRow,
  | "key"
  | "label"
  | "detail"
  | "lineCount"
  | "jobCount"
  | "saleCount"
  | "quantity"
  | "saleTotal"
  | "costTotal"
  | "yieldTotal"
  | "cultCommons"
  | "afterCc"
  | "currency"
> & { dimension: string };

/** The rows each kind writes. */
export type ExportRows = {
  series: SeriesBucket;
  breakdown: BreakdownCsvRow;
  lines: ReportLine;
  stock_value: StockValueRow;
  mechanics: MechanicActivity;
  // Phase 9 step 4: snapshots of now, for any active staff member.
  exceptions: OperationalException;
  stock: StockReconciliationRow;
  units: UnitReconciliationRow;
  // Phase 14 step 3 (D154): customer money, View financial reports.
  payments: PaymentItem;
  payments_held: HeldJob;
};

export type ExportKind = keyof ExportRows;

export const EXPORT_KIND_VALUES = [
  "series",
  "breakdown",
  "lines",
  "stock_value",
  "mechanics",
  "exceptions",
  "stock",
  "units",
  "payments",
  "payments_held",
] as const satisfies readonly ExportKind[];

/**
 * Kinds that are a snapshot of now, whatever period the URL carries: their
 * file is named by the day of the export, not by a period and basis.
 */
export const SNAPSHOT_KINDS: ReadonlySet<ExportKind> = new Set([
  "exceptions",
  "stock",
  "units",
  "payments_held",
]);

/**
 * Period kinds the date basis does not drive (D154a): their file is named
 * by the range only, `bicii-<kind>-<from>_<to>.csv`.
 */
export const BASIS_FREE_KINDS: ReadonlySet<ExportKind> = new Set(["payments"]);

export const exportKindSchema = z.enum(EXPORT_KIND_VALUES);

const text = <T>(header: string, value: CsvColumn<T>["value"]): ExportColumn<T> => ({
  header,
  kind: "text",
  value,
});
const int = <T>(header: string, value: CsvColumn<T>["value"]): ExportColumn<T> => ({
  header,
  kind: "integer",
  value,
});
const money = <T>(header: string, value: CsvColumn<T>["value"]): ExportColumn<T> => ({
  header,
  kind: "money",
  value,
});
const costMoney = <T>(header: string, value: CsvColumn<T>["value"]): ExportColumn<T> => ({
  header,
  kind: "money",
  value,
  costs: true,
});

/**
 * Each kind: the permission it needs (null: any active staff member), its
 * columns in order, and a name for the export link's label.
 */
export const EXPORT_KINDS: {
  readonly [K in ExportKind]: {
    permission: PermissionKey | null;
    title: string;
    columns: readonly ExportColumn<ExportRows[K]>[];
  };
} = {
  series: {
    permission: "view_financial_reports",
    title: "the period by bucket",
    columns: [
      { header: "bucket_start", kind: "date", value: (r) => r.start },
      { header: "bucket_end", kind: "date", value: (r) => r.end },
      { header: "partial", kind: "boolean", value: (r) => r.partial },
      int("lines", (r) => r.lineCount),
      int("jobs", (r) => r.jobCount),
      int("sales", (r) => r.saleCount),
      money("gross", (r) => r.saleTotal),
      costMoney("cost", (r) => r.costTotal),
      costMoney("yield", (r) => r.yieldTotal),
      costMoney("cult_commons", (r) => r.cultCommons),
      costMoney("after_cc", (r) => r.afterCc),
      money("refunds", (r) => r.refundsTotal),
      int("consignment_sales", (r) => r.consignmentSales),
      money("consignment_sales_total", (r) => r.consignmentSalesTotal),
      costMoney("new_consignor_liability", (r) => r.newConsignorLiability),
      costMoney("settlements_paid", (r) => r.settlementsPaid),
      text("currency", (r) => r.currency),
    ],
  },
  breakdown: {
    permission: "view_financial_reports",
    title: "the breakdown",
    columns: [
      text("dimension", (r) => r.dimension),
      text("key", (r) => r.key),
      text("name", (r) => r.label),
      text("detail", (r) => r.detail),
      int("lines", (r) => r.lineCount),
      int("jobs", (r) => r.jobCount),
      int("sales", (r) => r.saleCount),
      { header: "quantity", kind: "decimal", value: (r) => r.quantity },
      money("gross", (r) => r.saleTotal),
      costMoney("cost", (r) => r.costTotal),
      costMoney("yield", (r) => r.yieldTotal),
      costMoney("cult_commons", (r) => r.cultCommons),
      costMoney("after_cc", (r) => r.afterCc),
      text("currency", (r) => r.currency),
    ],
  },
  lines: {
    permission: "view_financial_reports",
    title: "the lines",
    columns: [
      { header: "date", kind: "datetime", value: (r) => r.basisAt },
      text("channel", (r) => r.channel),
      text("document_number", (r) => r.documentNumber),
      text("type", (r) => r.lineType),
      text("description", (r) => r.description),
      { header: "quantity", kind: "decimal", value: (r) => r.quantity },
      money("unit_price", (r) => r.unitSalePrice),
      money("gross", (r) => r.saleTotal),
      costMoney("cost", (r) => r.costTotal),
      costMoney("yield", (r) => r.yieldTotal),
      costMoney("cult_commons", (r) => r.cultCommons),
      { header: "cost_pending", kind: "boolean", value: (r) => r.costPending },
      text("ownership", (r) => r.ownershipType),
      text("category", (r) => r.categoryName),
      text("mechanic", (r) => r.mechanicName),
      text("currency", (r) => r.currency),
    ],
  },
  stock_value: {
    permission: "view_financial_reports",
    title: "stock at cost now",
    columns: [
      text("ownership", (r) => r.ownership),
      int("quantity_on_hand", (r) => r.quantityOnHand),
      int("units_in_stock", (r) => r.unitsInStock),
      int("uncosted_items", (r) => r.uncostedItems),
      costMoney("value_at_cost", (r) => r.valueAtCost),
      text("currency", (r) => r.currency),
    ],
  },
  mechanics: {
    permission: null,
    title: "jobs by mechanic",
    columns: [
      text("name", (r) => r.name),
      { header: "active", kind: "boolean", value: (r) => r.active },
      int("checked_in", (r) => r.checkedIn),
      int("completed", (r) => r.completed),
      int("collected", (r) => r.collected),
      int("open_now", (r) => r.openNow),
    ],
  },
  // The caller's exceptions (public.operational_exceptions already applies
  // D108's per-kind visibility, so the rows are what the screen shows).
  exceptions: {
    permission: null,
    title: "exceptions",
    columns: [
      text("kind", (r) => r.kind),
      text("severity", (r) => r.severity),
      text("issue", (r) => r.issue),
      text("short_id", (r) => r.shortId ?? r.entityLabel),
      text("title", (r) => r.title),
      text("detail", (r) => r.detail),
      money("amount", (r) => r.amount),
      text("currency", (r) => r.currency),
      { header: "since", kind: "datetime", value: (r) => r.since },
    ],
  },
  // Stock reconciliation (D106): read-only, no cost column.
  stock: {
    permission: null,
    title: "products by location",
    columns: [
      text("product_short_id", (r) => r.productShortId),
      text("product", (r) => r.productName),
      text("tracking", (r) => r.trackingType),
      text("location", (r) => r.locationName),
      int("ledger_on_hand", (r) => r.ledgerOnHand),
      int("units_in_stock", (r) => r.unitsInStock),
      text("issue", (r) => r.issue),
    ],
  },
  units: {
    permission: null,
    title: "unique items",
    columns: [
      text("unit_short_id", (r) => r.unitShortId),
      text("product", (r) => r.productName),
      text("status", (r) => r.status),
      text("location", (r) => r.locationName),
      text("ledger_location", (r) => r.ledgerLocationName),
      int("ledger_on_hand", (r) => r.ledgerOnHand),
      int("expected_on_hand", (r) => r.expectedOnHand),
      text("disposition", (r) => r.disposition),
      text("disposition_ref", (r) => r.dispositionRef),
      text("issue", (r) => r.issue),
      text("issue_detail", (r) => r.issueDetail),
      { header: "last_movement_at", kind: "datetime", value: (r) => r.lastMovementAt },
    ],
  },
  // D154b: one row per movement, as report_payment_items lists it. The
  // amount is signed (a refund or a give-back is negative); recorded_at and
  // recorded_by are set for counter rows only, so back-dating shows.
  payments: {
    permission: "view_financial_reports",
    title: "customer payments",
    columns: [
      { header: "date", kind: "datetime", value: (r) => r.at },
      text("movement", (r) => r.movement),
      text("job_number", (r) => r.jobNumber),
      text("customer", (r) => r.customerLabel),
      text("kind", (r) => r.kind),
      text("method", (r) => r.method),
      money("amount", (r) => r.signedAmount),
      text("currency", (r) => r.currency),
      { header: "other_currency", kind: "boolean", value: (r) => r.otherCurrency },
      { header: "recorded_at", kind: "datetime", value: (r) => r.recordedAt },
      text("recorded_by", (r) => r.recordedByName),
    ],
  },
  // D154c: now, per job and group (open, awaiting_collection, above_bill),
  // from the job card's own totals; no grand total.
  payments_held: {
    permission: "view_financial_reports",
    title: "money held on jobs now",
    columns: [
      text("group", (r) => r.group),
      text("job_number", (r) => r.jobNumber),
      text("status", (r) => r.status),
      text("customer", (r) => r.customerLabel),
      money("amount", (r) => r.amount),
      money("net_paid", (r) => r.netPaid),
      money("net_paid_online", (r) => r.netPaidOnline),
      money("paid_at_counter", (r) => r.paidAtCounter),
      money("job_total", (r) => r.jobTotal),
      money("balance_due", (r) => r.balanceDue),
      money("paid_ahead", (r) => r.paidAhead),
      text("currency", (r) => r.currency),
    ],
  },
};

/** The columns `kind` writes for a caller with or without view_costs. */
export function exportColumns<K extends ExportKind>(
  kind: K,
  showCosts: boolean,
): ExportColumn<ExportRows[K]>[] {
  const columns = EXPORT_KINDS[kind].columns as readonly ExportColumn<ExportRows[K]>[];
  return columns.filter((c) => showCosts || !c.costs);
}

/** Whether a caller holding `permissions` may export `kind` (active staff is checked first). */
export function mayExport(kind: ExportKind, can: (permission: PermissionKey) => boolean): boolean {
  const needed = EXPORT_KINDS[kind].permission;
  return needed === null || can(needed);
}

/**
 * The breakdown CSV's last row: the period's totals exactly as
 * report_period_summary returned them (never a sum of the groups).
 */
export function breakdownTotalRow(summary: PeriodSummary): BreakdownCsvRow {
  return {
    dimension: "TOTAL",
    key: "",
    label: "TOTAL",
    detail: null,
    lineCount: summary.lineCount,
    jobCount: summary.jobCount,
    saleCount: summary.saleCount,
    quantity: null,
    saleTotal: summary.saleTotal,
    costTotal: summary.costTotal,
    yieldTotal: summary.yieldTotal,
    cultCommons: summary.cultCommons,
    afterCc: summary.afterCc,
    currency: summary.currency,
  };
}

/**
 * `bicii-<kind>-<basis>-<from>_<to>.csv`, `bicii-<kind>-<from>_<to>.csv`
 * for a kind the basis does not drive (BASIS_FREE_KINDS), or
 * `bicii-<kind>-<asOf>.csv` for a snapshot kind (SNAPSHOT_KINDS) given the
 * shop day of the export (safe characters only).
 */
export function exportFilename(
  kind: ExportKind,
  params: Pick<ReportParams, "basis" | "from" | "to">,
  asOf?: string,
): string {
  if (asOf && SNAPSHOT_KINDS.has(kind)) return `bicii-${kind}-${asOf}.csv`;
  if (BASIS_FREE_KINDS.has(kind)) return `bicii-${kind}-${params.from}_${params.to}.csv`;
  return `bicii-${kind}-${params.basis}-${params.from}_${params.to}.csv`;
}

/**
 * The export URL for `kind` with the report's parameters (and, for
 * `lines`, a group's `by` and `key`).
 */
export function exportHref(
  kind: ExportKind,
  params: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  const q = new URLSearchParams({ kind, ...params, ...extra });
  return `/reports/export?${q.toString()}`;
}
