import "server-only";

import { headers } from "next/headers";

import { clientAddress, overSignInLimit } from "@/lib/auth/sign-in-limits";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { QUOTE_WINDOW_SECONDS, quoteBuckets, type QuoteAttempt } from "@/lib/quote-limits";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The quote page's limits (src/lib/quote-limits.ts says why), counted in
 * Postgres through public.note_sign_in_attempt (service role only), so they
 * hold across every server instance. Fails open: a token cannot be
 * guessed and `answer_quote` answers once, so a missing key or an outage
 * must not stop a customer from answering; the cause is logged.
 */
export async function noteQuoteAttempt(
  attempt: QuoteAttempt,
  token: string,
): Promise<"ok" | "limited"> {
  try {
    const { SIGN_IN_LIMIT_MULTIPLIER, SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      logger.warn({ attempt, reason: "no_service_role_key" }, "quote limit not counted");
      return "ok";
    }
    const buckets = quoteBuckets(
      attempt,
      clientAddress(await headers()),
      token,
      SIGN_IN_LIMIT_MULTIPLIER,
    );
    const { data, error } = await createServiceClient().rpc("note_sign_in_attempt", {
      buckets: buckets.map((b) => b.key),
      window_seconds: QUOTE_WINDOW_SECONDS,
    });
    if (error || !data) {
      logger.warn({ attempt, reason: "rpc_error", code: error?.code }, "quote limit not counted");
      return "ok";
    }
    const hits = new Map(data.map((row) => [row.bucket_key, row.hit_count]));
    return overSignInLimit(buckets, hits) ? "limited" : "ok";
  } catch (error) {
    // Only the error's class: a message could carry configuration.
    logger.warn(
      { attempt, reason: "request_failed", error: error instanceof Error ? error.name : "unknown" },
      "quote limit not counted",
    );
    return "ok";
  }
}
