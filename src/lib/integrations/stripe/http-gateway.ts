import "server-only";

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
  type CheckoutSession,
  type CheckoutSessionInput,
  type StripeGateway,
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
 *   5xx                                   -> stripe_unavailable (retriable)
 *   429                                   -> stripe_rate_limited (retriable)
 *   401, 403                              -> stripe_auth_failed
 *   404                                   -> stripe_not_found
 *   400 with error.type idempotency_error -> stripe_idempotency_conflict
 *   any 400 on /expire                    -> stripe_session_not_open
 *   other 4xx                             -> stripe_request_failed (stripeCode)
 *   a 2xx BICII cannot use (wrong object, no id, another livemode)
 *                                         -> stripe_bad_response
 *
 * Each call is retried once after a retriable error, with the same
 * Idempotency-Key and byte-identical body. Of an error body only
 * `error.type` and `error.code` are read; Stripe's message and param can
 * echo request values (the return URLs carry the quote token) and are
 * dropped. The gateway never logs: callers log the op and the error's code.
 */

export type HttpGatewayOptions = {
  secretKey: string;
  /** The key's mode (stripeConfig): every session read must have the same livemode. */
  livemode: boolean;
  timeoutMs?: number;
};

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
  { secretKey, livemode, timeoutMs = STRIPE_TIMEOUT_MS }: HttpGatewayOptions,
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
    if (status >= 200 && status < 300) {
      if (!isObj(body)) throw new StripeError("stripe_bad_response", false, status);
      return body;
    }
    const error = isObj(body) && isObj(body.error) ? body.error : {};
    const type = shortString(error.type);
    const code = shortString(error.code);
    if (status === 429) throw new StripeError("stripe_rate_limited", true, status, code);
    if (status === 409 || status >= 500) {
      throw new StripeError("stripe_unavailable", true, status, code);
    }
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
      if (e instanceof StripeError && e.retriable) return once(call);
      throw e;
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
      const body = formEncode(checkoutSessionParams(input));
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
        idempotencyKey: expireIdempotencyKey(id),
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
