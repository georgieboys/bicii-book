// @vitest-environment node
/**
 * POST /api/stripe/webhooks's handler with injected dependencies (D153,
 * D159; ADR-025): what is stored, with which status, what is answered, and
 * what reaches the logs. The database side (store and apply, dedupe,
 * rejected rows, the projection) is tests/db/stripe-payments.test.ts.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { handleStripeWebhook } = await import("@/lib/integrations/stripe/webhooks");
const { SlidingWindowLimiter } = await import("@/lib/integrations/limiter");
const { MAX_WEBHOOK_BYTES, WEBHOOK_HEADER_ALLOWLIST } =
  await import("@/lib/integrations/stripe/config");

import type { StripeConfig } from "@/lib/integrations/stripe/client";
import type { RecordStripeEventInput } from "@/lib/integrations/stripe/records";
import type { StripeWebhookDeps } from "@/lib/integrations/stripe/webhooks";

import {
  sessionObject,
  signStripeBody,
  STRIPE_TEST_WEBHOOK_SECRET,
  stripeEvent,
  stripeWebhookHeaders,
} from "../fixtures/stripe";

const URL_ = "http://localhost:3000/api/stripe/webhooks";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const ON: StripeConfig = {
  state: "on",
  mode: "fake",
  livemode: false,
  origin: "http://localhost:3000",
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
  secretKey: null,
};

const event = stripeEvent({
  id: "evt_test_1",
  type: "checkout.session.completed",
  created: NOW_S,
  object: sessionObject({
    id: "cs_test_hook1",
    paymentId: "11111111-2222-4333-8444-555555555555",
    workOrderId: "66666666-7777-4888-9999-000000000000",
    amountCents: 12000,
    paymentIntent: "pi_t1",
    extra: {
      customer_details: { email: "payer@example.com", name: "Pat Payer" },
      success_url: "http://localhost:3000/quote/TOKEN123?deposit=returned",
    },
  }),
});
const raw = JSON.stringify(event);

function signed(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    body,
    headers: { ...stripeWebhookHeaders({ raw: body, timestamp: NOW_S }), ...headers },
  });
}

function deps(overrides: Partial<StripeWebhookDeps> = {}) {
  const records: RecordStripeEventInput[] = [];
  const lines: string[] = [];
  const log = pino(
    { level: "trace" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  const d: Partial<StripeWebhookDeps> = {
    config: ON,
    record: vi.fn(async (input: RecordStripeEventInput) => {
      records.push(input);
      return input.rejection_reason
        ? {
            event_id: "e-rej",
            duplicate: false,
            event_status: "rejected" as const,
            outcome: null,
            payment_id: null,
          }
        : {
            event_id: "e-1",
            duplicate: false,
            event_status: "applied" as const,
            outcome: "payment_paid",
            payment_id: "p-1",
          };
    }),
    rejectedLimiter: new SlidingWindowLimiter(30),
    log,
    now: () => NOW_MS,
    ...overrides,
  };
  return { d, records, lines };
}

function expectCleanLogs(lines: string[]) {
  const all = lines.join("\n");
  for (const banned of [
    "stripe-signature",
    "whsec_",
    "/quote/",
    "TOKEN123",
    "cs_test_",
    "payer@example.com",
    "Pat Payer",
    "customer_details",
    "v1=",
  ]) {
    expect(all, banned).not.toContain(banned);
  }
}

describe("handleStripeWebhook", () => {
  it("413 by Content-Length, nothing read or stored", async () => {
    const { d, records } = deps();
    const req = new Request(URL_, {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
    });
    const res = await handleStripeWebhook(req, d);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(records).toEqual([]);
  });

  it("413 by the body's real size, nothing stored", async () => {
    const { d, records } = deps();
    const body = `{"x":"${"a".repeat(MAX_WEBHOOK_BYTES)}"}`;
    const res = await handleStripeWebhook(new Request(URL_, { method: "POST", body }), d);
    expect(res.status).toBe(413);
    expect(records).toEqual([]);
  });

  it("400 for an unreadable body, nothing stored", async () => {
    const { d, records } = deps();
    const req = signed(raw);
    vi.spyOn(req, "arrayBuffer").mockRejectedValue(new TypeError("aborted"));
    const res = await handleStripeWebhook(req, d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unreadable_body" });
    expect(records).toEqual([]);
  });

  it("503 while Stripe is off, stored as stripe_off without the body", async () => {
    const { d, records } = deps({ config: { state: "off", reason: "not_configured" } });
    const res = await handleStripeWebhook(signed(raw), d);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "stripe_off" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rejection_reason: "stripe_off", payload: null });
  });

  it("stores each rejection with capped evidence and no body", async () => {
    const forged = signStripeBody(raw, { timestamp: NOW_S, secret: "whsec_another" });
    const stale = signStripeBody(raw, { timestamp: NOW_S - 301 });
    const notJson = "not json";
    const array = "[1,2]";
    const shapeless = JSON.stringify({ ...event, id: "evt-bad" });
    const live = JSON.stringify({ ...event, livemode: true });
    const cases: Array<[Request, string]> = [
      [signed(raw, { "stripe-signature": forged }), "signature_invalid"],
      [signed(raw, { "stripe-signature": "" }), "signature_invalid"],
      [signed(raw, { "stripe-signature": stale }), "signature_expired"],
      [signed(notJson), "body_not_json"],
      [signed(array), "body_not_json"],
      [signed(shapeless), "event_shape_invalid"],
      [signed(live), "livemode_mismatch"],
    ];
    for (const [req, reason] of cases) {
      const { d, records, lines } = deps();
      const res = await handleStripeWebhook(req, d);
      expect(res.status, reason).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: reason });
      expect(records).toHaveLength(1);
      const r = records[0];
      expect(r).toMatchObject({ rejection_reason: reason, payload: null });
      expect(r.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body_bytes).toBeGreaterThan(0);
      // Only allow-listed headers are kept, and the signature that was sent
      // is kept as sent (evidence of what failed).
      const allowed: readonly string[] = WEBHOOK_HEADER_ALLOWLIST;
      for (const name of Object.keys(r.headers)) expect(allowed, name).toContain(name);
      expect(req.headers.has("stripe-signature"), reason).toBe(true);
      expect(r.headers).toHaveProperty("stripe-signature", req.headers.get("stripe-signature"));
      expect(r.correlation_id).toBeTruthy();
      expectCleanLogs(lines);
    }
  });

  it("keeps only the allow-listed headers", async () => {
    const { d, records } = deps();
    await handleStripeWebhook(
      signed(raw, { "stripe-signature": "t=1,v1=00", cookie: "a=b", "x-other": "1" }),
      d,
    );
    expect(Object.keys(records[0].headers).sort()).toEqual([
      "content-type",
      "stripe-signature",
      "user-agent",
    ]);
  });

  it("the 31st rejection in a minute is logged, not stored, and still refused", async () => {
    const { d, records } = deps();
    for (let i = 0; i < 31; i += 1) {
      const res = await handleStripeWebhook(signed(raw, { "stripe-signature": "bad" }), d);
      expect(res.status).toBe(400);
    }
    expect(records).toHaveLength(30);
  });

  it("200 for a new event: stored with its payload and the evidence", async () => {
    const { d, records, lines } = deps();
    const res = await handleStripeWebhook(signed(raw), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ received: true, duplicate: false });
    expect(text).not.toContain("payer@example.com");
    expect(text).not.toContain("Pat Payer");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rejection_reason: null, payload: event });
    expect(records[0].body_bytes).toBe(Buffer.byteLength(raw));
    const info = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "stripe webhook");
    expect(info).toMatchObject({
      eventId: "evt_test_1",
      type: "checkout.session.completed",
      status: 200,
      outcome: "payment_paid",
      duplicate: false,
    });
    expectCleanLogs(lines);
  });

  it("200 for a duplicate", async () => {
    const { d } = deps({
      record: async () => ({
        event_id: "e-1",
        duplicate: true,
        event_status: "applied",
        outcome: "payment_paid",
        payment_id: "p-1",
      }),
    });
    const res = await handleStripeWebhook(signed(raw), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
  });

  it("500 when storing fails (Stripe retries), then a not_recorded evidence row", async () => {
    const calls: RecordStripeEventInput[] = [];
    const { d, lines } = deps({
      record: async (input) => {
        calls.push(input);
        if (!input.rejection_reason) {
          throw Object.assign(new Error("boom payer@example.com"), { code: "XX000" });
        }
        return {
          event_id: "e-rej",
          duplicate: false,
          event_status: "rejected",
          outcome: null,
          payment_id: null,
        };
      },
    });
    const res = await handleStripeWebhook(signed(raw), d);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "not_recorded" });
    expect(calls.map((c) => c.rejection_reason)).toEqual([null, "not_recorded"]);
    expect(calls[1].payload).toBeNull();
    expect(calls[1].body_sha256).toBe(calls[0].body_sha256);
    expect(lines.join("\n")).toContain("XX000");
    expectCleanLogs(lines);
  });

  it("still answers 500 when the evidence cannot be stored either", async () => {
    const { d } = deps({
      record: async () => {
        throw new Error("down");
      },
    });
    const res = await handleStripeWebhook(signed(raw), d);
    expect(res.status).toBe(500);
  });
});
