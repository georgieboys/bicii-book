import "server-only";

import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/service";

import { bearerMatches } from "../shopify/cron";
import { runAdventureParse, type ParseSummary, type ParseWorkerDeps } from "./parse-worker";

/**
 * GET /api/cron/adventure-work (Adventures Phase B, D176): the Vercel cron
 * reads uploaded ride files. Fails closed (handoff §16): without
 * CRON_SECRET it answers 503; a missing or wrong bearer, 401. At most 3
 * files a run, nothing started after 40 seconds (maxDuration 60).
 */

export type WorkCronDeps = {
  secret: string | undefined;
  run: (deadlineMs: number) => Promise<ParseSummary>;
  now: () => number;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function defaultRun(deadlineMs: number): Promise<ParseSummary> {
  const correlationId = newRequestId();
  const deps: ParseWorkerDeps = {
    supabase: createServiceClient({ correlationId }),
    log: child(correlationId, { integration: "adventure-work" }),
    now: Date.now,
  };
  return runAdventureParse(deps, { max: 3, deadlineMs });
}

export async function handleAdventureWork(
  request: Request,
  overrides: Partial<WorkCronDeps> = {},
): Promise<Response> {
  const secret = "secret" in overrides ? overrides.secret : getServerEnv().CRON_SECRET;
  const run = overrides.run ?? defaultRun;
  const now = overrides.now ?? Date.now;
  if (!secret) return json(503, { error: "off" });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return json(401, { error: "unauthorized" });
  }
  try {
    const summary = await run(now() + 40_000);
    return json(200, summary);
  } catch {
    return json(500, { error: "failed" });
  }
}
