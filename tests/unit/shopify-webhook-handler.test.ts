// @vitest-environment node
/**
 * POST /api/shopify/webhooks's handler with injected dependencies (SPEC
 * §17.1, §23; D87, D88): what is stored, with which status, and what runs
 * after the response. The database side (dedupe, rejected rows) is
 * tests/db/shopify-webhooks.test.ts; the live chain is
 * tests/db/shopify.stack.test.ts.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { handleShopifyWebhook, SlidingWindowLimiter } =
  await import("@/lib/integrations/shopify/webhooks");
const { MAX_WEBHOOK_BYTES } = await import("@/lib/integrations/shopify/config");

import type { RecordWebhookInput, WebhookDeps } from "@/lib/integrations/shopify/webhooks";

import {
  SHOPIFY_TEST_SECRET,
  SHOPIFY_TEST_SHOP,
  orderPaidPayload,
  webhookHeaders,
} from "../fixtures/shopify";

const URL_ = "http://localhost:3000/api/shopify/webhooks";

function signed(raw: string, headers: Partial<Record<string, string>> = {}, webhookId = "wh-1") {
  const h = { ...webhookHeaders({ topic: "orders/paid", webhookId, raw }), ...headers };
  for (const [k, v] of Object.entries(h)) if (v === undefined) delete h[k];
  return new Request(URL_, { method: "POST", body: raw, headers: h as Record<string, string> });
}

const order = JSON.stringify(
  orderPaidPayload({
    orderId: 7000009001,
    name: "#9001",
    lines: [{ lineItemId: 1, variantId: 2, title: "Bottle", quantity: 1, price: "25.00" }],
  }),
);

/** The fake clock's request time: due jobs may be claimed until T0 + 10 s (lastClaimAt). */
const T0 = 1_800_000_000_000;

function deps(overrides: Partial<WebhookDeps> = {}) {
  const records: RecordWebhookInput[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const runEvent = vi.fn(async () => "done");
  const runDue = vi.fn(async () => ({}));
  const d: Partial<WebhookDeps> = {
    secret: SHOPIFY_TEST_SECRET,
    shopDomain: SHOPIFY_TEST_SHOP,
    record: vi.fn(async (input: RecordWebhookInput) => {
      records.push(input);
      return input.rejection_reason
        ? { event_id: "e-rej", duplicate: false, event_status: "rejected" as const, job_id: null }
        : { event_id: "e-1", duplicate: false, event_status: "pending" as const, job_id: "j-1" };
    }),
    schedule: (task) => {
      tasks.push(task);
    },
    runEvent,
    runDue,
    rejectedLimiter: new SlidingWindowLimiter(30),
    log: pino({ level: "silent" }),
    now: () => T0,
    ...overrides,
  };
  return { d, records, tasks, runEvent, runDue };
}

describe("handleShopifyWebhook", () => {
  it("413 by Content-Length, nothing read or stored", async () => {
    const { d, records } = deps();
    const req = new Request(URL_, {
      method: "POST",
      body: "{}",
      headers: {
        "content-length": String(MAX_WEBHOOK_BYTES + 1),
        "content-type": "application/json",
      },
    });
    const res = await handleShopifyWebhook(req, d);
    expect(res.status).toBe(413);
    expect(records).toEqual([]);
  });

  it("413 by the body's real size, nothing stored", async () => {
    const { d, records } = deps();
    const raw = `{"x":"${"a".repeat(MAX_WEBHOOK_BYTES)}"}`;
    const req = new Request(URL_, {
      method: "POST",
      body: raw,
      headers: { "x-shopify-topic": "orders/paid" },
    });
    expect((await handleShopifyWebhook(req, d)).status).toBe(413);
    expect(records).toEqual([]);
  });

  it("503 without a webhook secret, stored as rejected evidence without the body", async () => {
    const { d, records, tasks } = deps({ secret: undefined });
    const res = await handleShopifyWebhook(signed(order), d);
    expect(res.status).toBe(503);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      rejection_reason: "webhook_secret_missing",
      payload: null,
      hmac_valid: false,
    });
    expect(tasks).toEqual([]);
  });

  it("503 without a shop domain, stored as shop_not_configured", async () => {
    const { d, records } = deps({ shopDomain: undefined });
    expect((await handleShopifyWebhook(signed(order), d)).status).toBe(503);
    expect(records[0]).toMatchObject({ rejection_reason: "shop_not_configured", payload: null });
  });

  it("401 for a bad HMAC: stored with capped headers, size and SHA-256, never the body", async () => {
    const { d, records } = deps();
    const res = await handleShopifyWebhook(
      signed(order, { "x-shopify-hmac-sha256": "AAAA", "x-not-allowed": "secret" }),
      d,
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("#9001");
    const r = records[0];
    expect(r).toMatchObject({
      rejection_reason: "hmac_invalid",
      hmac_valid: false,
      payload: null,
      topic: "orders/paid",
      webhook_id: "wh-1",
      shop_domain: SHOPIFY_TEST_SHOP,
      body_bytes: Buffer.byteLength(order),
    });
    expect(r.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.headers).not.toHaveProperty("x-not-allowed");
    expect(r.headers["x-shopify-topic"]).toBe("orders/paid");
  });

  it("401 for another shop's delivery (case-insensitive match passes)", async () => {
    const other = deps();
    expect(
      (
        await handleShopifyWebhook(
          signed(order, { "x-shopify-shop-domain": "evil.myshopify.com" }),
          other.d,
        )
      ).status,
    ).toBe(401);
    expect(other.records[0]).toMatchObject({
      rejection_reason: "shop_domain_mismatch",
      hmac_valid: true,
      payload: null,
    });

    const upper = deps();
    expect(
      (
        await handleShopifyWebhook(
          signed(order, { "x-shopify-shop-domain": SHOPIFY_TEST_SHOP.toUpperCase() }),
          upper.d,
        )
      ).status,
    ).toBe(200);
  });

  it("400 for missing topic or webhook id, and for a body that is not a JSON object", async () => {
    for (const missing of ["x-shopify-topic", "x-shopify-webhook-id"]) {
      const { d, records } = deps();
      const res = await handleShopifyWebhook(signed(order, { [missing]: undefined }), d);
      expect(res.status).toBe(400);
      expect(records[0]).toMatchObject({ rejection_reason: "missing_headers", payload: null });
    }
    for (const raw of ["[1,2]", "not json", "null", '"text"']) {
      const { d, records } = deps();
      expect((await handleShopifyWebhook(signed(raw), d)).status).toBe(400);
      expect(records[0]).toMatchObject({ rejection_reason: "body_not_json", payload: null });
    }
  });

  it("the 31st rejected delivery in a minute is logged, not stored, and still refused", async () => {
    const limiter = new SlidingWindowLimiter(30);
    const { d, records } = deps({ rejectedLimiter: limiter });
    for (let i = 0; i < 31; i++) {
      const res = await handleShopifyWebhook(
        signed(`{"n":${i}}`, { "x-shopify-hmac-sha256": "bad" }),
        d,
      );
      expect(res.status).toBe(401);
    }
    expect(records).toHaveLength(30);
  });

  it("the limiter's window slides", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect([limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, false]);
    now = 60_001;
    expect(limiter.allow()).toBe(true);
  });

  it("200 for a new event: stored with its payload, then its job and a few due jobs run after the response", async () => {
    const { d, records, tasks, runEvent, runDue } = deps();
    const res = await handleShopifyWebhook(
      signed(order, {
        "x-shopify-triggered-at": "2026-10-06T01:02:03.000Z",
        "x-request-id": "req-abcdef12",
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: false });
    expect(records[0]).toMatchObject({
      rejection_reason: null,
      hmac_valid: true,
      topic: "orders/paid",
      webhook_id: "wh-1",
      shopify_event_id: "evt-wh-1",
      triggered_at: "2026-10-06T01:02:03.000Z",
    });
    // A fresh id, never the incoming x-request-id (audit 2026-10-18).
    const correlationId = records[0].correlation_id;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((records[0].payload as { name: string }).name).toBe("#9001");
    expect(runEvent).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(runEvent).toHaveBeenCalledExactlyOnceWith("j-1", correlationId);
    expect(runDue).toHaveBeenCalledExactlyOnceWith(
      { limit: 5, claimUntil: T0 + 10_000 },
      correlationId,
    );
    expect(runEvent.mock.invocationCallOrder[0]).toBeLessThan(runDue.mock.invocationCallOrder[0]);
  });

  it("200 for a duplicate: no event run, only due jobs", async () => {
    const { d, tasks, runEvent, runDue } = deps({
      record: async () => ({
        event_id: "e-1",
        duplicate: true,
        event_status: "processed",
        job_id: null,
      }),
    });
    const res = await handleShopifyWebhook(signed(order), d);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    await tasks[0]();
    expect(runEvent).not.toHaveBeenCalled();
    expect(runDue).toHaveBeenCalledOnce();
  });

  it("500 when the event cannot be stored (Shopify retries), nothing scheduled", async () => {
    const { d, tasks } = deps({
      record: async () => {
        throw new Error("database down");
      },
    });
    const res = await handleShopifyWebhook(signed(order), d);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("#9001");
    expect(tasks).toEqual([]);
  });

  it("a failing follow-up is logged, never thrown", async () => {
    const { d, tasks } = deps({
      runEvent: async () => {
        throw new Error("boom");
      },
    });
    await handleShopifyWebhook(signed(order), d);
    await expect(tasks[0]()).resolves.toBeUndefined();
  });
});
