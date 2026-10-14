import "server-only";

import { randomUUID } from "node:crypto";

import type { Json } from "@/lib/database.types";

import {
  PAYMENT_INTENT_ID,
  SESSION_ID,
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  STRIPE_TIMEOUT_MS,
  expireIdempotencyKey,
} from "./config";
import { checkoutSessionParams, formEncode } from "./form";
import {
  StripeError,
  toCheckoutSession,
  toPaymentIntent,
  type CheckoutSession,
  type CheckoutSessionInput,
  type StripeGateway,
  type StripePaymentIntent,
  type StripeRefundObject,
} from "./gateway";

/**
 * The live StripeGateway: Stripe's REST API over fetch, no SDK (Phase 14;
 * ADR-025), authenticated with a secret or restricted key and pinned to
 * STRIPE_API_VERSION. The host is fixed and every id in a path is
 * validated first, so nothing a caller passes can send the key elsewhere.
 *
 * Error mapping (RUNBOOK "Stripe payments"):
 *   fetch throws or times out, 409 (an idempotent request still running),
 *   5xx                                   -> stripe_unavailable
 *   429                                   -> stripe_rate_limited
 *   401, 403                              -> stripe_auth_failed
 *   404                                   -> stripe_not_found
 *   400 with error.type idempotency_error -> stripe_idempotency_conflict
 *   any 400 on /expire                    -> stripe_session_not_open
 *   other 4xx                             -> stripe_request_failed (stripeCode)
 *   a 2xx BICII cannot use (wrong object, no id, another livemode)
 *                                         -> stripe_bad_response
 *
 * Each call is retried once, with the same Idempotency-Key and
 * byte-identical body, only when the retry can get a different answer:
 * after a network error or a timeout (nothing was saved), a 409 (the same
 * idempotent request still running) or a 429, and after a 5xx on a GET
 * (no key) or when Stripe says `Stripe-Should-Retry: true`. A POST's other
 * 5xx is not retried: Stripe saves the result of an idempotent request
 * that started executing, 500s included, and replays it for the same key
 * (docs.stripe.com/api/idempotent_requests). After a 409 or a 429 the
 * retry waits RETRY_DELAY_MIN_MS to RETRY_DELAY_MAX_MS, jittered, so it
 * does not land on the same contention; otherwise it is immediate. Expire
 * takes a fresh key per call (expireIdempotencyKey), so a saved 500 never
 * blocks a later expire. Of an error body only `error.type` and `error.code` are
 * read; Stripe's message and param can echo request values (the return
 * URLs carry the quote token) and are dropped. The gateway never logs:
 * callers log the op and the error's code.
 */

export type HttpGatewayOptions = {
  secretKey: string;
  /** The key's mode (stripeConfig): every session read must have the same livemode. */
  livemode: boolean;
  timeoutMs?: number;
  /** Waits before a retry after 409 or 429 (injected by tests). */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1) for the jitter (injected by tests). */
  random?: () => number;
  /** Epoch milliseconds (checkoutSessionParams' window; injected by tests). */
  now?: () => number;
  /** The expire key's nonce (injected by tests). */
  nonce?: () => string;
};

/** The wait before the single retry after a 409 or a 429, in milliseconds. */
export const RETRY_DELAY_MIN_MS = 250;
export const RETRY_DELAY_MAX_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A jittered wait in [RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS]. */
export function retryDelayMs(random: () => number = Math.random): number {
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
  return Math.round(RETRY_DELAY_MIN_MS + unit * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS));
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 100 ? value : undefined;
}

type Call = {
  method: "GET" | "POST";
  path: string;
  /** POST only: the form body, computed once and reused on the retry. */
  body?: string;
  idempotencyKey?: string;
  /** Any 400 means the session is no longer open (/expire). */
  expire?: boolean;
};

export function createHttpStripeGateway(
  {
    secretKey,
    livemode,
    timeoutMs = STRIPE_TIMEOUT_MS,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    nonce = randomUUID,
  }: HttpGatewayOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): StripeGateway {
  async function once(call: Call): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
      Accept: "application/json",
    };
    if (call.method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (call.idempotencyKey) headers["Idempotency-Key"] = call.idempotencyKey;
    }
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(`${STRIPE_API_BASE}${call.path}`, {
        method: call.method,
        headers,
        body: call.method === "POST" ? (call.body ?? "") : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
      text = await res.text();
    } catch {
      throw new StripeError("stripe_unavailable", true);
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const status = res.status;
    // A 5xx is worth repeating only when no result was saved under the key.
    const shouldRetry = call.method === "GET" || res.headers.get("stripe-should-retry") === "true";
    if (status >= 200 && status < 300) {
      if (!isObj(body)) throw new StripeError("stripe_bad_response", false, status);
      return body;
    }
    const error = isObj(body) && isObj(body.error) ? body.error : {};
    const type = shortString(error.type);
    const code = shortString(error.code);
    if (status === 429) throw new StripeError("stripe_rate_limited", true, status, code);
    if (status === 409) throw new StripeError("stripe_unavailable", true, status, code);
    if (status >= 500) throw new StripeError("stripe_unavailable", shouldRetry, status, code);
    if (status === 401 || status === 403) {
      throw new StripeError("stripe_auth_failed", false, status, code);
    }
    if (status === 404) throw new StripeError("stripe_not_found", false, status, code);
    if (status === 400 && type === "idempotency_error") {
      throw new StripeError("stripe_idempotency_conflict", false, status, code);
    }
    if (status === 400 && call.expire) {
      throw new StripeError("stripe_session_not_open", false, status, code);
    }
    throw new StripeError("stripe_request_failed", false, status, code);
  }

  async function request(call: Call): Promise<unknown> {
    try {
      return await once(call);
    } catch (e) {
      if (!(e instanceof StripeError && e.retriable)) throw e;
      if (e.status === 409 || e.status === 429) await sleep(retryDelayMs(random));
      // The same call: the body was computed once, the key is the same.
      return once(call);
    }
  }

  function sessionPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new StripeError("stripe_request_failed", false);
    return `/v1/checkout/sessions/${encodeURIComponent(id)}`;
  }

  return {
    mode: livemode ? "live" : "test",
    livemode,

    async createCheckoutSession(
      input: CheckoutSessionInput,
      idempotencyKey: string,
    ): Promise<CheckoutSession> {
      const body = formEncode(checkoutSessionParams(input, Math.floor(now() / 1000)));
      const raw = await request({
        method: "POST",
        path: "/v1/checkout/sessions",
        body,
        idempotencyKey,
      });
      return toCheckoutSession(raw, livemode);
    },

    async retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
      const raw = await request({ method: "GET", path: sessionPath(id) });
      return toCheckoutSession(raw, livemode);
    },

    async expireCheckoutSession(id: string): Promise<CheckoutSession> {
      const raw = await request({
        method: "POST",
        path: `${sessionPath(id)}/expire`,
        body: "",
        idempotencyKey: expireIdempotencyKey(id, nonce()),
        expire: true,
      });
      return toCheckoutSession(raw, livemode);
    },

    async listRefunds(paymentIntentId: string): Promise<StripeRefundObject[]> {
      if (!PAYMENT_INTENT_ID.test(paymentIntentId)) {
        throw new StripeError("stripe_request_failed", false);
      }
      const raw = await request({
        method: "GET",
        path: `/v1/refunds?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`,
      });
      if (!isObj(raw) || !Array.isArray(raw.data))
        throw new StripeError("stripe_bad_response", false);
      return raw.data
        .filter((r): r is Obj => isObj(r) && r.object === "refund" && typeof r.id === "string")
        .map((r) => ({ id: r.id as string, raw: r as Record<string, Json> }));
    },

    async retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
      if (!PAYMENT_INTENT_ID.test(id)) throw new StripeError("stripe_request_failed", false);
      const raw = await request({
        method: "GET",
        path: `/v1/payment_intents/${encodeURIComponent(id)}`,
      });
      return toPaymentIntent(raw, livemode);
    },
  };
}

/**
 * The payment method names a session offers (Stripe's
 * `payment_method_types`), for the caller's info log at go-live: names
 * only, never anything else of the session.
 */
export function paymentMethodTypes(session: CheckoutSession): string[] {
  const types = session.raw.payment_method_types;
  return Array.isArray(types)
    ? types.filter((t): t is string => typeof t === "string" && t.length <= 40)
    : [];
}
