import "server-only";

import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";
import { createServiceClient } from "@/lib/supabase/service";

import { bearerMatches } from "../shopify/cron";
import {
  checkStaleAdventurePayments,
  type StalePaymentSummary,
} from "../stripe/adventure-payments";
import { defaultStripeDeps } from "../stripe/deps";
import { runTrackingFeeds, type FeedSummary } from "../tracking/feed-worker";
import { sendDueAdventureNotices } from "./notices";
import {
  EVIDENCE_BUCKET,
  runAdventureParse,
  type ParseSummary,
  type ParseWorkerDeps,
} from "./parse-worker";

/**
 * GET /api/cron/adventure-work (Adventures Phase B, D176, D184): the Vercel
 * cron sends due adventure emails, reads due tracking feeds (D190), reads
 * uploaded ride files, then purges old unattributed positions; each step
 * runs even when another fails. Fails closed (handoff §16): without CRON_SECRET it answers 503; a missing or
 * wrong bearer, 401. At most 3 files and 5 emails a run; nothing starts
 * after 40 seconds (maxDuration 60), and emails not reached are released.
 */

export type WorkSummary = {
  payments?: StalePaymentSummary | null;
  files: ParseSummary | null;
  emails: Awaited<ReturnType<typeof sendDueAdventureNotices>> | null;
  feeds: FeedSummary | null;
  purged?: number | null;
  /** Evidence objects deleted from Storage (removed or abandoned files, D230). */
  objectsDeleted?: number | null;
  /** The steps that failed this run (each step runs whatever the others do). */
  failed?: string[];
};

export type WorkCronDeps = {
  secret: string | undefined;
  run: (deadlineMs: number) => Promise<WorkSummary | ParseSummary>;
  now: () => number;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The four steps of a run; each is tried even when another fails. */
export type WorkSteps = {
  payments?: () => Promise<StalePaymentSummary | null>;
  emails: () => Promise<WorkSummary["emails"]>;
  feeds: () => Promise<WorkSummary["feeds"]>;
  files: () => Promise<WorkSummary["files"]>;
  purge: () => Promise<number | null>;
  objects?: () => Promise<number | null>;
};

/**
 * Runs the steps in order: emails and feeds first (riders waiting on a
 * message, live positions), then file reading (the slowest, and the one a
 * rider's file can make slow), then the purge. A failing step is logged
 * with its error name and code and the others still run (audit A-44).
 */
export async function runWorkSteps(
  steps: WorkSteps,
  log: Pick<ReturnType<typeof child>, "error">,
): Promise<WorkSummary> {
  const summary: WorkSummary = { files: null, emails: null, feeds: null, purged: null, failed: [] };
  const attempt = async <K extends keyof WorkSteps>(
    name: K,
    apply: (v: Awaited<ReturnType<NonNullable<WorkSteps[K]>>>) => void,
  ) => {
    try {
      const step = steps[name] as NonNullable<WorkSteps[K]>;
      apply((await step()) as Awaited<ReturnType<NonNullable<WorkSteps[K]>>>);
    } catch (err) {
      summary.failed!.push(name);
      const e = err as { name?: string; code?: string; message?: string };
      log.error(
        { step: name, error: e?.name ?? "Error", code: e?.code ?? null },
        "adventure-work step failed",
      );
    }
  };
  if (steps.payments) await attempt("payments", (v) => (summary.payments = v));
  await attempt("emails", (v) => (summary.emails = v));
  await attempt("feeds", (v) => (summary.feeds = v));
  await attempt("files", (v) => (summary.files = v));
  await attempt("purge", (v) => (summary.purged = v));
  if (steps.objects) await attempt("objects", (v) => (summary.objectsDeleted = v));
  return summary;
}

async function defaultRun(deadlineMs: number): Promise<WorkSummary> {
  const correlationId = newRequestId();
  const supabase = createServiceClient({ correlationId });
  const log = child(correlationId, { integration: "adventure-work" });
  const deps: ParseWorkerDeps = { supabase, log, now: Date.now };
  return runWorkSteps(
    {
      // Payments whose webhook never came are read back from Stripe (D225).
      payments: () =>
        checkStaleAdventurePayments(defaultStripeDeps(correlationId), { max: 3, deadlineMs }),
      emails: () => sendDueAdventureNotices(supabase, getServerEnv(), { max: 5, deadlineMs }),
      // Feed access lives in TRACKING_FEED_* variables, read by name (D190).
      feeds: () =>
        runTrackingFeeds(
          { supabase, env: process.env, log, now: Date.now },
          { maxFeeds: 2, deadlineMs },
        ),
      files: () => runAdventureParse(deps, { max: 3, deadlineMs }),
      // Tracker messages that belong to no ride go after 30 days (D203).
      purge: async () => {
        const purge = await supabase.rpc("purge_unattributed_tracking", { max_rows: 1000 });
        if (purge.error) throw Object.assign(new Error("purge failed"), { code: purge.error.code });
        // Waiver signatures never used for a booking go after 7 days (D236).
        const unused = await supabase.rpc("purge_unused_waiver_signatures", { max_rows: 500 });
        if (unused.error)
          throw Object.assign(new Error("purge failed"), { code: unused.error.code });
        return Number(purge.data ?? 0) + Number(unused.data ?? 0);
      },
      // Objects of removed or abandoned evidence files leave Storage (D230).
      objects: async () => {
        const due = await supabase.rpc("adventure_evidence_objects_to_delete", { max_rows: 50 });
        if (due.error) throw Object.assign(new Error("objects failed"), { code: due.error.code });
        const rows = due.data ?? [];
        if (rows.length === 0) return 0;
        const removed = await supabase.storage
          .from(EVIDENCE_BUCKET)
          .remove(rows.map((r) => r.storage_path));
        if (removed.error)
          throw Object.assign(new Error("storage remove failed"), { code: "storage" });
        const marked = await supabase.rpc("mark_adventure_objects_deleted", {
          file_ids: rows.map((r) => r.file_id),
        });
        if (marked.error)
          throw Object.assign(new Error("mark failed"), { code: marked.error.code });
        return rows.length;
      },
    },
    log,
  );
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
    // Every step was tried; a failed one still makes the run show as failed.
    const failed = (summary as WorkSummary).failed;
    return json(failed && failed.length > 0 ? 500 : 200, summary);
  } catch (err) {
    const e = err as { name?: string; code?: string };
    child(newRequestId(), { integration: "adventure-work" }).error(
      { error: e?.name ?? "Error", code: e?.code ?? null },
      "adventure-work run failed",
    );
    return json(500, { error: "failed" });
  }
}
