import { createHash } from "node:crypto";

/**
 * The quote page's own limits (Phase 13 step 3; PLAN D143). A link token
 * cannot be guessed (D141), so these are a brake on load and on hammering
 * one quote, not the guard: `answer_quote` answers a quote once whatever
 * arrives, and Stripe Checkout is reused per quote (D158d). Counted per
 * client address (as on /login, D72) and per token, in public.note_sign_in_attempt's counters
 * (src/lib/admin/quote-throttle.ts) under their own "quote-" keys.
 */

export type QuoteAttempt = "view" | "answer" | "pay";

/** Length of one counting window, as for sign-in. */
export const QUOTE_WINDOW_SECONDS = 300;

/**
 * Per window. Views: a customer reopening the link, a family sharing it,
 * a shop's own checks, all from one address. Answers: one answer succeeds;
 * the rest are retries after a validation message. Pay (Phase 14 step 2):
 * Pay deposit and the return's check together; each can reach Stripe, and
 * one open session is reused, so a handful is plenty.
 */
export const QUOTE_LIMITS: Readonly<
  Record<QuoteAttempt, Readonly<{ client: number; token: number }>>
> = {
  view: { client: 60, token: 60 },
  answer: { client: 10, token: 10 },
  pay: { client: 10, token: 10 },
};

export type QuoteBucket = { key: string; limit: number };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The counters one attempt adds to. Keys hold SHA-256 digests, never the
 * address or the token in clear; the token's digest is salted with
 * "quote-limit:" so it never equals the stored `quotes.token_hash`.
 * Clients without a usable address share one "unknown" bucket.
 * `multiplier` is SIGN_IN_LIMIT_MULTIPLIER (tests only).
 */
export function quoteBuckets(
  attempt: QuoteAttempt,
  client: string | null,
  token: string,
  multiplier = 1,
): QuoteBucket[] {
  const limits = QUOTE_LIMITS[attempt];
  return [
    {
      key: `quote-${attempt}:client:${digest(client ?? "unknown")}`,
      limit: limits.client * multiplier,
    },
    {
      key: `quote-${attempt}:token:${digest(`quote-limit:${token}`)}`,
      limit: limits.token * multiplier,
    },
  ];
}
