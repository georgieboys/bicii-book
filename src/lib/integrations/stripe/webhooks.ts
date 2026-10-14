import "server-only";

import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { Json } from "@/lib/database.types";
import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/service";

import { SlidingWindowLimiter } from "../limiter";
import { stripeConfig, type StripeConfig } from "./client";
import { MAX_REJECTED_PER_MINUTE, MAX_WEBHOOK_BYTES, WEBHOOK_HEADER_ALLOWLIST } from "./config";
import { parseStripeEvent } from "./gateway";
import {
  recordStripeEvent,
  type RecordStripeEventInput,
  type RecordStripeEventResult,
  type StripeRejectionReason,
} from "./records";
import { verifyStripeSignature } from "./signature";

/**
 * POST /api/stripe/webhooks (D153, D159; ADR-025; RUNBOOK "Stripe
 * payments"): verify the signature on the raw bytes, then store and apply
 * the event in one transaction (public.record_stripe_event) before
 * answering. There is no after(): storing and applying take milliseconds,
 * well inside the 10 seconds Checkout waits for the answer to
 * checkout.session.completed before it sends the customer back.
 *
 *   413  Content-Length or the body above 1 MiB (not stored)
 *   400  an unreadable body (not stored)
 *   503  Stripe is off (stored as rejected evidence: stripe_off)
 *   400  a Stripe-Signature that does not match the raw body
 *        (signature_invalid) or is outside the 5-minute tolerance
 *        (signature_expired); a body that is not a JSON object
 *        (body_not_json); no evt_ id, type or boolean livemode
 *        (event_shape_invalid); a test event on a live endpoint or the
 *        reverse (livemode_mismatch). All stored without the body.
 *   500  record_stripe_event failed: everything rolled back, a
 *        not_recorded row kept as evidence (best effort), Stripe retries
 *        for up to 3 days
 *   200  { received: true, duplicate }, duplicates included (a 4xx is
 *        only for a real rejection)
 *
 * Rejected deliveries are evidence only (D88): capped headers, the body's
 * size and SHA-256, never the body; above 30 a minute per server instance
 * they are logged, not stored. Responses never echo the payload, and the
 * logs carry ids, type, status and outcome only: never a URL, the
 * signature, a secret or the body.
 */

export type StripeWebhookDeps = {
  config: StripeConfig;
  record: (input: RecordStripeEventInput) => Promise<RecordStripeEventResult>;
  rejectedLimiter: { allow(): boolean };
  log: Logger;
  /** The clock (tests pass a fake one), epoch milliseconds. */
  now: () => number;
};

const rejectedLimiter = new SlidingWindowLimiter(MAX_REJECTED_PER_MINUTE);

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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

function errorCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof e.code === "string") return e.code;
  return e instanceof Error ? e.name : "unknown";
}

export async function handleStripeWebhook(
  request: Request,
  overrides: Partial<StripeWebhookDeps> = {},
): Promise<Response> {
  // 1. Correlation id (the proxy does not run on this route).
  const correlationId = requestIdFrom(request.headers.get(REQUEST_ID_HEADER));
  const deps: StripeWebhookDeps = {
    config: overrides.config ?? stripeConfig(getServerEnv()),
    record:
      overrides.record ??
      ((input) => recordStripeEvent(createServiceClient({ correlationId }), input)),
    rejectedLimiter: overrides.rejectedLimiter ?? rejectedLimiter,
    log: overrides.log ?? child(correlationId, { integration: "stripe", route: "webhooks" }),
    now: overrides.now ?? Date.now,
  };

  // 2. Too large by its own account: not read, not stored.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    deps.log.warn({ status: 413, outcome: "too_large", bytes: declared }, "stripe webhook");
    return respond(413, { error: "payload_too_large" });
  }

  // 3. The raw bytes, read once.
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await request.arrayBuffer());
  } catch {
    deps.log.warn({ status: 400, outcome: "unreadable_body" }, "stripe webhook");
    return respond(400, { error: "unreadable_body" });
  }
  if (raw.byteLength > MAX_WEBHOOK_BYTES) {
    deps.log.warn({ status: 413, outcome: "too_large", bytes: raw.byteLength }, "stripe webhook");
    return respond(413, { error: "payload_too_large" });
  }

  // 4. What is kept of the delivery.
  const headers: Record<string, string> = {};
  for (const name of WEBHOOK_HEADER_ALLOWLIST) {
    const v = request.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  const base = {
    headers,
    body_sha256: createHash("sha256").update(raw).digest("hex"),
    body_bytes: raw.byteLength,
    correlation_id: correlationId,
  };

  // 5. Every rejection: stored without the body, unless too many this minute.
  const reject = async (reason: StripeRejectionReason, status: number) => {
    if (!deps.rejectedLimiter.allow()) {
      deps.log.warn(
        { status, outcome: "rejected", reason, bytes: raw.byteLength },
        "stripe_rejected_rate_limited",
      );
      return respond(status, { error: reason });
    }
    try {
      const stored = await deps.record({ ...base, payload: null, rejection_reason: reason });
      deps.log.warn(
        {
          status,
          outcome: "rejected",
          reason,
          duplicate: stored.duplicate,
          bytes: raw.byteLength,
        },
        "stripe webhook",
      );
    } catch (e) {
      deps.log.error(
        { status, outcome: "rejected", reason, code: errorCode(e) },
        "could not store a rejected stripe webhook",
      );
    }
    return respond(status, { error: reason });
  };

  // 6. Stripe off.
  const config = deps.config;
  if (config.state !== "on") return reject("stripe_off", 503);

  // 7. The signature, on the raw bytes.
  const signature = verifyStripeSignature(
    raw,
    request.headers.get("stripe-signature"),
    config.webhookSecret,
    Math.floor(deps.now() / 1000),
  );
  if (signature === "expired") return reject("signature_expired", 400);
  if (signature !== "ok") return reject("signature_invalid", 400);

  // 8-10. Shape and mode.
  const payload = parseObject(raw);
  if (!payload) return reject("body_not_json", 400);
  const event = parseStripeEvent(payload);
  if (!event) return reject("event_shape_invalid", 400);
  if (event.livemode !== config.livemode) return reject("livemode_mismatch", 400);

  // 11. Store and apply in one transaction; a failure rolls back and Stripe retries.
  let stored: RecordStripeEventResult;
  try {
    stored = await deps.record({ ...base, payload, rejection_reason: null });
  } catch (e) {
    deps.log.error(
      {
        eventId: event.id,
        type: event.type,
        status: 500,
        outcome: "not_recorded",
        code: errorCode(e),
      },
      "could not store a stripe webhook",
    );
    await reject("not_recorded", 500);
    return respond(500, { error: "not_recorded" });
  }

  // 12. Stored (a duplicate too).
  deps.log.info(
    {
      eventId: event.id,
      type: event.type,
      status: 200,
      outcome: stored.outcome ?? stored.event_status,
      eventStatus: stored.event_status,
      duplicate: stored.duplicate,
      bytes: raw.byteLength,
    },
    "stripe webhook",
  );
  return respond(200, { received: true, duplicate: stored.duplicate });
}
