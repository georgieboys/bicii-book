/**
 * Input schemas of the job discount Server Actions (D271). Pure, so they
 * are unit-tested directly; apply_job_discount checks again (the amount is
 * at most the job's total, the job is not collected or cancelled).
 */
import { z } from "zod";

import { money } from "@/lib/inventory-forms";
import { parseMoney } from "@/lib/money";

export const DISCOUNT_REASON_MAX = 300;

const amount = money("amount to take off").refine((v) => parseMoney(v)!.greaterThan(0), {
  error: "Take off an amount above zero.",
});

export const previewDiscountSchema = z.object({
  workOrderId: z.guid({ error: "Open the job again." }),
  amount,
});

export const applyDiscountSchema = z.object({
  requestId: z.guid({ error: "Open the form again." }),
  workOrderId: z.guid({ error: "Open the job again." }),
  amount,
  reason: z
    .string({ error: "Say why the job is discounted." })
    .trim()
    .min(1, { error: "Say why the job is discounted." })
    .max(DISCOUNT_REASON_MAX, {
      error: `Keep the reason under ${DISCOUNT_REASON_MAX} characters.`,
    }),
});
