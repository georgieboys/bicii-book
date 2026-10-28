"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { unwrap } from "@/lib/db-errors";
import { getQuoteRecipient } from "@/lib/domain/indent";
import { recordCounterPayment, sendBalanceLink, voidCounterPayment } from "@/lib/domain/payments";
import { balanceEmailEnabled, sendBalanceEmail } from "@/lib/integrations/email/balance";
import { expireOpenCheckouts, refreshPaymentFromStripe } from "@/lib/integrations/stripe/checkout";
import { stripeConnection } from "@/lib/integrations/stripe/client";
import { defaultStripeDeps } from "@/lib/integrations/stripe/deps";
import { noteStripeCheck } from "@/lib/integrations/stripe/limits";
import { formatMoney, parseMoney, toMoneyString } from "@/lib/money";
import {
  COUNTER_MAX,
  COUNTER_METHODS,
  COUNTER_VOID_KINDS,
  LINK_DAYS,
  counterCheckoutNote,
  payPath,
  replacedLinkCheckoutNote,
  type CounterMethod,
  type CounterVoidKind,
  type IncompleteCheck,
  type PaymentStatus,
} from "@/lib/payments";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/**
 * A job's Customer payments (Phase 14 step 2; D153, D159a; R-086). Check
 * with Stripe asks Stripe for its own record of one payment (the Checkout
 * Session and its Refunds) with the server's key and records what comes
 * back (record_stripe_read): staff only trigger the read, they never
 * supply payment data. Any active staff member may ask (D154: everyone
 * sees the card); the payment must be one their RLS can read. At most a
 * few reads per payment every 5 minutes.
 */
export const checkWithStripeAction = staffAction(
  z.object({ paymentId: z.guid({ error: "Unknown payment." }) }),
  { name: "payments.check_with_stripe" },
  async (
    { paymentId },
    { supabase, correlationId },
  ): Promise<{
    changed: boolean;
    after: PaymentStatus;
    /** Still pending with Checkout completed (Stripe confirming). */
    processing: boolean;
    /**
     * Null, or why the session was recorded but its PaymentIntent or
     * refunds could not be read: the key's permission, Stripe not reachable,
     * or an answer BICII could not use.
     */
    incomplete: IncompleteCheck | null;
  }> => {
    const row = unwrap(
      await supabase.from("payments").select("id").eq("id", paymentId).maybeSingle(),
    );
    if (!row) throw new ActionError("That payment no longer exists.");
    if ((await noteStripeCheck(paymentId)) === "limited") {
      throw new ActionError("Checked a moment ago. Wait a few minutes.");
    }
    const result = await refreshPaymentFromStripe(paymentId, defaultStripeDeps(correlationId));
    switch (result.kind) {
      case "checked":
        refresh();
        return {
          changed: result.changed,
          after: result.after,
          processing: result.processing,
          incomplete: result.incomplete,
        };
      case "other_mode":
        throw new ActionError(
          "This payment was made in Stripe's other mode (test or live) and can't be checked here.",
        );
      case "not_found":
        throw new ActionError("That payment no longer exists.");
      case "session_missing":
        throw new ActionError(
          "Stripe has no record of this Checkout under the key BICII uses now (another Stripe account?). An admin can follow RUNBOOK “Stripe: resolving problems”.",
        );
      case "unavailable":
        throw new ActionError(
          "Stripe can't be reached right now, or it isn't set up. Try again in a few minutes.",
        );
    }
  },
);

// ---------------------------------------------------------------------------
// Payment links (D156) and counter payments (D161)
// ---------------------------------------------------------------------------

const workOrderId = z.guid({ error: "Unknown job." });

/**
 * ADMIN_ORIGIN while Stripe is on, else null: the pay link is built from
 * it, never from the request's Host (R-091), and is only worth sending
 * while the customer can pay. A server environment that does not parse
 * reads as off.
 */
function payOrigin(): string | null {
  try {
    const connection = stripeConnection();
    return connection.state === "on" ? connection.origin : null;
  } catch {
    return null;
  }
}

/**
 * Send a payment link for what is left to pay (D156; any active staff
 * member, as quotes, D147). Refused while Stripe is off: nobody could pay
 * it. By email (when email is on and the customer has an address) the
 * Admin also emails it; a failed email keeps the link, and staff copy it
 * instead. The link (ADMIN_ORIGIN + /pay/<token>) is returned this once
 * and never logged. When it replaced a live link, the old link's open
 * Checkout is expired, best effort (step3-critique C9), and what came of
 * that is said in `checkoutNote`.
 */
export const sendBalanceLinkAction = staffAction(
  z.object({
    linkId: z.guid({ error: "Open the form again." }),
    workOrderId,
    channel: z.enum(["whatsapp", "email", "link"], { error: "Choose how to send it." }),
    validDays: z.coerce
      .number({ error: `Enter ${LINK_DAYS.min} to ${LINK_DAYS.max} days.` })
      .int({ error: "Enter a whole number of days." })
      .min(LINK_DAYS.min, { error: `At least ${LINK_DAYS.min} day.` })
      .max(LINK_DAYS.max, { error: `At most ${LINK_DAYS.max} days.` }),
  }),
  { name: "payments.send_balance_link" },
  async (
    input,
    { supabase, correlationId, log },
  ): Promise<{
    link: string;
    /** What was left to pay when it was sent ("180.00"), as Postgres computed it. */
    amount: string;
    validDays: number;
    expiresAt: string;
    emailedTo: string | null;
    emailFailed: boolean;
    /** The replaced link's open Checkout, if it could not be expired or was paid meanwhile. */
    checkoutNote: string | null;
  }> => {
    const origin = payOrigin();
    if (!origin) {
      throw new ActionError(
        "Stripe isn't set up, so the customer can't pay online. Take the payment at the counter.",
      );
    }
    const recipient =
      input.channel === "email" ? await getQuoteRecipient(supabase, input.workOrderId) : null;
    if (input.channel === "email") {
      if (!balanceEmailEnabled()) {
        throw new ActionError("Email isn't set up yet. Send by WhatsApp or copy the link.");
      }
      if (!recipient?.email) {
        throw new ActionError(
          "The customer has no email address. Add one, or send by WhatsApp or copy the link.",
        );
      }
    }
    const sent = await sendBalanceLink(supabase, input);
    const link = `${origin}${payPath(sent.token)}`;
    let emailedTo: string | null = null;
    let emailFailed = false;
    if (recipient?.email) {
      const mailed = await sendBalanceEmail({
        linkId: sent.linkId,
        to: recipient.email,
        firstName: recipient.firstName,
        jobNumber: recipient.jobNumber,
        amount: formatMoney(sent.amount),
        link,
        days: input.validDays,
      });
      if (mailed.ok) emailedTo = recipient.email;
      else emailFailed = true;
    }
    let checkoutNote: string | null = null;
    if (sent.replacedLinkId) {
      // Balance sessions only (no quote): the new link has none yet.
      const expired = await expireOpenCheckouts(input.workOrderId, {
        deps: defaultStripeDeps(correlationId),
      });
      checkoutNote = replacedLinkCheckoutNote(expired);
      log.info(
        { linkId: sent.linkId, replacedLinkId: sent.replacedLinkId, ...expired },
        "replaced link checkouts",
      );
    }
    refresh();
    return {
      link,
      amount: sent.amount,
      validDays: input.validDays,
      expiresAt: sent.expiresAt,
      emailedTo,
      emailFailed,
      checkoutNote,
    };
  },
);

const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * Record money the shop took at the counter (D161; an active admin only,
 * the RPC's require_admin). With `quoteId` it settles that quote's
 * deposit (exactly its amount, which the sheet fixes); without, it counts
 * towards the bill. `receivedAt` null means now. After it commits, and
 * also on a replay of the same id, the job's open Checkout sessions it
 * made stale (the RPC's live `open_checkouts`) are expired, best effort
 * (D161g; never while Stripe is off), and `checkoutNote` says when one was
 * paid meanwhile or may still be open. A replay expires too because the
 * first submission's expiry may not have finished (Stripe slow, the
 * function cut off, the response lost). Works with Stripe off.
 */
export const recordCounterPaymentAction = staffAction(
  z.object({
    id: z.guid({ error: "Open the form again." }),
    workOrderId,
    quoteId: z
      .union([z.guid({ error: "Unknown quote." }), z.literal(""), z.null()])
      .optional()
      .transform((v) => v || null),
    amount: z
      .string({ error: "Enter the amount." })
      .trim()
      .min(1, { error: "Enter the amount." })
      .refine((v) => parseMoney(v) !== null, {
        error: "Enter the amount, like 12.50.",
        abort: true,
      })
      .refine((v) => parseMoney(v)!.greaterThan(0), {
        error: "The amount must be more than 0.",
        abort: true,
      })
      .refine((v) => parseMoney(v)!.lte(COUNTER_MAX), {
        error: `At most ${formatMoney(COUNTER_MAX)}.`,
      })
      .transform((v) => toMoneyString(parseMoney(v)!)),
    method: z.enum(COUNTER_METHODS as [CounterMethod, ...CounterMethod[]], {
      error: "Choose how it was paid.",
    }),
    receivedAt: z.iso
      .datetime({ offset: true, error: "Choose the day it was paid." })
      .nullish()
      .transform((v) => v ?? null),
    reference: optionalText(200, "reference"),
    note: optionalText(2_000, "note"),
  }),
  { name: "payments.record_counter_payment", admin: true },
  async (
    input,
    { supabase, correlationId, log },
  ): Promise<{ replayed: boolean; checkoutNote: string | null }> => {
    const recorded = await recordCounterPayment(supabase, input);
    let checkoutNote: string | null = null;
    if (recorded.openCheckouts > 0) {
      const expired = await expireOpenCheckouts(input.workOrderId, {
        quoteId: input.quoteId,
        deps: defaultStripeDeps(correlationId),
      });
      checkoutNote = counterCheckoutNote(expired, recorded.openCheckouts);
      log.info(
        {
          counterPaymentId: recorded.counterPaymentId,
          openCheckouts: recorded.openCheckouts,
          ...expired,
        },
        "counter payment checkouts",
      );
    }
    refresh();
    return { replayed: recorded.replayed, checkoutNote };
  },
);

/**
 * Void a counter payment (D161d; an active admin only): recorded in error
 * (it never came in) or given back (the shop handed it back outside
 * BICII), with a reason. It never expires or refunds anything.
 */
export const voidCounterPaymentAction = staffAction(
  z.object({
    counterPaymentId: z.guid({ error: "Unknown counter payment." }),
    kind: z.enum(COUNTER_VOID_KINDS as [CounterVoidKind, ...CounterVoidKind[]], {
      error: "Choose why it is voided.",
    }),
    reason: z
      .string({ error: "Give a reason." })
      .trim()
      .min(1, { error: "Give a reason." })
      .max(REASON_MAX_LENGTH, {
        error: `Keep the reason under ${REASON_MAX_LENGTH} characters.`,
      }),
  }),
  { name: "payments.void_counter_payment", admin: true },
  async (input, { supabase }): Promise<{ replayed: boolean }> => {
    const result = await voidCounterPayment(supabase, input);
    refresh();
    return result;
  },
);
