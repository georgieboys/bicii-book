/**
 * Purchasing (Phase 7; SPEC §14, §21 "Suppliers, purchase orders and
 * receiving"; PLAN D60 D-PO-COSTS, D61 D-PO-CANCEL, D65 D-OVERRECEIPT):
 * labels, tones and sentences for suppliers and purchase orders. Pure: safe
 * in Client Components and unit tests. The database stays the authority:
 * reporting.purchase_order_progress decides which lines are overdue for
 * lists, the RPCs decide what may change, and purchase totals come from
 * purchase_order_totals_staff, never from arithmetic here.
 */
import type { PermissionKey, StaffDTO } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/permissions";
import { Constants, type Database } from "@/lib/database.types";
import { formatDate, shopToday, type DateInput } from "@/lib/dates";
import { formatMoney, type MoneyInput } from "@/lib/money";
import { plural } from "@/lib/plural";

export type PurchaseOrderStatus = Database["public"]["Enums"]["purchase_order_status"];
export type PurchaseOrderEventType = Database["public"]["Enums"]["purchase_order_event_type"];

/** purchase_order_lines_unit_cost_check / purchase_receipt_lines_unit_cost_actual_check. */
export const MAX_PURCHASE_UNIT_COST = "99999.99";
/** purchase_order_lines_quantity_ordered_check. */
export const MAX_PURCHASE_QUANTITY = 100_000;

export const PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] =
  Constants.public.Enums.purchase_order_status;

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  partially_received: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

/** A StatusPill tone; the pill always carries the label too (never colour alone). */
export type PurchaseOrderTone = "info" | "waiting" | "progress" | "done" | "danger";

const STATUS_TONES: Record<PurchaseOrderStatus, PurchaseOrderTone> = {
  draft: "info",
  submitted: "waiting",
  partially_received: "progress",
  received: "done",
  cancelled: "danger",
};

export function purchaseOrderStatusLabel(status: PurchaseOrderStatus): string {
  return PURCHASE_ORDER_STATUS_LABELS[status];
}

export function purchaseOrderStatusTone(status: PurchaseOrderStatus): PurchaseOrderTone {
  return STATUS_TONES[status];
}

/** Submitted or partially received: goods are still expected (on order, D66). */
export function isOpenStatus(status: PurchaseOrderStatus): boolean {
  return status === "submitted" || status === "partially_received";
}

/**
 * Draft, submitted or partially received: lines and details may still
 * change, and the order may be cancelled (D61). Received and cancelled
 * orders are closed for good (D65): extra or late units go on a new order.
 */
export function isEditableStatus(status: PurchaseOrderStatus): boolean {
  return status === "draft" || isOpenStatus(status);
}

/** The PO list's status filter (?status=). */
export const PURCHASE_ORDER_FILTERS = {
  open: { label: "Open", statuses: ["submitted", "partially_received"] },
  draft: { label: "Drafts", statuses: ["draft"] },
  closed: { label: "Closed", statuses: ["received", "cancelled"] },
  all: { label: "All", statuses: PURCHASE_ORDER_STATUSES },
} as const satisfies Record<string, { label: string; statuses: readonly PurchaseOrderStatus[] }>;

export type PurchaseOrderFilter = keyof typeof PURCHASE_ORDER_FILTERS;

export function isPurchaseOrderFilter(value: unknown): value is PurchaseOrderFilter {
  return typeof value === "string" && Object.hasOwn(PURCHASE_ORDER_FILTERS, value);
}

export type Progress = {
  ordered: number;
  received: number;
  /** Still to come (open orders; drafts count what they would order). */
  outstanding: number;
  /** Not received on a cancelled order (D61): reported, never outstanding. */
  cancelled: number;
};

const units = (n: number) => n.toLocaleString("en-SG");

/**
 * "18 of 20 received · 2 to come", "20 of 20 received",
 * "18 of 20 received · 2 cancelled" (D61). A draft has not gone to the
 * supplier, so nothing is "to come" (as reporting.product_on_order leaves
 * drafts out, D66): "15 items · not submitted".
 */
export function progressText(
  { ordered, received, outstanding, cancelled }: Progress,
  status?: PurchaseOrderStatus,
): string {
  if (status === "draft")
    return `${units(ordered)} ${ordered === 1 ? "item" : "items"} · not submitted`;
  const head = `${units(received)} of ${units(ordered)} received`;
  if (cancelled > 0) return `${head} · ${units(cancelled)} cancelled`;
  if (outstanding > 0) return `${head} · ${units(outstanding)} to come`;
  return head;
}

/**
 * Whether an expected date has passed on the shop day with units still to
 * come on a submitted or partially received order. Client display only
 * (e.g. a line's own date); lists use reporting.purchase_order_progress's
 * is_overdue, which is authoritative.
 */
export function isOverdue(
  expectedAt: string | null,
  status: PurchaseOrderStatus,
  outstanding: number,
  now: DateInput = new Date(),
): boolean {
  if (!expectedAt || !isOpenStatus(status) || outstanding <= 0) return false;
  return expectedAt < shopToday(now);
}

type PermissionHolder = Pick<StaffDTO, "role" | "active" | "permissions">;

/**
 * Mirrors private.can_view_purchase_costs (D60 D-PO-COSTS): view_costs OR
 * manage_purchasing. Purchasing surfaces only; it opens no other cost,
 * yield or financial surface.
 */
export function canSeePurchaseCosts(staff: PermissionHolder): boolean {
  return hasPermission(staff, "view_costs") || hasPermission(staff, "manage_purchasing");
}

/**
 * The product page's "Suppliers & orders" card (a Phase 4 screen, not a
 * purchasing screen): each supplier's last cost needs view_costs.
 * manage_purchasing alone shows purchase costs on purchasing screens only
 * (D60), so a buyer without view_costs sees no cost on the product page.
 */
export function canSeeProductPageSupplierCosts(staff: PermissionHolder): boolean {
  return hasPermission(staff, "view_costs");
}

/** Every supplier and PO write, and receiving. */
export function canManagePurchasing(staff: PermissionHolder): boolean {
  return hasPermission(staff, "manage_purchasing" satisfies PermissionKey);
}

/** "veloparts.test" -> "https://veloparts.test"; blank -> null; http(s) kept as typed. */
export function normaliseWebsite(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** A supplier's lead time: "1 day lead time", "5 days lead time". */
export function leadTimeText(days: number): string {
  return `${plural(days, "day", "days")} lead time`;
}

/** A shop day "YYYY-MM-DD" for people: "12 Oct 2026". */
export function formatExpected(day: string): string {
  return formatDate(`${day}T12:00:00+08:00`);
}

// ---------------------------------------------------------------------------
// History sentences
// ---------------------------------------------------------------------------

export type PurchaseOrderEventLike = {
  type: PurchaseOrderEventType;
  payload: Record<string, unknown>;
  reason: string | null;
  /** The staff member's display name; null for changes made outside the app. */
  actor: string | null;
  /** The product the line event is about, resolved by the caller. */
  productName?: string | null;
};

export type DescribeOptions = {
  /** The PO's currency (money is formatted in it, never as a hard-coded symbol). */
  currency: string;
  /** D60: false leaves every amount out of the sentence. */
  showCosts: boolean;
};

const FIELD_NAMES: Record<string, string> = {
  supplier_id: "supplier",
  expected_at: "expected date",
  supplier_reference: "supplier reference",
  notes: "notes",
  quantity_ordered: "quantity",
  unit_cost: "unit cost",
};

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : null;

const asMoney = (v: unknown): MoneyInput | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())
      ? v.trim()
      : null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One changed field for a sentence: "quantity 20 → 24", "expected date 12 Oct 2026". */
function describeChange(
  field: string,
  change: unknown,
  { currency, showCosts }: DescribeOptions,
): string | null {
  const name = FIELD_NAMES[field] ?? field.replaceAll("_", " ");
  if (field === "unit_cost" && !showCosts) return name;
  if (!isRecord(change)) return name;
  const show = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (field === "unit_cost") {
      const m = asMoney(v);
      return m === null ? null : formatMoney(m, currency);
    }
    if (field === "quantity_ordered") {
      const n = asNumber(v);
      return n === null ? null : units(n);
    }
    if (field === "expected_at" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return formatExpected(v);
    }
    return null;
  };
  if (field === "unit_cost" || field === "quantity_ordered" || field === "expected_at") {
    const from = show(change.from);
    const to = show(change.to);
    if (from && to) return `${name} ${from} → ${to}`;
    if (to) return `${name} to ${to}`;
    if (from && field === "expected_at") return `${name} (cleared)`;
  }
  return name;
}

/**
 * A PO history entry as a sentence with its actor, hiding every amount when
 * `showCosts` is false (D60): "Asha Admin added Road disc brake pads × 20 at
 * $12.00", "Asha Admin submitted the order", "Asha Admin received 18 items
 * (delivery note DN-5531)", "Asha Admin cancelled: Supplier out of stock".
 * Reasons other than a cancellation's are shown separately by the caller.
 */
export function describePurchaseOrderEvent(
  event: PurchaseOrderEventLike,
  options: DescribeOptions,
): string {
  const who = event.actor ?? "Someone outside the app";
  const p = event.payload ?? {};
  const product = event.productName ?? "a product";
  switch (event.type) {
    case "created":
      return `${who} created the order`;
    case "details_changed": {
      const fields = Object.keys(p).map((f) => describeChange(f, p[f], options));
      const parts = fields.filter((f): f is string => !!f);
      return parts.length > 0
        ? `${who} changed the ${joinList(parts)}`
        : `${who} changed the order details`;
    }
    case "line_added": {
      const qty = asNumber(p.quantity_ordered);
      const cost = asMoney(p.unit_cost);
      const amount =
        options.showCosts && cost !== null ? ` at ${formatMoney(cost, options.currency)}` : "";
      return `${who} added ${product}${qty !== null ? ` × ${units(qty)}` : ""}${amount}`;
    }
    case "line_changed": {
      const parts = Object.keys(p)
        .map((f) => describeChange(f, p[f], options))
        .filter((f): f is string => !!f);
      return parts.length > 0
        ? `${who} changed ${product}: ${parts.join(", ")}`
        : `${who} changed ${product}`;
    }
    case "line_removed": {
      const qty = asNumber(p.quantity_ordered);
      return `${who} removed ${product}${qty !== null ? ` × ${units(qty)}` : ""}`;
    }
    case "submitted":
      return `${who} submitted the order`;
    case "received": {
      const n = asNumber(p.units);
      const ref = typeof p.reference === "string" && p.reference ? p.reference : null;
      const what = n === null ? "a delivery" : `${units(n)} ${n === 1 ? "item" : "items"}`;
      return `${who} received ${what}${ref ? ` (delivery note ${ref})` : ""}`;
    }
    case "status_changed": {
      const to = typeof p.to === "string" ? p.to : null;
      const label =
        to && Object.hasOwn(PURCHASE_ORDER_STATUS_LABELS, to)
          ? PURCHASE_ORDER_STATUS_LABELS[to as PurchaseOrderStatus]
          : null;
      return label ? `Status changed to ${label}` : "Status changed";
    }
    case "cancelled":
      return event.reason ? `${who} cancelled: ${event.reason}` : `${who} cancelled the order`;
  }
}

/** Whether the caller should show the event's reason under the sentence (the cancellation's is in it). */
export function eventShowsReason(event: Pick<PurchaseOrderEventLike, "type" | "reason">): boolean {
  return !!event.reason && event.type !== "cancelled";
}

/** Where a PO's line cost default came from (purchase_cost_defaults), for the line sheet's hint. */
export function costSourceHint(source: string | null | undefined): string {
  switch (source) {
    case "supplier_last":
      return "Prefilled with this supplier's last cost.";
    case "product":
      return "Prefilled with the product's cost.";
    default:
      return "No earlier cost known: enter what the supplier charges.";
  }
}

// ---------------------------------------------------------------------------
// Customer jobs waiting on a purchase order line (A-21)
// ---------------------------------------------------------------------------

/** A job's indent part ordered on a purchase order line (job_part_requests). */
export type LinePartRequest = {
  id: string;
  workOrderId: string;
  lineId: string;
  status: string;
  quantity: number;
  orderedAt: string | null;
  createdAt: string;
};

/** What customer jobs still wait for on one line. */
export type LineWaiting = {
  /** The smallest quantity the line may have while they wait. */
  quantity: number;
  /** The waiting jobs, first ordered first, with how many each waits for. */
  jobs: { workOrderId: string; quantity: number }[];
};

function byQueueOrder(a: LinePartRequest, b: LinePartRequest): number {
  const at = (v: string | null) => (v === null ? Number.POSITIVE_INFINITY : Date.parse(v));
  return (
    at(a.orderedAt) - at(b.orderedAt) ||
    (a.orderedAt ?? "").localeCompare(b.orderedAt ?? "") ||
    at(a.createdAt) - at(b.createdAt) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Which jobs wait on each purchase order line for a part that has not
 * arrived: the rule of private.purchase_order_waiting_indent (and
 * part_request_arrival_rows). A line's receipts cover its ordered and fitted
 * requests first ordered first; an ordered request waits while the receipts
 * are below the running total up to it. These are the jobs cancel_purchase_order,
 * remove_purchase_order_line and a lowered quantity are refused for
 * (purchase_order_has_indent_requests), so the order page names them. The
 * database decides; this only shows it.
 */
export function waitingJobParts(
  requests: readonly LinePartRequest[],
  receivedByLine: ReadonlyMap<string, number>,
): Map<string, LineWaiting> {
  const byLine = new Map<string, LinePartRequest[]>();
  for (const r of requests) {
    if (r.status !== "ordered" && r.status !== "fitted") continue;
    byLine.set(r.lineId, [...(byLine.get(r.lineId) ?? []), r]);
  }
  const waiting = new Map<string, LineWaiting>();
  for (const [lineId, queue] of byLine) {
    const received = receivedByLine.get(lineId) ?? 0;
    const jobs = new Map<string, number>();
    let cumulative = 0;
    let quantity = 0;
    for (const r of [...queue].sort(byQueueOrder)) {
      cumulative += r.quantity;
      if (r.status !== "ordered" || received >= cumulative) continue;
      quantity = cumulative;
      jobs.set(r.workOrderId, (jobs.get(r.workOrderId) ?? 0) + r.quantity);
    }
    if (jobs.size > 0) {
      waiting.set(lineId, {
        quantity,
        jobs: [...jobs].map(([workOrderId, q]) => ({ workOrderId, quantity: q })),
      });
    }
  }
  return waiting;
}

/** "J-000101", "J-000101 and J-000102", "J-000101, J-000102 and J-000103". */
export function jobList(jobNumbers: readonly string[]): string {
  return jobNumbers.length <= 1
    ? (jobNumbers[0] ?? "")
    : `${jobNumbers.slice(0, -1).join(", ")} and ${jobNumbers[jobNumbers.length - 1]}`;
}
