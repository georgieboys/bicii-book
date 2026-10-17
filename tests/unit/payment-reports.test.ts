/**
 * Customer payments on Reports, in words (Phase 14 step 3; PLAN D154a–e;
 * src/lib/payment-reports.ts): the movement, kind and method labels, the
 * notes that say these figures are not sales, the integer movement count
 * the export checks, the three held lists (their order, their own display
 * totals, no grand total), each held job's line, and the list's cursor.
 * The SQL itself is tests/db/payment-reports.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  COUNTER_RECORDED_NOTE,
  HELD_BASIS_NOTE,
  HELD_GROUPS,
  HELD_GROUP_COPY,
  MOVEMENT_LABELS,
  PAYMENTS_NOT_SALES_NOTE,
  PAYMENT_MOVEMENTS,
  heldGroups,
  heldJobDetail,
  heldStatusLabel,
  isOutgoing,
  movementCount,
  movementLabel,
  otherCurrencyNote,
  parsePaymentCursor,
  paymentKindLabel,
  paymentMethodLabel,
  type HeldJob,
} from "@/lib/payment-reports";

const JOB_A = "66666666-7777-4888-9999-000000000001";
const JOB_B = "66666666-7777-4888-9999-000000000002";
const JOB_C = "66666666-7777-4888-9999-000000000003";

const held = (over: Partial<HeldJob>): HeldJob => ({
  group: "open",
  workOrderId: JOB_A,
  jobNumber: "J-000001",
  jobHref: `/jobs/${JOB_A}`,
  status: "in_progress",
  customerLabel: "Ana Lim",
  amount: "0.00",
  netPaid: "0.00",
  netPaidOnline: "0.00",
  paidAtCounter: "0.00",
  jobTotal: "0.00",
  balanceDue: "0.00",
  paidAhead: "0.00",
  currency: "SGD",
  ...over,
});

describe("the movement vocabulary (D154b, D154d)", () => {
  it("labels the four movements of reporting.payment_movements", () => {
    expect([...PAYMENT_MOVEMENTS]).toEqual([
      "online_payment",
      "online_refund",
      "counter_payment",
      "counter_given_back",
    ]);
    expect(MOVEMENT_LABELS).toEqual({
      online_payment: "Taken online",
      online_refund: "Refunded online",
      counter_payment: "Recorded at the counter",
      counter_given_back: "Given back at the counter",
    });
    expect(movementLabel("counter_payment")).toBe("Recorded at the counter");
    // A movement a later migration adds still reads as something.
    expect(movementLabel("future_kind")).toBe("future_kind");
  });

  it("marks money going back to the customer", () => {
    expect(isOutgoing("online_refund")).toBe(true);
    expect(isOutgoing("counter_given_back")).toBe(true);
    expect(isOutgoing("online_payment")).toBe(false);
    expect(isOutgoing("counter_payment")).toBe(false);
  });

  it("names the kind as the job card does: a counter balance is towards the bill", () => {
    expect(paymentKindLabel("online_payment", "deposit")).toBe("Deposit");
    expect(paymentKindLabel("counter_payment", "deposit")).toBe("Deposit");
    expect(paymentKindLabel("online_payment", "balance")).toBe("Balance");
    expect(paymentKindLabel("online_refund", "balance")).toBe("Balance");
    expect(paymentKindLabel("counter_payment", "balance")).toBe("Towards the bill");
    expect(paymentKindLabel("counter_given_back", "balance")).toBe("Towards the bill");
    expect(paymentKindLabel("online_payment", "other")).toBe("other");
  });

  it("names the method: Stripe online, the counter method otherwise", () => {
    expect(paymentMethodLabel("stripe")).toBe("Stripe");
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("paynow")).toBe("PayNow");
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(paymentMethodLabel("cheque")).toBe("cheque");
  });
});

describe("the copy", () => {
  it("says the figures are not sales and what the counter figure is", () => {
    expect(PAYMENTS_NOT_SALES_NOTE).toBe(
      "Not sales: money taken and given back by the day it moved.",
    );
    expect(COUNTER_RECORDED_NOTE).toBe(
      "Recorded at the counter: only what an admin recorded in BICII; not the till's takings.",
    );
    expect(HELD_BASIS_NOTE).toBe(
      "Not sales. On the Sale date basis, a job counts as sales on the day it is completed, so the second list is already in that figure and the others are not.",
    );
  });

  it("notes other-currency payments only when there are some", () => {
    expect(otherCurrencyNote(0)).toBeNull();
    expect(otherCurrencyNote(-1)).toBeNull();
    expect(otherCurrencyNote(1)).toMatch(/^1 payment in another currency is /);
    expect(otherCurrencyNote(3)).toMatch(/^3 payments in another currency are /);
  });

  it("titles the three held lists", () => {
    expect([...HELD_GROUPS]).toEqual(["open", "awaiting_collection", "above_bill"]);
    expect(HELD_GROUP_COPY.open.title).toBe("Paid on open jobs");
    expect(HELD_GROUP_COPY.awaiting_collection.title).toBe("Paid on jobs awaiting collection");
    expect(HELD_GROUP_COPY.above_bill.title).toBe("Paid above the bill");
  });
});

describe("movementCount", () => {
  it("adds the four integer counts (the export's consistency check)", () => {
    expect(
      movementCount({ onlineCount: 3, refundCount: 1, counterCount: 2, givenBackCount: 1 }),
    ).toBe(7);
    expect(
      movementCount({ onlineCount: 0, refundCount: 0, counterCount: 0, givenBackCount: 0 }),
    ).toBe(0);
  });
});

describe("heldGroups (D154c)", () => {
  it("keeps the three lists in order, each with its own total, and no grand total", () => {
    const lists = heldGroups([
      held({ group: "open", workOrderId: JOB_A, amount: "300.00" }),
      held({ group: "open", workOrderId: JOB_B, amount: "0.10" }),
      held({ group: "open", workOrderId: JOB_C, amount: "0.20" }),
      held({ group: "above_bill", workOrderId: JOB_A, amount: "45.50" }),
    ]);
    expect(lists.map((l) => l.group)).toEqual(["open", "awaiting_collection", "above_bill"]);
    // Exact decimal addition: 300.00 + 0.10 + 0.20, never 300.30000000000001.
    expect(lists[0].total).toBe("300.30");
    expect(lists[0].rows.map((r) => r.workOrderId)).toEqual([JOB_A, JOB_B, JOB_C]);
    expect(lists[1]).toEqual({
      group: "awaiting_collection",
      rows: [],
      total: "0.00",
      currency: "SGD",
    });
    expect(lists[2].total).toBe("45.50");
    expect(lists).toHaveLength(3);
  });

  it("shows three empty lists when nothing is held", () => {
    const lists = heldGroups([]);
    expect(lists.map((l) => [l.group, l.rows.length, l.total])).toEqual([
      ["open", 0, "0.00"],
      ["awaiting_collection", 0, "0.00"],
      ["above_bill", 0, "0.00"],
    ]);
  });
});

describe("heldJobDetail", () => {
  it("an open job: status, where it was paid, and paid ahead only when above 0", () => {
    expect(
      heldJobDetail(held({ netPaid: "300.00", netPaidOnline: "300.00", paidAhead: "0.00" })),
    ).toBe("In progress · Paid online");
    expect(
      heldJobDetail(
        held({
          netPaid: "350.00",
          netPaidOnline: "300.00",
          paidAtCounter: "50.00",
          paidAhead: "20.00",
        }),
      ),
    ).toBe("In progress · $300.00 online, $50.00 at the counter · Paid ahead $20.00");
  });

  it("a job awaiting collection: still to pay beside it, even with nothing paid", () => {
    expect(
      heldJobDetail(
        held({
          group: "awaiting_collection",
          status: "ready_for_collection",
          paidAtCounter: "100.00",
          balanceDue: "45.00",
        }),
      ),
    ).toBe("Ready for collection · Paid at the counter · Still to pay $45.00");
    expect(
      heldJobDetail(
        held({ group: "awaiting_collection", status: "completed", balanceDue: "80.00" }),
      ),
    ).toBe("Completed · Still to pay $80.00");
  });

  it("a job paid above its bill: what was paid of what bill", () => {
    expect(
      heldJobDetail(
        held({
          group: "above_bill",
          status: "collected",
          amount: "20.00",
          netPaid: "165.00",
          netPaidOnline: "165.00",
          jobTotal: "145.00",
          balanceDue: null,
          paidAhead: null,
        }),
      ),
    ).toBe("Collected · Paid online · Paid $165.00 of a $145.00 bill");
  });

  it("labels an unknown status as it came", () => {
    expect(heldStatusLabel("cancelled")).toBe("Cancelled");
    expect(heldStatusLabel("archived")).toBe("archived");
  });
});

describe("parsePaymentCursor", () => {
  it("is none without either half, and the pair exactly as received with both", () => {
    expect(parsePaymentCursor(undefined, undefined)).toBeNull();
    expect(parsePaymentCursor("2026-10-17T03:04:05.123456+00:00", JOB_A)).toEqual({
      at: "2026-10-17T03:04:05.123456+00:00",
      id: JOB_A,
    });
    expect(parsePaymentCursor("2026-10-17T03:04:05Z", JOB_A)).toEqual({
      at: "2026-10-17T03:04:05Z",
      id: JOB_A,
    });
  });

  it("is invalid when only one half is there or either is malformed", () => {
    expect(parsePaymentCursor("2026-10-17T03:04:05Z", undefined)).toBe("invalid");
    expect(parsePaymentCursor(undefined, JOB_A)).toBe("invalid");
    expect(parsePaymentCursor("", JOB_A)).toBe("invalid");
    expect(parsePaymentCursor("2026-10-17", JOB_A)).toBe("invalid");
    expect(parsePaymentCursor("2026-10-17T03:04:05Z", "not-a-uuid")).toBe("invalid");
    expect(parsePaymentCursor("2026-10-17T03:04:05Z", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(
      "invalid",
    );
  });
});
