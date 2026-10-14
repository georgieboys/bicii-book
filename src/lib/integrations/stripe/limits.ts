import "server-only";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/service";

import { STRIPE_CHECK_LIMIT, stripeCheckBucket } from "./config";

/** One counting window, as for sign-in and the quote page. */
const WINDOW_SECONDS = 300;

/**
 * Staff "Check with Stripe" (Phase 14 step 2): at most STRIPE_CHECK_LIMIT
 * reads of one payment per 5 minutes, counted in Postgres through
 * public.note_sign_in_attempt (service role) so it holds across server
 * instances. Fails open, as noteQuoteAttempt does: a read only asks Stripe
 * for its own record, so a missing key or an outage must not block it;
 * the cause is logged (never the payment id in a bucket key).
 */
export async function noteStripeCheck(paymentId: string): Promise<"ok" | "limited"> {
  try {
    const { SIGN_IN_LIMIT_MULTIPLIER, SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      logger.warn({ paymentId, reason: "no_service_role_key" }, "stripe check not counted");
      return "ok";
    }
    const bucket = stripeCheckBucket(paymentId);
    const { data, error } = await createServiceClient().rpc("note_sign_in_attempt", {
      buckets: [bucket],
      window_seconds: WINDOW_SECONDS,
    });
    if (error || !data) {
      logger.warn(
        { paymentId, reason: "rpc_error", code: error?.code },
        "stripe check not counted",
      );
      return "ok";
    }
    const hits = data.find((row) => row.bucket_key === bucket)?.hit_count ?? 0;
    return hits > STRIPE_CHECK_LIMIT * SIGN_IN_LIMIT_MULTIPLIER ? "limited" : "ok";
  } catch (error) {
    // Only the error's class: a message could carry configuration.
    logger.warn(
      {
        paymentId,
        reason: "request_failed",
        error: error instanceof Error ? error.name : "unknown",
      },
      "stripe check not counted",
    );
    return "ok";
  }
}
