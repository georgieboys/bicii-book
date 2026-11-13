/**
 * Tracking providers (D190; handoff §12.1-12.3): one normalised message,
 * the SPOT feed adapter, a deterministic fake, and the worker's window
 * arithmetic. Pure apart from `fetch`, which is injected, so every rule is
 * unit-tested without the network.
 *
 * SPOT's public feed (handoff §12.2): data since the feed was created, at
 * most seven days back; the same feed no more often than every 2.5 minutes
 * (the database's `min_interval_seconds` enforces it); at most 50 messages
 * a page, newest first; date filters; messages without a usable position
 * carry sentinel coordinates. None of this is verified against a real BICII
 * feed yet (R-102).
 */

export type TrackingKind = "position" | "check_in" | "help" | "stop" | "other";

export type TrackingMessage = {
  providerMessageId: string;
  providerDeviceId: string;
  recordedAt: string;
  kind: TrackingKind;
  latitude: number | null;
  longitude: number | null;
};

export type FetchResult = { messages: TrackingMessage[]; pageSize: number };

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

// ------------------------------------------------------------- window ----

/** How far before the watermark each request reaches, for late deliveries. */
export const OVERLAP_MS = 10 * 60_000;
/** The longest window one request asks for. */
export const MAX_WINDOW_MS = 6 * 60 * 60_000;
/** SPOT keeps seven days; never ask for older. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The window to fetch: from just before the watermark, to the cursor or a bounded step ahead. */
export function fetchWindow(
  watermarkAt: string,
  windowEndAt: string | null,
  now: number,
): { from: Date; to: Date } {
  const watermark = Date.parse(watermarkAt);
  const earliest = now - RETENTION_MS + 60_000;
  const from = Math.max(watermark - OVERLAP_MS, earliest);
  const to = windowEndAt
    ? Date.parse(windowEndAt)
    : Math.min(now, Math.max(watermark, earliest) + MAX_WINDOW_MS);
  return { from: new Date(from), to: new Date(Math.max(to, from)) };
}

/**
 * After a fetch: a page with room to spare means the window is complete and
 * the watermark moves to its end; a full page means older messages remain,
 * so the next window ends at the oldest message received (inclusive).
 */
export function nextCursor(
  result: FetchResult,
  window: { from: Date; to: Date },
): { complete: true; windowTo: Date } | { complete: false; windowTo: Date; nextWindowEnd: Date } {
  if (result.messages.length < result.pageSize) return { complete: true, windowTo: window.to };
  const oldest = Math.min(...result.messages.map((m) => Date.parse(m.recordedAt)));
  // A page of messages all at one instant would never move: step past it.
  const end = oldest >= window.to.getTime() ? window.to.getTime() - 1000 : oldest + 1000;
  return {
    complete: false,
    windowTo: window.to,
    nextWindowEnd: new Date(Math.max(end, window.from.getTime())),
  };
}

// --------------------------------------------------------------- SPOT ----

export const SPOT_HOST = "api.findmespot.com";
export const SPOT_PAGE_SIZE = 50;
export const MAX_RESPONSE_BYTES = 1_000_000;

/** SPOT's date format: 2026-11-14T08:00:00-0000. */
function spotDate(d: Date): string {
  return `${d.toISOString().slice(0, 19)}-0000`;
}

/** The feed request. Only SPOT's host and a feed ID made of letters and digits. */
export function spotFeedUrl(
  feedId: string,
  window: { from: Date; to: Date },
  password?: string,
): URL {
  if (!/^[A-Za-z0-9]{10,64}$/.test(feedId)) throw new ProviderError("The feed ID is not valid.");
  const url = new URL(
    `https://${SPOT_HOST}/spot-main-web/consumer/rest-api/2.0/public/feed/${feedId}/message.json`,
  );
  url.searchParams.set("startDate", spotDate(window.from));
  url.searchParams.set("endDate", spotDate(window.to));
  if (password) url.searchParams.set("feedPassword", password);
  return url;
}

const SPOT_KINDS: Record<string, TrackingKind> = {
  TRACK: "position",
  UNLIMITED_TRACK: "position",
  EXTREME_TRACK: "position",
  NEWMOVEMENT: "position",
  OK: "check_in",
  CUSTOM: "check_in",
  HELP: "help",
  SOS: "help",
  STOP: "stop",
  POWER_OFF: "stop",
};

type SpotMessage = {
  id?: unknown;
  messengerId?: unknown;
  unixTime?: unknown;
  messageType?: unknown;
  latitude?: unknown;
  longitude?: unknown;
};

function validCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** SPOT's JSON into messages; "no messages" is an empty page, any other error throws. */
export function parseSpotFeed(body: unknown): TrackingMessage[] {
  const response = (body as { response?: Record<string, unknown> } | null)?.response;
  if (!response || typeof response !== "object")
    throw new ProviderError("Unexpected feed response.");
  const errors = response.errors as { error?: { code?: unknown } } | undefined;
  if (errors) {
    // E-0195: no displayable messages in the window.
    if (errors.error?.code === "E-0195") return [];
    throw new ProviderError(
      `Feed error ${typeof errors.error?.code === "string" ? errors.error.code : "unknown"}.`,
    );
  }
  const container = (
    response.feedMessageResponse as { messages?: { message?: unknown } } | undefined
  )?.messages?.message;
  const list = (
    Array.isArray(container) ? container : container ? [container] : []
  ) as SpotMessage[];
  const out: TrackingMessage[] = [];
  for (const m of list) {
    const id = typeof m.id === "number" || typeof m.id === "string" ? String(m.id) : "";
    const device = typeof m.messengerId === "string" ? m.messengerId.trim() : "";
    const unix = Number(m.unixTime);
    if (!id || !device || !Number.isFinite(unix) || unix <= 0) continue;
    const lat = Number(m.latitude);
    const lon = Number(m.longitude);
    const placed = validCoordinate(lat, lon);
    out.push({
      providerMessageId: id,
      providerDeviceId: device,
      recordedAt: new Date(unix * 1000).toISOString(),
      kind: SPOT_KINDS[String(m.messageType ?? "").toUpperCase()] ?? "other",
      latitude: placed ? lat : null,
      longitude: placed ? lon : null,
    });
  }
  return out;
}

/** One SPOT request, with a timeout and a response size cap. */
export async function fetchSpot(
  feedId: string,
  window: { from: Date; to: Date },
  options: { password?: string; fetchImpl?: typeof fetch } = {},
): Promise<FetchResult> {
  const url = spotFeedUrl(feedId, window, options.password);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderError("Provider unavailable.");
  }
  if (!response.ok) throw new ProviderError(`Provider answered ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new ProviderError("Feed response too large.");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError("Feed response too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError("Feed response was not JSON.");
  }
  return { messages: parseSpotFeed(body), pageSize: SPOT_PAGE_SIZE };
}

// --------------------------------------------------------------- fake ----

const FAKE_STEP_MS = 10 * 60_000;

/**
 * A deterministic feed for development and tests (D186): each device in
 * the list reports a position every 10 minutes on a loop round Singapore.
 * The same device and minute always give the same message id and place, so
 * repeated fetches deduplicate like a real feed. Newest first, 50 a page.
 */
export function fakeFeed(deviceIds: string[], window: { from: Date; to: Date }): FetchResult {
  const out: TrackingMessage[] = [];
  const first = Math.ceil(window.from.getTime() / FAKE_STEP_MS) * FAKE_STEP_MS;
  for (const device of deviceIds) {
    for (let t = first; t <= window.to.getTime(); t += FAKE_STEP_MS) {
      const a = ((t / FAKE_STEP_MS) % 72) * ((2 * Math.PI) / 72);
      out.push({
        providerMessageId: `${device}-${t / 60_000}`,
        providerDeviceId: device,
        recordedAt: new Date(t).toISOString(),
        kind: "position",
        latitude: Math.round((1.35 + 0.12 * Math.sin(a)) * 1e6) / 1e6,
        longitude: Math.round((103.82 + 0.25 * Math.cos(a)) * 1e6) / 1e6,
      });
    }
  }
  out.sort((x, y) => y.recordedAt.localeCompare(x.recordedAt));
  return { messages: out.slice(0, SPOT_PAGE_SIZE), pageSize: SPOT_PAGE_SIZE };
}
