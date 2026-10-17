/**
 * The words and states the payment screens share (Phase 14 step 2;
 * D151, D157, D159; src/lib/payments.ts): every enum value has words and
 * a tone, and Stripe's off reasons name variables, never values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Constants } from "@/lib/database.types";
import {
  DEPOSIT_STATE_LABELS,
  DEPOSIT_STATE_TONES,
  DEPOSIT_STATES,
  PAYMENT_STATUS_TONES,
  REFUND_STATUS_LABELS,
  STRIPE_EVENT_STATUS_LABELS,
  STRIPE_EVENT_STATUS_TONES,
  STRIPE_OFF_REASON_CODES,
  STRIPE_OFF_REASONS,
  STRIPE_REJECTION_LABELS,
  depositBlockedIds,
  depositPercentLabel,
  depositPercentRefusal,
  depositStates,
  incompleteCheckNote,
  collectedNotes,
  heldOverSentence,
  paidSummary,
  paymentStatusLabel,
  type PaidSummary,
  showsPaymentTotals,
  stripeConnectionLabel,
  stripeDashboardHref,
  stripeOutcomeLabel,
  type DepositState,
} from "@/lib/payments";

describe("payment labels", () => {
  it("every payment status has words and a tone", () => {
    for (const status of Constants.public.Enums.payment_status) {
      expect(paymentStatusLabel({ status, checkoutCompletedAt: null }), status).toMatch(/\w/);
      expect(PAYMENT_STATUS_TONES[status], status).toBeDefined();
    }
    expect(paymentStatusLabel({ status: "pending", checkoutCompletedAt: null })).toBe(
      "Checkout open",
    );
    expect(
      paymentStatusLabel({ status: "pending", checkoutCompletedAt: "2026-10-14T02:00:00Z" }),
    ).toBe("Being confirmed");
    expect(paymentStatusLabel({ status: "partially_refunded", checkoutCompletedAt: null })).toBe(
      "Partly refunded",
    );
  });

  it("every refund status, event status and rejection reason has words", () => {
    for (const s of Constants.public.Enums.stripe_refund_status) {
      expect(REFUND_STATUS_LABELS[s], s).toMatch(/\w/);
    }
    for (const s of Constants.public.Enums.stripe_event_status) {
      expect(STRIPE_EVENT_STATUS_LABELS[s], s).toMatch(/\w/);
      expect(STRIPE_EVENT_STATUS_TONES[s], s).toBeDefined();
    }
    for (const s of Constants.public.Enums.stripe_rejection_reason) {
      expect(STRIPE_REJECTION_LABELS[s], s).toMatch(/\w/);
    }
  });

  it("every outcome the database allows has words; an unknown one shows as stored", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261014000400_stripe_payments.sql"),
      "utf8",
    );
    const list = /stripe_events_outcome_check check \(outcome in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const outcomes = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(outcomes.length).toBeGreaterThan(20);
    for (const outcome of outcomes) {
      expect(stripeOutcomeLabel(outcome), outcome).not.toBe(outcome);
    }
    expect(stripeOutcomeLabel("something_new")).toBe("something_new");
  });

  it("every deposit state has words and a tone", () => {
    for (const state of DEPOSIT_STATES) {
      expect(DEPOSIT_STATE_LABELS[state], state).toMatch(/\w/);
      expect(DEPOSIT_STATE_TONES[state], state).toBeDefined();
    }
    expect(DEPOSIT_STATE_LABELS.due).toBe("Deposit due");
    expect(DEPOSIT_STATE_TONES.paid).toBe("done");
  });

  it("says what the deposit percent means", () => {
    expect(depositPercentLabel(0)).toBe("No deposit is asked on indent quotes");
    expect(depositPercentLabel(50)).toBe(
      "Customers pay 50% of the approved indent parts after answering",
    );
  });
});

describe("the ordering gate on screen (D152)", () => {
  it("blocks the parts whose deposit is set and not paid, like the SQL gate", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const states = new Map<string, DepositState>([
      ["a", "due"],
      ["b", "paid"],
      ["c", "refunded"],
      ["d", "processing"],
    ]);
    expect(depositBlockedIds(ids, states)).toEqual(["a", "c", "d"]);
    expect(depositBlockedIds(ids, new Map())).toEqual([]);
    expect(depositBlockedIds([], states)).toEqual([]);
    // "none" (every approved part cancelled) is not paid, so the gate holds, as in SQL.
    expect(depositBlockedIds(["n"], new Map([["n", "none" as DepositState]]))).toEqual(["n"]);
  });

  it("a request on a paid and a due quote takes the blocking state, in either order", () => {
    const paid = { state: "paid" as const, partRequestIds: ["r1", "r2"] };
    const due = { state: "due" as const, partRequestIds: ["r1"] };
    for (const deposits of [
      [paid, due],
      [due, paid],
    ]) {
      const map = depositStates(deposits);
      expect(map.get("r1")).toBe("due");
      expect(map.get("r2")).toBe("paid");
      expect(depositBlockedIds(["r1", "r2", "r3"], map)).toEqual(["r1"]);
    }
    expect(depositStates([]).size).toBe(0);
  });
});

describe("the deposit setting's rollout guard (D157a)", () => {
  it("refuses above 0 while Stripe is off; 0 is always allowed; above 0 is allowed while on", () => {
    expect(depositPercentRefusal(50, false)).toBe(
      "Set up Stripe first: customers can't pay a deposit until it is.",
    );
    expect(depositPercentRefusal(1, false)).not.toBeNull();
    expect(depositPercentRefusal(0, false)).toBeNull();
    expect(depositPercentRefusal(0, true)).toBeNull();
    expect(depositPercentRefusal(100, true)).toBeNull();
  });
});

describe("the card's totals (D161: a totals row for every job)", () => {
  const totals = { paidAtCounter: "0.00", processingOnline: "0.00" };
  it("show only with a Stripe payment, a counter payment, money being confirmed or a live link", () => {
    expect(showsPaymentTotals({ payments: [], counterPayments: [], link: null, totals })).toBe(
      false,
    );
    expect(showsPaymentTotals({ payments: [{}], totals })).toBe(true);
    expect(
      showsPaymentTotals({ payments: [], totals: { ...totals, paidAtCounter: "45.00" } }),
    ).toBe(true);
    // A voided counter payment still shows what is left to pay.
    expect(showsPaymentTotals({ payments: [], counterPayments: [{}], totals })).toBe(true);
    expect(
      showsPaymentTotals({ payments: [], totals: { ...totals, processingOnline: "10.00" } }),
    ).toBe(true);
    expect(showsPaymentTotals({ payments: [], link: {}, totals })).toBe(true);
    expect(showsPaymentTotals({ payments: [{}], totals: null })).toBe(false);
  });
});

describe("what was paid, at the counter (D154, D161)", () => {
  const totals = {
    currency: "SGD",
    netPaid: "60.00",
    netPaidOnline: "60.00",
    paidAtCounter: "0.00",
    processingOnline: "0.00",
    balanceDue: "85.00",
    paidAhead: "0.00",
  };
  const base: PaidSummary = {
    paid: "$60.00",
    source: "online",
    online: null,
    counter: null,
    stillToPay: "$85.00",
    paidAhead: null,
    moreThanBill: null,
    processing: null,
    nothingLeft: false,
  };

  it("says what was paid online and what is left, as Postgres computed it", () => {
    expect(paidSummary(totals)).toEqual(base);
    expect(paidSummary({ ...totals, balanceDue: "0.00", paidAhead: "35.00" })).toEqual({
      ...base,
      stillToPay: "$0.00",
      paidAhead: "$35.00",
    });
    // Closed (collected or cancelled): no balance, the payment still shows.
    expect(paidSummary({ ...totals, balanceDue: null, paidAhead: null })).toEqual({
      ...base,
      stillToPay: null,
    });
  });

  it("says when nothing is left to pay, from Postgres's own zero (no arithmetic)", () => {
    // Paid in full through the link: balance_due 0 and nothing paid ahead.
    expect(paidSummary({ ...totals, balanceDue: "0.00", paidAhead: "0.00" })).toEqual({
      ...base,
      stillToPay: "$0.00",
      nothingLeft: true,
    });
    // Paid ahead is not "nothing left": it says how much more was paid instead.
    expect(paidSummary({ ...totals, balanceDue: "0.00", paidAhead: "35.00" })!.nothingLeft).toBe(
      false,
    );
    // A closed job has no balance, so never "nothing left".
    expect(paidSummary({ ...totals, balanceDue: null, paidAhead: null })!.nothingLeft).toBe(false);
  });

  it("a job paid only at the counter is not 'nothing paid' (step3-critique C3)", () => {
    const counterOnly = {
      ...totals,
      netPaid: "45.00",
      netPaidOnline: "0.00",
      paidAtCounter: "45.00",
      balanceDue: "100.00",
    };
    expect(paidSummary(counterOnly)).toEqual({
      ...base,
      paid: "$45.00",
      source: "counter",
      stillToPay: "$100.00",
    });
  });

  it("names both parts when money came online and at the counter", () => {
    expect(
      paidSummary({
        ...totals,
        netPaid: "345.00",
        netPaidOnline: "300.00",
        paidAtCounter: "45.00",
        balanceDue: "35.00",
      }),
    ).toEqual({
      ...base,
      paid: "$345.00",
      source: "both",
      online: "$300.00",
      counter: "$45.00",
      stillToPay: "$35.00",
    });
  });

  it("says what Stripe is still confirming, apart from what was paid", () => {
    expect(paidSummary({ ...totals, processingOnline: "35.00" })).toEqual({
      ...base,
      processing: "$35.00",
    });
    // Nothing paid yet, but a PayNow payment is being confirmed: not null.
    expect(
      paidSummary({ ...totals, netPaid: "0.00", netPaidOnline: "0.00", processingOnline: "35.00" }),
    ).toEqual({ ...base, paid: null, processing: "$35.00" });
  });

  it("says how much a closed job holds above its bill (R-082, held_over_total)", () => {
    const closed = {
      ...totals,
      netPaid: "2.00",
      netPaidOnline: "2.00",
      balanceDue: null,
      paidAhead: null,
    };
    expect(paidSummary({ ...closed, heldOverTotal: "2.00" })).toEqual({
      ...base,
      paid: "$2.00",
      stillToPay: null,
      moreThanBill: "$2.00",
    });
    expect(paidSummary({ ...closed, heldOverTotal: "0.00" })!.moreThanBill).toBeNull();
    // Open jobs say Paid ahead or Still to pay instead, whatever is held over.
    expect(
      paidSummary({ ...totals, balanceDue: "0.00", paidAhead: "35.00", heldOverTotal: "35.00" })!
        .moreThanBill,
    ).toBeNull();
  });

  it("is null only when nothing is paid and nothing is being confirmed", () => {
    expect(paidSummary(null)).toBeNull();
    expect(paidSummary({ ...totals, netPaid: "0.00", netPaidOnline: "0.00" })).toBeNull();
    // A refunded online payment with counter money still counts the counter money.
    expect(
      paidSummary({ ...totals, netPaid: "10.00", netPaidOnline: "0.00", paidAtCounter: "10.00" })
        ?.source,
    ).toBe("counter");
  });
});

describe("held above the bill on a closed job names the source (R-082, D161d)", () => {
  const closed = { currency: "SGD", jobTotal: "0.00", balanceDue: null, heldOverTotal: "2.00" };
  it("online money is refunded in Stripe", () => {
    expect(heldOverSentence({ ...closed, netPaidOnline: "2.00", paidAtCounter: "0.00" })).toBe(
      "$2.00 was paid online above this job's bill of $0.00. Refund it in Stripe if it is due back, or agree with the customer how it counts.",
    );
    // Without the split (older callers) it reads as before.
    expect(heldOverSentence(closed)).toBe(
      "$2.00 was paid online above this job's bill of $0.00. Refund it in Stripe if it is due back, or agree with the customer how it counts.",
    );
  });

  it("counter money given back is recorded by an admin, never 'refund it in Stripe'", () => {
    const sentence = heldOverSentence({ ...closed, netPaidOnline: "0.00", paidAtCounter: "2.00" });
    expect(sentence).toBe(
      "$2.00 was paid at the counter above this job's bill of $0.00. If it is given back, an admin records it as given back; or agree with the customer how it counts.",
    );
    expect(sentence).not.toContain("Stripe");
  });

  it("both: the online part in Stripe, the counter part by an admin", () => {
    expect(
      heldOverSentence({
        ...closed,
        heldOverTotal: "50.00",
        jobTotal: "100.00",
        netPaidOnline: "100.00",
        paidAtCounter: "50.00",
      }),
    ).toBe(
      "$50.00 was paid above this job's bill of $100.00. Refund the online part in Stripe, or an admin records counter money given back; or agree with the customer how it counts.",
    );
  });

  it("nothing while the job is open or nothing is held over", () => {
    expect(heldOverSentence({ ...closed, balanceDue: "0.00" })).toBeNull();
    expect(heldOverSentence({ ...closed, heldOverTotal: "0.00" })).toBeNull();
    expect(heldOverSentence({ currency: "SGD", jobTotal: "5.00", balanceDue: null })).toBeNull();
  });
});

describe("the Collected confirmation's sentences (D154, D161; D149b)", () => {
  const paid: PaidSummary = {
    paid: "$2.00",
    source: "online",
    online: null,
    counter: null,
    stillToPay: "$0.00",
    paidAhead: "$2.00",
    moreThanBill: null,
    processing: null,
  };

  it("says what was paid online and what to take; nothing when nothing was", () => {
    expect(collectedNotes(paid)).toEqual([
      "$2.00 was paid online. That is $2.00 more than the job total; take nothing more.",
    ]);
    expect(collectedNotes({ ...paid, paidAhead: null, stillToPay: "$85.00" })).toEqual([
      "$2.00 was paid online. Take only $85.00.",
    ]);
    expect(collectedNotes({ ...paid, paidAhead: null, stillToPay: null })).toEqual([
      "$2.00 was paid online. Take only what is left of the job total.",
    ]);
    expect(collectedNotes(null)).toEqual([]);
  });

  it("a counter-only job says 'at the counter', so staff never take the full total again", () => {
    expect(
      collectedNotes({ ...paid, source: "counter", paidAhead: null, stillToPay: "$35.00" }),
    ).toEqual(["$2.00 was paid at the counter. Take only $35.00."]);
  });

  it("a mixed job names both parts", () => {
    expect(
      collectedNotes({
        ...paid,
        paid: "$345.00",
        source: "both",
        online: "$300.00",
        counter: "$45.00",
        paidAhead: null,
        stillToPay: "$35.00",
      }),
    ).toEqual(["$345.00 was paid ($300.00 online, $45.00 at the counter). Take only $35.00."]);
  });

  it("says take nothing once nothing is left to pay, never 'Take only $0.00.'", () => {
    const notes = collectedNotes({
      ...paid,
      paid: "$135.00",
      paidAhead: null,
      stillToPay: "$0.00",
      nothingLeft: true,
    });
    expect(notes).toEqual(["$135.00 was paid online. Nothing is left to pay; take nothing."]);
    expect(notes.join(" ")).not.toContain("Take only");
  });

  it("names no amount to take while Stripe is still confirming a payment (no double charge)", () => {
    // $200 job, $50 deposit paid, the $150 balance paid by PayNow and pending.
    const confirming = collectedNotes({
      ...paid,
      paid: "$50.00",
      paidAhead: null,
      stillToPay: "$150.00",
      processing: "$150.00",
    });
    expect(confirming).toEqual([
      "$50.00 was paid online.",
      "Stripe is still confirming $150.00 paid online, so $150.00 still to pay may already be covered. Press Check with Stripe before taking anything.",
    ]);
    expect(confirming.join(" ")).not.toContain("Take only");
    // Nothing paid yet, only Stripe money being confirmed: the same warning.
    const onlyProcessing = collectedNotes({
      ...paid,
      paid: null,
      paidAhead: null,
      stillToPay: "$200.00",
      processing: "$150.00",
    });
    expect(onlyProcessing).toEqual([
      "Stripe is still confirming $150.00 paid online, so $200.00 still to pay may already be covered. Press Check with Stripe before taking anything.",
    ]);
    expect(onlyProcessing.join(" ")).not.toContain("Take only");
    // No balance (outside SGD): no amount at all.
    const noBalance = collectedNotes({
      ...paid,
      paidAhead: null,
      stillToPay: null,
      processing: "$85.00",
    });
    expect(noBalance).toEqual([
      "$2.00 was paid online.",
      "Stripe is still confirming $85.00 paid online, so what is left of the job total may already be covered. Press Check with Stripe before taking anything.",
    ]);
    expect(noBalance.join(" ")).not.toContain("Take only");
  });

  it("keeps 'take nothing' and adds the plain sentence when nothing is left anyway", () => {
    expect(collectedNotes({ ...paid, processing: "$85.00" })).toEqual([
      "$2.00 was paid online. That is $2.00 more than the job total; take nothing more.",
      "$85.00 paid online is being confirmed by Stripe; don't take it again.",
    ]);
    expect(
      collectedNotes({
        ...paid,
        paidAhead: null,
        stillToPay: "$0.00",
        nothingLeft: true,
        processing: "$85.00",
      }),
    ).toEqual([
      "$2.00 was paid online. Nothing is left to pay; take nothing.",
      "$85.00 paid online is being confirmed by Stripe; don't take it again.",
    ]);
  });
});

describe("Open in Stripe", () => {
  it("links a PaymentIntent in the right mode, and nothing else", () => {
    expect(stripeDashboardHref("pi_3Abc_def", true)).toBe(
      "https://dashboard.stripe.com/payments/pi_3Abc_def",
    );
    expect(stripeDashboardHref("pi_3Abc", false)).toBe(
      "https://dashboard.stripe.com/test/payments/pi_3Abc",
    );
    expect(stripeDashboardHref(null, true)).toBeNull();
    expect(stripeDashboardHref("cs_test_abc", false)).toBeNull();
    expect(stripeDashboardHref("pi_../../x", false)).toBeNull();
  });
});

describe("Stripe's state on Settings (D157)", () => {
  it("every off reason has a sentence that names a variable, never a value", () => {
    for (const reason of STRIPE_OFF_REASON_CODES) {
      const sentence = STRIPE_OFF_REASONS[reason];
      expect(sentence, reason).toMatch(/\w/);
      expect(sentence, reason).not.toContain("=");
      expect(sentence, reason).not.toMatch(/(sk|rk|pk)_(live|test)_[A-Za-z0-9]/);
      expect(sentence, reason).not.toMatch(/whsec_[A-Za-z0-9]/);
    }
    expect(STRIPE_OFF_REASONS.test_key_in_production).toBe(
      "STRIPE_SECRET_KEY is a test key; Production takes a live key only.",
    );
  });

  it("labels the connection", () => {
    expect(stripeConnectionLabel({ state: "on", mode: "live", reason: null })).toBe("Live");
    expect(stripeConnectionLabel({ state: "on", mode: "test", reason: null })).toBe("Test mode");
    expect(stripeConnectionLabel({ state: "on", mode: "fake", reason: null })).toBe(
      "Fake Stripe (development and tests only)",
    );
    expect(stripeConnectionLabel({ state: "off", mode: null, reason: "preview" })).toBe(
      `Off: ${STRIPE_OFF_REASONS.preview}`,
    );
  });
});

describe("Check with Stripe, incomplete (R-086)", () => {
  it("names the key's permissions only when Stripe refused the key", () => {
    const permission = incompleteCheckNote("permission");
    expect(permission).toContain("permissions");
    expect(permission).toContain("RUNBOOK “Stripe: restricted key”");
    const unavailable = incompleteCheckNote("unavailable");
    expect(unavailable).toContain("Stripe could not be reached; try again");
    expect(unavailable).not.toMatch(/permission|key/i);
    const error = incompleteCheckNote("error");
    expect(error).toContain("could not use Stripe's answer");
    expect(error).toContain("RUNBOOK “Stripe: resolving problems”");
    expect(error).not.toMatch(/permission|key|try again/i);
  });
});
