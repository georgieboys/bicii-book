"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import { recordPayout, reversePayout, setServicePayRule } from "@/lib/domain/payouts";
import { recordPayoutSchema, reversePayoutSchema, servicePayRuleSchema } from "@/lib/payouts";

/**
 * Month-end payouts (D276; src/lib/domain/payouts.ts). Admins only, as the
 * RPCs check again (private.require_admin). Payout ids are made when the
 * sheet opens, so a retry records once.
 */

export const recordPayoutAction = staffAction(
  recordPayoutSchema,
  { name: "payouts.record_payout", admin: true },
  async (input, { supabase }) => {
    const result = await recordPayout(supabase, input);
    refresh();
    return result;
  },
);

export const reversePayoutAction = staffAction(
  reversePayoutSchema,
  { name: "payouts.reverse_payout", admin: true },
  async (input, { supabase }) => {
    await reversePayout(supabase, input);
    refresh();
    return null;
  },
);

export const setServicePayRuleAction = staffAction(
  servicePayRuleSchema,
  { name: "payouts.set_service_pay_rule", admin: true },
  async (input, { supabase }) => {
    await setServicePayRule(supabase, input);
    refresh();
    return null;
  },
);
