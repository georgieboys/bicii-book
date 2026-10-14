import type { Database } from "@/lib/database.types";
import type { StatusTone } from "@/lib/workshop";

/**
 * Customer payments (Phase 14; D150-D159, ADR-025): the words and states
 * the screens share. Pure and safe in the browser: nothing here computes
 * money (Postgres does, DATA-MODEL §19), and nothing names a key or a
 * secret value.
 */

type Enums = Database["public"]["Enums"];
export type PaymentStatus = Enums["payment_status"];
export type StripeRefundStatus = Enums["stripe_refund_status"];
export type StripeEventStatus = Enums["stripe_event_status"];
export type StripeRejectionReason = Enums["stripe_rejection_reason"];

// ---------------------------------------------------------------------------
// Deposits (D151, D152, D158): public.quote_deposits.state
// ---------------------------------------------------------------------------

/**
 * A deposit's state, as public.quote_deposits computes it: paid (paid or
 * partly refunded, D158e), refunded, processing (Checkout complete, Stripe
 * still confirming), due, none (every approved part cancelled).
 */
export const DEPOSIT_STATES = ["due", "processing", "paid", "refunded", "none"] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];

export const DEPOSIT_STATE_LABELS: Readonly<Record<DepositState, string>> = {
  due: "Deposit due",
  processing: "Being confirmed",
  paid: "Deposit paid",
  refunded: "Deposit refunded",
  none: "No longer due",
};

export const DEPOSIT_STATE_TONES: Readonly<Record<DepositState, StatusTone>> = {
  due: "waiting",
  processing: "waiting",
  paid: "done",
  refunded: "info",
  none: "neutral",
};

/** Settings → Customer payments: what the deposit percent means (D151, D157a). */
export function depositPercentLabel(percent: number): string {
  return percent === 0
    ? "No deposit is asked on indent quotes"
    : `Customers pay ${percent}% of the approved indent parts after answering`;
}

// ---------------------------------------------------------------------------
// Payments and refunds (D153, D155, D159)
// ---------------------------------------------------------------------------

/** A payment row's state in words; a pending one whose Checkout completed is being confirmed. */
export function paymentStatusLabel(payment: {
  status: PaymentStatus;
  checkoutCompletedAt: string | null;
}): string {
  switch (payment.status) {
    case "pending":
      return payment.checkoutCompletedAt ? "Being confirmed" : "Checkout open";
    case "paid":
      return "Paid";
    case "partially_refunded":
      return "Partly refunded";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Payment failed";
    case "expired":
      return "Checkout expired";
  }
}

export const PAYMENT_STATUS_TONES: Readonly<Record<PaymentStatus, StatusTone>> = {
  pending: "waiting",
  paid: "done",
  partially_refunded: "info",
  refunded: "info",
  failed: "danger",
  expired: "neutral",
};

export const REFUND_STATUS_LABELS: Readonly<Record<StripeRefundStatus, string>> = {
  pending: "Refund pending",
  requires_action: "Refund waiting on the customer",
  succeeded: "Refunded",
  failed: "Refund failed",
  canceled: "Refund cancelled",
};

// ---------------------------------------------------------------------------
// Whether Stripe is on (D157)
// ---------------------------------------------------------------------------

/**
 * Why Stripe is off, in the order stripeConfig checks them
 * (src/lib/integrations/stripe/client.ts; D157b, c). Each names a
 * configuration problem, never a value.
 */
export const STRIPE_OFF_REASON_CODES = [
  "preview",
  "not_configured",
  "key_invalid",
  "test_key_in_production",
  "live_key_outside_production",
  "webhook_secret_missing",
  "webhook_secret_invalid",
  "service_role_missing",
  "origin_invalid",
] as const;

export type StripeOffReason = (typeof STRIPE_OFF_REASON_CODES)[number];

/**
 * Settings → Customer payments: each reason as a sentence an admin can act
 * on (RUNBOOK "Stripe: environment variables and fake mode"). Variables are
 * named; their values never are.
 */
export const STRIPE_OFF_REASONS: Readonly<Record<StripeOffReason, string>> = {
  preview:
    "This is a Vercel Preview deployment. Stripe never runs in Preview: there is no staging database.",
  not_configured:
    "Customers can't pay online yet. Follow RUNBOOK “Stripe payments”: add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and ADMIN_ORIGIN to Vercel (Production).",
  key_invalid:
    "STRIPE_SECRET_KEY isn't a Stripe secret or restricted key (sk_ or rk_). Paste the key again; a publishable pk_ key is the wrong one.",
  test_key_in_production: "STRIPE_SECRET_KEY is a test key; Production takes a live key only.",
  live_key_outside_production:
    "STRIPE_SECRET_KEY is a live key, but this isn't Production. Use a test key here; the live key belongs in Production only.",
  webhook_secret_missing:
    "STRIPE_WEBHOOK_SECRET isn't set. Copy the signing secret from the webhook endpoint in Stripe's Dashboard.",
  webhook_secret_invalid:
    "STRIPE_WEBHOOK_SECRET isn't a signing secret (whsec_). Copy it again from the webhook endpoint, not the endpoint's id.",
  service_role_missing:
    "SUPABASE_SERVICE_ROLE_KEY isn't set, so BICII can't record payments. Set it in Vercel (sign-in needs it too).",
  origin_invalid:
    "ADMIN_ORIGIN isn't this Admin's https address with no path (http only for localhost). Set it to https://<admin host>.",
};

export type StripeConnectionSummary = {
  state: "on" | "off";
  mode: "live" | "test" | "fake" | null;
  reason: StripeOffReason | null;
};

/** One line for Settings: Live, Test mode, the fake, or Off with the reason. */
export function stripeConnectionLabel(c: StripeConnectionSummary): string {
  if (c.state === "on") {
    if (c.mode === "live") return "Live";
    if (c.mode === "test") return "Test mode";
    return "Fake Stripe (development and tests only)";
  }
  return `Off: ${STRIPE_OFF_REASONS[c.reason ?? "not_configured"]}`;
}

// ---------------------------------------------------------------------------
// Stripe deliveries (Settings → Customer payments, admins only, D86)
// ---------------------------------------------------------------------------

export const STRIPE_EVENT_STATUS_LABELS: Readonly<Record<StripeEventStatus, string>> = {
  received: "Being recorded",
  applied: "Applied",
  ignored: "Nothing to change",
  needs_attention: "Needs attention",
  rejected: "Rejected",
};

export const STRIPE_EVENT_STATUS_TONES: Readonly<Record<StripeEventStatus, StatusTone>> = {
  received: "neutral",
  applied: "done",
  ignored: "neutral",
  needs_attention: "danger",
  rejected: "danger",
};

/** Why a delivery was rejected (stored without its body, D88). */
export const STRIPE_REJECTION_LABELS: Readonly<Record<StripeRejectionReason, string>> = {
  stripe_off: "Stripe was off",
  signature_invalid: "Signature didn't match",
  signature_expired: "Signature too old",
  body_not_json: "Body wasn't JSON",
  event_shape_invalid: "Not a Stripe event",
  livemode_mismatch: "Wrong mode (test or live)",
  not_recorded: "Couldn't be recorded; Stripe retries",
};

/**
 * What applying an event or read did (stripe_events.outcome; the values
 * stripe_events_outcome_check allows).
 */
const STRIPE_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  payment_paid: "Payment recorded",
  paid_amount_mismatch: "Paid, amount differs",
  paid_after_failed: "Paid after failing",
  paid_after_expired: "Paid after expiring",
  payment_processing: "Payment being confirmed",
  payment_failed: "Payment failed",
  payment_expired: "Checkout expired",
  already_paid: "Already paid",
  already_processing: "Already being confirmed",
  already_failed: "Already failed",
  already_expired: "Already expired",
  still_open: "Checkout still open",
  stale: "Older than what's recorded",
  refund_recorded: "Refund recorded",
  refund_unchanged: "Refund unchanged",
  refund_unmatched: "Refund of an unknown payment",
  not_ours: "Not a BICII payment",
  type_not_handled: "Event type not used",
  payment_not_found: "Unknown payment",
  session_mismatch: "Checkout didn't match",
  livemode_mismatch: "Wrong mode (test or live)",
  currency_mismatch: "Other currency",
  object_invalid: "Unreadable data",
  unexpected_payment_status: "Unexpected payment status",
  read_mismatch: "Read didn't match",
};

/** An outcome in words; an unknown one shows as it is stored. */
export function stripeOutcomeLabel(outcome: string): string {
  return STRIPE_OUTCOME_LABELS[outcome] ?? outcome;
}
