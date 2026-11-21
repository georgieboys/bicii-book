// @vitest-environment node
/**
 * GET /api/cron/integrations (D87): off without CRON_SECRET, refused
 * without the bearer, otherwise one bounded run of due jobs.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { bearerMatches, handleCronRequest } = await import("@/lib/integrations/shopify/cron");
const {
  MAX_JOB_MS,
  RUNNER_MARGIN_MS,
  RUNNER_MAX_DURATION_MS,
  SHOPIFY_CALLS_PER_JOB_MAX,
  SHOPIFY_TIMEOUT_MS,
  lastClaimAt,
} = await import("@/lib/integrations/shopify/config");
const { runDueJobs } = await import("@/lib/integrations/shopify/queue");

const SUMMARY = { claimed: 2, done: 1, failed: 0, needsAttention: 1, deferred: 0 };
const log = pino({ level: "silent" });
const req = (authorization?: string) =>
  new Request("http://localhost:3000/api/cron/integrations", {
    headers: authorization ? { authorization } : {},
  });

describe("handleCronRequest", () => {
  it("503 when CRON_SECRET is not configured, without running anything", async () => {
    const runDue = vi.fn();
    const res = await handleCronRequest(req("Bearer x"), { secret: undefined, runDue, log });
    expect(res.status).toBe(503);
    expect(runDue).not.toHaveBeenCalled();
  });

  it("401 for a missing, malformed or wrong bearer", async () => {
    const runDue = vi.fn();
    for (const auth of [
      undefined,
      "secret-1",
      "Basic secret-1",
      "Bearer secret-2",
      "Bearer secret-1x",
      "Bearer ",
    ]) {
      const res = await handleCronRequest(req(auth), { secret: "secret-1", runDue, log });
      expect(res.status).toBe(401);
    }
    expect(runDue).not.toHaveBeenCalled();
  });

  it("200 with the run's summary for the right bearer", async () => {
    const runDue = vi.fn(async () => SUMMARY);
    const res = await handleCronRequest(req("Bearer secret-1"), {
      secret: "secret-1",
      runDue,
      log,
      now: () => 1_800_000_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(SUMMARY);
    // A job claimed at the last instant still ends 5 s before maxDuration.
    expect(runDue).toHaveBeenCalledExactlyOnceWith(
      { limit: 25, claimUntil: 1_800_000_000_000 + 10_000 },
      expect.any(String),
    );
  });

  it("compares the bearer exactly", () => {
    expect(bearerMatches("Bearer a-b", "a-b")).toBe(true);
    expect(bearerMatches("bearer a-b", "a-b")).toBe(false);
    expect(bearerMatches(null, "a-b")).toBe(false);
  });
});

describe("the route modules", () => {
  it("run on Node with a 90 s budget and export only their method", async () => {
    vi.doMock("@/lib/integrations/shopify/cron", () => ({
      handleCronRequest: async () => new Response("cron"),
    }));
    vi.doMock("@/lib/integrations/shopify/webhooks", () => ({
      handleShopifyWebhook: async () => new Response("webhook"),
    }));
    const cron = await import("@/app/api/cron/integrations/route");
    const webhooks = await import("@/app/api/shopify/webhooks/route");
    expect(cron.runtime).toBe("nodejs");
    expect(cron.maxDuration).toBe(90);
    // config's budget arithmetic assumes exactly this limit.
    expect(cron.maxDuration * 1000).toBe(RUNNER_MAX_DURATION_MS);
    expect(Object.keys(cron).sort()).toEqual(["GET", "maxDuration", "runtime"]);
    expect(await (await cron.GET(req())).text()).toBe("cron");
    expect(webhooks.runtime).toBe("nodejs");
    expect(webhooks.maxDuration).toBe(90);
    expect(Object.keys(webhooks).sort()).toEqual(["POST", "maxDuration", "runtime"]);
    expect(await (await webhooks.POST(req())).text()).toBe("webhook");
  });
});

describe("the runner's time budget (D87)", () => {
  it("a job's worst case (every Shopify call at its timeout) fits inside maxDuration with the margin", () => {
    expect(MAX_JOB_MS).toBeGreaterThanOrEqual(SHOPIFY_CALLS_PER_JOB_MAX * SHOPIFY_TIMEOUT_MS);
    expect(MAX_JOB_MS + RUNNER_MARGIN_MS).toBeLessThanOrEqual(RUNNER_MAX_DURATION_MS);
    expect(lastClaimAt(0) + MAX_JOB_MS + RUNNER_MARGIN_MS).toBe(RUNNER_MAX_DURATION_MS);
  });

  it("never claims a job that could not finish before maxDuration (fake clock)", async () => {
    let clock = 0;
    const claims: number[] = [];
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_integration_jobs") {
        claims.push(clock);
        return {
          data: [{ id: `j-${claims.length}`, kind: "shopify_event", integration_event_id: "e" }],
          error: null,
        };
      }
      // process_shopify_event: each job takes 4 s of the clock.
      clock += 4_000;
      return { data: [{ event_status: "processed", outcome: "sale_recorded" }], error: null };
    });
    const deps = {
      supabase: { rpc } as never,
      admin: null,
      log,
      publicStorageBase: "http://localhost/storage",
    };
    const summary = await runDueJobs(
      { limit: 25, claimUntil: lastClaimAt(0), now: () => clock },
      deps,
    );
    // Claimed at 0, 4 and 8 s; at 12 s a job's worst case would end past 55 s.
    expect(claims).toEqual([0, 4_000, 8_000]);
    expect(summary).toMatchObject({ claimed: 3, done: 3 });
    for (const at of claims) expect(at + MAX_JOB_MS + RUNNER_MARGIN_MS).toBeLessThanOrEqual(RUNNER_MAX_DURATION_MS);

    // Past the deadline from the start: nothing is claimed at all.
    clock = lastClaimAt(0) + 1;
    claims.length = 0;
    expect(
      await runDueJobs({ limit: 25, claimUntil: lastClaimAt(0), now: () => clock }, deps),
    ).toMatchObject({ claimed: 0 });
    expect(claims).toEqual([]);
  });
});
