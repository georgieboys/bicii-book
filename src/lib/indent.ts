/**
 * Indent parts and quotes (Phase 13; PLAN D140-D146, D149, ADR-024): the
 * words and links the job page and the quote page share. Pure, so the
 * browser, the server and the unit tests use the same rules.
 */
import type { Database } from "@/lib/database.types";
import { formatMoney } from "@/lib/money";

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
 * The Fit sheet's warning for a part that was never ordered in BICII (no
 * purchase order line): it comes out of stock at the default location,
 * which may go below zero (D23) when it was bought outside BICII.
 */
export function neverOrderedNote(locationName: string | null): string {
  return `Never ordered in BICII: fitting takes it out of stock at ${
    locationName ?? "the default location"
  }. If it was bought outside BICII, that count may go below zero until the stock is corrected.`;
}

/** The Fit sheet's note when the product has no cost (D24, part_cost_missing), for cost holders. */
export const COST_MISSING_NOTE =
  "This part has no cost yet, so it can't be fitted: its yield can't be worked out. Set its cost on the product's page first.";

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

const escapeHtml = (value: string) =>
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
