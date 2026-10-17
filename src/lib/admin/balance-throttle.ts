import "server-only";

import { BALANCE_WINDOW_SECONDS, balanceBuckets, type BalanceAttempt } from "@/lib/balance-limits";

import { noteLinkAttempt } from "./link-throttle";

/**
 * The payment link page's limits (src/lib/balance-limits.ts says why),
 * counted in Postgres through public.note_sign_in_attempt (service role
 * only), so they hold across every server instance. Fails open, as the
 * quote page's do: a token cannot be guessed and Pay reuses the link's
 * open Checkout session, so a missing key or an outage must not stop a
 * customer from paying; the cause is logged (src/lib/admin/link-throttle.ts).
 */
export async function noteBalanceAttempt(
  attempt: BalanceAttempt,
  token: string,
): Promise<"ok" | "limited"> {
  return noteLinkAttempt("balance", attempt, BALANCE_WINDOW_SECONDS, (client, multiplier) =>
    balanceBuckets(attempt, client, token, multiplier),
  );
}
