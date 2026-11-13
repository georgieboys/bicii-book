import "server-only";

import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/service";

import { bearerMatches } from "../shopify/cron";
import { runTrackingFeeds, type FeedSummary } from "../tracking/feed-worker";
import { sendDueAdventureNotices } from "./notices";
import { runAdventureParse, type ParseSummary, type ParseWorkerDeps } from "./parse-worker";

/**
 * GET /api/cron/adventure-work (Adventures Phase B, D176, D184): the Vercel
 * cron reads uploaded ride files, sends due adventure emails, then reads
 * due tracking feeds (D190). Fails closed (handoff §16): without CRON_SECRET it answers 503; a missing or
 * wrong bearer, 401. At most 3 files and 5 emails a run; nothing starts
 * after 40 seconds (maxDuration 60), and emails not reached are released.
 */

export type WorkSummary = {
  files: ParseSummary;
  emails: Awaited<ReturnType<typeof sendDueAdventureNotices>>;
  feeds: FeedSummary;
};

export type WorkCronDeps = {
  secret: string | undefined;
  run: (deadlineMs: number) => Promise<WorkSummary | ParseSummary>;
  now: () => number;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function defaultRun(deadlineMs: number): Promise<WorkSummary> {
  const correlationId = newRequestId();
  const supabase = createServiceClient({ correlationId });
  const deps: ParseWorkerDeps = {
    supabase,
    log: child(correlationId, { integration: "adventure-work" }),
    now: Date.now,
  };
  const files = await runAdventureParse(deps, { max: 3, deadlineMs });
  const emails = await sendDueAdventureNotices(supabase, getServerEnv(), { max: 5, deadlineMs });
  // Feed access lives in TRACKING_FEED_* variables, read by name (D190).
  const feeds = await runTrackingFeeds(
    { supabase, env: process.env, log: deps.log, now: Date.now },
    { maxFeeds: 2, deadlineMs },
  );
  return { files, emails, feeds };
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
