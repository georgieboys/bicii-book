"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions";
import { noteQuoteAttempt } from "@/lib/admin/quote-throttle";
import { mapDbError } from "@/lib/db-errors";
import { confirmDepositReturn, startDepositCheckout } from "@/lib/integrations/stripe/checkout";
import { defaultStripeDeps } from "@/lib/integrations/stripe/deps";
import { child } from "@/lib/logger";
import { ANSWER_NAME_MAX, QUOTE_TOKEN, parseQuoteView, type QuoteView } from "@/lib/quote-page";
import { getCorrelationId } from "@/lib/auth/session";
import { createAnonClient } from "@/lib/supabase/anon";

/**
 * The customer's answer to a quote (D142): every item approved or
 * declined, and their name. Anyone holding the link may answer (D143,
 * R-078), so this runs as anon whoever is signed in, after the quote
 * page's own limit; `answer_quote` answers a quote once.
 *
 * Paying its deposit (Phase 14 step 2; D151, D153, D158): Pay deposit and
 * the check on returning from Stripe run with whoever holds the link,
 * after the quote page's "pay" limit. They reach the service role only
 * through src/lib/integrations/stripe/checkout.ts; anon gains no RPC.
 * Neither ever marks anything paid: only Stripe's data does (D153), and
 * Next's Server Action origin check is the CSRF guard.
 */

const answerSchema = z.object({
  token: z.string().regex(QUOTE_TOKEN, { error: "This link is not valid." }),
  decisions: z
    .array(z.object({ itemId: z.uuid(), approve: z.boolean() }), {
      error: "Approve or decline each item.",
    })
    .min(1, { error: "Approve or decline each item." })
    .max(50, { error: "Approve or decline each item." }),
  name: z
    .string({ error: "Type your name." })
    .trim()
    .min(1, { error: "Type your name." })
    .max(ANSWER_NAME_MAX, { error: `Keep your name under ${ANSWER_NAME_MAX} characters.` }),
});

export type AnswerQuoteInput = z.input<typeof answerSchema>;

export async function answerQuoteAction(input: AnswerQuoteInput): Promise<ActionResult<QuoteView>> {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>;
    return {
      ok: false,
      error: Object.values(fieldErrors).flat()[0] ?? "Check your answer.",
      fieldErrors,
    };
  }
  const { token, decisions, name } = parsed.data;
  if ((await noteQuoteAttempt("answer", token)) === "limited") {
    return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };
  }

  const { data, error } = await createAnonClient().rpc("answer_quote", {
    token,
    decisions: decisions.map((d) => ({ item_id: d.itemId, approve: d.approve })),
    name,
  });
  if (error) {
    if (error.code === "P0002") {
      return { ok: false, error: "This link is not valid. Ask the shop for a new one." };
    }
    const mapped = mapDbError(error);
    if (mapped.kind === "unknown" || mapped.kind === "unavailable") {
      child(await getCorrelationId()).error(
        { action: "quote.answer", code: mapped.code, reason: mapped.reason },
        "quote answer failed",
      );
    }
    return {
      ok: false,
      error: mapped.message,
      // Only a mapped business reason: an unmapped P0001's text is the raw
      // database message, never sent to whoever holds the link.
      code: mapped.kind === "business" ? mapped.reason : undefined,
      ...(mapped.reason === "quote_name_required"
        ? { fieldErrors: { name: [mapped.message] } }
        : {}),
    };
  }
  const view = parseQuoteView(data);
  if (!view) return { ok: false, error: "Something went wrong. Reload the page." };
  return { ok: true, data: view };
}

const tokenSchema = z.object({
  token: z.string().regex(QUOTE_TOKEN, { error: "This link is not valid." }),
});

export type DepositInput = z.input<typeof tokenSchema>;

const LIMITED = "Too many attempts. Wait a few minutes and try again.";
const UNAVAILABLE =
  "Online payment isn't available right now. Try again in a few minutes, or contact the shop.";

/** The token, checked and counted; or the failure to return. */
async function payToken(
  input: DepositInput,
): Promise<{ token: string } | { ok: false; error: string }> {
  const parsed = tokenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "This link is not valid." };
  if ((await noteQuoteAttempt("pay", parsed.data.token)) === "limited") {
    return { ok: false, error: LIMITED };
  }
  return { token: parsed.data.token };
}

/**
 * Pay deposit: Stripe Checkout's URL to go to (the same open session when
 * there is one), or null when the deposit is already paid, being
 * confirmed or refunded (the page refreshes to say so).
 */
export async function startDepositCheckoutAction(
  input: DepositInput,
): Promise<ActionResult<{ url: string | null }>> {
  const checked = await payToken(input);
  if (!("token" in checked)) return checked;
  const correlationId = await getCorrelationId();
  const result = await startDepositCheckout(checked.token, defaultStripeDeps(correlationId));
  child(correlationId).info({ action: "quote.pay", outcome: result.kind }, "action");
  switch (result.kind) {
    case "redirect":
      return { ok: true, data: { url: result.url } };
    case "paid":
    case "processing":
    case "refunded":
      return { ok: true, data: { url: null } };
    case "refused":
      return { ok: false, error: result.message, code: result.reason };
    case "unavailable":
      return { ok: false, error: UNAVAILABLE };
  }
}

/**
 * Back from Stripe: one re-read of the open session at Stripe, recorded
 * as Stripe's word (D159a), so the page shows the deposit as Stripe has it.
 */
export async function checkDepositAction(
  input: DepositInput,
): Promise<ActionResult<{ state: string | null }>> {
  const checked = await payToken(input);
  if (!("token" in checked)) return checked;
  const correlationId = await getCorrelationId();
  const { state } = await confirmDepositReturn(checked.token, defaultStripeDeps(correlationId));
  child(correlationId).info(
    { action: "quote.check_deposit", outcome: state ?? "unknown" },
    "action",
  );
  return { ok: true, data: { state } };
}
