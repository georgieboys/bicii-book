// @vitest-environment node
/**
 * Adventures Phase B, slice 2: starting an adventure payment (D167, D172;
 * handoff §10.2-10.3, C01, C05, A12). The encoder's adventure bytes, the
 * fake gateway, the redirect check and POST /api/adventures/checkout with
 * scripted Supabase clients and the fake Stripe gateway.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { checkoutSessionParams } = await import("@/lib/integrations/stripe/form");
const { createFakeStripeGateway } = await import("@/lib/integrations/stripe/fake-gateway");
const { adventureReturnUrls, validAdventureRedirect } =
  await import("@/lib/integrations/stripe/adventure-checkout");
const { handleAdventureCheckout } =
  await import("@/lib/integrations/stripe/adventure-checkout-route");

import type { StripeDeps } from "@/lib/integrations/stripe/deps";
import type { AdventureCheckoutInput } from "@/lib/integrations/stripe/gateway";

const NOW_MS = Date.UTC(2026, 10, 14, 4, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const SITE = "https://bicii.example";
const PAYMENT = "11111111-2222-4333-8444-555555555555";
const BOOKING = "66666666-7777-4888-8999-000000000000";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature-part";

const INPUT: AdventureCheckoutInput = {
  subject: "adventure",
  paymentId: PAYMENT,
  bookingReference: "AV-000042",
  description: "BICII 125 certification",
  amountCents: 4900,
  expiresAt: NOW_S + 35 * 60,
  successUrl: `${SITE}/account/adventures/${BOOKING}?checkout=done`,
  cancelUrl: `${SITE}/adventures?checkout=cancelled`,
};

describe("the adventure Checkout Session body (D167)", () => {
  it("names the booking and carries only the adventure metadata", () => {
    const params = new Map(checkoutSessionParams(INPUT, NOW_S));
    expect(params.get("line_items[0][price_data][product_data][name]")).toBe(
      "BICII 125 certification (AV-000042)",
    );
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("4900");
    expect(params.get("line_items[0][price_data][currency]")).toBe("sgd");
    expect(params.get("metadata[bicii_subject]")).toBe("adventure");
    expect(params.get("metadata[bicii_adventure_payment_id]")).toBe(PAYMENT);
    expect(params.get("metadata[bicii_booking_reference]")).toBe("AV-000042");
    expect(params.get("payment_intent_data[metadata][bicii_subject]")).toBe("adventure");
    // No workshop key, so the workshop apply can never claim it.
    expect([...params.keys()].some((k) => k.includes("bicii_payment_id"))).toBe(false);
    expect([...params.keys()].some((k) => k.includes("bicii_work_order_id"))).toBe(false);
  });

  it("refuses a session that would expire inside Stripe's 30 minutes", () => {
    expect(() => checkoutSessionParams({ ...INPUT, expiresAt: NOW_S + 29 * 60 }, NOW_S)).toThrow();
  });

  it("the fake gateway returns the adventure metadata", async () => {
    const fake = createFakeStripeGateway({ now: () => NOW_MS });
    const session = await fake.createCheckoutSession(INPUT, `bicii-checkout-${PAYMENT}`);
    expect(session.raw.metadata).toEqual({
      bicii_subject: "adventure",
      bicii_adventure_payment_id: PAYMENT,
      bicii_booking_reference: "AV-000042",
    });
    expect(session.url).toBe(INPUT.successUrl);
  });
});

describe("validAdventureRedirect", () => {
  it("accepts only Stripe's Checkout host, or the fake's return page on the public site", () => {
    expect(
      validAdventureRedirect("https://checkout.stripe.com/c/pay/cs_test_x", "test", SITE),
    ).toBe(true);
    expect(validAdventureRedirect("https://evil.example/c/pay", "live", SITE)).toBe(false);
    expect(validAdventureRedirect("http://checkout.stripe.com/c", "live", SITE)).toBe(false);
    expect(validAdventureRedirect(`${SITE}/account/adventures/${BOOKING}`, "fake", SITE)).toBe(
      true,
    );
    expect(validAdventureRedirect(`${SITE}/account/../admin`, "fake", SITE)).toBe(false);
    expect(validAdventureRedirect("https://checkout.stripe.com/c", "fake", SITE)).toBe(false);
    expect(validAdventureRedirect(null, "test", SITE)).toBe(false);
  });

  it("returns riders to their booking, or to the adventures page when they cancel", () => {
    expect(adventureReturnUrls(`${SITE}/`, BOOKING)).toEqual({
      success: `${SITE}/account/adventures/${BOOKING}?checkout=done`,
      cancel: `${SITE}/adventures?checkout=cancelled`,
    });
  });
});

type RpcCall = { name: string; args: Record<string, unknown> };

function harness(
  o: {
    prepare?: { data: unknown; error: { code: string; message: string } | null };
    sessionId?: string | null;
    record?: { error: { code: string; message: string } | null };
    verify?: string | null;
    hits?: number;
    limitError?: boolean;
    stripeOff?: boolean;
  } = {},
) {
  const riderCalls: RpcCall[] = [];
  const serviceCalls: RpcCall[] = [];
  const gateway = createFakeStripeGateway({ now: () => NOW_MS });
  const prepared = {
    booking_id: BOOKING,
    reference: "AV-000042",
    payment_id: PAYMENT,
    amount: "49.00",
    amount_cents: 4900,
    currency: "SGD",
    expires_at: new Date(NOW_MS + 35 * 60_000).toISOString(),
    description: "BICII 125 certification",
    reused: false,
  };
  const rider = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      riderCalls.push({ name, args });
      return o.prepare ?? { data: [prepared], error: null };
    },
  };
  const service = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      serviceCalls.push({ name, args });
      if (name === "note_sign_in_attempt") {
        if (o.limitError) return { data: null, error: { code: "57014", message: "timeout" } };
        return { data: [{ bucket_key: "k", hit_count: o.hits ?? 1 }], error: null };
      }
      return { data: {}, error: o.record?.error ?? null };
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: { stripe_checkout_session_id: o.sessionId ?? null },
          error: null,
        }),
      };
      return builder;
    },
  };
  const stripe: StripeDeps = {
    supabase: service as never,
    gateway,
    config: o.stripeOff
      ? { state: "off", reason: "no_key" as never }
      : {
          state: "on",
          mode: "fake",
          livemode: false,
          origin: "https://admin.example",
          webhookSecret: "whsec_testtesttest",
          secretKey: null,
        },
    log: pino({ level: "silent" }),
    correlationId: "req-1",
    now: () => NOW_MS,
  };
  const deps = {
    stripe: () => stripe,
    verify: async () => (o.verify === undefined ? USER : o.verify),
    riderClient: () => rider as never,
    siteUrl: () => SITE,
  };
  return { deps, gateway, riderCalls, serviceCalls, prepared };
}

const BODY = {
  requestId: "99999999-8888-4777-8666-555555555555",
  adventureSlug: "bicii-125",
  kind: "self_supported",
  revisionNumber: 2,
  tshirtSize: "M",
  finisherName: "first_name_initial",
  termsVersion: "2026-11",
};

function post(body: unknown = BODY, token: string | null = TOKEN): Request {
  return new Request("https://admin.example/api/adventures/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/adventures/checkout", () => {
  it("needs the rider's token, a valid body and a verified sign-in", async () => {
    const h = harness();
    expect((await handleAdventureCheckout(post(BODY, null), h.deps)).status).toBe(401);
    expect((await handleAdventureCheckout(post("{", TOKEN), h.deps)).status).toBe(400);
    expect((await handleAdventureCheckout(post({ ...BODY, kind: "race" }), h.deps)).status).toBe(
      400,
    );
    expect((await handleAdventureCheckout(post({ ...BODY, amount: 1 }), h.deps)).status).toBe(200);
    const unverified = harness({ verify: null });
    expect((await handleAdventureCheckout(post(), unverified.deps)).status).toBe(401);
    expect(unverified.riderCalls).toEqual([]);
  });

  it("passes tracker hire days to the database, and refuses a malformed day (D187)", async () => {
    const h = harness();
    const res = await handleAdventureCheckout(
      post({ ...BODY, hire: { collectOn: "2026-12-05", returnOn: "2026-12-07" } }),
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(h.riderCalls[0].args).toMatchObject({
      recording_method: "tracker_hire",
      hire_collect_on: "2026-12-05",
      hire_return_on: "2026-12-07",
    });
    const bad = harness();
    const refused = await handleAdventureCheckout(
      post({ ...BODY, hire: { collectOn: "5/12/2026", returnOn: "2026-12-07" } }),
      bad.deps,
    );
    expect(refused.status).toBe(400);
    expect(bad.riderCalls).toEqual([]);
  });

  it("passes a supported departure to the database (D196)", async () => {
    const h = harness();
    const res = await handleAdventureCheckout(
      post({ ...BODY, kind: "supported", departureId: "77777777-6666-4555-8444-333333333333" }),
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(h.riderCalls[0].args).toMatchObject({
      kind: "supported",
      departure_id: "77777777-6666-4555-8444-333333333333",
    });
  });

  it("sets the board name the rider chose, as the rider, after preparing (D218)", async () => {
    const h = harness();
    const res = await handleAdventureCheckout(
      post({ ...BODY, finisherName: "hidden", boardName: " Captain Cadence " }),
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(h.riderCalls.map((c) => c.name)).toEqual([
      "prepare_my_adventure_checkout",
      "set_my_board_name",
    ]);
    expect(h.riderCalls[1].args).toEqual({
      booking_id: h.prepared.booking_id,
      board_name: "Captain Cadence",
    });
    const long = harness();
    expect(
      (await handleAdventureCheckout(post({ ...BODY, boardName: "x".repeat(41) }), long.deps))
        .status,
    ).toBe(400);
  });

  it("refuses a board name the database would refuse before anything is held (audit A-59)", async () => {
    for (const bad of ["j@ne", "see www.x.sg", "A\u200bB", "x"]) {
      const h = harness();
      const res = await handleAdventureCheckout(post({ ...BODY, boardName: bad }), h.deps);
      expect(res.status).toBe(409);
      expect(h.riderCalls).toEqual([]);
    }
  });

  it("prepares as the rider, creates a session with the payment's key, records it and returns Stripe's URL", async () => {
    const h = harness();
    const res = await handleAdventureCheckout(post(), h.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `${SITE}/account/adventures/${BOOKING}?checkout=done`,
      bookingId: BOOKING,
      reference: "AV-000042",
    });
    expect(h.riderCalls).toEqual([
      {
        name: "prepare_my_adventure_checkout",
        args: {
          request_id: BODY.requestId,
          adventure_slug: "bicii-125",
          kind: "self_supported",
          revision_number: 2,
          tshirt_size: "M",
          finisher_name: "first_name_initial",
          terms_version: "2026-11",
        },
      },
    ]);
    expect(h.gateway.calls).toEqual([{ op: "create", key: `bicii-checkout-${PAYMENT}` }]);
    const recorded = h.serviceCalls.find((c) => c.name === "record_adventure_checkout");
    expect(recorded?.args.payment_id).toBe(PAYMENT);
    expect(
      (recorded?.args.session as { metadata: Record<string, string> }).metadata.bicii_subject,
    ).toBe("adventure");
  });

  it("a retry with a recorded open session reuses it without creating another (C01)", async () => {
    const h = harness();
    const first = await h.gateway.createCheckoutSession(
      { ...INPUT, successUrl: `${SITE}/account/adventures/${BOOKING}?checkout=done` },
      `bicii-checkout-${PAYMENT}`,
    );
    const again = harness({ sessionId: first.id });
    // Share the fake's state: the same gateway object.
    (again.deps.stripe() as StripeDeps).gateway = h.gateway;
    const res = await handleAdventureCheckout(post(), again.deps);
    expect(res.status).toBe(200);
    expect(h.gateway.calls.map((c) => c.op)).toEqual(["create", "retrieve"]);
    expect(again.serviceCalls.some((c) => c.name === "record_adventure_checkout")).toBe(false);
  });

  it("passes on Postgres's refusals with the customer's sentence, never a raw message", async () => {
    const closed = harness({
      prepare: { data: null, error: { code: "P0001", message: "adventure_sales_closed" } },
    });
    const res = await handleAdventureCheckout(post(), closed.deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "adventure_sales_closed",
      message: "Certified rides are not on sale yet.",
    });
    const notCustomer = harness({
      prepare: { data: null, error: { code: "42501", message: "customer account required" } },
    });
    expect((await handleAdventureCheckout(post(), notCustomer.deps)).status).toBe(403);
    expect(closed.gateway.calls).toEqual([]);
  });

  it("limits each rider to 20 starts per 5 minutes, and answers 503 when Stripe is off", async () => {
    const busy = harness({ hits: 21 });
    expect((await handleAdventureCheckout(post(), busy.deps)).status).toBe(429);
    expect(busy.riderCalls).toEqual([]);
    // The limiter failing closes checkout rather than skipping the limit (audit A-36).
    const broken = harness({ limitError: true });
    expect((await handleAdventureCheckout(post(), broken.deps)).status).toBe(503);
    expect(broken.riderCalls).toEqual([]);
    const off = harness({ stripeOff: true });
    expect((await handleAdventureCheckout(post(), off.deps)).status).toBe(503);
  });
});

describe("adventure payments outside the checkout (audit A-41, A-42)", () => {
  function deps(
    gateway: Record<string, unknown> | null,
    rpc?: (name: string, args: unknown) => unknown,
  ) {
    return {
      supabase: rpc ? ({ rpc: async (n: string, a: unknown) => rpc(n, a) } as never) : null,
      gateway: gateway as never,
      config: { state: "on" } as never,
      log: { warn: () => {}, info: () => {}, error: () => {} } as never,
      correlationId: "c-1",
      now: () => 0,
    };
  }

  it("expires each open Stripe page of a booking before it is cancelled", async () => {
    const { expireAdventureCheckouts } =
      await import("@/lib/integrations/stripe/adventure-payments");
    const expired: string[] = [];
    const staff = {
      from: () => {
        const b = {
          select: () => b,
          eq: () => b,
          not: async () => ({
            data: [{ id: "p-1", stripe_checkout_session_id: "cs_test_1" }],
            error: null,
          }),
        };
        return b;
      },
    };
    const n = await expireAdventureCheckouts(
      deps({ expireCheckoutSession: async (id: string) => expired.push(id) }),
      staff as never,
      "b-1",
    );
    expect(n).toBe(1);
    expect(expired).toEqual(["cs_test_1"]);
  });

  it("reads stale sessions back from Stripe and records them", async () => {
    const { checkStaleAdventurePayments } =
      await import("@/lib/integrations/stripe/adventure-payments");
    const calls: Array<[string, unknown]> = [];
    const summary = await checkStaleAdventurePayments(
      deps(
        {
          retrieveCheckoutSession: async (id: string) => ({
            id,
            raw: { id, object: "checkout.session" },
          }),
        },
        (name, args) => {
          calls.push([name, args]);
          if (name === "stale_adventure_payments") {
            return { data: [{ payment_id: "p-1", session_id: "cs_test_9" }], error: null };
          }
          return { data: [{ outcome: "payment_paid" }], error: null };
        },
      ),
      { max: 3, deadlineMs: 1 },
    );
    expect(summary).toEqual({ checked: 1, failed: 0 });
    expect(calls[1]).toEqual([
      "record_adventure_stripe_read",
      {
        payment_id: "p-1",
        object: { id: "cs_test_9", object: "checkout.session" },
        correlation_id: "c-1",
      },
    ]);
  });
});
