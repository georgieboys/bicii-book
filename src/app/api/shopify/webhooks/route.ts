import { handleShopifyWebhook } from "@/lib/integrations/shopify/webhooks";

/**
 * Shopify webhooks (orders/paid, refunds/create; RUNBOOK "Shopify").
 * Authenticated by HMAC, not by session: proxy.ts does not run here. The
 * handler stores the delivery, answers, then processes it in after(), so
 * the function may outlive the response (maxDuration, seconds).
 */
export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request): Promise<Response> {
  return handleShopifyWebhook(request);
}
