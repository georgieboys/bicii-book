import "server-only";

import { QUOTE_WINDOW_SECONDS, quoteBuckets, type QuoteAttempt } from "@/lib/quote-limits";

import { noteLinkAttempt } from "./link-throttle";

/**
 * The quote page's limits (src/lib/quote-limits.ts says why), counted in
 * Postgres through public.note_sign_in_attempt (service role only), so they
 * hold across every server instance. Fails open: a token cannot be
 * guessed and `answer_quote` answers once, so a missing key or an outage
 * must not stop a customer from answering; the cause is logged
 * (src/lib/admin/link-throttle.ts).
 */
export async function noteQuoteAttempt(
  attempt: QuoteAttempt,
  token: string,
): Promise<"ok" | "limited"> {
  return noteLinkAttempt("quote", attempt, QUOTE_WINDOW_SECONDS, (client, multiplier) =>
    quoteBuckets(attempt, client, token, multiplier),
  );
}
