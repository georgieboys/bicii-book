"use server";

import { refresh } from "next/cache";

import { staffAction } from "@/lib/actions";
import { applyDiscountSchema, previewDiscountSchema } from "@/lib/discount-forms";
import { applyJobDiscount, previewJobDiscount } from "@/lib/domain/discounts";

/**
 * D271: a discount or round-off on a job, for any active staff member. The
 * preview shows each line's new price; apply_job_discount does the
 * arithmetic, reopens and completes again a completed or ready job, and is
 * replay-safe by the sheet's request id.
 */

export const previewJobDiscountAction = staffAction(
  previewDiscountSchema,
  { name: "jobs.preview_discount" },
  async ({ workOrderId, amount }, { supabase }) =>
    previewJobDiscount(supabase, workOrderId, amount),
);

export const applyJobDiscountAction = staffAction(
  applyDiscountSchema,
  { name: "jobs.apply_discount" },
  async (input, { supabase }) => {
    const result = await applyJobDiscount(supabase, input);
    refresh();
    return result;
  },
);
