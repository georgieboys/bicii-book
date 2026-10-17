"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions";
import { noteBalanceAttempt } from "@/lib/admin/balance-throttle";
import { getCorrelationId } from "@/lib/auth/session";
import { BALANCE_TOKEN } from "@/lib/balance-page";
import {
  confirmBalanceReturn,
  startBalanceCheckout,
  type BalanceReturnState,
} from "@/lib/integrations/stripe/checkout";
import { defaultStripeDeps } from "@/lib/integrations/stripe/deps";
import { child } from "@/lib/logger";

/**
 * Paying a payment link (Phase 14 step 3; D156g, D156h; ADR-025): Pay and
 * the check on returning from Stripe run with whoever holds the link,
 * after the pay page's own "pay" limit. They reach the service role only
 * through src/lib/integrations/stripe/checkout.ts; anon gains no RPC.
 * Neither ever marks anything paid: only Stripe's data does (D153), and
 * Next's Server Action origin check is the CSRF guard. Logs carry the
 * outcome only, never the token.
 */

const tokenSchema = z.object({
  token: z.string().regex(BALANCE_TOKEN, { error: "This link is not valid." }),
});

export type BalanceInput = z.input<typeof tokenSchema>;

const LIMITED = "Too many attempts. Wait a few minutes and try again.";
const UNAVAILABLE =
  "Online payment isn't available right now. Try again in a few minutes, or contact the shop.";

/**
 * Refusals the page itself words once it is read again: the link replaced
 * or stopped, expired or unknown, the job no longer completed or ready,
 * the balance too large to pay online. Pay refreshes the page for these
 * rather than showing the refusal's own sentence.
 */
const PAGE_STATE_REFUSALS: ReadonlySet<string> = new Set([
  "balance_link_not_found",
  "balance_link_withdrawn",
  "balance_link_expired",
  "balance_link_job_closed",
  "balance_too_large",
]);

/** The token, checked and counted; or the failure to return. */
async function payToken(
  input: BalanceInput,
): Promise<{ token: string } | { ok: false; error: string }> {
  const parsed = tokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "This link is not valid." };
  if ((await noteBalanceAttempt("pay", parsed.data.token)) === "limited") {
    return { ok: false, error: LIMITED };
  }
  return { token: parsed.data.token };
}

/**
 * Pay: Stripe Checkout's URL to go to (this link's open session when there
 * is one), or null when the page should be read again to say what is now
 * true (a payment on the job being confirmed, nothing left to pay, the
 * link replaced, stopped or expired).
 */
export async function startBalanceCheckoutAction(
  input: BalanceInput,
): Promise<ActionResult<{ url: string | null }>> {
  const checked = await payToken(input);
  if (!("token" in checked)) return checked;
  const correlationId = await getCorrelationId();
  const result = await startBalanceCheckout(checked.token, defaultStripeDeps(correlationId));
  child(correlationId).info(
    {
      action: "balance.pay",
      outcome: result.kind,
      ...(result.kind === "refused" ? { reason: result.reason } : {}),
    },
    "action",
  );
  switch (result.kind) {
    case "redirect":
      return { ok: true, data: { url: result.url } };
    case "processing":
    case "nothing_due":
      return { ok: true, data: { url: null } };
    case "refused":
      if (PAGE_STATE_REFUSALS.has(result.reason)) return { ok: true, data: { url: null } };
      return { ok: false, error: result.message, code: result.reason };
    case "unavailable":
      return { ok: false, error: UNAVAILABLE };
  }
}

/**
 * Back from Stripe: one re-read of the job's pending balance session at
 * Stripe, recorded as Stripe's word (D159a), so the page says what Stripe
 * has: paid, being confirmed, still due or nothing left; null when it
 * cannot tell (the link refused, Stripe unreachable or off).
 */
export async function checkBalanceAction(
  input: BalanceInput,
): Promise<ActionResult<{ state: BalanceReturnState | null }>> {
  const checked = await payToken(input);
  if (!("token" in checked)) return checked;
  const correlationId = await getCorrelationId();
  const { state } = await confirmBalanceReturn(checked.token, defaultStripeDeps(correlationId));
  child(correlationId).info(
    { action: "balance.check_return", outcome: state ?? "unknown" },
    "action",
  );
  return { ok: true, data: { state } };
}
