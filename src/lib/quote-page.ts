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
