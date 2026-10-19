/*
 * BICII Admin service worker (ADR-001 A7). Deliberately small:
 *
 *   - cache-first for immutable build assets (/_next/static/*) and icons;
 *   - everything else goes to the network untouched: pages, Server Actions,
 *     API routes and Supabase calls are never cached or replayed, so there
 *     are no offline mutations — stock and money need a live connection.
 *
 * Bump VERSION to drop every old cache on the next activation. Build assets
 * are content-hashed, so every deploy adds new names while this file (and
 * so its activate step) stays the same; the cache is therefore capped at
 * MAX_ENTRIES, dropping the oldest first (audit E3-5): what a previous
 * deploy left behind goes, the current one's assets stay.
 */
const VERSION = "v1";
const CACHE = `bicii-static-${VERSION}`;
/** More than one build's static files; older entries are dropped first. */
const MAX_ENTRIES = 400;
const ICONS = [
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/apple-touch-icon.png",
  "/logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ICONS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("bicii-") && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Drops the oldest entries (Cache keys keep insertion order), never the icons. */
async function trim(cache) {
  const keys = await cache.keys();
  let excess = keys.length - MAX_ENTRIES;
  for (const request of keys) {
    if (excess <= 0) break;
    if (ICONS.includes(new URL(request.url).pathname)) continue;
    await cache.delete(request);
    excess -= 1;
  }
}

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith("/_next/static/") || ICONS.includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // network-only, never intercepted
  const url = new URL(request.url);
  if (!isCacheable(url)) return; // network-only

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        event.waitUntil(cache.put(request, response.clone()).then(() => trim(cache)));
      }
      return response;
    }),
  );
});
