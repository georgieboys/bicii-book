/**
 * The pure words and rules of Phase 14 step 3's staff screens
 * (src/lib/payments.ts; D156, D161; step3-critique C15, C19): the counter
 * payment sheet's choices, prefill, warnings and commit labels, what the
 * admin is told after the job's open Checkouts are expired, the live
 * link's line, when "Send payment link" applies, and the message and email
 * a link is sent with. Nothing here computes stored money: the warnings
 * compare what was typed with Postgres's figures, on display only.
 */
import { describe, expect, it } from "vitest";

import { Constants } from "@/lib/database.types";
import {
  COUNTER_METHODS,
  COUNTER_METHOD_LABELS,
  COUNTER_VOID_KINDS,
  COUNTER_VOID_LABELS,
  balanceEmail,
  balanceMessage,
  canSendLink,
  counterCheckoutNote,
  counterCommitLabels,
  counterDayRange,
  counterDepositChoices,
  counterDepositLabel,
  counterPrefill,
  counterReceivedAt,
  counterWarnings,
  depositBadge,
  linkLine,
  payPath,
  replacedLinkCheckoutNote,
  type DepositState,
} from "@/lib/payments";

describe("counter payment words (D161b, D161d)", () => {
  it("every method and void kind the database allows has a label, in its order", () => {
    expect(COUNTER_METHODS).toEqual(Constants.public.Enums.counter_payment_method);
    expect(COUNTER_VOID_KINDS).toEqual(Constants.public.Enums.counter_void_kind);
    expect(COUNTER_METHODS.map((m) => COUNTER_METHOD_LABELS[m])).toEqual([
      "Cash",
      "Card",
      "PayNow",
      "Bank transfer",
      "Other",
    ]);
    expect(COUNTER_VOID_LABELS).toEqual({
      recorded_in_error: "Recorded in error",
      given_back: "Given back",
    });
  });

  it("the commit repeats the amount and the method, then the amount (C19)", () => {
    expect(counterCommitLabels("$3,800.00", "cash")).toEqual({
      start: "Record $3,800.00 cash…",
      confirm: "Record $3,800.00",
    });
    expect(counterCommitLabels("$12.50", "card").start).toBe("Record $12.50 by card…");
    expect(counterCommitLabels("$12.50", "paynow").start).toBe("Record $12.50 by PayNow…");
    expect(counterCommitLabels("$12.50", "bank_transfer").start).toBe(
      "Record $12.50 by bank transfer…",
    );
    expect(counterCommitLabels("$12.50", "other").start).toBe("Record $12.50 paid another way…");
    expect(counterCommitLabels(null, "cash")).toEqual({
      start: "Record payment…",
      confirm: "Record payment",
    });
  });
});

const deposit = (state: DepositState, quoteId = "q1") => ({
  quoteId,
  state,
  amount: "300.00",
  currency: "SGD",
  answeredAt: "2026-10-12T04:00:00Z",
});

describe("what a counter payment can settle (D161f, C19)", () => {
  it("offers each deposit that is due or refunded, on any job but a cancelled one", () => {
    const all = (["due", "processing", "paid", "refunded", "none"] as const).map((s) =>
      deposit(s, s),
    );
    for (const status of [
      "in_progress",
      "completed",
      "ready_for_collection",
      "collected",
    ] as const) {
      expect(counterDepositChoices(all, status).map((d) => d.state)).toEqual(["due", "refunded"]);
    }
    expect(counterDepositChoices(all, "cancelled")).toEqual([]);
  });

  it("names the deposit with its fixed amount and the quote's answer", () => {
    expect(counterDepositLabel(deposit("due"))).toBe(
      "Record the $300.00 deposit for the quote answered 12 Oct 2026",
    );
    expect(counterDepositLabel({ ...deposit("due"), answeredAt: null })).toBe(
      "Record the $300.00 deposit for the quote",
    );
  });

  it("towards the bill starts at what is left to pay, else empty", () => {
    expect(counterPrefill("35.00")).toBe("35.00");
    expect(counterPrefill("0.00")).toBe("");
    expect(counterPrefill(null)).toBe("");
  });
});

describe("the counter payment sheet's warnings, which never refuse (C19)", () => {
  const base = {
    choice: "bill" as const,
    amount: "",
    currency: "SGD",
    jobStatus: "in_progress" as const,
    jobOpen: true,
    dueDeposit: null,
    balanceDue: "145.00",
    jobTotal: "145.00",
  };
  const due = { amount: "300.00", currency: "SGD" };

  it("towards the bill while a deposit is due on an open job: the quote page still asks it", () => {
    expect(counterWarnings({ ...base, dueDeposit: due }).warnings).toEqual([
      "The customer's quote page still asks the full $300.00 deposit online. Record the deposit instead if this money is for it.",
    ]);
    // Recording the deposit itself: no warning.
    expect(counterWarnings({ ...base, dueDeposit: due, choice: "deposit" }).warnings).toEqual([]);
  });

  it("a deposit due on a completed or ready job stays due unless recorded as the deposit", () => {
    for (const jobStatus of ["completed", "ready_for_collection"] as const) {
      expect(
        counterWarnings({ ...base, jobStatus, jobOpen: false, dueDeposit: due }).warnings,
      ).toEqual([
        "The deposit stays 'due' on this card, and is asked online again if the job is reopened, unless you record it as the deposit.",
      ]);
    }
    // Recording the deposit itself: moot.
    expect(
      counterWarnings({
        ...base,
        jobStatus: "completed",
        jobOpen: false,
        dueDeposit: due,
        choice: "deposit",
      }).warnings,
    ).toEqual([]);
    // Not on a collected job: it can no longer be reopened.
    expect(
      counterWarnings({ ...base, jobStatus: "collected", jobOpen: false, dueDeposit: due })
        .warnings,
    ).toEqual([]);
  });

  it("above what is left on a completed or ready job: how much more, shown as paid above the bill", () => {
    const ready = { ...base, jobStatus: "ready_for_collection" as const, jobOpen: false };
    expect(counterWarnings({ ...ready, balanceDue: "35.00", amount: "3800" }).warnings).toEqual([
      "This is $3,765.00 more than still to pay; it will show as paid above the bill.",
    ]);
    expect(counterWarnings({ ...ready, balanceDue: "35.00", amount: "35" }).warnings).toEqual([]);
    expect(counterWarnings({ ...ready, balanceDue: "35.00", amount: "abc" }).warnings).toEqual([]);
  });

  it("above what is left on an open job: an information line only", () => {
    const r = counterWarnings({ ...base, balanceDue: "25.00", amount: "50" });
    expect(r.warnings).toEqual([]);
    expect(r.info).toBe(
      "More than is left to pay on the job so far ($25.00 of a job total of $145.00). Indent parts join the job total when they're fitted.",
    );
    expect(counterWarnings({ ...base, balanceDue: "25.00", amount: "25" }).info).toBeNull();
    // A deposit's amount is fixed: no amount line.
    expect(
      counterWarnings({ ...base, choice: "deposit", balanceDue: "25.00", amount: "300" }).info,
    ).toBeNull();
  });

  it("a collected job (no balance) has no amount line", () => {
    expect(
      counterWarnings({
        ...base,
        jobStatus: "collected",
        jobOpen: false,
        balanceDue: null,
        amount: "50",
      }),
    ).toEqual({ warnings: [], info: null });
  });
});

describe("after the job's open Checkouts are expired (C9, C20)", () => {
  it("after a counter payment: paid meanwhile, may still be open, or nothing", () => {
    expect(counterCheckoutNote({ expired: 1, paid: 1, failed: 0 }, 2)).toBe(
      "An online payment for this job has just gone through; refund it in Stripe or record the counter money as given back.",
    );
    const open = "An online payment page may still be open for this job; use Check with Stripe.";
    expect(counterCheckoutNote({ expired: 1, paid: 0, failed: 1 }, 2)).toBe(open);
    // Stripe off: zeros, fewer than were open.
    expect(counterCheckoutNote({ expired: 0, paid: 0, failed: 0 }, 1)).toBe(open);
    expect(counterCheckoutNote({ expired: 2, paid: 0, failed: 0 }, 2)).toBeNull();
    expect(counterCheckoutNote({ expired: 0, paid: 0, failed: 0 }, 0)).toBeNull();
  });

  it("after a link replaced another", () => {
    expect(replacedLinkCheckoutNote({ expired: 0, paid: 1, failed: 0 })).toBe(
      "A payment on the earlier link has just gone through. The new link asks only what is left; check the card.",
    );
    expect(replacedLinkCheckoutNote({ expired: 0, paid: 0, failed: 1 })).toBe(
      "The earlier link's payment page may still be open; use Check with Stripe.",
    );
    expect(replacedLinkCheckoutNote({ expired: 1, paid: 0, failed: 0 })).toBeNull();
  });
});

describe("the live payment link (D156)", () => {
  const link = {
    channel: "whatsapp",
    sentAt: "2026-10-17T02:00:00Z",
    expiresAt: "2026-10-24T02:00:00Z",
    amountAtSend: "180.00",
  };

  it("says when and how it was sent, what it asked then, and until when it works", () => {
    expect(linkLine(link, "SGD", new Date("2026-10-18T00:00:00Z"))).toBe(
      "Payment link sent 17 Oct 2026 by WhatsApp ($180.00 when sent), valid until 24 Oct 2026.",
    );
    expect(linkLine({ ...link, channel: "email" }, "SGD", new Date("2026-10-18T00:00:00Z"))).toBe(
      "Payment link sent 17 Oct 2026 by email ($180.00 when sent), valid until 24 Oct 2026.",
    );
    expect(linkLine({ ...link, channel: "link" }, "SGD", new Date("2026-10-18T00:00:00Z"))).toBe(
      "Payment link sent 17 Oct 2026 ($180.00 when sent), valid until 24 Oct 2026.",
    );
    expect(linkLine(link, "SGD", new Date("2026-10-24T02:00:00Z"))).toBe(
      "Payment link sent 17 Oct 2026 by WhatsApp ($180.00 when sent), expired 24 Oct 2026.",
    );
  });

  it("is a /pay/ path", () => {
    expect(payPath("abc")).toBe("/pay/abc");
  });

  it("Send payment link applies only with Stripe on, a final SGD bill of at least S$0.50 and nothing being confirmed", () => {
    const ok = {
      stripeOn: true,
      jobStatus: "completed" as const,
      currency: "SGD",
      balanceDue: "0.50",
      processingOnline: "0.00",
    };
    expect(canSendLink(ok)).toBe(true);
    expect(canSendLink({ ...ok, jobStatus: "ready_for_collection" })).toBe(true);
    expect(canSendLink({ ...ok, stripeOn: false })).toBe(false);
    for (const jobStatus of ["in_progress", "collected", "cancelled", "received"] as const) {
      expect(canSendLink({ ...ok, jobStatus }), jobStatus).toBe(false);
    }
    expect(canSendLink({ ...ok, currency: "MYR" })).toBe(false);
    expect(canSendLink({ ...ok, balanceDue: "0.49" })).toBe(false);
    expect(canSendLink({ ...ok, balanceDue: null })).toBe(false);
    expect(canSendLink({ ...ok, processingOnline: "35.00" })).toBe(false);
  });
});

describe("the message and email a link is sent with (D156)", () => {
  const input = {
    firstName: "Priya",
    jobNumber: "J-000123",
    amount: "$180.00",
    link: "https://admin.bicii.test/pay/tok",
    days: 7,
  };

  it("names the customer, the job, what was left to pay and how long the link works", () => {
    expect(balanceMessage(input)).toBe(
      [
        "Hi Priya, here is the bill for your bike (job J-000123) from BICII: $180.00 is left to pay.",
        "You can pay it securely by card or PayNow here: https://admin.bicii.test/pay/tok",
        "The link works for 7 days.",
      ].join("\n"),
    );
    const short = balanceMessage({ ...input, firstName: null, days: 1 }).split("\n");
    expect(short[0]).toMatch(/^Hi, here is the bill/);
    expect(short.at(-1)).toBe("The link works for 1 day.");
  });

  it("the email: same words, a button, and escaped values", () => {
    const email = balanceEmail({ ...input, firstName: "<Pri & ya>" });
    expect(email.subject).toBe("Your bill from BICII (job J-000123)");
    expect(email.text).toContain("Hi <Pri & ya>,");
    expect(email.html).toContain("Hi &lt;Pri &amp; ya&gt;,");
    expect(email.html).not.toContain("<Pri");
    expect(email.html).toContain('href="https://admin.bicii.test/pay/tok"');
    expect(email.html).toContain("See your bill and pay");
    expect(email.html).toContain("$180.00 is left to pay");
  });
});

describe("the counter sheet's Paid on day (D161h)", () => {
  it("offers today back to the later of 29 days ago and the check-in day", () => {
    expect(counterDayRange("2026-10-17", "2026-10-01T01:00:00Z")).toEqual({
      min: "2026-10-01",
      max: "2026-10-17",
    });
    expect(counterDayRange("2026-10-17", "2026-08-01T01:00:00Z")).toEqual({
      min: "2026-09-18",
      max: "2026-10-17",
    });
    expect(counterDayRange("2026-10-17", null).min).toBe("2026-09-18");
    // Checked in late in the evening, Singapore time: that shop day.
    expect(counterDayRange("2026-10-17", "2026-10-16T17:30:00Z").min).toBe("2026-10-17");
  });

  it("today sends nothing; an earlier day is noon Singapore time", () => {
    expect(counterReceivedAt("2026-10-17", "2026-10-17", null)).toBeNull();
    expect(counterReceivedAt("2026-10-15", "2026-10-17", "2026-10-01T01:00:00Z")).toBe(
      "2026-10-15T04:00:00.000Z",
    );
  });

  it("never before the check-in on its own day: just after it, microseconds rounded up", () => {
    // Checked in 15:00 Singapore time on the 15th; noon would be before it.
    expect(counterReceivedAt("2026-10-15", "2026-10-17", "2026-10-15T07:00:00.123456+00:00")).toBe(
      "2026-10-15T07:00:00.124Z",
    );
    // Checked in at 9:00: noon is after it, so noon.
    expect(counterReceivedAt("2026-10-15", "2026-10-17", "2026-10-15T01:00:00Z")).toBe(
      "2026-10-15T04:00:00.000Z",
    );
  });
});

describe("a deposit's badge on the card (C15)", () => {
  it("due on a job no longer open reads Part of the balance; otherwise as before", () => {
    expect(depositBadge("due", true)).toEqual({ label: "Deposit due", tone: "waiting" });
    expect(depositBadge("due", false)).toEqual({ label: "Part of the balance", tone: "neutral" });
    expect(depositBadge("paid", false)).toEqual({ label: "Deposit paid", tone: "done" });
    expect(depositBadge("refunded", false).label).toBe("Deposit refunded");
  });
});
