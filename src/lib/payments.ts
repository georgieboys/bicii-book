/**
 * Customer payments (Phase 14; D150-D159, ADR-025): the words and states
 * the screens share. Pure and safe in the browser: nothing here computes
 * money (Postgres does, DATA-MODEL §19).
 *
 * Phase 14 step 1 holds only why Stripe is off. Step 2 adds the labels,
 * tones and the sentences Settings → Customer payments shows for each
 * reason.
 */

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
