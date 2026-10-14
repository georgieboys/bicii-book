/**
 * The Stripe fixtures (tests/fixtures/stripe.ts) have the shapes BICII reads
 * (DATA-MODEL §19) and sign like Stripe does, so the database tests that use
 * them exercise the real projection and apply paths (TESTING.md "Stripe
 * payments"). Phase 14 step 1 pins the fixtures on their own; the adapter's
 * verifier and parser are checked against them once they exist.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  refundObject,
  sessionObject,
  signStripeBody,
  STRIPE_TEST_API_VERSION,
  STRIPE_TEST_WEBHOOK_SECRET,
  stripeEvent,
  stripeWebhookHeaders,
} from "../fixtures/stripe";

const PAYMENT = "5b0c1f9e-4a7d-4c8e-9f2a-0d1e2f3a4b5c";
const JOB = "6c1d2e3f-5b8e-4d9f-8a3b-1e2f3a4b5c6d";

describe("signStripeBody", () => {
  it("is t=<seconds>,v1=<HMAC-SHA256 of `${t}.${raw}`> under the test secret", () => {
    const raw = JSON.stringify({ id: "evt_1", amount: 12000, name: "Zoë" });
    const header = signStripeBody(raw, { timestamp: 1_760_000_000 });
    const expected = createHmac("sha256", STRIPE_TEST_WEBHOOK_SECRET)
      .update(Buffer.concat([Buffer.from("1760000000."), Buffer.from(raw, "utf8")]))
      .digest("hex");
    expect(header).toBe(`t=1760000000,v1=${expected}`);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("differs with another secret or another body", () => {
    const raw = '{"id":"evt_1"}';
    const a = signStripeBody(raw, { timestamp: 1 });
    expect(signStripeBody(raw, { timestamp: 1, secret: "whsec_other" })).not.toBe(a);
    expect(signStripeBody(`${raw} `, { timestamp: 1 })).not.toBe(a);
  });

  it("uses a secret shaped like a Stripe signing secret that is plainly not a real one", () => {
    expect(STRIPE_TEST_WEBHOOK_SECRET).toMatch(/^whsec_[A-Za-z0-9]+$/);
    expect(STRIPE_TEST_WEBHOOK_SECRET).toContain("NotARealSecret");
  });
});

describe("stripeWebhookHeaders", () => {
  it("carries the JSON content type, a Stripe user agent and the signature", () => {
    const raw = '{"id":"evt_2"}';
    const headers = stripeWebhookHeaders({ raw, timestamp: 42 });
    expect(headers).toEqual({
      "content-type": "application/json",
      "stripe-signature": signStripeBody(raw, { timestamp: 42 }),
      "user-agent": expect.stringMatching(/^Stripe\//),
    });
  });
});

describe("sessionObject", () => {
  it("is a Checkout Session carrying BICII's ids in metadata and client_reference_id", () => {
    const s = sessionObject({
      id: "cs_test_a1",
      paymentId: PAYMENT,
      workOrderId: JOB,
      amountCents: 12000,
      paymentIntent: "pi_t1",
      expiresAt: 1_760_003_600,
    });
    expect(s).toMatchObject({
      id: "cs_test_a1",
      object: "checkout.session",
      livemode: false,
      status: "complete",
      payment_status: "paid",
      amount_total: 12000,
      currency: "sgd",
      client_reference_id: PAYMENT,
      payment_intent: "pi_t1",
      expires_at: 1_760_003_600,
      metadata: { bicii_payment_id: PAYMENT, bicii_work_order_id: JOB, bicii_kind: "deposit" },
    });
    for (const key of Object.keys(s.metadata as object)) expect(key).toMatch(/^bicii_[a-z_]+$/);
  });

  it("adds extra fields and merges extra metadata", () => {
    const s = sessionObject({
      id: "cs_test_a2",
      paymentId: PAYMENT,
      workOrderId: JOB,
      quoteId: JOB,
      amountCents: 100,
      extra: { customer_email: "x@example.com", metadata: { foo: "bar" } },
    });
    expect(s.customer_email).toBe("x@example.com");
    expect(s.metadata).toMatchObject({
      foo: "bar",
      bicii_payment_id: PAYMENT,
      bicii_quote_id: JOB,
    });
  });
});

describe("refundObject and stripeEvent", () => {
  it("builds a Refund and wraps it in a snapshot Event", () => {
    const r = refundObject({
      id: "re_1",
      paymentIntent: "pi_t1",
      amountCents: 5000,
      status: "succeeded",
      created: 1_760_000_100,
    });
    expect(r).toMatchObject({
      id: "re_1",
      object: "refund",
      amount: 5000,
      currency: "sgd",
      status: "succeeded",
      payment_intent: "pi_t1",
      created: 1_760_000_100,
    });
    const e = stripeEvent({
      id: "evt_r1",
      type: "refund.updated",
      object: r,
      created: 1_760_000_200,
    });
    expect(e).toMatchObject({
      id: "evt_r1",
      object: "event",
      type: "refund.updated",
      livemode: false,
      created: 1_760_000_200,
      api_version: STRIPE_TEST_API_VERSION,
      data: { object: r },
    });
    expect(e.id).toMatch(/^evt_[A-Za-z0-9_]{1,250}$/);
  });
});
