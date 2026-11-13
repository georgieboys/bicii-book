// @vitest-environment node
/**
 * Tracking providers and the feed worker (D190; handoff §12.1-12.3, T09):
 * the window and cursor arithmetic, SPOT's URL and JSON (synthetic
 * fixtures, not a real feed: R-102), the request limits, the fake feed,
 * and the worker's handling of feeds and their variables.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  fakeFeed,
  fetchSpot,
  fetchWindow,
  MAX_WINDOW_MS,
  nextCursor,
  OVERLAP_MS,
  parseSpotFeed,
  ProviderError,
  RETENTION_MS,
  spotFeedUrl,
} = await import("@/lib/tracking/providers");
const { runTrackingFeeds } = await import("@/lib/integrations/tracking/feed-worker");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const FEED_ID = "0abcDEF123456789xyz";

describe("windows and cursors", () => {
  it("reaches back past the watermark, steps at most 6 hours, never past seven days, or ends at the cursor", () => {
    const w = fetchWindow("2026-11-14T06:00:00Z", null, NOW);
    expect(w.from.getTime()).toBe(Date.parse("2026-11-14T06:00:00Z") - OVERLAP_MS);
    expect(w.to.getTime()).toBe(Math.min(NOW, Date.parse("2026-11-14T06:00:00Z") + MAX_WINDOW_MS));
    const old = fetchWindow("2026-10-01T00:00:00Z", null, NOW);
    expect(old.from.getTime()).toBeGreaterThan(NOW - RETENTION_MS);
    const cursor = fetchWindow("2026-11-14T06:00:00Z", "2026-11-14T08:00:00Z", NOW);
    expect(cursor.to.toISOString()).toBe("2026-11-14T08:00:00.000Z");
  });

  it("a short page completes the window; a full page moves the cursor to its oldest message", () => {
    const window = { from: new Date("2026-11-14T06:00:00Z"), to: new Date("2026-11-14T12:00:00Z") };
    const msg = (iso: string) => ({
      providerMessageId: iso,
      providerDeviceId: "d",
      recordedAt: iso,
      kind: "position" as const,
      latitude: 1,
      longitude: 1,
    });
    expect(nextCursor({ messages: [msg("2026-11-14T07:00:00Z")], pageSize: 2 }, window)).toEqual({
      complete: true,
      windowTo: window.to,
    });
    const full = nextCursor(
      { messages: [msg("2026-11-14T11:00:00Z"), msg("2026-11-14T09:00:00Z")], pageSize: 2 },
      window,
    );
    expect(full).toMatchObject({ complete: false });
    expect(full.complete ? null : full.nextWindowEnd.toISOString()).toBe(
      "2026-11-14T09:00:01.000Z",
    );
    // A full page all at the window's end still moves back.
    const stuck = nextCursor(
      { messages: [msg("2026-11-14T12:00:00Z"), msg("2026-11-14T12:00:00Z")], pageSize: 2 },
      window,
    );
    expect(stuck.complete ? null : stuck.nextWindowEnd.getTime()).toBeLessThan(window.to.getTime());
  });
});

describe("SPOT", () => {
  const window = { from: new Date("2026-11-14T06:00:00Z"), to: new Date("2026-11-14T12:00:00Z") };

  it("asks only SPOT's host, for a feed ID of letters and digits", () => {
    const url = spotFeedUrl(FEED_ID, window, "pw");
    expect(url.host).toBe("api.findmespot.com");
    expect(url.pathname).toBe(
      `/spot-main-web/consumer/rest-api/2.0/public/feed/${FEED_ID}/message.json`,
    );
    expect(url.searchParams.get("startDate")).toBe("2026-11-14T06:00:00-0000");
    expect(url.searchParams.get("feedPassword")).toBe("pw");
    expect(() => spotFeedUrl("../../evil.example/x", window)).toThrow(ProviderError);
    expect(() => spotFeedUrl("short", window)).toThrow(ProviderError);
  });

  it("reads messages, kinds and sentinel positions; no messages is an empty page", () => {
    const body = {
      response: {
        feedMessageResponse: {
          count: 3,
          messages: {
            message: [
              {
                id: 101,
                messengerId: "0-111",
                unixTime: 1794643200,
                messageType: "UNLIMITED-TRACK".replace("-", "_"),
                latitude: 1.3,
                longitude: 103.8,
              },
              {
                id: 102,
                messengerId: "0-111",
                unixTime: 1794643260,
                messageType: "OK",
                latitude: -99999,
                longitude: -99999,
              },
              {
                id: 103,
                messengerId: "0-111",
                unixTime: 1794643320,
                messageType: "HELP",
                latitude: 1.31,
                longitude: 103.81,
              },
              { id: 104, messengerId: "", unixTime: 1794643320 },
            ],
          },
        },
      },
    };
    expect(parseSpotFeed(body)).toEqual([
      {
        providerMessageId: "101",
        providerDeviceId: "0-111",
        recordedAt: "2026-11-14T08:00:00.000Z",
        kind: "position",
        latitude: 1.3,
        longitude: 103.8,
      },
      {
        providerMessageId: "102",
        providerDeviceId: "0-111",
        recordedAt: "2026-11-14T08:01:00.000Z",
        kind: "check_in",
        latitude: null,
        longitude: null,
      },
      {
        providerMessageId: "103",
        providerDeviceId: "0-111",
        recordedAt: "2026-11-14T08:02:00.000Z",
        kind: "help",
        latitude: 1.31,
        longitude: 103.81,
      },
    ]);
    // A single message comes as an object, not a list.
    expect(
      parseSpotFeed({
        response: {
          feedMessageResponse: {
            messages: {
              message: {
                id: 1,
                messengerId: "d",
                unixTime: 1794643200,
                messageType: "TRACK",
                latitude: 1,
                longitude: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      parseSpotFeed({
        response: { errors: { error: { code: "E-0195", text: "No displayable messages found" } } },
      }),
    ).toEqual([]);
    expect(() => parseSpotFeed({ response: { errors: { error: { code: "E-0160" } } } })).toThrow(
      /E-0160/,
    );
    expect(() => parseSpotFeed({ nope: true })).toThrow(ProviderError);
  });

  it("refuses an unreachable provider, an error status, a large or non-JSON answer", async () => {
    const answer = (body: string, init: ResponseInit = {}) =>
      vi.fn(async () => new Response(body, init));
    await expect(
      fetchSpot(FEED_ID, window, {
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNRESET");
        }),
      }),
    ).rejects.toThrow("Provider unavailable.");
    await expect(
      fetchSpot(FEED_ID, window, { fetchImpl: answer("", { status: 503 }) }),
    ).rejects.toThrow("Provider answered 503.");
    await expect(
      fetchSpot(FEED_ID, window, {
        fetchImpl: answer("{}", { headers: { "content-length": "5000000" } }),
      }),
    ).rejects.toThrow("too large");
    await expect(fetchSpot(FEED_ID, window, { fetchImpl: answer("<html>") })).rejects.toThrow(
      "not JSON",
    );
    const ok = await fetchSpot(FEED_ID, window, {
      fetchImpl: answer(JSON.stringify({ response: { errors: { error: { code: "E-0195" } } } })),
    });
    expect(ok).toEqual({ messages: [], pageSize: 50 });
  });
});

describe("the fake feed", () => {
  it("is deterministic, every 10 minutes per device, newest first, 50 a page", () => {
    const window = { from: new Date("2026-11-14T06:00:00Z"), to: new Date("2026-11-14T07:00:00Z") };
    const a = fakeFeed(["fake-1", "fake-2"], window);
    expect(a).toEqual(fakeFeed(["fake-1", "fake-2"], window));
    expect(a.messages).toHaveLength(14);
    expect(a.messages[0].recordedAt >= a.messages[13].recordedAt).toBe(true);
    const day = fakeFeed(["fake-1"], {
      from: new Date("2026-11-14T00:00:00Z"),
      to: new Date("2026-11-15T00:00:00Z"),
    });
    expect(day.messages).toHaveLength(50);
  });
});

describe("the feed worker", () => {
  function supabase(feeds: Array<Record<string, unknown>>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        rpc: async (name: string, args: Record<string, unknown> = {}) => {
          calls.push({ name, args });
          if (name === "claim_tracking_feed")
            return { data: feeds.length ? [feeds.shift()] : [], error: null };
          if (name === "store_tracking_messages")
            return { data: (args.messages as unknown[]).length, error: null };
          return { data: true, error: null };
        },
      },
    };
  }
  const feed = (provider: string, config: string) => ({
    feed_id: `f-${config}`,
    lease_token: "lease",
    provider,
    config_name: config,
    watermark_at: "2026-11-14T11:00:00Z",
    window_end_at: null,
  });

  it("reads a fake feed into the database, and fails a feed whose variable is missing or not allowed", async () => {
    const s = supabase([
      feed("fake", "TRACKING_FEED_DEMO"),
      feed("spot", "TRACKING_FEED_MISSING"),
      feed("spot", "SUPABASE_SERVICE_ROLE_KEY"),
    ]);
    const fetchImpl = vi.fn();
    const summary = await runTrackingFeeds(
      {
        supabase: s.client as never,
        env: { TRACKING_FEED_DEMO: "fake-1", SUPABASE_SERVICE_ROLE_KEY: "secret-value" },
        log: pino({ level: "silent" }),
        now: () => NOW,
        fetchImpl: fetchImpl as never,
      },
      { maxFeeds: 3, deadlineMs: NOW + 1 },
    );
    expect(summary).toMatchObject({ feeds: 3, failed: 2 });
    expect(summary.stored).toBeGreaterThan(0);
    const store = s.calls.find((c) => c.name === "store_tracking_messages");
    expect(store?.args).toMatchObject({
      feed_id: "f-TRACKING_FEED_DEMO",
      lease_token: "lease",
      complete: true,
    });
    const fails = s.calls.filter((c) => c.name === "fail_tracking_feed").map((c) => c.args.error);
    expect(fails).toEqual([
      "TRACKING_FEED_MISSING is not set.",
      "The feed's variable name is not allowed.",
    ]);
    expect(JSON.stringify(s.calls)).not.toContain("secret-value");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("starts nothing after the deadline", async () => {
    const s = supabase([feed("fake", "TRACKING_FEED_DEMO")]);
    const summary = await runTrackingFeeds(
      { supabase: s.client as never, env: {}, log: pino({ level: "silent" }), now: () => NOW },
      { maxFeeds: 2, deadlineMs: NOW - 1 },
    );
    expect(summary).toEqual({ feeds: 0, stored: 0, failed: 0 });
    expect(s.calls).toEqual([]);
  });
});
