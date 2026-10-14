"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions";
import { noteQuoteAttempt } from "@/lib/admin/quote-throttle";
import { mapDbError } from "@/lib/db-errors";
import { child } from "@/lib/logger";
import { ANSWER_NAME_MAX, QUOTE_TOKEN, parseQuoteView, type QuoteView } from "@/lib/quote-page";
import { getCorrelationId } from "@/lib/auth/session";
import { createAnonClient } from "@/lib/supabase/anon";

/**
 * The customer's answer to a quote (D142): every item approved or
 * declined, and their name. Anyone holding the link may answer (D143,
 * R-078), so this runs as anon whoever is signed in, after the quote
 * page's own limit; `answer_quote` answers a quote once.
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
      code: mapped.reason,
      ...(mapped.reason === "quote_name_required"
        ? { fieldErrors: { name: [mapped.message] } }
        : {}),
    };
  }
  const view = parseQuoteView(data);
  if (!view) return { ok: false, error: "Something went wrong. Reload the page." };
  return { ok: true, data: view };
}
