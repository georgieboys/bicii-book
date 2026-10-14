import { z } from "zod";

/**
 * The customer's quote page (Phase 13 step 3; PLAN D142, D143, ADR-024):
 * what `quote_by_token` and `answer_quote` return, parsed at the trust
 * boundary, and the token's shape. Pure, so the page, its action and the
 * unit tests share it.
 */

/** A link token: 32 random bytes as base64url without padding (43 characters, D141). */
export const QUOTE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isQuoteToken = (token: string) => QUOTE_TOKEN.test(token);

const money = z.union([z.string(), z.number()]).transform(String);

const quoteItem = z.object({
  id: z.uuid(),
  kind: z.enum(["part", "service"]),
  description: z.string(),
  quantity: money,
  unit_sale_price: money,
  line_total: money,
  decision: z.enum(["approved", "declined"]).nullable(),
});

/**
 * The deposit the quote asks (Phase 14 step 2; D151, D158): on_answer
 * while open (the percent only: no amount is computed outside Postgres),
 * then due, processing, paid or refunded once answered, with
 * parts_ordered once every approved part still live is ordered or fitted
 * (D152: the shop ordered without waiting for the deposit). Optional, so a
 * payload from before the deposit migration still parses (null).
 */
const deposit = z
  .object({
    percent: z.number().int().min(1).max(100),
    amount: money.nullable(),
    status: z.enum(["on_answer", "due", "processing", "paid", "refunded"]),
    parts_ordered: z
      .boolean()
      .optional()
      .transform((v) => v ?? false),
  })
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/** Withdrawn and expired quotes show only their state and the job (D143). */
const closedQuote = <S extends "withdrawn" | "expired">(status: S) =>
  z.object({ status: z.literal(status), job_number: z.string() });

const fullQuote = <S extends "open" | "answered">(status: S) =>
  z.object({
    status: z.literal(status),
    job_number: z.string(),
    bike: z.string().nullable(),
    first_name: z.string().nullable(),
    currency: z.string(),
    total: money,
    sent_at: z.string(),
    expires_at: z.string(),
    answered_at: z.string().nullable(),
    answered_name: z.string().nullable(),
    items: z.array(quoteItem),
    deposit,
  });

export const quoteViewSchema = z.discriminatedUnion("status", [
  closedQuote("withdrawn"),
  closedQuote("expired"),
  fullQuote("open"),
  fullQuote("answered"),
]);

export type QuoteView = z.infer<typeof quoteViewSchema>;
export type OpenOrAnsweredQuote = Extract<QuoteView, { status: "open" | "answered" }>;
export type QuoteItem = z.infer<typeof quoteItem>;
export type QuoteDeposit = NonNullable<OpenOrAnsweredQuote["deposit"]>;

/**
 * Where Stripe sent the customer back to (`?deposit=`): display only,
 * never proof of payment (D153).
 */
export type DepositReturn = "returned" | "cancelled" | null;

export function depositReturn(value: string | string[] | undefined): DepositReturn {
  return value === "returned" || value === "cancelled" ? value : null;
}

/** Parses what the RPC returned; null for an unknown token or an unexpected shape. */
export function parseQuoteView(value: unknown): QuoteView | null {
  if (value === null || value === undefined) return null;
  const parsed = quoteViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The longest name the database accepts (quotes_answered_name_check). */
export const ANSWER_NAME_MAX = 100;

/** How many items were approved, of how many, for the answered page. */
export function approvedSummary(items: readonly QuoteItem[]): { approved: number; of: number } {
  return { approved: items.filter((i) => i.decision === "approved").length, of: items.length };
}

/**
 * The sentence after "Thank you": what happens to the parts. Once the
 * shop has ordered them without waiting for the deposit (D152), the page
 * no longer says the order waits for it.
 */
export function answeredNext(deposit: QuoteDeposit | null): string {
  const ordered = deposit?.parts_ordered === true;
  switch (deposit?.status) {
    case "due":
      return ordered
        ? "The shop has ordered your parts. Ask the shop if you still need to pay the deposit."
        : "The shop orders your parts once the deposit is paid.";
    case "processing":
      return ordered
        ? "The shop has ordered your parts."
        : "The shop orders your parts once the deposit is paid.";
    case "paid":
      return ordered
        ? "Your deposit is paid and the shop has ordered your parts."
        : "Your deposit is paid, so the shop will order your parts.";
    default:
      return "The shop will be in touch.";
  }
}
