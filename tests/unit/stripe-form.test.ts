// @vitest-environment node
/**
 * The Checkout Session request body (ADR-025; RUNBOOK "Stripe payments"):
 * the exact bytes, in a fixed order, with BICII's ids only and none of the
 * parameters BICII must never send.
 */
import { describe, expect, it } from "vitest";

import { checkoutSessionParams, formEncode } from "@/lib/integrations/stripe/form";
import type { CheckoutSessionInput } from "@/lib/integrations/stripe/gateway";

/** Stripe's clock in these tests: the session below expires an hour later. */
const NOW_S = 1_800_000_000;

const INPUT: CheckoutSessionInput = {
  paymentId: "11111111-2222-4333-8444-555555555555",
  workOrderId: "66666666-7777-4888-9999-000000000000",
  quoteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  kind: "deposit",
  jobNumber: "J-0042",
  amountCents: 12000,
  expiresAt: 1_800_003_600,
  successUrl: "https://admin.example.com/quote/tok_A/b=c?deposit=returned",
  cancelUrl: "https://admin.example.com/quote/tok_A/b=c?deposit=cancelled",
};

describe("formEncode", () => {
  it("keeps literal brackets in keys and percent-encodes the rest", () => {
    expect(
      formEncode([
        ["a[0][b c]", "x y"],
        ["k", "?=/&"],
      ]),
    ).toBe("a[0][b%20c]=x%20y&k=%3F%3D%2F%26");
  });
});

describe("checkoutSessionParams", () => {
  it("is this exact body for a deposit", () => {
    const pi = (k: string) => `payment_intent_data[metadata][${k}]`;
    expect(formEncode(checkoutSessionParams(INPUT, NOW_S))).toBe(
      [
        "mode=payment",
        `client_reference_id=${INPUT.paymentId}`,
        "line_items[0][quantity]=1",
        "line_items[0][price_data][currency]=sgd",
        "line_items[0][price_data][unit_amount]=12000",
        "line_items[0][price_data][product_data][name]=Deposit%20for%20job%20J-0042",
        `metadata[bicii_payment_id]=${INPUT.paymentId}`,
        `metadata[bicii_work_order_id]=${INPUT.workOrderId}`,
        `metadata[bicii_quote_id]=${INPUT.quoteId}`,
        "metadata[bicii_kind]=deposit",
        "payment_intent_data[description]=Deposit%20for%20job%20J-0042",
        `${pi("bicii_payment_id")}=${INPUT.paymentId}`,
        `${pi("bicii_work_order_id")}=${INPUT.workOrderId}`,
        `${pi("bicii_quote_id")}=${INPUT.quoteId}`,
        `${pi("bicii_kind")}=deposit`,
        "expires_at=1800003600",
        "success_url=https%3A%2F%2Fadmin.example.com%2Fquote%2Ftok_A%2Fb%3Dc%3Fdeposit%3Dreturned",
        "cancel_url=https%3A%2F%2Fadmin.example.com%2Fquote%2Ftok_A%2Fb%3Dc%3Fdeposit%3Dcancelled",
      ].join("&"),
    );
  });

  it("names a balance and leaves out a null quote", () => {
    const pairs = checkoutSessionParams({ ...INPUT, kind: "balance", quoteId: null }, NOW_S);
    const keys = pairs.map(([k]) => k);
    expect(keys).not.toContain("metadata[bicii_quote_id]");
    expect(Object.fromEntries(pairs)["line_items[0][price_data][product_data][name]"]).toBe(
      "Balance for job J-0042",
    );
    expect(Object.fromEntries(pairs)["metadata[bicii_kind]"]).toBe("balance");
  });

  it("never sends payment method types, a customer email, ui_mode or locale", () => {
    const keys = checkoutSessionParams(INPUT, NOW_S).map(([k]) => k);
    for (const banned of [
      "payment_method_types",
      "allowed_payment_method_types",
      "customer_email",
      "ui_mode",
      "locale",
    ]) {
      expect(keys.some((k) => k.startsWith(banned))).toBe(false);
    }
    // Metadata carries BICII's ids only.
    for (const k of keys.filter(
      (key) => key.includes("[metadata]") || key.startsWith("metadata"),
    )) {
      expect(k).toMatch(/\[bicii_(payment_id|work_order_id|quote_id|kind)\]$/);
    }
  });

  it("refuses an amount outside 50..99999999 whole cents and a fractional expiry", () => {
    for (const amountCents of [49, 100_000_000, 120.5, Number.NaN, -1]) {
      expect(() => checkoutSessionParams({ ...INPUT, amountCents }, NOW_S)).toThrow(/amountCents/);
    }
    expect(() => checkoutSessionParams({ ...INPUT, amountCents: 50 }, NOW_S)).not.toThrow();
    expect(() => checkoutSessionParams({ ...INPUT, amountCents: 99_999_999 }, NOW_S)).not.toThrow();
    expect(() => checkoutSessionParams({ ...INPUT, expiresAt: 1.5 }, NOW_S)).toThrow(/expiresAt/);
    expect(() => checkoutSessionParams({ ...INPUT, jobNumber: "x".repeat(250) }, NOW_S)).toThrow(
      /product name/,
    );
  });

  it("refuses an expiry outside Stripe's window of 30 minutes to 24 hours", () => {
    for (const ahead of [0, 29 * 60, 30 * 60 - 1, 24 * 3600 + 1, 2 * 24 * 3600, -60]) {
      expect(
        () => checkoutSessionParams({ ...INPUT, expiresAt: NOW_S + ahead }, NOW_S),
        String(ahead),
      ).toThrow(/30 minutes to 24 hours/);
    }
    for (const ahead of [30 * 60, 60 * 60, 24 * 3600]) {
      expect(() =>
        checkoutSessionParams({ ...INPUT, expiresAt: NOW_S + ahead }, NOW_S),
      ).not.toThrow();
    }
  });
});
