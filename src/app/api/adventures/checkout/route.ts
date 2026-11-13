import { handleAdventureCheckout } from "@/lib/integrations/stripe/adventure-checkout-route";

/**
 * Starts an adventure payment for the signed-in rider (Adventures Phase B,
 * D167; handoff §10.2). Called server to server by the public site with the
 * rider's access token, which the handler verifies with Supabase Auth.
 * proxy.ts does not run here.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleAdventureCheckout(request);
}
