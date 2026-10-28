/**
 * Consignment vocabulary and previews (SPEC §13, §23; PLAN D4, D44–D47).
 * Pure, so the screens, the sheets and the unit tests share one statement
 * of the labels and the settlement arithmetic. The database stays the
 * authority: owed, paid and outstanding come from
 * reporting.consignor_item_ledger through consignor_statement and
 * list_consignors; record_settlement checks every allocation again (D47).
 * The arithmetic here is a labelled preview in Decimal, never stored.
 */
import type { Database } from "@/lib/database.types";
import { SHOP_UTC_OFFSET } from "@/lib/dates";
import { Decimal, formatMoney, parseMoney, toDecimal } from "@/lib/money";

export type ConsignmentStatus = Database["public"]["Enums"]["consignment_status"];
export type ChargeBearer = Database["public"]["Enums"]["charge_bearer"];
export type ConsignmentEventType = Database["public"]["Enums"]["consignment_item_event_type"];

/** StatusPill / Badge tones (src/components/ui/badge.tsx). */
export type ConsignmentTone = "neutral" | "waiting" | "progress" | "done" | "danger" | "info";

export type Pill = { label: string; tone: ConsignmentTone };

const isNegative = (v: string) => toDecimal(v).isNegative() && !toDecimal(v).isZero();
const isPositive = (v: string) => toDecimal(v).greaterThan(0);

/**
 * An item's status as staff read it. A sold item says whether the
 * consignor has been paid only to staff who may see consignment money
 * (D48): `outstanding` is null for everyone else, and the pill then says
 * "Sold" alone.
 *
 *   active   info     For sale
 *   sold     waiting  Sold, awaiting payment   (outstanding > 0)
 *            done     Settled                  (outstanding = 0)
 *            info     Overpaid                 (outstanding < 0, D46)
 *            done     Sold                     (outstanding hidden)
 *   returned neutral  Returned
 *   withdrawn neutral Withdrawn (reserved; never written in Phase 6)
 */
export function consignmentStatusPill(status: ConsignmentStatus, outstanding: string | null): Pill {
  switch (status) {
    case "active":
      return { label: "For sale", tone: "info" };
    case "sold":
      if (outstanding === null) return { label: "Sold", tone: "done" };
      if (isPositive(outstanding)) return { label: "Sold, awaiting payment", tone: "waiting" };
      if (isNegative(outstanding)) return { label: "Overpaid", tone: "info" };
      return { label: "Settled", tone: "done" };
    case "returned":
      return { label: "Returned", tone: "neutral" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "neutral" };
  }
}

/** The Items tab's status filter (`?status=`). */
export const ITEM_STATUS_FILTERS = [
  { key: "active", label: "For sale" },
  { key: "sold", label: "Sold" },
  { key: "returned", label: "Returned" },
  { key: "all", label: "All" },
] as const;
export type ItemStatusFilter = (typeof ITEM_STATUS_FILTERS)[number]["key"];

export function readItemStatusFilter(value: unknown): ItemStatusFilter {
  return ITEM_STATUS_FILTERS.some((f) => f.key === value) ? (value as ItemStatusFilter) : "active";
}

// ---------------------------------------------------------------------------
// Charges (D4: every charge has an explicit bearer, no default)
// ---------------------------------------------------------------------------

export const CHARGE_BEARER_LABELS: Record<ChargeBearer, string> = {
  consignor: "Consignor pays",
  shop: "Shop pays",
};

/** What each bearer means, one line each (the charge sheet's options). */
export const CHARGE_BEARER_EXPLANATIONS: Record<ChargeBearer, string> = {
  consignor: "Consignor pays: deducted from what we owe them",
  shop: "Shop pays: added to the cost of the sale, so it lowers yield",
};

export function chargeBearerLabel(bearer: ChargeBearer): string {
  return CHARGE_BEARER_LABELS[bearer];
}

/** D50: what replaces the adjust, write-off and split controls on consigned stock. */
export const CONSIGNED_STOCK_NOTE =
  "Consigned stock changes through sale, restock, a job or return to the consignor.";

/** D45: shop-borne charges exist only on unique items. */
export const SHOP_CHARGE_UNIQUE_ONLY =
  "Shop-paid charges go on a single item only: a quantity consignment has no one unit to add the cost to.";

// ---------------------------------------------------------------------------
// Balances (D46: never "credit")
// ---------------------------------------------------------------------------

/** What has been owed and paid so far, to tell "Settled" from "nothing yet". */
export type BalanceHistory = { owed: string | null; paid: string | null };

const isZeroOrNull = (v: string | null) => v === null || toDecimal(v).isZero();

/** Nothing has ever been owed or paid: no payment cycle has started. */
function nothingYet(outstanding: string, history?: BalanceHistory): boolean {
  return (
    history !== undefined &&
    toDecimal(outstanding).isZero() &&
    isZeroOrNull(history.owed) &&
    isZeroOrNull(history.paid)
  );
}

/**
 * What a consignor's (or an item's) outstanding means in words:
 * "$300.00 owed", "Settled" (paid what was owed), "Nothing owed yet"
 * (nothing owed and nothing paid, when `history` is given) or "Overpaid
 * $40.00 (consignor owes the shop)". A negative outstanding is never a
 * credit (D46).
 */
export function outstandingLabel(
  outstanding: string,
  currency = "SGD",
  history?: BalanceHistory,
): string {
  if (isPositive(outstanding)) return `${formatMoney(outstanding, currency)} owed`;
  if (isNegative(outstanding)) {
    return `Overpaid ${formatMoney(toDecimal(outstanding).negated(), currency)} (consignor owes the shop)`;
  }
  return nothingYet(outstanding, history) ? "Nothing owed yet" : "Settled";
}

export function outstandingTone(outstanding: string, history?: BalanceHistory): ConsignmentTone {
  if (isPositive(outstanding)) return "waiting";
  if (isNegative(outstanding)) return "info";
  return nothingYet(outstanding, history) ? "neutral" : "done";
}

/** How an overpayment clears (D46), one line. */
export const OVERPAID_REMEDIES =
  "It clears with a later sale, by voiding a consignor-paid charge or by reversing a payment. It is never taken back automatically.";

/** "3 of 6 left" for a quantity consignment. */
export function remainingLabel(remaining: number, quantity: number): string {
  return `${remaining} of ${quantity} left`;
}

// ---------------------------------------------------------------------------
// Item history
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null;

const moneyOf = (v: unknown, currency: string): string | null => {
  const s = text(v);
  if (s === null) return null;
  try {
    return formatMoney(s, currency);
  } catch {
    return null;
  }
};

const change = (label: string, v: unknown, currency: string): string | null => {
  if (typeof v !== "object" || v === null) return null;
  const { from, to } = v as { from?: unknown; to?: unknown };
  const a = moneyOf(from, currency) ?? "none";
  const b = moneyOf(to, currency) ?? "none";
  return `${label} ${a} → ${b}`;
};

const STATUS_WORDS: Record<string, string> = {
  active: "for sale",
  sold: "sold",
  returned: "returned",
  withdrawn: "withdrawn",
};

/**
 * One consignment_item_events row in words: a title ("Received",
 * "Terms changed", "Sold on J-000123", "Restocked", "Job reopened",
 * "Returned to consignor", "2 returned to consignor") and a detail line
 * with the amounts. Only staff who may see consignment money read events
 * (D48), so the detail may name amounts.
 */
export function describeConsignmentEvent(
  type: ConsignmentEventType,
  payload: Payload,
  currency = "SGD",
): { title: string; detail: string | null } {
  switch (type) {
    case "received": {
      const parts = [
        typeof payload.quantity === "number" && payload.quantity > 1
          ? `${payload.quantity} items`
          : null,
        moneyOf(payload.agreed_amount_owed, currency)
          ? `owed ${moneyOf(payload.agreed_amount_owed, currency)}${
              typeof payload.quantity === "number" && payload.quantity > 1 ? " each" : ""
            }`
          : null,
        moneyOf(payload.asking_price, currency)
          ? `asking ${moneyOf(payload.asking_price, currency)}`
          : null,
      ].filter(Boolean);
      return { title: "Received", detail: parts.length > 0 ? parts.join(" · ") : null };
    }
    case "terms_changed": {
      const parts = [
        change("Owed", payload.agreed_amount_owed, currency),
        change("Asking", payload.asking_price, currency),
      ].filter(Boolean);
      return { title: "Terms changed", detail: parts.length > 0 ? parts.join(" · ") : null };
    }
    case "charge_added":
    case "charge_voided": {
      const bearer =
        payload.bearer === "consignor" || payload.bearer === "shop"
          ? CHARGE_BEARER_LABELS[payload.bearer]
          : null;
      const parts = [text(payload.description), moneyOf(payload.amount, currency), bearer].filter(
        Boolean,
      );
      return {
        title: type === "charge_added" ? "Charge added" : "Charge voided",
        detail: parts.length > 0 ? parts.join(" · ") : null,
      };
    }
    case "status_changed": {
      const from = text(payload.from);
      const to = text(payload.to);
      const job = text(payload.job_number);
      const sale = text(payload.sale_number);
      if (to === "sold") {
        const on = job ?? sale;
        return { title: on ? `Sold on ${on}` : "Sold", detail: null };
      }
      if (from === "sold" && to === "active") {
        if (payload.cause === "job_reopened") {
          return { title: job ? `Job ${job} reopened` : "Job reopened", detail: null };
        }
        if (payload.cause === "restock") {
          return { title: sale ? `Restocked from ${sale}` : "Restocked", detail: null };
        }
        return { title: "Back for sale", detail: null };
      }
      if (to === "returned") return { title: "Returned to consignor", detail: null };
      return { title: `Now ${STATUS_WORDS[to ?? ""] ?? to ?? "changed"}`, detail: null };
    }
    case "stock_returned": {
      const qty = typeof payload.quantity === "number" ? payload.quantity : 1;
      return { title: `${qty} returned to consignor`, detail: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Settlement allocations (D47)
// ---------------------------------------------------------------------------

export type AllocationCandidate = {
  id: string;
  /** reporting.consignor_item_ledger outstanding, as a decimal string. */
  outstanding: string;
  /** When it last sold; the oldest sale is paid first. Null sorts last. */
  lastSaleAt: string | null;
};

export type Allocation = { id: string; amount: string };

/** A positive amount typed by staff, or null. */
const amountOf = (input: string): Decimal | null => {
  const d = parseMoney(input);
  return d && d.greaterThan(0) ? d : null;
};

/**
 * Spreads a payment over the items that are owed, oldest sale first (ties
 * keep the given order), never more than an item's outstanding and never
 * to an item with nothing outstanding. What does not fit is `unallocated`
 * (an overpayment needs a deliberate allocation with a reason, D47).
 */
export function autoAllocate(
  amount: string,
  items: readonly AllocationCandidate[],
): { allocations: Allocation[]; unallocated: string } {
  let left = amountOf(amount) ?? new Decimal(0);
  const order = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isPositive(item.outstanding))
    .sort((a, b) => {
      const x = a.item.lastSaleAt;
      const y = b.item.lastSaleAt;
      if (x !== y) {
        if (x === null) return 1;
        if (y === null) return -1;
        const dx = Date.parse(x);
        const dy = Date.parse(y);
        if (dx !== dy) return dx - dy;
      }
      return a.index - b.index;
    });
  const allocations: Allocation[] = [];
  for (const { item } of order) {
    if (!left.greaterThan(0)) break;
    const take = Decimal.min(left, toDecimal(item.outstanding));
    allocations.push({ id: item.id, amount: take.toFixed(2) });
    left = left.minus(take);
  }
  return { allocations, unallocated: left.toFixed(2) };
}

export type AllocationLine = { id: string; amount: string; overrideReason?: string | null };

export type AllocationProblems = {
  /** "Unallocated $x" or "Over by $x" when the lines do not add up to the amount. */
  mismatch: string | null;
  /** Lines whose amount is missing, not a positive amount, or more than 2 decimals. */
  invalid: string[];
  /** Lines above max(outstanding, 0): they need an override reason (D47). */
  overrides: string[];
  /** Overrides without a reason yet. */
  missingReasons: string[];
  /** Nothing may be recorded while true. */
  blocking: boolean;
};

/**
 * What stops a settlement from being recorded (D47): the amount must be a
 * positive amount; at least one line; every line a positive amount; the
 * lines must add up to the amount exactly; and a line above the item's
 * max(outstanding, 0) needs a reason. record_settlement checks all of it
 * again.
 */
export function allocationProblems(
  amount: string,
  allocations: readonly AllocationLine[],
  items: readonly Pick<AllocationCandidate, "id" | "outstanding">[],
  currency = "SGD",
): AllocationProblems {
  const total = amountOf(amount);
  const invalid: string[] = [];
  const overrides: string[] = [];
  const missingReasons: string[] = [];
  let sum = new Decimal(0);
  for (const line of allocations) {
    const value = amountOf(line.amount);
    if (!value) {
      invalid.push(line.id);
      continue;
    }
    sum = sum.plus(value);
    const item = items.find((i) => i.id === line.id);
    const cap = item ? Decimal.max(toDecimal(item.outstanding), 0) : new Decimal(0);
    if (value.greaterThan(cap)) {
      overrides.push(line.id);
      if (!line.overrideReason?.trim()) missingReasons.push(line.id);
    }
  }
  let mismatch: string | null = null;
  const target = total ?? new Decimal(0);
  if (!sum.equals(target)) {
    mismatch = sum.lessThan(target)
      ? `Unallocated ${formatMoney(target.minus(sum), currency)}`
      : `Over by ${formatMoney(sum.minus(target), currency)}`;
  }
  return {
    mismatch,
    invalid,
    overrides,
    missingReasons,
    blocking:
      total === null ||
      allocations.length === 0 ||
      invalid.length > 0 ||
      mismatch !== null ||
      missingReasons.length > 0,
  };
}

/**
 * The paid_at a settlement sends for the date staff picked: null when it
 * is today (the database stamps now()), otherwise noon Singapore time on
 * that day, as an ISO instant, so the shop day can never slip. Fixed in
 * the sheet's state when chosen, so a retry sends the same payload.
 */
export function paidAtFromDate(date: string, today: string): string | null {
  if (date === today) return null;
  const at = new Date(`${date}T12:00:00${SHOP_UTC_OFFSET}`);
  if (Number.isNaN(at.getTime())) throw new RangeError(`Invalid date: ${date}`);
  return at.toISOString();
}

/** A location's count as Change owner sees it (D162). */
export type ChangeOwnerStock = { locationId: string; name: string; onHand: number };

/**
 * The stock Change owner moves (D162): every location whose count is not
 * zero. reclassify_as_consignment takes it from one location only, so the
 * sheet asks for a transfer first when this is more than one.
 */
export function stockToMove(stock: ChangeOwnerStock[]): ChangeOwnerStock[] {
  return stock.filter((s) => s.onHand !== 0);
}
