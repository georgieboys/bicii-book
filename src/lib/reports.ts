/**
 * The Today dashboard's and the financial reports' shapes and wording
 * (SPEC §19.1, §22; PLAN D30 FIN-ACCESS, D31 TODAY-TILES, D32 RECOGNITION,
 * D33 SIGNIFICANT-ADJ, D34 EXCEPTIONS, D35 SHOP-TZ). Pure and client-safe:
 * the server-only reads are in src/lib/domain/reports.ts, which maps the
 * RPC rows onto these DTOs.
 *
 * Money: every amount here was computed by Postgres and arrives as a
 * fixed-2 string with its currency. Nothing in this module adds, subtracts
 * or multiplies money; it formats, compares and words what it is given. A
 * figure the database withheld (D30) is null, and the UI says it is hidden
 * rather than deriving it.
 *
 * Phase 9 adds its period-report exports beside these without changing
 * them; each export here is self-contained.
 */
import { formatRate } from "@/lib/cult-commons";
import type { Database } from "@/lib/database.types";
import { hrefForRecord, isShortId } from "@/lib/ids";
import { issueSentence } from "@/lib/reconciliation";
import { formatMoney, toDecimal, toMoneyString } from "@/lib/money";
import {
  DEFAULT_BOARD_FILTERS,
  OVERDUE_AFTER_DAYS,
  boardQuery,
  type BoardFilters,
  type StatusTone,
  type WorkOrderStatus,
} from "@/lib/workshop";
import { shiftShopDay } from "@/lib/dates";

// ---------------------------------------------------------------------------
// Today (public.today_dashboard)
// ---------------------------------------------------------------------------

type Nullable<T> = { [K in keyof T]: T[K] | null };

/**
 * One public.today_dashboard row as PostgREST returns it. The generated
 * types call every column non-null; in fact the money columns are NULL
 * without view_financial_reports / view_costs (D30), the snapshot is NULL
 * on past days (D31) and the Phase 2/6 placeholders are NULL until those
 * phases fill them, so every column is read as nullable.
 */
export type TodayDashboardRow = Nullable<
  Database["public"]["Functions"]["today_dashboard"]["Returns"][number]
>;

export type TodayDashboard = {
  /** The shop day shown ("YYYY-MM-DD"), as the database decided it (D35). */
  day: string;
  /** Whether `day` is the shop's today (the database's answer). */
  isToday: boolean;
  /** When the database answered (ISO timestamp). */
  generatedAt: string;
  /** Flows: jobs whose CURRENT stamp falls on `day` (D31). */
  workshop: {
    checkedIn: number;
    started: number;
    completed: number;
    readyForCollection: number;
    collected: number;
    cancelled: number;
  };
  /** The current snapshot (D31), grouped as BOARD_GROUPS; null on a past day. */
  now: null | {
    received: number;
    waiting: number;
    readyToStart: number;
    inProgress: number;
    awaitingCollection: number;
    open: number;
    overdue: number;
    lowStock: number;
    exceptions: number;
  };
  /** Null while Phase 2 has not filled the appointment columns. */
  appointments: null | { scheduled: number; arrived: number; noShow: number };
  /** Null without view_financial_reports (D30). */
  money: null | {
    currency: string;
    grossSales: string;
    linesRecognised: number;
    /** Recognised lines with no cost entered (D14): the cost side is provisional while > 0. */
    costPendingLines: number;
    /** Documents with a consigned line recognised that day, and their sale totals (Phase 6). */
    consignmentSales: { count: number; total: string };
    /** Null without view_costs (D30). */
    costs: null | {
      cogs: string;
      yield: string;
      cultCommons: string;
      biciiAfterCc: string;
      /** ≤ 0: the sum of the loss-making lines' yields. */
      lossTotal: string;
      lossLines: number;
      /** What that day's consigned lines owe their consignors (D46; view_costs, D30). */
      newConsignorLiability: string;
    };
  };
  stock: {
    partsConsumedQty: number;
    partsConsumedLines: number;
    partsReturnedQty: number;
    adjustments: number;
    significantAdjustments: number;
  };
};

const int = (v: number | null | undefined): number => v ?? 0;

/** A database amount as a fixed-2 string in `currency`; null stays null. */
function amount(v: number | string | null | undefined, currency: string): string | null {
  return v === null || v === undefined ? null : toMoneyString(v, currency);
}

/** The Today DTO from one today_dashboard row. */
export function toTodayDashboard(row: TodayDashboardRow): TodayDashboard {
  if (!row.day) throw new RangeError("today_dashboard returned no day");
  const isToday = row.is_today === true;
  const currency = row.currency ?? "SGD";
  const fin = row.can_see_financials === true;
  const costs = fin && row.can_see_costs === true;
  const appointmentsTracked =
    row.appointments_scheduled !== null ||
    row.appointments_arrived !== null ||
    row.appointments_no_show !== null;
  return {
    day: row.day,
    isToday,
    generatedAt: row.generated_at ?? new Date().toISOString(),
    workshop: {
      checkedIn: int(row.jobs_checked_in),
      started: int(row.jobs_started),
      completed: int(row.jobs_completed),
      readyForCollection: int(row.jobs_ready_for_collection),
      collected: int(row.jobs_collected),
      cancelled: int(row.jobs_cancelled),
    },
    now:
      isToday && row.received_now !== null
        ? {
            received: int(row.received_now),
            waiting: int(row.waiting_now),
            readyToStart: int(row.ready_to_start_now),
            inProgress: int(row.in_progress_now),
            awaitingCollection: int(row.awaiting_collection_now),
            open: int(row.open_jobs_now),
            overdue: int(row.overdue_now),
            lowStock: int(row.low_stock_now),
            exceptions: int(row.exceptions_now),
          }
        : null,
    appointments: appointmentsTracked
      ? {
          scheduled: int(row.appointments_scheduled),
          arrived: int(row.appointments_arrived),
          noShow: int(row.appointments_no_show),
        }
      : null,
    money:
      fin && row.gross_sales !== null
        ? {
            currency,
            grossSales: amount(row.gross_sales, currency)!,
            linesRecognised: int(row.lines_recognised),
            costPendingLines: int(row.cost_pending_lines),
            consignmentSales: {
              count: int(row.consignment_sales),
              total: amount(row.consignment_sales_total ?? 0, currency)!,
            },
            costs:
              costs && row.cogs !== null
                ? {
                    cogs: amount(row.cogs, currency)!,
                    yield: amount(row.yield_total ?? 0, currency)!,
                    cultCommons: amount(row.cult_commons_share ?? 0, currency)!,
                    biciiAfterCc: amount(row.bicii_yield_after_cc ?? 0, currency)!,
                    lossTotal: amount(row.loss_total ?? 0, currency)!,
                    lossLines: int(row.loss_lines),
                    newConsignorLiability: amount(row.new_consignor_liability ?? 0, currency)!,
                  }
                : null,
          }
        : null,
    stock: {
      partsConsumedQty: int(row.parts_consumed_qty),
      partsConsumedLines: int(row.parts_consumed_lines),
      partsReturnedQty: int(row.parts_returned_qty),
      adjustments: int(row.stock_adjustments),
      significantAdjustments: int(row.significant_stock_adjustments),
    },
  };
}

/**
 * What a tile says (to screen readers, beside a visible "—") for a measure
 * a later phase has not started tracking. StatTile's `notTracked` renders
 * exactly this, so the wording has one source.
 */
export const NOT_TRACKED = "Not tracked yet";

// ---------------------------------------------------------------------------
// Money wording
// ---------------------------------------------------------------------------

/** A real minus sign (U+2212), so a negative amount reads as one. */
const MINUS = "−";

/** formatMoney with a real minus sign: "−$15.00". */
export function formatSignedMoney(value: string, currency: string): string {
  return formatMoney(value, currency).replace("-", MINUS);
}

/** The loss note shared by Today and the job yield panel (D1): null when no line lost money. */
export function lossNote(lossLines: number, lossTotal: string, currency: string): string | null {
  if (lossLines <= 0) return null;
  const lines = lossLines === 1 ? "1 line" : `${lossLines} lines`;
  return `${lines} sold at a loss: ${formatSignedMoney(lossTotal, currency)}. Losses don't reduce Cult Commons on other lines.`;
}

/** Today's provisional note (D14): null when every recognised line has a cost. */
export function provisionalNote(costPendingLines: number): string | null {
  if (costPendingLines <= 0) return null;
  return costPendingLines === 1
    ? "Provisional: 1 line has no cost entered, so cost, yield and Cult Commons count it at 0."
    : `Provisional: ${costPendingLines} lines have no cost entered, so cost, yield and Cult Commons count them at 0.`;
}

/**
 * The Cult Commons rates a job's lines snapshotted (fractions), as a label:
 * "30%", or "25–30%" when lines carry different rates; null for none.
 */
export function formatRateRange(rates: readonly string[]): string | null {
  if (rates.length === 0) return null;
  const sorted = [...rates].sort((a, b) => toDecimal(a).comparedTo(toDecimal(b)));
  const low = formatRate(sorted[0]);
  const high = formatRate(sorted[sorted.length - 1]);
  return low === high ? low : `${low.replace(/%$/, "")}–${high}`;
}

// ---------------------------------------------------------------------------
// Daily summaries (public.daily_summary) and the week strip
// ---------------------------------------------------------------------------

export type DailySummary = {
  day: string;
  jobsCheckedIn: number;
  jobsStarted: number;
  jobsCompleted: number;
  jobsReadyForCollection: number;
  jobsCollected: number;
  jobsCancelled: number;
  /** Null without view_financial_reports (as every money field below). */
  currency: string | null;
  linesRecognised: number | null;
  grossSales: string | null;
  /** Null without view_costs (as yield, Cult Commons, after CC and losses). */
  cogs: string | null;
  yield: string | null;
  cultCommons: string | null;
  biciiAfterCc: string | null;
  lossLines: number | null;
  lossTotal: string | null;
  partsConsumedQty: number;
  stockAdjustments: number;
  significantAdjustments: number;
};

/** One entry of the week strip: the day and its summary (null if the database returned none). */
export type WeekStripDay = { day: string; summary: DailySummary | null };

/**
 * Exactly the 7 shop days ending at `endDay`, oldest first, each with its
 * summary. Quiet days are kept (a zero row is a real answer); a day the
 * database did not return at all has a null summary.
 */
export function weekStrip(rows: readonly DailySummary[], endDay: string): WeekStripDay[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: 7 }, (_, i) => {
    const day = shiftShopDay(endDay, i - 6);
    return { day, summary: byDay.get(day) ?? null };
  });
}

// ---------------------------------------------------------------------------
// The snapshot tiles' links to the workshop board (D31; P3's BOARD_GROUPS)
// ---------------------------------------------------------------------------

export type SnapshotTile =
  "received" | "waiting" | "ready_to_start" | "in_progress" | "awaiting_collection" | "overdue";

/** The board filters each snapshot tile opens (a group, statuses or the overdue age filter). */
export const TILE_BOARD_FILTERS: Readonly<Record<SnapshotTile, Partial<BoardFilters>>> = {
  received: { group: "received" },
  waiting: { group: "waiting" },
  ready_to_start: { group: "ready" },
  in_progress: { group: "in_progress" },
  awaiting_collection: { statuses: ["completed", "ready_for_collection"] },
  overdue: { age: "overdue" },
};

/** Snapshot tile → the P3 board URL showing the same jobs. */
export const TILE_LINKS: Readonly<Record<SnapshotTile, string>> = Object.fromEntries(
  (Object.keys(TILE_BOARD_FILTERS) as SnapshotTile[]).map((tile) => [
    tile,
    `/jobs${boardQuery(DEFAULT_BOARD_FILTERS, TILE_BOARD_FILTERS[tile])}`,
  ]),
) as Record<SnapshotTile, string>;

// ---------------------------------------------------------------------------
// Activity, adjustments, low stock
// ---------------------------------------------------------------------------

/** One job behind the day's flows (public.work_order_activity_on). */
export type ActivityRow = {
  workOrderId: string;
  jobNumber: string;
  status: WorkOrderStatus;
  customerLabel: string;
  bikeTitle: string;
  leadName: string | null;
  /** Which of the job's current stamps fall on the day. */
  on: {
    checkedIn: boolean;
    started: boolean;
    completed: boolean;
    readyForCollection: boolean;
    collected: boolean;
    cancelled: boolean;
  };
  isOpen: boolean;
  isOverdue: boolean;
  ageDays: number;
  /** The live lines' sale total (sale only: every staff member sees it). */
  saleTotal: string;
  currency: string;
};

export type ActivityFlow = keyof ActivityRow["on"];

/** The Activity lists, in order, with the anchors the flow tiles link to. */
export const ACTIVITY_FLOWS: readonly { flow: ActivityFlow; label: string; anchor: string }[] = [
  { flow: "checkedIn", label: "Checked in", anchor: "activity-checked-in" },
  { flow: "started", label: "Started", anchor: "activity-started" },
  { flow: "completed", label: "Completed", anchor: "activity-completed" },
  { flow: "readyForCollection", label: "Ready for collection", anchor: "activity-ready" },
  { flow: "collected", label: "Collected", anchor: "activity-collected" },
  { flow: "cancelled", label: "Cancelled", anchor: "activity-cancelled" },
];

/** One manual stock change of the day (public.stock_adjustments_on). */
export type AdjustmentRow = {
  movementId: number;
  createdAt: string;
  movementType: string;
  productId: string;
  productShortId: string;
  productName: string;
  unitId: string | null;
  unitShortId: string | null;
  locationName: string;
  quantityDelta: number;
  reason: string | null;
  actorName: string | null;
  /** D33, shown to everyone. */
  significant: boolean;
  /** |delta| × unit cost; null without view_costs (D30). */
  valueAtCost: string | null;
  currency: string;
};

/** Adjustments listed on Today before "Show N more" (a stock count can add one per product). */
export const ADJUSTMENT_ROWS = 5;

/**
 * Today's adjustments split for display: significant ones first (D33; SPEC
 * §19.1 asks for significant adjustments), each group keeping the
 * database's newest-first order, the first `limit` shown and the rest
 * behind a disclosure.
 */
export function splitAdjustments<T extends Pick<AdjustmentRow, "significant">>(
  rows: readonly T[],
  limit: number = ADJUSTMENT_ROWS,
): { shown: T[]; more: T[] } {
  const ordered = [...rows.filter((r) => r.significant), ...rows.filter((r) => !r.significant)];
  return { shown: ordered.slice(0, limit), more: ordered.slice(limit) };
}

/** A product at or below its reorder point, or below zero (P4's reporting.low_stock). */
export type LowStockItem = {
  productId: string;
  shortId: string;
  name: string;
  sku: string | null;
  onHand: number;
  reorderPoint: number | null;
  negativeLocations: number;
  shortfall: number;
};

// ---------------------------------------------------------------------------
// Operational exceptions (D34)
// ---------------------------------------------------------------------------

export type OperationalException = {
  /** Text: later phases add kinds; unknown ones still render. */
  kind: string;
  severity: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  subjectLabel: string | null;
  days: number | null;
  quantity: number | null;
  since: string | null;
  /*
   * Phase 9 (D106-D108) appends six columns to public.operational_exceptions.
   * Optional here so a Phase 5 row (and its tests) still type-checks; the
   * mapper (src/lib/domain/reports.ts) always fills them.
   */
  /** The specific issue code (reconciliation codes, or the kind itself). */
  issue?: string | null;
  /** The record's short ID (J-, P-, U-, C-, S-). */
  shortId?: string | null;
  /** A one-line title ("C-000012 · consignor" for consignments; the short ID otherwise). */
  title?: string | null;
  /** The database's own explanation with the specifics. */
  detail?: string | null;
  /** unsettled_consignment's outstanding amount, a fixed-2 string from Postgres; null otherwise. */
  amount?: string | null;
  currency?: string | null;
};

const days = (n: number | null) => (n === 1 ? "1 day" : `${n ?? 0} days`);

/** The tone for an exception: danger stays danger, anything else is a warning. */
function exceptionTone(severity: string): StatusTone {
  return severity === "danger" ? "danger" : "waiting";
}

const EXCEPTION_LABELS: Readonly<Record<string, string>> = {
  overdue_job: "Overdue",
  uncollected_job: "Not collected",
  negative_stock: "Below zero",
  unit_hold_stale: "Stale hold",
  // Phase 9 (D106, D107).
  unit_state_mismatch: "Impossible state",
  unsettled_consignment: "Unsettled consignment",
  currency_mismatch: "Other currency",
  integration_failed: "Shopify needs attention",
  // Phase 14 (D159b): customer payments (admins and managers) and Stripe deliveries (admins).
  payment_attention: "Customer payment",
  stripe_attention: "Stripe needs attention",
};

/** The pill text for an exception kind ("Needs attention" for kinds this build does not know). */
export function exceptionLabel(kind: string): string {
  return EXCEPTION_LABELS[kind] ?? "Needs attention";
}

/** What an exception means, in a sentence, with its tone. Unknown kinds never throw. */
export function exceptionCopy(
  kind: string,
  row: Pick<
    OperationalException,
    "severity" | "entityLabel" | "subjectLabel" | "days" | "quantity"
  > &
    Partial<Pick<OperationalException, "issue" | "amount" | "currency">>,
): { text: string; tone: StatusTone } {
  const tone = exceptionTone(row.severity);
  switch (kind) {
    case "overdue_job":
      // Overdue is danger everywhere (DESIGN tones; the Overdue tile and
      // badges): the view's 'warning' severity only orders it after danger.
      return {
        text: `Open ${days(row.days)} — over the ${OVERDUE_AFTER_DAYS}-day limit`,
        tone: "danger",
      };
    case "uncollected_job":
      return { text: `Waiting for collection ${days(row.days)}`, tone };
    case "negative_stock": {
      const location = (row.subjectLabel ?? "").split(" · ").at(-1) || "a location";
      const q = row.quantity ?? 0;
      return {
        text: `Below zero at ${location}: ${q < 0 ? `${MINUS}${Math.abs(q)}` : q}`,
        tone: "danger",
      };
    }
    case "unit_hold_stale":
      return {
        text: `Held for a customer, but no open job uses it (${days(row.days)})`,
        tone,
      };
    case "unit_state_mismatch":
      // Phase 9 (D106): the reconciliation issue in words.
      return {
        text: issueSentence(row.issue) ?? "The records and the stock ledger disagree",
        tone: "danger",
      };
    case "unsettled_consignment": {
      // Phase 9 (D107): the amount is the database's outstanding figure.
      const to = (row.subjectLabel ?? "").split(" · ")[0];
      if (row.amount === null || row.amount === undefined) {
        return { text: issueSentence("unsettled_consignment", row.days)!, tone };
      }
      return {
        text: `Sold ${days(row.days)} ago; ${formatMoney(row.amount, row.currency ?? undefined)} outstanding${to ? ` to ${to}` : ""}`,
        tone,
      };
    }
    case "currency_mismatch":
      return {
        text: "A line in another currency is left out of the totals",
        tone,
      };
    case "integration_failed":
      // Phase 10 (D86, admins only): the human message is the row's subject
      // line; the fix happens in the Shopify queue.
      return { text: "Fix it in the Shopify queue", tone: "danger" };
    case "payment_attention":
      // Phase 14 (D159b): the sentence public.payment_issues computed, the
      // same words the job's Customer payments card shows.
      return {
        text: row.subjectLabel ?? "Check the job's customer payments",
        tone: exceptionTone(row.severity),
      };
    case "stripe_attention":
      // Phase 14 (D86, D159b, admins only): a delivery BICII could not apply or store.
      return {
        text: row.subjectLabel ?? "Check Stripe deliveries in Settings → Customer payments",
        tone: "danger",
      };
    default: {
      const what = [row.entityLabel, row.subjectLabel].filter(Boolean).join(" · ");
      return { text: what ? `Check ${what}` : "Something needs checking", tone };
    }
  }
}

/**
 * A React key per exception row. The view gives one negative_stock row per
 * product and location under the same product id, so the subject (which
 * carries the location's unique name) is part of the key; a repeat that is
 * still identical gets an occurrence suffix, so keys never collide.
 */
export function exceptionKeys(
  rows: readonly Pick<OperationalException, "kind" | "entityType" | "entityId" | "subjectLabel">[],
): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.kind}:${r.entityType}:${r.entityId}:${r.subjectLabel ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** The note under a capped exception list: null when every exception is listed. */
export function exceptionsShownNote(shown: number, total: number): string | null {
  if (total <= shown) return null;
  return `Showing the ${shown} most urgent of ${total}`;
}

/** Where an exception's row opens; null when this build has no page for it. */
export function exceptionHref(
  row: Pick<OperationalException, "entityType" | "entityId" | "entityLabel">,
): string | null {
  switch (row.entityType) {
    case "work_order":
      return hrefForRecord("work_order", row.entityId);
    case "product":
      return hrefForRecord("product", row.entityId);
    case "inventory_unit":
      return hrefForRecord("inventory_unit", row.entityId);
    // Phase 9: unsettled consignments (D107) and sale lines in another currency (D104).
    case "consignment_item":
      return hrefForRecord("consignment_item", row.entityId);
    case "sale":
      return hrefForRecord("sale", row.entityId);
    case "work_order_line":
      // The row names the line's job by its J- number; /q opens it.
      return row.entityLabel && isShortId(row.entityLabel) ? `/q/${row.entityLabel}` : null;
    case "integration_job":
      // Phase 10: the queue with that job's sheet open (admins only, D86).
      return `/shopify/queue?job=${encodeURIComponent(row.entityId)}`;
    case "stripe_event":
      // Phase 14: a Stripe delivery with no job, listed in Settings (admins only, D86).
      return "/settings/payments#deliveries";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Financial entries (public.financial_lines) and the job yield panel
// ---------------------------------------------------------------------------

/** One recognised entry (D32). Cost-derived fields are null without view_costs (D30). */
export type FinancialEntry = {
  entryKey: string;
  source: string;
  /** The job (work_orders.id) for a workshop line. */
  documentId: string;
  /** J- number (S- for Phase 6 sales). */
  documentNumber: string;
  channel: string;
  recognizedAt: string;
  lineType: string | null;
  description: string;
  quantity: string;
  unitSalePrice: string;
  saleTotal: string;
  costTotal: string | null;
  yield: string | null;
  cultCommons: string | null;
  /** Fraction ("0.3000"). */
  ccRate: string | null;
  isLoss: boolean | null;
  costPending: boolean;
  currency: string;
};

/** Entries grouped by their document (job), in the order they arrive. */
export function groupEntries(
  entries: readonly FinancialEntry[],
): { documentId: string; documentNumber: string; source: string; entries: FinancialEntry[] }[] {
  const groups = new Map<
    string,
    { documentId: string; documentNumber: string; source: string; entries: FinancialEntry[] }
  >();
  for (const e of entries) {
    const key = `${e.source}:${e.documentId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        documentId: e.documentId,
        documentNumber: e.documentNumber,
        source: e.source,
        entries: [],
      };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** Where an entry's document opens (a workshop line: its job; a sale line: its sale). */
export function documentHref(entry: Pick<FinancialEntry, "source" | "documentId">): string | null {
  if (entry.source === "work_order") return hrefForRecord("work_order", entry.documentId);
  if (entry.source === "sale") return hrefForRecord("sale", entry.documentId);
  return null;
}

/** One job's economics from public.work_order_yield (view_costs only). */
export type WorkOrderYield = {
  workOrderId: string;
  jobNumber: string;
  status: WorkOrderStatus;
  currency: string;
  lineCount: number;
  saleTotal: string;
  costTotal: string;
  yieldTotal: string;
  cultCommons: string;
  biciiAfterCc: string;
  lossLineCount: number;
  lossTotal: string;
  /** The distinct Cult Commons rates the live lines snapshotted, as fractions ("0.3000"), ascending. */
  ccRates: string[];
  /** The job's current completed_at (D32); null while open, cancelled or reopened. */
  recognizedAt: string | null;
  recognizedDay: string | null;
  costPendingCount: number;
};
