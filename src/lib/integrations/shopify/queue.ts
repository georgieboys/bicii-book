import "server-only";

import type { Database } from "@/lib/database.types";

import type { IntegrationDeps } from "./deps";
import { readFeeAfterSale } from "./fees";
import { runProductSync } from "./sync";

/**
 * The integration queue runners (SPEC §26; D87; DATA-MODEL §13). Jobs are
 * handed out only by public.claim_integration_jobs (FOR UPDATE SKIP LOCKED:
 * two runners never get the same job; a claim marks it running and counts
 * the attempt) and settled only by the RPCs: process_shopify_event for an
 * inbound event, record_product_sync_result (through runProductSync) for a
 * product sync. Errors are logged, never thrown out and never swallowed
 * silently: a job whose result could not be stored stays running and is
 * reclaimed after ten minutes.
 */

export type QueueJob = Database["public"]["Tables"]["integration_retry_queue"]["Row"];

/** What happened to one job, as the summary counts it. */
export type JobOutcome = "done" | "failed" | "needs_attention" | "deferred";

export type DueJobsSummary = {
  claimed: number;
  done: number;
  failed: number;
  needsAttention: number;
  deferred: number;
};

async function jobStatus(deps: IntegrationDeps, jobId: string): Promise<string | null> {
  const { data, error } = await deps.supabase
    .from("integration_retry_queue")
    .select("status")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    deps.log.warn({ jobId, code: error.code }, "could not read the job status");
    return null;
  }
  return data?.status ?? null;
}

async function settledOutcome(deps: IntegrationDeps, jobId: string): Promise<JobOutcome> {
  return (await jobStatus(deps, jobId)) === "needs_attention" ? "needs_attention" : "failed";
}

export async function runJob(job: QueueJob, deps: IntegrationDeps): Promise<JobOutcome> {
  const started = Date.now();
  try {
    if (job.kind === "shopify_event") {
      if (!job.integration_event_id) throw new Error("shopify_event job without an event");
      const { data, error } = await deps.supabase.rpc("process_shopify_event", {
        event_id: job.integration_event_id,
      });
      if (error) {
        // Unexpected: the job stays running until it is reclaimed.
        deps.log.error(
          {
            jobId: job.id,
            eventId: job.integration_event_id,
            code: error.code,
            err: error.message,
          },
          "process_shopify_event failed",
        );
        return "failed";
      }
      const row = Array.isArray(data) ? data[0] : data;
      const status = row?.event_status ?? null;
      const outcome: JobOutcome =
        status === "processed" || status === "skipped"
          ? "done"
          : await settledOutcome(deps, job.id);
      deps.log[outcome === "done" ? "info" : "warn"](
        {
          jobId: job.id,
          eventId: job.integration_event_id,
          eventStatus: status,
          eventOutcome: row?.outcome ?? null,
          errorCode: row?.error_code ?? null,
          saleId: row?.sale_id ?? null,
          outcome,
          durationMs: Date.now() - started,
        },
        "shopify event processed",
      );
      // D274: best effort, after the sale's transaction committed; the cron
      // sweep reads it again if Shopify has not put the fee on yet.
      if (row?.outcome === "sale_recorded" && row.sale_id) {
        await readFeeAfterSale(deps, row.sale_id);
      }
      return outcome;
    }

    const result = await runProductSync(
      { id: job.id, product_id: job.product_id, last_error_code: job.last_error_code },
      deps,
    );
    switch (result.outcome) {
      case "pushed":
      case "unchanged":
        return "done";
      case "deferred":
        return "deferred";
      default:
        return settledOutcome(deps, job.id);
    }
  } catch (e) {
    deps.log.error(
      { jobId: job.id, kind: job.kind, err: e instanceof Error ? e.message : String(e) },
      "integration job crashed",
    );
    return "failed";
  }
}

/** Claim one named job (even before it is due) and run it; null when another runner holds it or it is closed. */
export async function runJobById(jobId: string, deps: IntegrationDeps): Promise<JobOutcome | null> {
  const { data, error } = await deps.supabase.rpc("claim_integration_jobs", {
    max_jobs: 1,
    only_job_id: jobId,
  });
  if (error) {
    deps.log.error(
      { jobId, code: error.code, err: error.message },
      "claim_integration_jobs failed",
    );
    return null;
  }
  const job = (data ?? [])[0];
  if (!job) {
    deps.log.info({ jobId }, "job not claimed (running elsewhere or closed)");
    return null;
  }
  return runJob(job, deps);
}

/**
 * Claim and run due jobs one at a time, oldest due first, until `limit`
 * jobs ran, none is due, or it is past `claimUntil` (epoch ms; config's
 * lastClaimAt: a claimed job always runs to its end, so the runner claims
 * one only while its worst case, MAX_JOB_MS, still ends before the
 * function is stopped; nothing is left running unattended). `now` is the
 * clock (tests pass a fake one).
 */
export async function runDueJobs(
  {
    limit = 10,
    claimUntil,
    now = Date.now,
  }: { limit?: number; claimUntil: number; now?: () => number },
  deps: IntegrationDeps,
): Promise<DueJobsSummary> {
  const started = now();
  const summary: DueJobsSummary = {
    claimed: 0,
    done: 0,
    failed: 0,
    needsAttention: 0,
    deferred: 0,
  };
  while (summary.claimed < limit && now() <= claimUntil) {
    const { data, error } = await deps.supabase.rpc("claim_integration_jobs", { max_jobs: 1 });
    if (error) {
      deps.log.error({ code: error.code, err: error.message }, "claim_integration_jobs failed");
      break;
    }
    const job = (data ?? [])[0];
    if (!job) break;
    summary.claimed += 1;
    const outcome = await runJob(job, deps);
    if (outcome === "done") summary.done += 1;
    else if (outcome === "deferred") summary.deferred += 1;
    else if (outcome === "needs_attention") summary.needsAttention += 1;
    else summary.failed += 1;
  }
  deps.log.info({ ...summary, durationMs: now() - started }, "integration queue run");
  return summary;
}
