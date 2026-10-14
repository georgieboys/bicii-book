// @vitest-environment node
/**
 * The in-memory Stripe (STRIPE_ADAPTER=fake; ADR-025): deterministic ids,
 * Stripe's idempotency rules, the success URL as the Checkout URL, and the
 * test drivers the flows' unit tests use.
 */
import { describe, expect, it } from "vitest";

import { createFakeStripeGateway } from "@/lib/integrations/stripe/fake-gateway";
import { StripeError, type CheckoutSessionInput } from "@/lib/integrations/stripe/gateway";

const PAYMENT = "11111111-2222-4333-8444-555555555555";
/** Stripe's clock: the session below expires an hour after it. */
const NOW_MS = 1_800_000_000_000;
const INPUT: CheckoutSessionInput = {
  paymentId: PAYMENT,
  workOrderId: "66666666-7777-4888-9999-000000000000",
  quoteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  kind: "deposit",
  jobNumber: "J-0042",
  amountCents: 12000,
  expiresAt: 1_800_003_600,
  successUrl: "http://localhost:3100/quote/tok?deposit=returned",
  cancelUrl: "http://localhost:3100/quote/tok?deposit=cancelled",
};
const KEY = `bicii-checkout-${PAYMENT}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StripeError);
    return (e as StripeError).code;
  }
  throw new Error("expected a StripeError");
}

describe("createFakeStripeGateway", () => {
  it("creates a test-mode session whose id comes from the payment id and whose url is the success URL", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    expect(fake).toMatchObject({ mode: "fake", livemode: false });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    expect(s).toMatchObject({
      id: "cs_test_fake_11111111222243338444555555555555",
      status: "open",
      paymentStatus: "unpaid",
      livemode: false,
      paymentIntent: null,
      expiresAt: INPUT.expiresAt,
      url: INPUT.successUrl,
    });
    expect(s.raw).toMatchObject({
      object: "checkout.session",
      amount_total: 12000,
      currency: "sgd",
      client_reference_id: PAYMENT,
      metadata: {
        bicii_payment_id: PAYMENT,
        bicii_work_order_id: INPUT.workOrderId,
        bicii_quote_id: INPUT.quoteId,
        bicii_kind: "deposit",
      },
    });
    expect(fake.calls).toEqual([{ op: "create", key: KEY }]);
  });

  it("returns the same session for the same key and body; another body is a conflict", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const a = await fake.createCheckoutSession(INPUT, KEY);
    const b = await fake.createCheckoutSession(INPUT, KEY);
    expect(b).toEqual(a);
    expect(await code(fake.createCheckoutSession({ ...INPUT, amountCents: 13000 }, KEY))).toBe(
      "stripe_idempotency_conflict",
    );
    expect(fake.sessions.size).toBe(1);
  });

  it("retrieves stored sessions only", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    expect((await fake.retrieveCheckoutSession(s.id)).id).toBe(s.id);
    expect(await code(fake.retrieveCheckoutSession("cs_test_unknown"))).toBe("stripe_not_found");
  });

  it("completes a session paid or unpaid, with a payment intent", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    const unpaid = fake.complete(s.id, { paid: false, paymentIntent: "pi_async" });
    expect(unpaid).toMatchObject({
      status: "complete",
      paymentStatus: "unpaid",
      paymentIntent: "pi_async",
      url: null,
    });
    const paid = fake.complete(s.id);
    expect(paid).toMatchObject({ status: "complete", paymentStatus: "paid" });
    expect(paid.paymentIntent).toMatch(/^pi_fake_/);
    expect((await fake.retrieveCheckoutSession(s.id)).paymentStatus).toBe("paid");
  });

  it("expires an open session once; then it is not open", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    const expired = await fake.expireCheckoutSession(s.id);
    expect(expired).toMatchObject({ status: "expired", url: null });
    expect(await code(fake.expireCheckoutSession(s.id))).toBe("stripe_session_not_open");
    const other = await fake.createCheckoutSession(
      { ...INPUT, paymentId: "22222222-2222-4333-8444-555555555555" },
      "k-2",
    );
    fake.expire(other.id);
    expect((await fake.retrieveCheckoutSession(other.id)).status).toBe("expired");
  });

  it("lists the refunds added for a payment intent", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    expect(await fake.listRefunds("pi_1")).toEqual([]);
    const r = fake.addRefund("pi_1", { amountCents: 5000, status: "succeeded" });
    fake.addRefund("pi_1", { id: "pyr_2", amountCents: 100, status: "pending" });
    fake.addRefund("pi_other", { amountCents: 1, status: "failed" });
    const list = await fake.listRefunds("pi_1");
    expect(list.map((x) => x.id)).toEqual([r.id, "pyr_2"]);
    expect(list[0].raw).toMatchObject({
      object: "refund",
      amount: 5000,
      currency: "sgd",
      status: "succeeded",
      payment_intent: "pi_1",
    });
  });

  it("reads a session as expired once its time has passed, as Stripe does", async () => {
    let now = NOW_MS;
    const fake = createFakeStripeGateway({ now: () => now });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    now = INPUT.expiresAt * 1000 - 1000;
    expect((await fake.retrieveCheckoutSession(s.id)).status).toBe("open");
    now = INPUT.expiresAt * 1000;
    expect(await fake.retrieveCheckoutSession(s.id)).toMatchObject({
      status: "expired",
      url: null,
    });
    expect(await code(fake.expireCheckoutSession(s.id))).toBe("stripe_session_not_open");
  });

  it("refuses an expiry Stripe would refuse (outside 30 minutes to 24 hours)", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    await expect(
      fake.createCheckoutSession({ ...INPUT, expiresAt: NOW_MS / 1000 + 15 * 60 }, KEY),
    ).rejects.toThrow(/30 minutes to 24 hours/);
  });

  it("keeps a PaymentIntent per completed session; an async failure returns it to requires_payment_method", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const s = await fake.createCheckoutSession(INPUT, KEY);
    expect(() => fake.failAsyncPayment(s.id)).toThrow(/completed unpaid/);
    fake.complete(s.id, { paid: false, paymentIntent: "pi_async" });
    expect(await fake.retrievePaymentIntent("pi_async")).toMatchObject({
      id: "pi_async",
      status: "processing",
      livemode: false,
    });
    fake.failAsyncPayment(s.id);
    const intent = await fake.retrievePaymentIntent("pi_async");
    expect(intent.status).toBe("requires_payment_method");
    expect(intent.raw).toMatchObject({ object: "payment_intent", amount: 12000, currency: "sgd" });
    expect((await fake.retrieveCheckoutSession(s.id)).paymentStatus).toBe("unpaid");
    expect(await code(fake.retrievePaymentIntent("pi_unknown"))).toBe("stripe_not_found");
    expect(fake.calls.filter((c) => c.op === "retrieve_pi")).toHaveLength(3);
  });

  it("fails the next call of one op once, records calls, and resets", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    fake.failNext("create", new StripeError("stripe_unavailable", true));
    expect(await code(fake.createCheckoutSession(INPUT, KEY))).toBe("stripe_unavailable");
    const s = await fake.createCheckoutSession(INPUT, KEY);
    await fake.retrieveCheckoutSession(s.id);
    await fake.listRefunds("pi_1");
    expect(fake.calls.map((c) => c.op)).toEqual(["create", "create", "retrieve", "list"]);
    fake.reset();
    expect(fake.calls).toEqual([]);
    expect(fake.sessions.size).toBe(0);
    expect(await code(fake.retrieveCheckoutSession(s.id))).toBe("stripe_not_found");
  });
});
