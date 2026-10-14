import { createHash } from "node:crypto";

/**
 * Stripe integration constants (Phase 14; PLAN D150-D159; ADR-025;
 * RUNBOOK "Stripe payments"). Pure: imported by the adapters, the webhook
 * handler and the unit tests. No Stripe SDK: every call is a form-encoded
 * fetch to STRIPE_API_BASE (http-gateway.ts).
 */

/** The only host the live adapter calls (fixed, so a validated path cannot reach anywhere else). */
export const STRIPE_API_BASE = "https://api.stripe.com";

/**
 * The API version every call sends (Stripe-Version) and the webhook
 * endpoint is pinned to in the Dashboard (snapshot payloads). Since this
 * version `payment_method_types` on a Checkout Session is a 400, so it is
 * never sent: payment methods are chosen in the Dashboard (RUNBOOK).
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

/** A Stripe call that has not answered by then is abandoned (retried once). */
export const STRIPE_TIMEOUT_MS = 8_000;

/** A webhook body above 1 MiB gets 413 and is not stored (as D88 for Shopify). */
export const MAX_WEBHOOK_BYTES = 1_048_576;

/** Above this many rejected deliveries a minute per server instance, they are logged, not stored (D88). */
export const MAX_REJECTED_PER_MINUTE = 30;

/** How far a Stripe-Signature timestamp may be from now, either way (seconds; never 0). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The request headers kept on a delivery (lower-cased); the database caps them again. */
export const WEBHOOK_HEADER_ALLOWLIST = [
  "stripe-signature",
  "content-type",
  "content-length",
  "user-agent",
] as const;

/**
 * The event types BICII applies: exactly the RUNBOOK's subscription list
 * for the webhook endpoint. Anything else that arrives is stored and
 * ignored (`type_not_handled`), never applied.
 */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;

/** Where a live Checkout Session's url must point before a customer is sent there. */
export const CHECKOUT_HOST = "checkout.stripe.com";

/** An open session is reused until this close to its expiry (D158d). */
export const REUSE_MARGIN_SECONDS = 120;

/** BICII's ids on a Checkout Session and its PaymentIntent (ids only, never personal data). */
export const METADATA_KEYS = {
  payment: "bicii_payment_id",
  job: "bicii_work_order_id",
  quote: "bicii_quote_id",
  kind: "bicii_kind",
} as const;

/** Stripe ids, as record_stripe_event and record_stripe_read check them in SQL. */
export const EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;
export const EVENT_TYPE = /^[a-z0-9_.]{1,100}$/;
export const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]{1,250}$/;
export const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,250}$/;

/**
 * One Idempotency-Key per Checkout attempt: each attempt has a fresh
 * payments.id from Postgres, so a retry of the same attempt can never
 * create a second session, and a new attempt never collides with an old one.
 */
export function checkoutIdempotencyKey(paymentId: string): string {
  return `bicii-checkout-${paymentId}`;
}

/**
 * A fresh key per expire call (`nonce`: a random UUID), reused only by that
 * call's own retry. Expiring is idempotent at Stripe anyway (a second
 * expire is a 400, not open), and a fixed key would replay a saved 500 for
 * 24 hours.
 */
export function expireIdempotencyKey(sessionId: string, nonce: string): string {
  return `bicii-expire-${sessionId}-${nonce}`;
}

/** Stripe's window for a Checkout Session's expires_at: 30 minutes to 24 hours ahead. */
export const SESSION_MIN_LIFETIME_SECONDS = 30 * 60;
export const SESSION_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

/** Staff "Check with Stripe" presses per payment in one 5-minute window (limits.ts). */
export const STRIPE_CHECK_LIMIT = 6;

/**
 * The note_sign_in_attempt counter of one payment's checks. It holds a
 * salted SHA-256, never the payment id in clear (as quote-limits.ts does).
 */
export function stripeCheckBucket(paymentId: string): string {
  return `stripe-check:payment:${createHash("sha256").update(`stripe-check:${paymentId}`).digest("hex")}`;
}
