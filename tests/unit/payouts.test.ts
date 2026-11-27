import { describe, expect, it } from "vitest";

import {
  carryOverWords,
  formatMonth,
  outstandingWords,
  parseMonth,
  prefillAmount,
  recordPayoutSchema,
  reserveWords,
  reversePayoutSchema,
  servicePayRuleSchema,
  shiftMonth,
} from "@/lib/payouts";

// 28 Nov 2026, 10:00 in Singapore.
const NOW = new Date("2026-11-28T02:00:00Z");
const ID = "0b6c1f7e-3f7a-4a51-9a51-1d8b8f0c2a11";

describe("payout months (D276)", () => {
  it("defaults to last month and refuses a future or malformed month", () => {
    expect(parseMonth(undefined, NOW)).toBe("2026-10");
    expect(parseMonth("2026-11", NOW)).toBe("2026-11");
    expect(parseMonth("2026-12", NOW)).toBe("2026-10");
    expect(parseMonth("2026-13", NOW)).toBe("2026-10");
    expect(parseMonth("1999-12", NOW)).toBe("2026-10");
    expect(parseMonth(["2026-09"], NOW)).toBe("2026-10");
    // Shop time: 1 Dec 00:30 in Singapore is still 30 Nov in UTC.
    expect(parseMonth(undefined, new Date("2026-11-30T16:30:00Z"))).toBe("2026-11");
  });

  it("steps across years and names the month", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(formatMonth("2026-10")).toBe("October 2026");
  });
});

describe("payout words (D276)", () => {
  it("says what is left, paid, or over", () => {
    expect(outstandingWords("3000.00", "SGD")).toBe("$3,000.00 to pay");
    expect(outstandingWords("0.00", "SGD")).toBe("Paid");
    expect(outstandingWords("-500.00", "SGD")).toBe("Over by $500.00");
  });

  it("says when the reserve is overdrawn and what earlier months still owe", () => {
    expect(reserveWords("500.00", "SGD")).toBe("$500.00");
    expect(reserveWords("-100.00", "SGD")).toBe("Reserve overdrawn by $100.00");
    expect(carryOverWords("0.00", "SGD")).toBeNull();
    expect(carryOverWords("250.00", "SGD")).toBe("Still owed from earlier months: $250.00");
    expect(carryOverWords("-20.00", "SGD")).toBe("Paid ahead by $20.00");
  });

  it("prefills Record payment with the month's outstanding only when something is owed", () => {
    expect(prefillAmount("3000.00")).toBe("3000.00");
    expect(prefillAmount("0.00")).toBe("");
    expect(prefillAmount("-5.00")).toBe("");
  });
});

describe("payout schemas (D276)", () => {
  const base = { id: ID, amount: "3,000", paidAt: null, reference: " PayNow ", notes: "" };

  it("takes a mechanic's pay with the month and the mechanic", () => {
    const r = recordPayoutSchema.safeParse({
      ...base,
      kind: "mechanic_pay",
      month: "2026-10-01",
      staffId: ID,
    });
    expect(r.success && r.data).toMatchObject({
      amount: "3000.00",
      month: "2026-10-01",
      staffId: ID,
      payeeName: null,
      reference: "PayNow",
      notes: null,
    });
    expect(
      recordPayoutSchema.safeParse({ ...base, kind: "mechanic_pay", month: "2026-10-01" }).success,
    ).toBe(false);
    expect(recordPayoutSchema.safeParse({ ...base, kind: "cult_commons" }).success).toBe(false);
    expect(
      recordPayoutSchema.safeParse({
        ...base,
        kind: "cult_commons",
        month: "2026-10-01",
        amount: "0",
      }).success,
    ).toBe(false);
  });

  it("ad hoc labour needs a staff member or a name, not both", () => {
    expect(
      recordPayoutSchema.safeParse({ ...base, kind: "reserve_labour", payeeName: "Ah Seng" })
        .success,
    ).toBe(true);
    expect(
      recordPayoutSchema.safeParse({ ...base, kind: "reserve_labour", staffId: ID }).success,
    ).toBe(true);
    expect(recordPayoutSchema.safeParse({ ...base, kind: "reserve_labour" }).success).toBe(false);
    expect(
      recordPayoutSchema.safeParse({ ...base, kind: "reserve_labour", staffId: ID, payeeName: "X" })
        .success,
    ).toBe(false);
  });

  it("a reversal needs a reason; a pay rule a mechanic, a cap of 0 or more and a month", () => {
    expect(reversePayoutSchema.safeParse({ payoutId: ID, reason: "  " }).success).toBe(false);
    expect(reversePayoutSchema.safeParse({ payoutId: ID, reason: "Typo" }).success).toBe(true);
    const rule = servicePayRuleSchema.safeParse({
      staffId: ID,
      monthlyCap: "3000",
      effectiveFrom: "2026-11",
    });
    expect(rule.success && rule.data).toEqual({
      staffId: ID,
      monthlyCap: "3000.00",
      effectiveFrom: "2026-11-01",
    });
    expect(
      servicePayRuleSchema.safeParse({ staffId: ID, monthlyCap: "-1", effectiveFrom: "2026-11" })
        .success,
    ).toBe(false);
    expect(
      servicePayRuleSchema.safeParse({ staffId: ID, monthlyCap: "1", effectiveFrom: "2026-11-01" })
        .success,
    ).toBe(false);
  });
});
