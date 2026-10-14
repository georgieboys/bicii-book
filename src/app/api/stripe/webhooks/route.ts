import { handleStripeWebhook } from "@/lib/integrations/stripe/webhooks";

/**
 * Stripe webhooks (D153, D159; RUNBOOK "Stripe payments"). Authenticated by
 * Stripe's signature on the raw body, not by session: proxy.ts does not run
 * here. The delivery is stored and applied in one transaction before the
 * answer (no after()).
 */
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhook(request);
}
