/**
 * Indent parts and quotes (Phase 13; PLAN D140-D146, ADR-024): the words
 * and links the job page and the quote page share. Pure, so the browser,
 * the server and the unit tests use the same rules.
 */
import type { Database } from "@/lib/database.types";

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
