/**
 * The privacy line under every Pay button on the customer pages (the quote
 * page's deposit, Phase 14 step 2; the payment link, step 3, D156f): the
 * owner's privacy notice names Stripe, and this says where card details
 * go. A server component (no state).
 */
export const STRIPE_PRIVACY_LINE =
  "Payments are taken by Stripe on its own page, so Stripe's privacy policy applies to them; BICII never sees or keeps your card details.";

export function StripePrivacyLine() {
  return <p className="text-sm text-dust-500">{STRIPE_PRIVACY_LINE}</p>;
}
