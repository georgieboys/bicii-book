/**
 * Customer payments on Reports (Phase 14 step 3; PLAN D154a–e; ADR-025,
 * ADR-022): the words, the DTOs and the URL state of the "Customer
 * payments" section of /reports, its "Held on jobs now" card and
 * /reports/payments. Pure and client-safe: the server-only reads are in
 * src/lib/domain/payment-reports.ts, which maps the rows of
 * report_payment_summary, report_payment_items and report_payments_held
 * (migration 20261014001500) onto these DTOs.
 *
 * A payment is money held, not a sale (D154): nothing here touches the
 * sales figures, and the section is not driven by the date basis. Every
 * amount was computed by Postgres and arrives as a fixed-2 string with its
 * currency; nothing here adds money up, with ONE display-only exception:
 * report_payments_held returns no group totals, so `heldGroups` adds each
 * list's amounts with Decimal (exactly, as the quote page's approved total
 * does) for the line under its heading. Nothing stores or sends that sum,
 * and the CSV export writes the rows only.
 */
import { COUNTER_METHOD_LABELS, type CounterMethod } from "@/lib/payments";
import { formatSignedMoney } from "@/lib/reports";
import { sumMoney, toDecimal, toMoneyString } from "@/lib/money";
import { STATUS_LABELS, type WorkOrderStatus } from "@/lib/workshop";

// ---------------------------------------------------------------------------
// Vocabulary (reporting.payment_movements.movement, D154b)
// ---------------------------------------------------------------------------

/** One movement of customer money, as reporting.payment_movements names it. */
export const PAYMENT_MOVEMENTS = [
  "online_payment",
  "online_refund",
  "counter_payment",
  "counter_given_back",
] as const;
export type PaymentMovement = (typeof PAYMENT_MOVEMENTS)[number];

/** What each movement is called on screen: the tiles and the list (D154d: "Recorded at the counter"). */
export const MOVEMENT_LABELS: Readonly<Record<PaymentMovement, string>> = {
  online_payment: "Taken online",
  online_refund: "Refunded online",
  counter_payment: "Recorded at the counter",
  counter_given_back: "Given back at the counter",
};

const isMovement = (v: string): v is PaymentMovement =>
  (PAYMENT_MOVEMENTS as readonly string[]).includes(v);

/** A movement as a label; an unknown one (a later migration) as it came. */
export function movementLabel(movement: string): string {
  return isMovement(movement) ? MOVEMENT_LABELS[movement] : movement;
}

/** Money coming back to the customer (a refund or a give-back) rather than coming in. */
export function isOutgoing(movement: string): boolean {
  return movement === "online_refund" || movement === "counter_given_back";
}

/**
 * The payment's kind as the job card says it: "Deposit"; a balance is
 * "Balance" online and "Towards the bill" at the counter (PaymentsCard).
 */
export function paymentKindLabel(movement: string, kind: string): string {
  if (kind === "deposit") return "Deposit";
  if (kind === "balance") {
    return movement === "counter_payment" || movement === "counter_given_back"
      ? "Towards the bill"
      : "Balance";
  }
  return kind;
}

/** How the money moved: Stripe online, or the counter method an admin recorded. */
export function paymentMethodLabel(method: string): string {
  if (method === "stripe") return "Stripe";
  return method in COUNTER_METHOD_LABELS ? COUNTER_METHOD_LABELS[method as CounterMethod] : method;
}

// ---------------------------------------------------------------------------
// Copy (D154a, D154c, D154d)
// ---------------------------------------------------------------------------

export const PAYMENTS_SECTION_TITLE = "Customer payments";

/** Under the tiles: what the figures are, and what they are not. */
export const PAYMENTS_NOT_SALES_NOTE = "Not sales: money taken and given back by the day it moved.";
export const COUNTER_RECORDED_NOTE =
  "Recorded at the counter: only what an admin recorded in BICII; not the till's takings.";

/**
 * report_payment_summary's other_currency_count: movements in another
 * currency (left out of the totals, D104) plus Stripe payments taken in
 * another currency (counted at the amount asked, as on the job card).
 * Null when there are none.
 */
export function otherCurrencyNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 payment in another currency is counted at the amount asked or left out of these totals."
    : `${count} payments in another currency are counted at the amount asked or left out of these totals.`;
}

/** The held card's basis sentence (D154c, step3-critique C17). */
export const HELD_BASIS_NOTE =
  "Not sales. On the Sale date basis, a job counts as sales on the day it is completed, so the second list is already in that figure and the others are not.";

/** report_payments_held's groups, in its order. */
export const HELD_GROUPS = ["open", "awaiting_collection", "above_bill"] as const;
export type HeldGroup = (typeof HELD_GROUPS)[number];

/** Each list's heading, its line and what an empty list says. */
export const HELD_GROUP_COPY: Readonly<
  Record<HeldGroup, { title: string; description: string; empty: string }>
> = {
  open: {
    title: "Paid on open jobs",
    description: "Deposits and payments ahead on work not finished yet.",
    empty: "No open job holds money now.",
  },
  awaiting_collection: {
    title: "Paid on jobs awaiting collection",
    description:
      "Completed or ready for collection: paid up to the bill, with what is still to pay.",
    empty: "No completed job is waiting for collection.",
  },
  above_bill: {
    title: "Paid above the bill",
    description:
      "More than the bill on a job that is not open: refund the online part in Stripe; an admin records counter money given back.",
    empty: "No job is paid above its bill.",
  },
};

// ---------------------------------------------------------------------------
// DTOs (money as fixed-2 strings)
// ---------------------------------------------------------------------------

/** report_payment_summary: the shop days from..to, in the shop currency. */
export type PaymentSummary = {
  from: string;
  to: string;
  currency: string;
  onlineCount: number;
  onlineTotal: string;
  depositOnlineTotal: string;
  balanceOnlineTotal: string;
  refundCount: number;
  /** Positive. */
  refundTotal: string;
  counterCount: number;
  counterTotal: string;
  givenBackCount: number;
  /** Positive. */
  givenBackTotal: string;
  /** online − refunds + counter − given back, as Postgres computed it. */
  netTotal: string;
  otherCurrencyCount: number;
};

/**
 * How many rows report_payment_items lists for the summary's period (the
 * export's consistency check, PR A): integer counts only, never money.
 */
export function movementCount(
  s: Pick<PaymentSummary, "onlineCount" | "refundCount" | "counterCount" | "givenBackCount">,
): number {
  return s.onlineCount + s.refundCount + s.counterCount + s.givenBackCount;
}

/** The payment list's keyset: the last row's (at, id), exactly as received. */
export type PaymentCursor = { at: string; id: string };

/** One movement (report_payment_items), newest first. */
export type PaymentItem = {
  at: string;
  /** The payment's, refund's or counter payment's id (a give-back shares its payment's). */
  id: string;
  movement: string;
  workOrderId: string;
  jobNumber: string;
  jobHref: string;
  customerLabel: string | null;
  kind: string;
  method: string;
  /** Positive. */
  amount: string;
  /** Negative for a refund or a give-back. */
  signedAmount: string;
  currency: string;
  /** Stripe took another currency: counted at the amount asked. */
  otherCurrency: boolean;
  /** Counter rows only: when and by whom an admin recorded it (shows back-dating). */
  recordedAt: string | null;
  recordedByName: string | null;
};

/** One job of report_payments_held (now, any period). */
export type HeldJob = {
  group: HeldGroup;
  workOrderId: string;
  jobNumber: string;
  jobHref: string;
  status: string;
  customerLabel: string | null;
  /** The group's figure: net paid (open), up to the bill (awaiting), above the bill. */
  amount: string;
  netPaid: string;
  netPaidOnline: string;
  paidAtCounter: string;
  jobTotal: string;
  /** Null once the job is collected or cancelled. */
  balanceDue: string | null;
  paidAhead: string | null;
  currency: string;
};

export type HeldList = {
  group: HeldGroup;
  rows: HeldJob[];
  /** Display only (see the module comment); "0.00" for an empty list. */
  total: string;
  currency: string;
};

/**
 * The three lists in their order, each with its rows and its own total
 * (no grand total, D154c). An empty list is kept, so the card always shows
 * all three. A row whose group is unknown is left out.
 */
export function heldGroups(rows: readonly HeldJob[], fallbackCurrency = "SGD"): HeldList[] {
  return HELD_GROUPS.map((group) => {
    const mine = rows.filter((r) => r.group === group);
    const currency = mine[0]?.currency ?? rows[0]?.currency ?? fallbackCurrency;
    return {
      group,
      rows: mine,
      total: toMoneyString(sumMoney(mine.map((r) => r.amount)), currency),
      currency,
    };
  });
}

const positive = (v: string | null) => v !== null && toDecimal(v).greaterThan(0);

/** A job status as staff read it; an unknown one as it came. */
export function heldStatusLabel(status: string): string {
  return status in STATUS_LABELS ? STATUS_LABELS[status as WorkOrderStatus] : status;
}

/**
 * The line under a held job: its status, where the money was paid
 * ("$A online, $B at the counter" when both), and the group's memo:
 * "Paid ahead" (open), "Still to pay" (awaiting collection) or the bill
 * it is above (above the bill). Formatting only.
 */
export function heldJobDetail(row: HeldJob): string {
  const m = (v: string) => formatSignedMoney(v, row.currency);
  const parts = [heldStatusLabel(row.status)];
  const online = positive(row.netPaidOnline);
  const counter = positive(row.paidAtCounter);
  if (online && counter) {
    parts.push(`${m(row.netPaidOnline)} online, ${m(row.paidAtCounter)} at the counter`);
  } else if (counter) {
    parts.push("Paid at the counter");
  } else if (online) {
    parts.push("Paid online");
  }
  if (row.group === "open" && positive(row.paidAhead)) {
    parts.push(`Paid ahead ${m(row.paidAhead!)}`);
  }
  if (row.group === "awaiting_collection" && row.balanceDue !== null) {
    parts.push(`Still to pay ${m(row.balanceDue)}`);
  }
  if (row.group === "above_bill") {
    parts.push(`Paid ${m(row.netPaid)} of a ${m(row.jobTotal)} bill`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// /reports/payments URL state
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The list's cursor from `after_at` and `after_id`: none when both are
 * absent; "invalid" when only one is there or either is malformed (the
 * page answers not-found, as report_payment_items refuses half a cursor
 * with report_key_invalid).
 */
export function parsePaymentCursor(
  afterAt: string | undefined,
  afterId: string | undefined,
): PaymentCursor | null | "invalid" {
  if (afterAt === undefined && afterId === undefined) return null;
  if (!afterAt || !afterId || !ISO_INSTANT.test(afterAt) || !UUID.test(afterId)) {
    return "invalid";
  }
  return { at: afterAt, id: afterId };
}
