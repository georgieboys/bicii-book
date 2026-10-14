import {
  METADATA_KEYS,
  SESSION_MAX_LIFETIME_SECONDS,
  SESSION_MIN_LIFETIME_SECONDS,
} from "./config";
import type { CheckoutSessionInput } from "./gateway";

/**
 * Stripe's request encoding (application/x-www-form-urlencoded with
 * bracketed keys) and the Checkout Session body BICII sends (Phase 14;
 * ADR-025). Pure, so the exact bytes are unit-tested.
 */

/**
 * Pairs joined with `&` in the given order. Keys keep literal brackets
 * (Stripe's documented form, e.g. `line_items[0][quantity]`); everything
 * else in keys and values is percent-encoded.
 */
export function formEncode(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs
    .map(([k, v]) => {
      const key = encodeURIComponent(k).replace(/%5B/g, "[").replace(/%5D/g, "]");
      return `${key}=${encodeURIComponent(v)}`;
    })
    .join("&");
}

/** Stripe's SGD minimum and the 8-digit cap (PayNow), in cents (D158b). */
const MIN_CENTS = 50;
const MAX_CENTS = 99_999_999;

/**
 * The Checkout Session parameters, in a fixed order. Never sent:
 * `payment_method_types` (a 400 under the pinned version),
 * `allowed_payment_method_types` (the owner picks Cards and PayNow in the
 * Dashboard), `customer_email` (whoever holds the link may not be the
 * customer, R-078), `ui_mode` and `locale`. Metadata holds BICII's ids
 * only; it is repeated on the PaymentIntent because Stripe does not copy
 * a session's metadata there.
 *
 * Throws a plain Error (a caller bug, not a Stripe failure) unless the
 * amount is whole cents from 50 to 99,999,999, `expiresAt` is a whole
 * number of seconds within Stripe's window (30 minutes to 24 hours after
 * `nowSeconds`, the caller's clock), and the product name is 1-250
 * characters. The live adapter and the fake share this, so a change to
 * prepare_deposit_checkout's 60 minutes that Stripe would refuse fails
 * the tests too.
 */
export function checkoutSessionParams(
  input: CheckoutSessionInput,
  nowSeconds: number,
): Array<[string, string]> {
  const { amountCents, expiresAt } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
    throw new Error("amountCents must be a whole number of cents from 50 to 99999999");
  }
  if (!Number.isSafeInteger(expiresAt)) throw new Error("expiresAt must be whole epoch seconds");
  const lifetime = expiresAt - nowSeconds;
  if (lifetime < SESSION_MIN_LIFETIME_SECONDS || lifetime > SESSION_MAX_LIFETIME_SECONDS) {
    throw new Error("expiresAt must be 30 minutes to 24 hours from now (Stripe's window)");
  }
  const name = `${input.kind === "deposit" ? "Deposit" : "Balance"} for job ${input.jobNumber}`;
  if (name.length < 1 || name.length > 250) {
    throw new Error("the product name must be 1-250 characters");
  }
  const metadata: Array<[string, string]> = [
    [METADATA_KEYS.payment, input.paymentId],
    [METADATA_KEYS.job, input.workOrderId],
  ];
  if (input.quoteId !== null) metadata.push([METADATA_KEYS.quote, input.quoteId]);
  metadata.push([METADATA_KEYS.kind, input.kind]);

  return [
    ["mode", "payment"],
    ["client_reference_id", input.paymentId],
    ["line_items[0][quantity]", "1"],
    ["line_items[0][price_data][currency]", "sgd"],
    ["line_items[0][price_data][unit_amount]", String(amountCents)],
    ["line_items[0][price_data][product_data][name]", name],
    ...metadata.map(([k, v]): [string, string] => [`metadata[${k}]`, v]),
    ["payment_intent_data[description]", name],
    ...metadata.map(([k, v]): [string, string] => [`payment_intent_data[metadata][${k}]`, v]),
    ["expires_at", String(expiresAt)],
    ["success_url", input.successUrl],
    ["cancel_url", input.cancelUrl],
  ];
}
