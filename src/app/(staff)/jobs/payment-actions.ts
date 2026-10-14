"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { unwrap } from "@/lib/db-errors";
import { refreshPaymentFromStripe } from "@/lib/integrations/stripe/checkout";
import { defaultStripeDeps } from "@/lib/integrations/stripe/deps";
import { noteStripeCheck } from "@/lib/integrations/stripe/limits";
import type { PaymentStatus } from "@/lib/payments";

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
  z.object({ paymentId: z.uuid({ error: "Unknown payment." }) }),
  { name: "payments.check_with_stripe" },
  async (
    { paymentId },
    { supabase, correlationId },
  ): Promise<{ changed: boolean; after: PaymentStatus }> => {
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
        return { changed: result.changed, after: result.after };
      case "other_mode":
        throw new ActionError(
          "This payment was made in Stripe's other mode (test or live) and can't be checked here.",
        );
      case "not_found":
        throw new ActionError("That payment no longer exists.");
      case "unavailable":
        throw new ActionError(
          "Stripe can't be reached right now, or it isn't set up. Try again in a few minutes.",
        );
    }
  },
);
