/**
 * Stripe webhook fixtures (Phase 14; TESTING.md "Stripe payments"). Pure
 * TypeScript on node:crypto only, shared by unit, database and E2E tests,
 * and deliberately free of `src` imports: they are an independent oracle
 * for the adapter's signature check and event parsing.
 *
 * The objects follow Stripe's API shapes (API version 2026-09-30.endive,
 * snapshot payloads) for the fields BICII reads (DATA-MODEL §19): a
 * Checkout Session (`checkout.session`) and a Refund (`refund`), wrapped in
 * an Event (`event`). Amounts are integers in the currency's minor unit;
 * currencies are lower-case. Anything BICII does not read is left out
 * unless a test adds it through `extra` (for example customer details,
 * which BICII must never store, D159e). Verify these shapes against a real
 * test-mode account before go-live (RUNBOOK "Stripe: verify before
 * go-live").
 */
import { createHmac } from "node:crypto";

/** The webhook signing secret E2E and the tests sign with (never a real secret). */
export const STRIPE_TEST_WEBHOOK_SECRET = "whsec_biciiE2eNotARealSecret";

/** The API version the account's endpoint is pinned to (ADR-025). */
export const STRIPE_TEST_API_VERSION = "2026-09-30.endive";

/**
 * A Stripe-Signature header for `raw`: `t=<unix seconds>,v1=<hex>`, the
 * HMAC-SHA256 of `${t}.${raw}` under the secret (Stripe's scheme).
 */
export function signStripeBody(
  raw: string,
  {
    secret = STRIPE_TEST_WEBHOOK_SECRET,
    timestamp = Math.floor(Date.now() / 1000),
  }: { secret?: string; timestamp?: number } = {},
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** The headers Stripe sends with a delivery of `raw`. */
export function stripeWebhookHeaders({
  raw,
  secret,
  timestamp,
}: {
  raw: string;
  secret?: string;
  timestamp?: number;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "stripe-signature": signStripeBody(raw, { secret, timestamp }),
    "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
  };
}

export type SessionInput = {
  /** cs_test_… or cs_live_… */
  id: string;
  /** BICII's payments.id (metadata bicii_payment_id and client_reference_id). */
  paymentId: string;
  workOrderId: string;
  quoteId?: string | null;
  kind?: "deposit" | "balance";
  amountCents: number | string | null;
  currency?: string;
  /** open | complete | expired */
  status?: string;
  /** paid | unpaid | no_payment_required */
  paymentStatus?: string;
  /** pi_… once Stripe created the PaymentIntent. */
  paymentIntent?: string | null;
  livemode?: boolean;
  /** Unix seconds; defaults to an hour from now. */
  expiresAt?: number;
  /** Anything else Stripe sends (customer_details, success_url, url, more metadata...). */
  extra?: Record<string, unknown>;
};

/** A Stripe Checkout Session object. */
export function sessionObject({
  id,
  paymentId,
  workOrderId,
  quoteId = null,
  kind = "deposit",
  amountCents,
  currency = "sgd",
  status = "complete",
  paymentStatus = "paid",
  paymentIntent = null,
  livemode = false,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  extra = {},
}: SessionInput): Record<string, unknown> {
  const metadata: Record<string, string> = {
    bicii_payment_id: paymentId,
    bicii_work_order_id: workOrderId,
    bicii_kind: kind,
  };
  if (quoteId) metadata.bicii_quote_id = quoteId;
  const extraMetadata =
    typeof extra.metadata === "object" && extra.metadata !== null
      ? (extra.metadata as Record<string, unknown>)
      : {};
  return {
    id,
    object: "checkout.session",
    livemode,
    mode: "payment",
    status,
    payment_status: paymentStatus,
    amount_total: amountCents,
    amount_subtotal: amountCents,
    currency,
    client_reference_id: paymentId,
    expires_at: expiresAt,
    created: expiresAt - 3600,
    payment_intent: paymentIntent,
    ...extra,
    metadata: { ...metadata, ...extraMetadata },
  };
}

export type RefundInput = {
  /** re_… (cards) or pyr_… (PayNow) */
  id: string;
  paymentIntent: string | null;
  amountCents: number;
  /** pending | requires_action | succeeded | failed | canceled */
  status: string;
  currency?: string;
  /** Unix seconds. */
  created?: number;
  reason?: string | null;
  failureReason?: string | null;
};

/** A Stripe Refund object. */
export function refundObject({
  id,
  paymentIntent,
  amountCents,
  status,
  currency = "sgd",
  created = Math.floor(Date.now() / 1000),
  reason = "requested_by_customer",
  failureReason = null,
}: RefundInput): Record<string, unknown> {
  return {
    id,
    object: "refund",
    amount: amountCents,
    currency,
    status,
    payment_intent: paymentIntent,
    charge: paymentIntent ? `ch_${paymentIntent.slice(3)}` : null,
    reason,
    failure_reason: failureReason,
    created,
    metadata: {},
  };
}

/** A Stripe Event wrapping `object` (snapshot payload). */
export function stripeEvent({
  id,
  type,
  object,
  livemode = false,
  created = Math.floor(Date.now() / 1000),
  apiVersion = STRIPE_TEST_API_VERSION,
}: {
  /** evt_… */
  id: string;
  type: string;
  object: Record<string, unknown>;
  livemode?: boolean;
  /** Unix seconds. */
  created?: number;
  apiVersion?: string;
}) {
  return {
    id,
    object: "event" as const,
    type,
    livemode,
    created,
    api_version: apiVersion,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}
