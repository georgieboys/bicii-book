import "server-only";

import { timingSafeEqual } from "node:crypto";

import type { Logger } from "pino";

import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { newRequestId } from "@/lib/request-id";

import { defaultStripeDeps } from "../stripe/deps";
import { sweepStripeFees, type FeeSweepSummary } from "../stripe/fees";
import { defaultDeps } from "./deps";
import { sweepShopifyFees, type ShopifyFeeSweepSummary } from "./fees";
import { lastClaimAt } from "./config";
import { runDueJobs, type DueJobsSummary } from "./queue";

/**
 * GET /api/cron/integrations (D87; RUNBOOK "Shopify"): the Vercel cron
 * (vercel.json, every 5 minutes) runs due integration jobs. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`; anything else is refused.
 *
 *   503  CRON_SECRET unset (the route is off)
 *   401  a missing or wrong bearer
 *   200  the run's summary { claimed, done, failed, needsAttention, deferred }
 *        and `stripeFees`: the Stripe fee sweep beside it (D273; null while
 *        Stripe is off, { error } when the step failed), and `shopifyFees`:
 *        the Shopify Payments fee sweep (D274; null while Shopify is off,
 *        { error } when the step failed)
 *
 * The fee sweeps run alongside the Shopify jobs, not after them: they may
 * use the whole budget. The Stripe sweep starts no read after
 * STRIPE_FEE_BUDGET_MS, and each read is at most two 8-second calls; the
 * Shopify sweep starts none after SHOPIFY_FEE_BUDGET_MS, and each read is
 * one 10-second call (plus a token exchange), so both end well inside
 * maxDuration.
 */

/** D273: the fee sweep reads at most this many payments a run... */
export const STRIPE_FEES_PER_RUN = 5;
/** ...and starts none this long after the run began. */
export const STRIPE_FEE_BUDGET_MS = 20_000;

/** D274: the Shopify fee sweep reads at most this many sales a run... */
export const SHOPIFY_FEES_PER_RUN = 5;
/** ...and starts none this long after the run began. */
export const SHOPIFY_FEE_BUDGET_MS = 20_000;

export type CronDeps = {
  secret: string | undefined;
  runDue: (
    options: { limit: number; claimUntil: number },
    correlationId: string,
  ) => Promise<DueJobsSummary>;
  /** D273: the Stripe fee sweep (null while Stripe is off). */
  sweepFees: (deadlineMs: number, correlationId: string) => Promise<FeeSweepSummary | null>;
  /** D274: the Shopify Payments fee sweep (null while Shopify is off). */
  sweepShopifyFees: (
    deadlineMs: number,
    correlationId: string,
  ) => Promise<ShopifyFeeSweepSummary | null>;
  log: Logger;
  /** The clock (tests pass a fake one). */
  now: () => number;
};

function respond(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Constant-time comparison of the presented bearer with the secret. */
export function bearerMatches(authorization: string | null, secret: string): boolean {
  if (!authorization) return false;
  const m = /^Bearer (.+)$/.exec(authorization.trim());
  if (!m) return false;
  const presented = Buffer.from(m[1], "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export async function handleCronRequest(
  request: Request,
  overrides: Partial<CronDeps> = {},
): Promise<Response> {
  const correlationId = newRequestId();
  const now = overrides.now ?? Date.now;
  const startedAt = now();
  const deps: CronDeps = {
    secret: Object.prototype.hasOwnProperty.call(overrides, "secret")
      ? overrides.secret
      : getServerEnv().CRON_SECRET,
    runDue: overrides.runDue ?? ((options, cid) => runDueJobs(options, defaultDeps(cid))),
    sweepFees:
      overrides.sweepFees ??
      ((deadlineMs, cid) =>
        sweepStripeFees(defaultStripeDeps(cid), { max: STRIPE_FEES_PER_RUN, deadlineMs })),
    sweepShopifyFees:
      overrides.sweepShopifyFees ??
      ((deadlineMs, cid) =>
        sweepShopifyFees(defaultDeps(cid), {
          max: SHOPIFY_FEES_PER_RUN,
          deadlineMs,
          now: overrides.now ?? Date.now,
        })),
    log: overrides.log ?? child(correlationId, { integration: "shopify", route: "cron" }),
    now,
  };
  if (!deps.secret) {
    deps.log.warn({ status: 503 }, "integration cron called without CRON_SECRET configured");
    return respond(503, { error: "cron_not_configured" });
  }
  if (!bearerMatches(request.headers.get("authorization"), deps.secret)) {
    deps.log.warn({ status: 401 }, "integration cron refused a bad bearer");
    return respond(401, { error: "unauthorized" });
  }
  // Claim only while a job's worst case still ends inside maxDuration (D87).
  const [summary, stripeFees, shopifyFees] = await Promise.all([
    deps.runDue({ limit: 25, claimUntil: lastClaimAt(startedAt) }, correlationId),
    // A step that throws at once (its configuration) still leaves the jobs running.
    Promise.resolve()
      .then(() => deps.sweepFees(startedAt + STRIPE_FEE_BUDGET_MS, correlationId))
      .catch((err: unknown) => {
        const e = err as { name?: string; code?: string };
        deps.log.error(
          { step: "stripe_fees", error: e?.name ?? "Error", code: e?.code ?? null },
          "stripe fee sweep failed",
        );
        return { error: "failed" as const };
      }),
    Promise.resolve()
      .then(() => deps.sweepShopifyFees(startedAt + SHOPIFY_FEE_BUDGET_MS, correlationId))
      .catch((err: unknown) => {
        const e = err as { name?: string; code?: string };
        deps.log.error(
          { step: "shopify_fees", error: e?.name ?? "Error", code: e?.code ?? null },
          "shopify fee sweep failed",
        );
        return { error: "failed" as const };
      }),
  ]);
  return respond(200, { ...summary, stripeFees, shopifyFees });
}
