import { handleCronRequest } from "@/lib/integrations/shopify/cron";

/**
 * The integration cron (vercel.json, every 5 minutes; D87): runs due
 * Shopify jobs behind Authorization: Bearer <CRON_SECRET>. proxy.ts does
 * not run here, so a signed-out GET reaches the handler instead of /login.
 */
export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(request: Request): Promise<Response> {
  return handleCronRequest(request);
}
