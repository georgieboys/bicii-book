// @vitest-environment node
/**
 * The live Stripe adapter over an injected fetch (ADR-025; RUNBOOK "Stripe
 * payments"): what it sends, how each answer maps to a StripeError, the
 * single retry with identical bytes, and that nothing secret or echoed
 * leaks into an error.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  createHttpStripeGateway,
  paymentMethodTypes,
  retryDelayMs,
  RETRY_DELAY_MIN_MS,
  RETRY_DELAY_MAX_MS,
} = await import("@/lib/integrations/stripe/http-gateway");
const { StripeError } = await import("@/lib/integrations/stripe/gateway");

import type { CheckoutSessionInput } from "@/lib/integrations/stripe/gateway";

const KEY = "rk_test_NotARealKey123";
const PAYMENT = "11111111-2222-4333-8444-555555555555";
const SESSION = "cs_test_a1B2c3";

const INPUT: CheckoutSessionInput = {
  paymentId: PAYMENT,
  workOrderId: "66666666-7777-4888-9999-000000000000",
  quoteId: null,
  kind: "deposit",
  jobNumber: "J-0042",
  amountCents: 12000,
  expiresAt: 1_800_003_600,
  successUrl: "https://admin.example.com/quote/SECRET_TOKEN?deposit=returned",
  cancelUrl: "https://admin.example.com/quote/SECRET_TOKEN?deposit=cancelled",
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    object: "checkout.session",
    livemode: false,
    status: "open",
    payment_status: "unpaid",
    expires_at: 1_800_003_600,
    payment_intent: null,
    url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3",
    payment_method_types: ["card", "paynow"],
    ...overrides,
  };
}

type Call = { url: string; init: RequestInit };

function fetchReturning(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetch: impl as unknown as typeof globalThis.fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Waits are recorded, never slept, so the suite stays fast. */
const noSleep = async () => {};
const gateway = (fetchImpl: typeof globalThis.fetch, livemode = false) =>
  createHttpStripeGateway({ secretKey: KEY, livemode, sleep: noSleep }, fetchImpl);

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof StripeError>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StripeError);
    return e as InstanceType<typeof StripeError>;
  }
  throw new Error("expected a StripeError");
}

describe("createCheckoutSession", () => {
  it("POSTs the form body with the key, the pinned version and the idempotency key", async () => {
    const { calls, fetch } = fetchReturning(json(200, session()));
    const s = await gateway(fetch).createCheckoutSession(INPUT, `bicii-checkout-${PAYMENT}`);
    expect(s).toMatchObject({ id: SESSION, status: "open", paymentStatus: "unpaid" });
    expect(paymentMethodTypes(s)).toEqual(["card", "paynow"]);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Stripe-Version": "2026-09-30.endive",
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `bicii-checkout-${PAYMENT}`,
    });
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).toContain("line_items[0][price_data][unit_amount]=12000");
    expect(String(init.body)).not.toContain("payment_method_types");
  });

  it("retries once after a retriable error with the identical bytes and key", async () => {
    const { calls, fetch } = fetchReturning(json(503, {}), json(200, session()));
    await gateway(fetch).createCheckoutSession(INPUT, "k-1");
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe(calls[0].init.body);
    expect(calls[1].init.headers).toEqual(calls[0].init.headers);
  });

  it("waits 250-500 ms (jittered) before retrying a 409 or a 429, with the same bytes and key", async () => {
    for (const status of [409, 429]) {
      for (const r of [0, 0.5, 0.999]) {
        const { calls, fetch } = fetchReturning(
          json(status, { error: { type: "idempotency_error" } }),
          json(200, session()),
        );
        const order: string[] = [];
        const sleep = vi.fn(async (ms: number) => {
          order.push(`sleep ${ms} after ${calls.length}`);
        });
        await createHttpStripeGateway(
          { secretKey: KEY, livemode: false, sleep, random: () => r },
          fetch,
        ).createCheckoutSession(INPUT, "k-1");
        expect(sleep).toHaveBeenCalledTimes(1);
        const ms = sleep.mock.calls[0][0];
        expect(ms).toBe(retryDelayMs(() => r));
        expect(ms).toBeGreaterThanOrEqual(RETRY_DELAY_MIN_MS);
        expect(ms).toBeLessThanOrEqual(RETRY_DELAY_MAX_MS);
        // Between the two requests, not before the first.
        expect(order).toEqual([`sleep ${ms} after 1`]);
        expect(calls).toHaveLength(2);
        expect(calls[1].init.body).toBe(calls[0].init.body);
        expect(calls[1].init.headers).toEqual(calls[0].init.headers);
      }
    }
    expect([RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS]).toEqual([250, 500]);
    expect(retryDelayMs(() => 0)).toBe(250);
    expect(retryDelayMs(() => 1)).toBe(500);
    expect(retryDelayMs(() => Number.NaN)).toBe(375);
  });

  it("retries a network error or a 5xx at once, without waiting", async () => {
    for (const first of [new TypeError("fetch failed"), json(503, {})]) {
      const { calls, fetch } = fetchReturning(first, json(200, session()));
      const sleep = vi.fn(async () => {});
      await createHttpStripeGateway(
        { secretKey: KEY, livemode: false, sleep },
        fetch,
      ).createCheckoutSession(INPUT, "k-1");
      expect(sleep).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
    }
  });

  it("gives up after the second retriable failure", async () => {
    const { calls, fetch } = fetchReturning(new TypeError("fetch failed"), json(500, {}));
    const e = await caught(gateway(fetch).createCheckoutSession(INPUT, "k-1"));
    expect(e).toMatchObject({ code: "stripe_unavailable", retriable: true, status: 500 });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a non-retriable error", async () => {
    const { calls, fetch } = fetchReturning(
      json(401, { error: { type: "invalid_request_error" } }),
    );
    const e = await caught(gateway(fetch).createCheckoutSession(INPUT, "k-1"));
    expect(e.code).toBe("stripe_auth_failed");
    expect(calls).toHaveLength(1);
  });
});

describe("the error table", () => {
  const cases: Array<[string, Response | Error, string, boolean]> = [
    ["fetch throws", new TypeError("fetch failed"), "stripe_unavailable", true],
    [
      "a timeout",
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      "stripe_unavailable",
      true,
    ],
    ["429", json(429, { error: { type: "rate_limit_error" } }), "stripe_rate_limited", true],
    ["409", json(409, { error: { type: "idempotency_error" } }), "stripe_unavailable", true],
    ["500", json(500, {}), "stripe_unavailable", true],
    ["401", json(401, {}), "stripe_auth_failed", false],
    ["403", json(403, {}), "stripe_auth_failed", false],
    ["404", json(404, { error: { code: "resource_missing" } }), "stripe_not_found", false],
    [
      "400 idempotency_error",
      json(400, { error: { type: "idempotency_error" } }),
      "stripe_idempotency_conflict",
      false,
    ],
    [
      "other 400",
      json(400, { error: { type: "invalid_request_error", code: "parameter_unknown" } }),
      "stripe_request_failed",
      false,
    ],
    ["402", json(402, { error: { code: "card_declined" } }), "stripe_request_failed", false],
    ["2xx not JSON", new Response("<html>", { status: 200 }), "stripe_bad_response", false],
    [
      "2xx wrong object",
      json(200, { ...session(), object: "payment_intent" }),
      "stripe_bad_response",
      false,
    ],
    ["2xx no id", json(200, { ...session(), id: undefined }), "stripe_bad_response", false],
    ["2xx another livemode", json(200, session({ livemode: true })), "stripe_bad_response", false],
  ];

  it.each(cases)("%s", async (_name, response, code, retriable) => {
    // A retriable error is retried once, so it is answered twice.
    const second =
      response instanceof Response ? response.clone() : Object.assign(new Error(), response);
    const { fetch } = fetchReturning(response, second);
    const e = await caught(gateway(fetch).retrieveCheckoutSession(SESSION));
    expect(e.code).toBe(code);
    expect(e.retriable).toBe(retriable);
  });

  it("keeps Stripe's code, never its message or param, and never the key", async () => {
    const { fetch } = fetchReturning(
      json(400, {
        error: {
          type: "invalid_request_error",
          code: "url_invalid",
          message: "Not a valid URL: https://admin.example.com/quote/SECRET_TOKEN",
          param: "success_url",
        },
      }),
    );
    const e = await caught(gateway(fetch).createCheckoutSession(INPUT, "k-1"));
    expect(e).toMatchObject({
      code: "stripe_request_failed",
      status: 400,
      stripeCode: "url_invalid",
    });
    const text = `${e.message} ${JSON.stringify(e)} ${String(e)}`;
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("success_url");
    expect(text).not.toContain(KEY);
    expect(e.message).toBe("stripe_request_failed");
  });

  it("drops a stripe code longer than 100 characters", async () => {
    const { fetch } = fetchReturning(json(400, { error: { code: "x".repeat(101) } }));
    const e = await caught(gateway(fetch).retrieveCheckoutSession(SESSION));
    expect(e.stripeCode).toBeUndefined();
  });
});

describe("retrieve, expire and list refunds", () => {
  it("retrieves by an encoded, validated id", async () => {
    const { calls, fetch } = fetchReturning(json(200, session({ status: "complete" })));
    const s = await gateway(fetch).retrieveCheckoutSession(SESSION);
    expect(s.status).toBe("complete");
    expect(calls[0].url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SESSION}`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("refuses an id that is not a session's, without calling Stripe", async () => {
    const { calls, fetch } = fetchReturning();
    for (const id of ["../v1/charges", "cs_test_a/b", "pi_123", "cs_test_"]) {
      const e = await caught(gateway(fetch).retrieveCheckoutSession(id));
      expect(e.code).toBe("stripe_request_failed");
    }
    expect(calls).toEqual([]);
  });

  it("expires with its own idempotency key, and any 400 means not open", async () => {
    const { calls, fetch } = fetchReturning(
      json(200, session({ status: "expired", url: null })),
      json(400, { error: { type: "invalid_request_error", code: "checkout_session_not_open" } }),
    );
    const g = gateway(fetch);
    expect((await g.expireCheckoutSession(SESSION)).status).toBe("expired");
    expect(calls[0].url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SESSION}/expire`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      `bicii-expire-${SESSION}`,
    );
    const e = await caught(g.expireCheckoutSession(SESSION));
    expect(e.code).toBe("stripe_session_not_open");
  });

  it("lists a payment intent's refunds, validated, keeping refund objects only", async () => {
    const { calls, fetch } = fetchReturning(
      json(200, {
        object: "list",
        data: [
          { id: "re_1", object: "refund", amount: 5000, status: "succeeded" },
          { id: "x", object: "charge" },
          "junk",
        ],
      }),
    );
    const refunds = await gateway(fetch).listRefunds("pi_123");
    expect(refunds).toEqual([
      { id: "re_1", raw: { id: "re_1", object: "refund", amount: 5000, status: "succeeded" } },
    ]);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/refunds?payment_intent=pi_123&limit=100");
    const { calls: none, fetch: f2 } = fetchReturning();
    expect((await caught(gateway(f2).listRefunds("pi_1&limit=1"))).code).toBe(
      "stripe_request_failed",
    );
    expect(none).toEqual([]);
  });

  it("reports its mode from the key's livemode", () => {
    const { fetch } = fetchReturning();
    expect(gateway(fetch, true)).toMatchObject({ mode: "live", livemode: true });
    expect(gateway(fetch, false)).toMatchObject({ mode: "test", livemode: false });
  });
});
