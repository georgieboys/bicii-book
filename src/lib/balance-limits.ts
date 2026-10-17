import { createHash } from "node:crypto";

/**
 * The payment link page's own limits (Phase 14 step 3; D156f), a sibling
 * of src/lib/quote-limits.ts. A link token cannot be guessed (D156c), so
 * these are a brake on load and on hammering one link, not the guard:
 * Pay reuses this link's open Checkout session and never charges twice
 * (prepare_balance_checkout), and the page reads only the bill. Counted
 * per client address and per token in public.note_sign_in_attempt's
 * counters (src/lib/admin/balance-throttle.ts), under their own "balance-"
 * keys, so a quote link and a payment link never share a bucket.
 */

export type BalanceAttempt = "view" | "pay";

/** Length of one counting window, as for sign-in and the quote page. */
export const BALANCE_WINDOW_SECONDS = 300;

/**
 * Per window. Views: a customer reopening the link, a family sharing it,
 * and the return from Stripe's refreshes (one every 5 s for a minute). Pay:
 * Pay and the return's check together; each can reach Stripe, and one open
 * session is reused, so a handful is plenty.
 */
export const BALANCE_LIMITS: Readonly<
  Record<BalanceAttempt, Readonly<{ client: number; token: number }>>
> = {
  view: { client: 60, token: 60 },
  pay: { client: 10, token: 10 },
};

export type BalanceBucket = { key: string; limit: number };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The counters one attempt adds to. Keys hold SHA-256 digests, never the
 * address or the token in clear; the token's digest is salted with
 * "balance-limit:" so it never equals the stored `balance_links.token_hash`
 * or the quote page's key for the same string. Keys are at most 84
 * characters (note_sign_in_attempt takes 1 to 200). Clients without a
 * usable address share one "unknown" bucket. `multiplier` is
 * SIGN_IN_LIMIT_MULTIPLIER (tests only).
 */
export function balanceBuckets(
  attempt: BalanceAttempt,
  client: string | null,
  token: string,
  multiplier = 1,
): BalanceBucket[] {
  const limits = BALANCE_LIMITS[attempt];
  return [
    {
      key: `balance-${attempt}:client:${digest(client ?? "unknown")}`,
      limit: limits.client * multiplier,
    },
    {
      key: `balance-${attempt}:token:${digest(`balance-limit:${token}`)}`,
      limit: limits.token * multiplier,
    },
  ];
}
