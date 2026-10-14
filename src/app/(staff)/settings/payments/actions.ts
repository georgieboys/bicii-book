"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { setIndentDepositPercent } from "@/lib/domain/payments";
import { stripeConnection } from "@/lib/integrations/stripe/client";

/**
 * Settings → Customer payments (admins only; Phase 14 step 2; D151,
 * D157a). The RPC checks the admin again and records the change in the
 * schedule history; the same value again changes nothing. Above 0 needs
 * Stripe on: a deposit nobody can pay online would only hold up indent
 * orders. Setting 0 is always allowed (the RUNBOOK's switch-off order).
 */
const percent = z.coerce
  .number({ error: "Enter a percent from 0 to 100." })
  .int({ error: "Enter a whole percent." })
  .min(0, { error: "Choose from 0 to 100%." })
  .max(100, { error: "Choose from 0 to 100%." });

export const setDepositPercentAction = staffAction(
  z.object({ percent }),
  { name: "payments.set_deposit_percent", admin: true },
  async ({ percent }, { supabase }) => {
    if (percent > 0 && stripeConnection().state !== "on") {
      throw new ActionError("Set up Stripe first: customers can't pay a deposit until it is.", {
        percent: ["Set up Stripe first: customers can't pay a deposit until it is."],
      });
    }
    const value = await setIndentDepositPercent(supabase, percent);
    refresh();
    return { percent: value };
  },
);
