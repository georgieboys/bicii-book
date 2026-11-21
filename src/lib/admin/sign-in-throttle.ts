import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";

import {
  SIGN_IN_WINDOW_SECONDS,
  clientAddress,
  overSignInLimit,
  signInBuckets,
  type SignInAttempt,
} from "@/lib/auth/sign-in-limits";
import type { Database } from "@/lib/database.types";
import { getServerEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The Admin's own sign-in limits (PLAN D72; src/lib/auth/sign-in-limits.ts
 * says why). Every code request and every code verification on /login is
 * counted here BEFORE Supabase Auth is asked, per client address and per
 * email, in Postgres (public.note_sign_in_attempt, service role only), so
 * the count holds across every server instance.
 *
 *   "ok"          go ahead and ask Auth;
 *   "limited"     over a limit: say "Too many attempts" (the same for every
 *                 email, with or without a login);
 *   "unavailable" the count could not be taken: say sign-in is unavailable
 *                 (without the database nobody can sign in anyway).
 */
export type SignInThrottle = "ok" | "limited" | "unavailable";

/**
 * Why a count could not be taken, for the login actions' error log so an
 * operator can tell a missing or wrong service-role key from an Auth outage
 * (OPERATIONS "Sign-in is unavailable"). Never the email or the address:
 * the bucket keys are digests and the RPC's messages name no argument.
 */
export type SignInUnavailableCause =
  | { reason: "no_service_role_key" }
  | { reason: "rpc_error"; code?: string; message?: string }
  | { reason: "request_failed"; error: string };

export type SignInThrottleResult = {
  throttle: SignInThrottle;
  /** Set only when `throttle` is "unavailable". */
  cause?: SignInUnavailableCause;
};

/**
 * Counts one attempt with an explicit client address and says why a count
 * failed. The client's bucket is counted alone first, and the email's only
 * while the client is under its limit (as in link-throttle.ts): a client
 * past its limit adds nothing to any email's counter, so it can neither
 * spend another person's per-email allowance nor grow the counter table
 * one row per email it names.
 */
export async function checkSignInAttempt(
  service: SupabaseClient<Database>,
  attempt: SignInAttempt,
  client: string | null,
  email: string,
  multiplier = 1,
): Promise<SignInThrottleResult> {
  const [clientBucket, ...emailBuckets] = signInBuckets(attempt, client, email, multiplier);
  for (const buckets of [[clientBucket], emailBuckets]) {
    if (buckets.length === 0) continue;
    const { data, error } = await service.rpc("note_sign_in_attempt", {
      buckets: buckets.map((b) => b.key),
      window_seconds: SIGN_IN_WINDOW_SECONDS,
    });
    if (error || !data) {
      return {
        throttle: "unavailable",
        cause: { reason: "rpc_error", code: error?.code, message: error?.message },
      };
    }
    const hits = new Map(data.map((row) => [row.bucket_key, row.hit_count]));
    if (overSignInLimit(buckets, hits)) return { throttle: "limited" };
  }
  return { throttle: "ok" };
}

/** Counts one attempt with an explicit client address (the stack test calls this). */
export async function countSignInAttempt(
  service: SupabaseClient<Database>,
  attempt: SignInAttempt,
  client: string | null,
  email: string,
  multiplier = 1,
): Promise<SignInThrottle> {
  return (await checkSignInAttempt(service, attempt, client, email, multiplier)).throttle;
}

/**
 * Counts one attempt by the client of the current request (a login Server
 * Action). Without SUPABASE_SERVICE_ROLE_KEY, or with a wrong one, every
 * attempt is "unavailable": nobody can sign in (ARCHITECTURE "Service-role
 * use", RUNBOOK key rotation).
 */
export async function noteSignInAttempt(
  attempt: SignInAttempt,
  email: string,
): Promise<SignInThrottleResult> {
  try {
    const client = clientAddress(await headers());
    const { SIGN_IN_LIMIT_MULTIPLIER, SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return { throttle: "unavailable", cause: { reason: "no_service_role_key" } };
    }
    return await checkSignInAttempt(
      createServiceClient(),
      attempt,
      client,
      email,
      SIGN_IN_LIMIT_MULTIPLIER,
    );
  } catch (error) {
    // The environment, the headers or the request failed before an answer.
    // Only the error's class: a message could carry configuration.
    return {
      throttle: "unavailable",
      cause: { reason: "request_failed", error: error instanceof Error ? error.name : "unknown" },
    };
  }
}
