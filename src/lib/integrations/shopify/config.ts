/**
 * Shopify integration constants (Phase 10; SPEC §17, §26; PLAN D84, D87,
 * D88; ADR-020). Pure: imported by the adapters, the webhook handler and
 * the unit tests.
 */

/**
 * The Admin API version every call is pinned to. The upgrade procedure is
 * in docs/RUNBOOK.md ("Shopify", API version upgrade); the version is
 * stored on each sync row (shopify_product_sync.api_version) and is part
 * of the desired-state hash, so an upgrade re-pushes every product once
 * (D84). Each webhook event stores the version Shopify sent
 * (X-Shopify-Api-Version).
 */
export const SHOPIFY_API_VERSION = "2026-10";

/** The webhook topics BICII subscribes to and processes (D85: no orders/cancelled). */
export const HANDLED_TOPICS = ["orders/paid", "refunds/create"] as const;

/** D88: a body above 1 MiB gets 413 and is not stored. */
export const MAX_WEBHOOK_BYTES = 1_048_576;

/** D88: above this many rejected deliveries per minute per server instance, they are logged, not stored. */
export const MAX_REJECTED_PER_MINUTE = 30;

/**
 * D88: the request headers kept on an event (lower-cased). The database
 * caps them again (16 keys, 512 characters each).
 */
export const WEBHOOK_HEADER_ALLOWLIST = [
  "x-shopify-topic",
  "x-shopify-hmac-sha256",
  "x-shopify-shop-domain",
  "x-shopify-webhook-id",
  "x-shopify-event-id",
  "x-shopify-api-version",
  "x-shopify-triggered-at",
  "x-shopify-test",
  "content-type",
  "content-length",
  "user-agent",
] as const;

/** A Shopify call that has not answered by then is abandoned (retriable). */
export const SHOPIFY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Queue-runner time (D87): a claimed job always runs to its end, so a
// runner claims one only while the worst case of that job still ends
// before the function is stopped. Otherwise a job could be killed mid-run
// and stay `running` until the ten-minute reclaim.
// ---------------------------------------------------------------------------

/**
 * The most Shopify calls one job makes: a product sync can look up the
 * location, write the product, set the quantity, overwrite it, read the
 * publications, publish, and exchange a client-credentials token.
 */
export const SHOPIFY_CALLS_PER_JOB_MAX = 7;

/** Postgres RPCs and logging around a job's Shopify calls. */
export const JOB_OVERHEAD_MS = 5_000;

/** The longest one job can run: every Shopify call at its timeout, plus the overhead (75 s). */
export const MAX_JOB_MS = SHOPIFY_CALLS_PER_JOB_MAX * SHOPIFY_TIMEOUT_MS + JOB_OVERHEAD_MS;

/**
 * How long the runner routes may run: `maxDuration` (seconds) in
 * src/app/api/cron/integrations/route.ts and src/app/api/shopify/webhooks/route.ts,
 * which must stay literals (route segment config is read statically);
 * tests/unit/shopify-cron-route.test.ts checks they match.
 */
export const RUNNER_MAX_DURATION_MS = 90_000;

/** Kept free at the end of the function (the response, the summary log). */
export const RUNNER_MARGIN_MS = 5_000;

/**
 * The last instant (epoch ms) a runner that started at `startedAt` may
 * claim a job: the job's worst case still ends `RUNNER_MARGIN_MS` before
 * the function's limit (startedAt + 10 s with the values above).
 */
export function lastClaimAt(startedAt: number): number {
  return startedAt + RUNNER_MAX_DURATION_MS - RUNNER_MARGIN_MS - MAX_JOB_MS;
}
