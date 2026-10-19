import "server-only";

import { createHash } from "node:crypto";

import { after } from "next/server";
import type { Logger } from "pino";

import type { Database, Json } from "@/lib/database.types";
import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";

import { SlidingWindowLimiter } from "../limiter";
import {
  MAX_REJECTED_PER_MINUTE,
  MAX_WEBHOOK_BYTES,
  WEBHOOK_HEADER_ALLOWLIST,
  lastClaimAt,
} from "./config";
import { defaultDeps, type ServiceSupabase } from "./deps";
import { verifyShopifyHmac } from "./hmac";
import { runDueJobs, runJobById } from "./queue";

// Moved to ../limiter (Phase 14: Stripe's webhook route uses it too); still
// exported from here for the callers and tests that import it from Shopify.
export { SlidingWindowLimiter } from "../limiter";

/**
 * POST /api/shopify/webhooks (SPEC §17.1, §23, §26; D87, D88; ADR-020):
 * store every delivery before anything is processed, answer Shopify
 * quickly, then process.
 *
 *   413  Content-Length or the body above 1 MiB (not stored)
 *   503  SHOPIFY_WEBHOOK_SECRET or SHOPIFY_SHOP_DOMAIN unset (stored as
 *        rejected evidence: webhook_secret_missing / shop_not_configured)
 *   401  a missing or wrong HMAC of the RAW body (hmac_invalid), or
 *        another shop's X-Shopify-Shop-Domain (shop_domain_mismatch)
 *   400  no X-Shopify-Topic or X-Shopify-Webhook-Id (missing_headers), or a
 *        body that is not a JSON object (body_not_json)
 *   500  record_shopify_webhook failed: nothing stored, Shopify retries
 *   200  { received: true, duplicate } once the event is stored; after the
 *        response the new event's job runs, then a few due jobs (D87)
 *
 * Rejected deliveries are evidence only (D88): capped headers, the body's
 * size and SHA-256, never the body, never the dedupe key; above 30 a
 * minute per server instance they are logged, not stored. The body is read
 * once, as bytes, and the signature is checked on those bytes before
 * anything is parsed. Responses never echo the payload.
 */

type RecordArgs = Database["public"]["Functions"]["record_shopify_webhook"]["Args"];
type RejectionReason = Database["public"]["Enums"]["integration_rejection_reason"];

export type RecordWebhookInput = {
  topic: string | null;
  webhook_id: string | null;
  shopify_event_id: string | null;
  shop_domain: string | null;
  api_version: string | null;
  triggered_at: string | null;
  headers: Record<string, string>;
  payload: Json | null;
  body_sha256: string;
  body_bytes: number;
  hmac_valid: boolean;
  rejection_reason: RejectionReason | null;
  correlation_id: string;
};

export type RecordWebhookResult = {
  event_id: string;
  duplicate: boolean;
  event_status: Database["public"]["Enums"]["integration_event_status"];
  job_id: string | null;
};

const processLimiter = new SlidingWindowLimiter(MAX_REJECTED_PER_MINUTE);

export type WebhookDeps = {
  secret: string | undefined;
  shopDomain: string | undefined;
  record: (input: RecordWebhookInput) => Promise<RecordWebhookResult>;
  schedule: (task: () => Promise<void>) => void;
  runEvent: (jobId: string, correlationId: string) => Promise<unknown>;
  runDue: (
    options: { limit: number; claimUntil: number },
    correlationId: string,
  ) => Promise<unknown>;
  rejectedLimiter: { allow(): boolean };
  log: Logger;
  /** The clock (tests pass a fake one). */
  now: () => number;
};

/** Store one delivery through public.record_shopify_webhook (service role). */
export async function recordShopifyWebhook(
  supabase: ServiceSupabase,
  input: RecordWebhookInput,
): Promise<RecordWebhookResult> {
  const { data, error } = await supabase.rpc(
    "record_shopify_webhook",
    input as unknown as RecordArgs,
  );
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const row = (data ?? [])[0];
  if (!row) throw new Error("record_shopify_webhook returned no row");
  return row as RecordWebhookResult;
}

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function header(request: Request, name: string): string | null {
  const v = request.headers.get(name)?.trim();
  return v ? v : null;
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function parseObject(raw: Uint8Array): Record<string, Json> | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, Json>)
      : null;
  } catch {
    return null;
  }
}

export async function handleShopifyWebhook(
  request: Request,
  overrides: Partial<WebhookDeps> = {},
): Promise<Response> {
  // 1. Correlation id (the proxy does not run on this route).
  const correlationId = newRequestId();
  const now = overrides.now ?? Date.now;
  // The function's clock starts with the request; after() shares its maxDuration.
  const startedAt = now();
  const has = (key: keyof WebhookDeps) => Object.prototype.hasOwnProperty.call(overrides, key);
  const env = has("secret") && has("shopDomain") ? null : getServerEnv();
  const deps: WebhookDeps = {
    secret: has("secret") ? overrides.secret : env?.SHOPIFY_WEBHOOK_SECRET,
    shopDomain: has("shopDomain") ? overrides.shopDomain : env?.SHOPIFY_SHOP_DOMAIN,
    record:
      overrides.record ??
      ((input) => recordShopifyWebhook(defaultDeps(input.correlation_id).supabase, input)),
    schedule: overrides.schedule ?? after,
    runEvent: overrides.runEvent ?? ((jobId, cid) => runJobById(jobId, defaultDeps(cid))),
    runDue: overrides.runDue ?? ((options, cid) => runDueJobs(options, defaultDeps(cid))),
    rejectedLimiter: overrides.rejectedLimiter ?? processLimiter,
    log: overrides.log ?? child(correlationId, { integration: "shopify", route: "webhooks" }),
    now,
  };

  const topic = header(request, "x-shopify-topic");
  const webhookId = header(request, "x-shopify-webhook-id");
  // The default logger is bound to the correlation id already.
  const logBase = { topic, webhookId };

  // 2. Too large by its own account: not read, not stored.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    deps.log.warn(
      { ...logBase, status: 413, outcome: "too_large", bytes: declared },
      "shopify webhook",
    );
    return respond(413, { error: "payload_too_large" });
  }

  // 3. The raw bytes, read once.
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await request.arrayBuffer());
  } catch {
    deps.log.warn({ ...logBase, status: 400, outcome: "unreadable_body" }, "shopify webhook");
    return respond(400, { error: "unreadable_body" });
  }
  if (raw.byteLength > MAX_WEBHOOK_BYTES) {
    deps.log.warn(
      { ...logBase, status: 413, outcome: "too_large", bytes: raw.byteLength },
      "shopify webhook",
    );
    return respond(413, { error: "payload_too_large" });
  }

  // 4. What is kept of the delivery.
  const headers: Record<string, string> = {};
  for (const name of WEBHOOK_HEADER_ALLOWLIST) {
    const v = request.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  const base: Omit<RecordWebhookInput, "payload" | "hmac_valid" | "rejection_reason"> = {
    topic,
    webhook_id: webhookId,
    shopify_event_id: header(request, "x-shopify-event-id"),
    shop_domain: header(request, "x-shopify-shop-domain"),
    api_version: header(request, "x-shopify-api-version"),
    triggered_at: isoOrNull(header(request, "x-shopify-triggered-at")),
    headers,
    body_sha256: createHash("sha256").update(raw).digest("hex"),
    body_bytes: raw.byteLength,
    correlation_id: correlationId,
  };

  const reject = async (reason: RejectionReason, status: number, hmacValid: boolean) => {
    if (!deps.rejectedLimiter.allow()) {
      deps.log.warn(
        { ...logBase, status, outcome: "rejected", reason },
        "shopify_rejected_rate_limited",
      );
      return respond(status, { error: reason });
    }
    try {
      const stored = await deps.record({
        ...base,
        payload: null,
        hmac_valid: hmacValid,
        rejection_reason: reason,
      });
      deps.log.warn(
        {
          ...logBase,
          eventId: stored.event_id,
          duplicate: stored.duplicate,
          status,
          outcome: "rejected",
          reason,
        },
        "shopify webhook",
      );
    } catch (e) {
      deps.log.error(
        {
          ...logBase,
          status,
          outcome: "rejected",
          reason,
          err: e instanceof Error ? e.message : String(e),
        },
        "could not store a rejected shopify webhook",
      );
    }
    return respond(status, { error: reason });
  };

  // 5-8. Configuration, signature, shop.
  if (!deps.secret) return reject("webhook_secret_missing", 503, false);
  if (!deps.shopDomain) return reject("shop_not_configured", 503, false);
  if (!verifyShopifyHmac(raw, request.headers.get("x-shopify-hmac-sha256"), deps.secret)) {
    return reject("hmac_invalid", 401, false);
  }
  if ((base.shop_domain ?? "").toLowerCase() !== deps.shopDomain.toLowerCase()) {
    return reject("shop_domain_mismatch", 401, true);
  }
  // 9-10. Shape.
  if (!topic || !webhookId) return reject("missing_headers", 400, true);
  const payload = parseObject(raw);
  if (!payload) return reject("body_not_json", 400, true);

  // 11. Store, answer, then process.
  let stored: RecordWebhookResult;
  try {
    stored = await deps.record({ ...base, payload, hmac_valid: true, rejection_reason: null });
  } catch (e) {
    deps.log.error(
      {
        ...logBase,
        status: 500,
        outcome: "not_recorded",
        err: e instanceof Error ? e.message : String(e),
      },
      "could not store a shopify webhook",
    );
    return respond(500, { error: "not_recorded" });
  }

  const jobId = stored.job_id;
  const duplicate = stored.duplicate;
  deps.schedule(async () => {
    try {
      if (jobId && !duplicate) await deps.runEvent(jobId, correlationId);
      // Claim only while a job's worst case still ends inside maxDuration (D87).
      await deps.runDue({ limit: 5, claimUntil: lastClaimAt(startedAt) }, correlationId);
    } catch (e) {
      deps.log.error(
        { ...logBase, eventId: stored.event_id, err: e instanceof Error ? e.message : String(e) },
        "shopify webhook follow-up failed",
      );
    }
  });
  deps.log.info(
    {
      ...logBase,
      eventId: stored.event_id,
      duplicate,
      status: 200,
      outcome: stored.event_status,
    },
    "shopify webhook",
  );
  return respond(200, { received: true, duplicate });
}
