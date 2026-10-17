import "server-only";

import { headers } from "next/headers";

import { clientAddress, overSignInLimit, type SignInBucket } from "@/lib/auth/sign-in-limits";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Counting for the customer link pages' limits: the quote page
 * (src/lib/quote-limits.ts, D143) and the payment link page
 * (src/lib/balance-limits.ts, D156f). Counted in Postgres through
 * public.note_sign_in_attempt (service role only), so they hold across
 * every server instance. Fails open: a token cannot be guessed, answering
 * a quote happens once and Pay reuses its open Checkout session, so a
 * missing key or an outage must not stop a customer; the cause is logged
 * (the page and attempt, never the token or the address).
 */
export async function noteLinkAttempt(
  page: "quote" | "balance",
  attempt: string,
  windowSeconds: number,
  bucketsFor: (client: string | null, multiplier: number) => SignInBucket[],
): Promise<"ok" | "limited"> {
  const notCounted = `${page} limit not counted`;
  try {
    const { SIGN_IN_LIMIT_MULTIPLIER, SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      logger.warn({ attempt, reason: "no_service_role_key" }, notCounted);
      return "ok";
    }
    const buckets = bucketsFor(clientAddress(await headers()), SIGN_IN_LIMIT_MULTIPLIER);
    const { data, error } = await createServiceClient().rpc("note_sign_in_attempt", {
      buckets: buckets.map((b) => b.key),
      window_seconds: windowSeconds,
    });
    if (error || !data) {
      logger.warn({ attempt, reason: "rpc_error", code: error?.code }, notCounted);
      return "ok";
    }
    const hits = new Map(data.map((row) => [row.bucket_key, row.hit_count]));
    return overSignInLimit(buckets, hits) ? "limited" : "ok";
  } catch (error) {
    // Only the error's class: a message could carry configuration.
    logger.warn(
      { attempt, reason: "request_failed", error: error instanceof Error ? error.name : "unknown" },
      notCounted,
    );
    return "ok";
  }
}
