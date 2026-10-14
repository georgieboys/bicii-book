/**
 * Stock reconciliation and the exceptions screen, in words (Phase 9 step 4;
 * SPEC §12, §19.1, §26; PLAN D34, D106–D108; ADR-022). Pure and
 * client-safe: the server-only reads are in src/lib/domain/reconciliation.ts.
 *
 * The database decides every issue (reporting.unit_reconciliation,
 * reporting.stock_reconciliation and reporting.operational_exceptions,
 * migrations 20261006001200 and 20261006001300). This module only names
 * them: ISSUE_CODES mirrors the codes those views emit, and
 * tests/unit/reconciliation.test.ts reads the migrations to prove the
 * mirror is exact. Reconciliation is read-only (D106): a screen links to
 * the guarded fix, never fixes anything itself.
 */
import { UNIT_STATUS_LABELS, type UnitStatus } from "@/lib/inventory";
import { isUuid } from "@/lib/uuid";

/** The unit issues of reporting.unit_reconciliation, in its order (the FIRST failing check). */
export const UNIT_ISSUE_CODES = [
  "ledger_out_of_range",
  "sale_without_sold_status",
  "sold_without_sale",
  "held_without_open_job",
  "in_stock_without_ledger",
  "ledger_without_stock_status",
  "location_mismatch",
  "consignment_status_mismatch",
] as const;

/** The product-by-location issues of reporting.stock_reconciliation, in its order. */
export const STOCK_ISSUE_CODES = [
  "negative_on_hand",
  "unique_movement_without_unit",
  "unit_count_mismatch",
] as const;

/** Every reconciliation issue code, plus the unsettled-consignment issue of the exceptions view (D107). */
export const ISSUE_CODES = [
  ...UNIT_ISSUE_CODES,
  ...STOCK_ISSUE_CODES,
  "unsettled_consignment",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** One human sentence per issue code (unsettled_consignment's carries its day count). */
export const ISSUE_SENTENCES: { readonly [K in IssueCode]: string } = {
  ledger_out_of_range:
    "The ledger puts this item in more than one place or counts it more than once.",
  sale_without_sold_status: "The ledger says this item was sold, but it is not marked as sold.",
  sold_without_sale: "Marked as sold, but the ledger has no sale or completed job for it.",
  held_without_open_job: "Held for a customer, but no open job holds it.",
  in_stock_without_ledger: "Marked as in stock, but the movement ledger says it has left.",
  ledger_without_stock_status: "The ledger says it is in stock, but it is not marked as available.",
  location_mismatch: "The item's location does not match where the ledger last moved it.",
  consignment_status_mismatch:
    "The consignment record and the item disagree about whether it was sold or returned.",
  negative_on_hand: "The ledger shows fewer than zero on hand.",
  unit_count_mismatch: "The number of items in stock here differs from the ledger.",
  unique_movement_without_unit: "A stock movement for a unique product does not name the item.",
  unsettled_consignment: "Sold N days ago and not fully paid to the consignor.",
};

export function isIssueCode(code: string | null | undefined): code is IssueCode {
  return typeof code === "string" && Object.hasOwn(ISSUE_SENTENCES, code);
}

const dayCount = (n: number) => (n === 1 ? "1 day" : `${n} days`);

/**
 * The sentence for an issue code; null for a code this build does not know
 * (a later phase's), so the caller falls back to the database's own detail.
 */
export function issueSentence(
  code: string | null | undefined,
  days: number | null = null,
): string | null {
  if (!isIssueCode(code)) return null;
  if (code === "unsettled_consignment") {
    return days === null
      ? "Sold and not fully paid to the consignor."
      : `Sold ${dayCount(days)} ago and not fully paid to the consignor.`;
  }
  return ISSUE_SENTENCES[code];
}

// ---------------------------------------------------------------------------
// Rows (public.report_stock_reconciliation, public.report_unit_reconciliation)
// ---------------------------------------------------------------------------

/** One (product, location) of report_stock_reconciliation. No cost column. */
export type StockReconciliationRow = {
  productId: string;
  productShortId: string;
  productName: string;
  trackingType: string;
  locationId: string;
  locationName: string;
  ledgerOnHand: number;
  /** Units there whose status implies on hand (unique products only; null for counted ones). */
  unitsInStock: number | null;
  issue: string | null;
  /** The product page (where Adjust stock lives). */
  href: string;
};

/** One unique item of report_unit_reconciliation. */
export type UnitReconciliationRow = {
  unitId: string;
  unitShortId: string;
  productId: string;
  productName: string;
  status: UnitStatus;
  locationId: string;
  locationName: string;
  ledgerOnHand: number;
  ledgerLocationId: string | null;
  ledgerLocationName: string | null;
  expectedOnHand: number | null;
  disposition: string;
  /** The S- or J- number behind the disposition, when there is one. */
  dispositionRef: string | null;
  issue: string | null;
  /** The database's own sentence with the specifics (status, locations, numbers). */
  issueDetail: string | null;
  lastMovementAt: string | null;
  /** The unit page. */
  href: string;
  /** The product page (where Adjust stock lives). */
  productHref: string;
};

/** What the unit's latest non-transfer movement says happened to it (D106). */
export const DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  none: "No movement",
  in_stock: "In stock",
  sold_by_sale: "Sold",
  sold_by_job: "Sold on a job",
  held_by_job: "On an open job",
  held_on_closed_job: "Used on a closed job",
  returned: "Returned to its consignor",
  written_off: "Written off",
  unexplained_out: "Taken out of stock",
};

/** "Sold · S-000012", "In stock"; an unknown disposition reads as it is. */
export function dispositionLabel(disposition: string, ref: string | null): string {
  const label = DISPOSITION_LABELS[disposition] ?? disposition;
  return ref ? `${label} · ${ref}` : label;
}

/** "Available", "On a job", … (Phase 4's labels). */
export function unitStatusLabel(status: string): string {
  return (UNIT_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status;
}

/** Rows with a problem first, as the RPC orders them; split for the two parts of a section. */
export function splitIssues<T extends { issue: string | null }>(
  rows: readonly T[],
): { issues: T[]; clear: T[] } {
  return { issues: rows.filter((r) => r.issue), clear: rows.filter((r) => !r.issue) };
}

// ---------------------------------------------------------------------------
// The screen's URL state and the exceptions page's sections
// ---------------------------------------------------------------------------

/** The most rows one reconciliation read returns (the RPCs clamp p_max_rows to 1..1000). */
export const RECONCILIATION_MAX_ROWS = 1000;

/** What public.operational_exceptions lists at most (it clamps max_rows to 1..200). */
export const EXCEPTIONS_MAX_ROWS = 200;

export type ReconciliationParams = { all: boolean; productId: string | null };

const firstOf = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v);

/** `all=1` shows every row (default: problems only); `product=<uuid>` narrows to one product. */
export function parseReconciliationParams(
  sp: Readonly<Record<string, string | string[] | undefined>>,
): ReconciliationParams {
  const product = firstOf(sp.product);
  return {
    all: firstOf(sp.all) === "1",
    productId: product && isUuid(product) ? product.toLowerCase() : null,
  };
}

/** The reconciliation URL for a state (defaults left out). */
export function reconciliationHref(params: Partial<ReconciliationParams> = {}): string {
  const q = new URLSearchParams();
  if (params.all) q.set("all", "1");
  if (params.productId) q.set("product", params.productId);
  const s = q.toString();
  return s ? `/reports/reconciliation?${s}` : "/reports/reconciliation";
}

/** The export URL parameters of a reconciliation state. */
export function reconciliationExportParams(params: ReconciliationParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (params.all) out.all = "1";
  if (params.productId) out.product = params.productId;
  return out;
}

/**
 * The sections of /reports/exceptions, in order (most serious first), each
 * with the kinds it holds. A kind not listed here (a later phase's) is
 * shown under "Other".
 */
export const EXCEPTION_SECTIONS = [
  { id: "negative", title: "Stock below zero", kinds: ["negative_stock"] },
  { id: "impossible", title: "Items in an impossible state", kinds: ["unit_state_mismatch"] },
  { id: "integration", title: "Shopify needs attention", kinds: ["integration_failed"] },
  {
    id: "payments",
    title: "Customer payments",
    kinds: ["payment_attention", "stripe_attention"],
  },
  { id: "currency", title: "Lines in another currency", kinds: ["currency_mismatch"] },
  { id: "consignment", title: "Unsettled consignments", kinds: ["unsettled_consignment"] },
  { id: "overdue", title: "Overdue jobs", kinds: ["overdue_job"] },
  { id: "uncollected", title: "Not collected", kinds: ["uncollected_job"] },
  { id: "hold", title: "Stale holds", kinds: ["unit_hold_stale"] },
] as const satisfies readonly { id: string; title: string; kinds: readonly string[] }[];

/** Groups exception rows into EXCEPTION_SECTIONS (empty sections dropped; unknown kinds last, under "Other"). */
export function groupExceptions<T extends { kind: string }>(
  rows: readonly T[],
): { id: string; title: string; rows: T[] }[] {
  const known = new Set<string>(EXCEPTION_SECTIONS.flatMap((s) => [...s.kinds]));
  const out: { id: string; title: string; rows: T[] }[] = EXCEPTION_SECTIONS.map((s) => ({
    id: s.id,
    title: s.title,
    rows: rows.filter((r) => (s.kinds as readonly string[]).includes(r.kind)),
  }));
  out.push({ id: "other", title: "Other", rows: rows.filter((r) => !known.has(r.kind)) });
  return out.filter((s) => s.rows.length > 0);
}

/** One public.report_exception_counts row. */
export type ExceptionCount = { kind: string; severity: string; count: number };

/** How many exceptions the caller may see in all (a count, never money). */
export function exceptionTotal(counts: readonly Pick<ExceptionCount, "count">[]): number {
  return counts.reduce((n, c) => n + c.count, 0);
}

/** The note when the list holds fewer exceptions than the counts: null when every one is listed. */
export function exceptionsCappedNote(listed: number, total: number): string | null {
  if (total <= listed) return null;
  return `Showing the ${listed} most urgent of ${total}. Fix these first; the rest appear as these clear.`;
}

/** "Alert unsettled consignments after 30 days". */
export function alertDaysLabel(days: number): string {
  return `Alert unsettled consignments after ${dayCount(days)}`;
}
