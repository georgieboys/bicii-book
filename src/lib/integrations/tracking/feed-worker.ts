import "server-only";

import type { Logger } from "pino";

import type { ServiceSupabase } from "@/lib/integrations/shopify/deps";
import {
  fakeFeed,
  fetchSpot,
  fetchWindow,
  nextCursor,
  ProviderError,
  type FetchResult,
} from "@/lib/tracking/providers";

/**
 * The tracking feed worker (D190; handoff §12.3), run by the adventure-work
 * cron. For each due feed: claim it under a lease (the database spaces
 * requests to the provider's limit), read its access from the server
 * variable it names (TRACKING_FEED_* only, never another secret), fetch one
 * bounded window, store the messages and move the cursor in one call, or
 * record a failure that backs off. Nothing starts after the deadline.
 */

export type FeedWorkerDeps = {
  supabase: ServiceSupabase;
  env: Record<string, string | undefined>;
  log: Logger;
  now: () => number;
  fetchImpl?: typeof fetch;
};

export type FeedSummary = { feeds: number; stored: number; failed: number };

const CONFIG_NAME = /^TRACKING_FEED_[A-Z0-9_]{1,40}$/;

async function fetchFor(
  provider: string,
  configName: string,
  window: { from: Date; to: Date },
  deps: FeedWorkerDeps,
): Promise<FetchResult> {
  if (!CONFIG_NAME.test(configName))
    throw new ProviderError("The feed's variable name is not allowed.");
  const value = deps.env[configName]?.trim();
  if (!value) throw new ProviderError(`${configName} is not set.`);
  if (provider === "spot") {
    return fetchSpot(value, window, {
      password: deps.env[`${configName}_PASSWORD`]?.trim() || undefined,
      fetchImpl: deps.fetchImpl,
    });
  }
  if (provider === "fake") {
    // The test feed makes up positions; never in production (audit A-68).
    if (deps.env.VERCEL_ENV === "production") {
      throw new ProviderError("The test feed is off in production.");
    }
    return fakeFeed(
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      window,
    );
  }
  throw new ProviderError("Unknown provider.");
}

export async function runTrackingFeeds(
  deps: FeedWorkerDeps,
  options: { maxFeeds: number; deadlineMs: number },
): Promise<FeedSummary> {
  const summary: FeedSummary = { feeds: 0, stored: 0, failed: 0 };
  for (let i = 0; i < options.maxFeeds && deps.now() < options.deadlineMs; i++) {
    const { data, error } = await deps.supabase.rpc("claim_tracking_feed");
    if (error) throw new Error(`claim_tracking_feed failed: ${error.code}`);
    const feed = (Array.isArray(data) ? data[0] : data) as
      | {
          feed_id: string;
          lease_token: string;
          provider: string;
          config_name: string;
          watermark_at: string;
          window_end_at: string | null;
        }
      | undefined;
    if (!feed) break;
    summary.feeds += 1;
    const log = deps.log.child({ feedId: feed.feed_id });
    const window = fetchWindow(feed.watermark_at, feed.window_end_at, deps.now());
    try {
      const result = await fetchFor(feed.provider, feed.config_name, window, deps);
      const cursor = nextCursor(result, window);
      const stored = await deps.supabase.rpc("store_tracking_messages", {
        feed_id: feed.feed_id,
        lease_token: feed.lease_token,
        messages: result.messages,
        complete: cursor.complete,
        window_to: cursor.windowTo.toISOString(),
        next_window_end: (cursor.complete
          ? null
          : cursor.nextWindowEnd.toISOString()) as unknown as string,
      });
      if (stored.error) throw new Error(`store_tracking_messages failed: ${stored.error.code}`);
      summary.stored += Math.max(0, Number(stored.data ?? 0));
      log.info(
        { received: result.messages.length, added: stored.data, complete: cursor.complete },
        "tracking feed read",
      );
    } catch (err) {
      summary.failed += 1;
      const reason = err instanceof ProviderError ? err.message : "Request failed.";
      await deps.supabase.rpc("fail_tracking_feed", {
        feed_id: feed.feed_id,
        lease_token: feed.lease_token,
        error: reason,
      });
      log.warn({ reason }, "tracking feed failed");
    }
  }
  return summary;
}
