import type { Json } from "@/lib/database.types";

import { EVENT_ID, EVENT_TYPE, SESSION_ID } from "./config";

/**
 * The Stripe adapter's interface (Phase 14; D153, D159; ADR-025): one
 * shape for the live adapter over fetch (http-gateway.ts) and the
 * in-memory fake (fake-gateway.ts). Pure: the types, the error and the
 * parsers that decide whether something Stripe returned or sent has the
 * shape BICII relies on. The money in it is Stripe's integer cents, taken
 * from Postgres on the way out and converted back in Postgres on the way
 * in; nothing here computes an amount.
 */

export type CheckoutSessionInput = {
  paymentId: string;
  workOrderId: string;
  quoteId: string | null;
  kind: "deposit" | "balance";
  jobNumber: string;
  /** From Postgres (prepare_deposit_checkout.amount_cents), never computed here. */
  amountCents: number;
  /** Epoch seconds, from Postgres. */
  expiresAt: number;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  expiresAt: number;
  livemode: boolean;
  paymentIntent: string | null;
  /** The object as Stripe returned it: passed to record_* (projected in SQL), never logged. */
  raw: Record<string, Json>;
};

export type StripeRefundObject = { id: string; raw: Record<string, Json> };

export interface StripeGateway {
  readonly mode: "live" | "test" | "fake";
  readonly livemode: boolean;
  createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession>;
  /** Throws stripe_session_not_open when the session is no longer open. */
  expireCheckoutSession(id: string): Promise<CheckoutSession>;
  listRefunds(paymentIntentId: string): Promise<StripeRefundObject[]>;
}

export type StripeErrorCode =
  | "stripe_unavailable"
  | "stripe_rate_limited"
  | "stripe_auth_failed"
  | "stripe_not_found"
  | "stripe_idempotency_conflict"
  | "stripe_session_not_open"
  | "stripe_request_failed"
  | "stripe_bad_response";

/**
 * A failed Stripe call. The message is the code only: Stripe's own
 * message and param can echo request values (a URL with the quote token),
 * so they are never kept. `stripeCode` is Stripe's `error.code`, when it
 * sent a short one.
 */
export class StripeError extends Error {
  constructor(
    readonly code: StripeErrorCode,
    readonly retriable: boolean,
    readonly status?: number,
    readonly stripeCode?: string,
  ) {
    super(code);
    this.name = "StripeError";
  }
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A verified webhook body's identity, by the same rules as
 * record_stripe_event's backstop: an evt_ id, a type and a boolean
 * livemode. Null for anything else.
 */
export function parseStripeEvent(
  value: unknown,
): { id: string; type: string; livemode: boolean } | null {
  if (!isObj(value)) return null;
  const { id, type, livemode } = value;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return null;
  if (typeof type !== "string" || !EVENT_TYPE.test(type)) return null;
  if (typeof livemode !== "boolean") return null;
  return { id, type, livemode };
}

const SESSION_STATUSES = new Set(["open", "complete", "expired"]);
const PAYMENT_STATUSES = new Set(["paid", "unpaid", "no_payment_required"]);

/**
 * A Checkout Session Stripe returned, checked: object 'checkout.session',
 * a cs_ id, the livemode of the key that read it, known status and
 * payment_status values and an integer expires_at. Anything else throws
 * stripe_bad_response (a response BICII must not act on).
 */
export function toCheckoutSession(raw: unknown, expectedLivemode: boolean): CheckoutSession {
  const bad = () => new StripeError("stripe_bad_response", false);
  if (!isObj(raw) || raw.object !== "checkout.session") throw bad();
  const { id, url, status, payment_status, expires_at, livemode, payment_intent } = raw;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw bad();
  if (typeof livemode !== "boolean" || livemode !== expectedLivemode) throw bad();
  if (typeof status !== "string" || !SESSION_STATUSES.has(status)) throw bad();
  if (typeof payment_status !== "string" || !PAYMENT_STATUSES.has(payment_status)) throw bad();
  if (typeof expires_at !== "number" || !Number.isSafeInteger(expires_at)) throw bad();
  if (url !== null && url !== undefined && typeof url !== "string") throw bad();
  // payment_intent is an id, or an expanded object when a caller expanded it.
  const pi =
    typeof payment_intent === "string"
      ? payment_intent
      : isObj(payment_intent) && typeof payment_intent.id === "string"
        ? payment_intent.id
        : null;
  return {
    id,
    url: typeof url === "string" ? url : null,
    status: status as CheckoutSession["status"],
    paymentStatus: payment_status as CheckoutSession["paymentStatus"],
    expiresAt: expires_at,
    livemode,
    paymentIntent: pi,
    raw: raw as Record<string, Json>,
  };
}
