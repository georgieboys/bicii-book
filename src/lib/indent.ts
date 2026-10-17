/**
 * Indent parts and quotes (Phase 13; PLAN D140-D146, D149, D149a-c, D160,
 * ADR-024): the words and links the job page and the quote page share.
 * Pure, so the browser, the server and the unit tests use the same rules.
 */
import type { Database } from "@/lib/database.types";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { isOpenStatus } from "@/lib/workshop";

type JobStatus = Database["public"]["Enums"]["work_order_status"];

export type PartRequestStatus = Database["public"]["Enums"]["part_request_status"];
export type PartRequestKind = Database["public"]["Enums"]["part_request_kind"];
export type QuoteChannel = Database["public"]["Enums"]["quote_channel"];
/** A quote as the page sees it: the stored status, or expired when open past expires_at. */
export type QuoteState = Database["public"]["Enums"]["quote_status"] | "expired";

export const PART_REQUEST_LABELS: Record<PartRequestStatus, string> = {
  proposed: "Proposed",
  quoted: "Waiting for the customer",
  approved: "Approved",
  declined: "Declined",
  ordered: "Ordered",
  fitted: "Fitted",
  cancelled: "Cancelled",
};

export type RequestTone = "neutral" | "info" | "waiting" | "done" | "danger";

export const PART_REQUEST_TONES: Record<PartRequestStatus, RequestTone> = {
  proposed: "neutral",
  quoted: "waiting",
  approved: "done",
  declined: "danger",
  ordered: "info",
  fitted: "done",
  cancelled: "neutral",
};

/** Requests staff may still cancel (D140): not on an open quote, not fitted. */
export const CANCELLABLE: readonly PartRequestStatus[] = [
  "proposed",
  "approved",
  "declined",
  "ordered",
];

/** Whether a request can be put on the job now (D146): approved, or an ordered part. */
export function canFit(kind: PartRequestKind, status: PartRequestStatus): boolean {
  return status === "approved" || (kind === "part" && status === "ordered");
}

/**
 * Approved by the customer and not on the bill yet (D140, R-082): approved
 * or ordered, so not fitted, declined or cancelled. The statuses
 * public.work_order_unfitted_requests counts.
 */
export function isUnfitted(status: PartRequestStatus): boolean {
  return status === "approved" || status === "ordered";
}

const closedJob = (jobStatus: JobStatus) => jobStatus === "collected" || jobStatus === "cancelled";

/**
 * Whether this staff member may cancel a request on a job in `jobStatus`
 * (D140, D149): a cancellable request, by any staff member until the job is
 * collected or cancelled; after that by an active admin or manager only
 * (`canCancelClosed`, the same role check as private.can_record_refunds()),
 * who may also cancel an item still on the open quote there (nobody can
 * answer or withdraw it on a closed job, so the cancel withdraws it). The
 * database checks again.
 */
export function canCancelRequest(
  status: PartRequestStatus,
  jobStatus: JobStatus,
  canCancelClosed: boolean,
): boolean {
  if (!closedJob(jobStatus)) return CANCELLABLE.includes(status);
  return canCancelClosed && (CANCELLABLE.includes(status) || status === "quoted");
}

/**
 * The badge of a request (R-082): its status, except on a job that is no
 * longer open, where an approved or ordered item is "Not fitted" (never the
 * green done tone) and an item on the open quote is "Not answered" (the
 * customer can no longer answer it).
 */
export function requestBadge(
  status: PartRequestStatus,
  jobOpen: boolean,
): { label: string; tone: RequestTone } {
  if (!jobOpen && isUnfitted(status)) return { label: "Not fitted", tone: "danger" };
  if (!jobOpen && status === "quoted") return { label: "Not answered", tone: "neutral" };
  return { label: PART_REQUEST_LABELS[status], tone: PART_REQUEST_TONES[status] };
}

/**
 * What can still be done with a quote left open when the job stopped being
 * open (R-082, D149); null while the job is open.
 */
export function unansweredQuoteNote(jobStatus: JobStatus): string | null {
  switch (jobStatus) {
    case "completed":
    case "ready_for_collection":
      return "Reopen the job with Change status to withdraw it or send it again.";
    case "collected":
    case "cancelled":
      return "An admin or manager can cancel its items, which withdraws it.";
    default:
      return null;
  }
}

/**
 * Why an approved or ordered item is not on the bill of a job that is no
 * longer open, and what can be done (R-082, D149); null while the job is
 * open (Fit is offered).
 */
export function notFittedNote(jobStatus: JobStatus): string | null {
  switch (jobStatus) {
    case "completed":
    case "ready_for_collection":
      return "Not on the bill: the job was completed before this was fitted. Reopen the job with Change status to fit it, or cancel it.";
    case "collected":
    case "cancelled":
      return `Not on the bill, and it can no longer be fitted: the job is ${jobStatus}. An admin or manager can cancel it and refund any deposit in Stripe.`;
    default:
      return null;
  }
}

/**
 * The memo under the job's Lines total (R-082): the approved items not on
 * the bill yet, counted and totalled by Postgres
 * (public.work_order_unfitted_requests). Never added to the total, the
 * yield or Cult Commons (D140). Null when there are none.
 */
export function unfittedMemo(
  memo: { itemCount: number; quotedTotal: string; currency: string } | null,
  open: boolean,
): string | null {
  if (!memo || memo.itemCount <= 0) return null;
  const total = formatMoney(memo.quotedTotal, memo.currency);
  if (!open) return `Approved but never fitted: ${total} (not billed).`;
  const it = memo.itemCount === 1 ? "it" : "them";
  return `Approved, not on the bill yet: ${memo.itemCount} ${
    memo.itemCount === 1 ? "item" : "items"
  }, ${total}. Fit ${it} to bill ${it}.`;
}

/**
 * Whether Fit offers "Bought outside BICII" (D149a): an approved part never
 * ordered in BICII (no purchase order), for staff with View costs or Manage
 * purchasing (`purchaseData`, D149c(3)). A part on a purchase order is
 * received in Purchasing first; fitting from stock stays for everyone.
 * public.fit_part_bought_outside checks again.
 */
export function canBuyOutside(
  request: { kind: PartRequestKind; status: PartRequestStatus; order: unknown },
  purchaseData: boolean,
): boolean {
  return (
    purchaseData &&
    request.kind === "part" &&
    request.status === "approved" &&
    request.order === null
  );
}

/**
 * The Fit sheet's note for a part never ordered in BICII (no purchase order
 * line). Fitting it from stock takes it from the default location, which
 * may go below zero (D23) if the shop really bought it elsewhere: staff who
 * can record a purchase are pointed at "Bought outside BICII" (D149a),
 * everyone else at who can.
 */
export function neverOrderedNote(locationName: string | null, canBuy: boolean): string {
  const where = locationName ?? "the default location";
  return canBuy
    ? `Never ordered in BICII. If you bought it outside BICII, choose Bought outside BICII so the stock count stays right and the job uses what you paid. From stock, it comes out of ${where}.`
    : `Never ordered in BICII: fitting takes it out of stock at ${where}. If it was bought outside BICII, ask someone with View costs or Manage purchasing to fit it as bought outside, so the stock count stays right.`;
}

/** The Fit sheet's note when the product has no cost (D24, part_cost_missing), for cost holders. */
export const COST_MISSING_NOTE =
  "This part has no cost yet, so it can't be fitted: its yield can't be worked out. Set its cost on the product's page first.";

/** The same, when the part may be bought outside BICII (D149a): From stock stays refused. */
export const COST_MISSING_BUY_NOTE =
  "This part has no cost yet, so it can't be fitted from stock. If you bought it outside BICII, choose Bought outside BICII and enter what you paid; otherwise set its cost on the product's page first.";

/** Fit from stock refused with part_cost_missing, when Bought outside BICII is offered. */
export const COST_MISSING_SWITCH_NOTE =
  "This part has no cost yet. If you bought it outside BICII, enter what you paid; otherwise ask someone with View costs to set the product's cost.";

/** Fit refused with part_cost_missing for a part on a purchase order. */
export const COST_SET_ON_RECEIPT_NOTE =
  "Its cost is set when its order is received in Purchasing. Receive it first.";

// ---------------------------------------------------------------------------
// Voiding a fitted indent line (D160)
// ---------------------------------------------------------------------------

/**
 * Where a fitted request goes when its line is voided (D160): ordered when
 * it is on a purchase order (`order`, from part_request_arrivals), else
 * approved. Mirrors private.unfit_part_request.
 */
export type UnfitStatus = "approved" | "ordered";

export function unfitStatus(request: { order: unknown }): UnfitStatus {
  return request.order === null || request.order === undefined ? "approved" : "ordered";
}

/** A job line that a fitted indent request points at, for the void confirmation (D160). */
export type FittedIndentLine = { description: string; backTo: UnfitStatus };

/** The job's fitted indent items keyed by their line id (D160). */
export function fittedIndentLines(
  requests: readonly {
    status: PartRequestStatus;
    lineId: string | null;
    description: string;
    order: unknown;
  }[],
): Record<string, FittedIndentLine> {
  const lines: Record<string, FittedIndentLine> = {};
  for (const r of requests) {
    if (r.status === "fitted" && r.lineId) {
      lines[r.lineId] = { description: r.description, backTo: unfitStatus(r) };
    }
  }
  return lines;
}

/** What the void confirmation says for a fitted indent line (D160). */
export function voidIndentNote(line: FittedIndentLine): string {
  return `Voiding puts ${line.description} back to ${line.backTo}: fit it again or cancel it before completing the job.`;
}

/**
 * What the indent card says under an approved or ordered item whose line
 * was voided (D160); a part bought outside BICII went back into stock
 * with the void, so it is fitted from stock.
 */
export function unfittedNote(boughtOutside: boolean): string {
  return boughtOutside
    ? "Its line was voided, so it is not on the bill. The part bought outside BICII went back into stock: fit it from stock, or cancel it."
    : "Its line was voided, so it is not on the bill: fit it again or cancel it.";
}

/** The Fit sheet's note for a part bought outside BICII whose line was voided (D160). */
export const BACK_IN_STOCK_NOTE =
  "It went back into stock when its line was voided: fit it from stock. Bought outside BICII would record a second purchase.";

// ---------------------------------------------------------------------------
// Settle before closing (D149b, D149c)
// ---------------------------------------------------------------------------

/** The statuses a job cannot enter while an item is approved or ordered. */
export type ClosingStatus = "completed" | "ready_for_collection" | "collected" | "cancelled";

/**
 * Whether moving a job to `to` must wait for its approved and ordered items
 * (D149b, D149c(1)): `to` is not open and an item is approved or ordered.
 * Mirrors private.work_orders_require_settled_requests, which refuses the
 * move with work_order_has_unfitted_requests whatever the screen shows.
 */
export function settleNeeded(
  to: JobStatus,
  requests: readonly { status: PartRequestStatus }[],
): to is ClosingStatus {
  return !isOpenStatus(to) && requests.some((r) => isUnfitted(r.status));
}

const SETTLE_TITLES: Record<ClosingStatus, (job: string) => string> = {
  completed: (job) => `Before completing ${job}`,
  ready_for_collection: (job) => `Before marking ${job} ready`,
  collected: (job) => `Before marking ${job} collected`,
  cancelled: (job) => `Before cancelling ${job}`,
};

/** The checklist's title for a move to `to`. */
export function settleTitle(to: ClosingStatus, jobNumber: string): string {
  return SETTLE_TITLES[to](jobNumber);
}

/** The checklist's description: Fit or cancel, or (cancelling the job) cancel only. */
export function settleDescription(to: ClosingStatus): string {
  return to === "cancelled"
    ? "Cancel each approved or ordered item first. A cancelled job can't keep items waiting."
    : "Fit or cancel each approved or ordered item first.";
}

/**
 * What staff read when the database refused a cancel for unsettled items (a
 * stale page): the trigger's own sentence for a cancel. db-errors maps the
 * code to "Fit or cancel…", which is wrong here: a fitted line would stop
 * the cancel too (work_order_has_lines, D16).
 */
export const CANCEL_UNSETTLED_REFUSAL =
  "Cancel the job's approved and ordered items before cancelling it.";

const LEAVING: Record<ClosingStatus, string> = {
  completed: "Completing the job",
  ready_for_collection: "Marking it ready",
  collected: "Marking it collected",
  cancelled: "Cancelling the job",
};

/**
 * What happens to an open quote when the job leaves the open statuses
 * (D149c(2)): withdrawn, its link says so, its items go back to proposed.
 * Null when the job has no quote stored as open (an expired one is still
 * open in the database, so it is named too).
 */
export function quoteWithdrawNote(
  quote: { state: QuoteState; sentAt: string } | null,
  to: ClosingStatus,
  quotedItems: number,
): string | null {
  if (!quote || (quote.state !== "open" && quote.state !== "expired")) return null;
  const items =
    quotedItems === 0
      ? ""
      : `, and ${quotedItems === 1 ? "its item goes" : `its ${quotedItems} items go`} back to Proposed`;
  return `${LEAVING[to]} withdraws the quote sent ${formatDateTime(quote.sentAt)}: the customer's link will say it was withdrawn${items}.`;
}

/** Quote validity the database accepts (D141). */
export const QUOTE_DAYS = { min: 1, max: 30, default: 7 } as const;

/** The quote page's path for a link token (D143). */
export const quotePath = (token: string) => `/quote/${token}`;

/**
 * The international number wa.me expects, digits only (D144): an 8-digit
 * Singapore number (starting 3, 6, 8 or 9) gets 65; a number already in
 * international form keeps its digits; anything else is null (no WhatsApp
 * button, the link is copied instead).
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^[3689]\d{7}$/.test(digits)) return `65${digits}`;
  if (/^65[3689]\d{7}$/.test(digits)) return digits;
  if ((trimmed.startsWith("+") || trimmed.startsWith("00")) && digits.length >= 8) {
    const international = trimmed.startsWith("00") ? digits.slice(2) : digits;
    return international.length >= 8 && international.length <= 15 ? international : null;
  }
  return null;
}

/** The message a quote is sent with (D144): who it is for, the job and the link. */
export function quoteMessage({
  firstName,
  jobNumber,
  link,
  days,
}: {
  firstName: string | null;
  jobNumber: string;
  link: string;
  days: number;
}): string {
  const hello = firstName ? `Hi ${firstName},` : "Hi,";
  return [
    `${hello} here is the quote for your bike (job ${jobNumber}) from BICII.`,
    `Please approve or decline each item here: ${link}`,
    `The link works for ${days} ${days === 1 ? "day" : "days"}.`,
  ].join("\n");
}

/** A wa.me link that opens WhatsApp with the message filled in, or null without a usable number. */
export function whatsappHref(phone: string | null | undefined, text: string): string | null {
  const number = whatsappNumber(phone);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}

/** Text made safe inside HTML (the quote and payment link emails). */
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The quote email (D144): the same words as the WhatsApp message, with a button. */
export function quoteEmail(input: {
  firstName: string | null;
  jobNumber: string;
  link: string;
  days: number;
}): { subject: string; text: string; html: string } {
  const text = quoteMessage(input);
  const hello = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi,";
  const link = escapeHtml(input.link);
  const html = [
    `<p>${hello} here is the quote for your bike (job ${escapeHtml(input.jobNumber)}) from BICII.</p>`,
    `<p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:bold">Approve or decline each item</a></p>`,
    `<p>Or open this link: <a href="${link}">${link}</a></p>`,
    `<p>The link works for ${input.days} ${input.days === 1 ? "day" : "days"}.</p>`,
  ].join("\n");
  return { subject: `Your quote from BICII (job ${input.jobNumber})`, text, html };
}
