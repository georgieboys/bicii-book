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
  paymentStatusLabel,
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
