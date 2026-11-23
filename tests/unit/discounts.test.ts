/**
 * The discount sheet's arithmetic and inputs (D271). The per-line
 * allocation is the database's (tests/db/job-discounts.test.ts).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { applyDiscountSchema, previewDiscountSchema } from "@/lib/discount-forms";
import { discountAmount } from "@/lib/discounts";
import { describeEvent } from "@/lib/workshop-timeline";

describe("discountAmount", () => {
  it("takes the amount off as typed, to the cent", () => {
    expect(discountAmount("amount", "10", "120.00")).toEqual({ ok: true, amount: "10.00" });
    expect(discountAmount("amount", "120", "120.00")).toEqual({ ok: true, amount: "120.00" });
  });

  it("rounds to a new total: the difference comes off", () => {
    expect(discountAmount("target", "100", "123.45")).toEqual({ ok: true, amount: "23.45" });
    expect(discountAmount("target", "0", "50.00")).toEqual({ ok: true, amount: "50.00" });
  });

  it("is empty until something is typed, and refuses what the job can't take", () => {
    expect(discountAmount("amount", "", "120.00")).toEqual({ ok: false, error: null });
    expect(discountAmount("amount", "0", "120.00")).toMatchObject({ ok: false });
    expect(discountAmount("amount", "120.01", "120.00")).toEqual({
      ok: false,
      error: "That's more than the job's total.",
    });
    expect(discountAmount("target", "120", "120.00")).toMatchObject({ ok: false });
    expect(discountAmount("target", "abc", "120.00")).toMatchObject({ ok: false });
  });
});

describe("discount schemas", () => {
  const ids = { requestId: randomUUID(), workOrderId: randomUUID() };

  it("needs an amount above zero and a reason", () => {
    expect(
      applyDiscountSchema.safeParse({ ...ids, amount: "5", reason: " Regular " }).data,
    ).toEqual({ ...ids, amount: "5.00", reason: "Regular" });
    expect(applyDiscountSchema.safeParse({ ...ids, amount: "0", reason: "x" }).success).toBe(false);
    expect(applyDiscountSchema.safeParse({ ...ids, amount: "5", reason: "  " }).success).toBe(
      false,
    );
    expect(
      applyDiscountSchema.safeParse({ ...ids, amount: "5", reason: "x".repeat(301) }).success,
    ).toBe(false);
    expect(
      previewDiscountSchema.safeParse({ workOrderId: ids.workOrderId, amount: "2.5" }).data,
    ).toEqual({ workOrderId: ids.workOrderId, amount: "2.50" });
  });
});

describe("the discount on the timeline", () => {
  it("names the amount, the new total and the reason", () => {
    expect(
      describeEvent({
        type: "discount_applied",
        payload: { amount: "23.45", total_after: "100.00", reason: "Round to 100" },
      }),
    ).toMatchObject({
      title: "Discount of $23.45, new total $100.00",
      detail: "Round to 100",
    });
  });
});
