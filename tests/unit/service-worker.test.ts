// @vitest-environment node
/**
 * The service worker's cache cap (public/sw.js; audit E3-5): content-hashed
 * build assets get new names on every deploy while the worker itself stays
 * the same, so the cache keeps MAX_ENTRIES and drops the oldest, never an icon.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const source = readFileSync("public/sw.js", "utf8");

function load() {
  const context: Record<string, unknown> = {
    self: { addEventListener: () => {}, location: { origin: "https://admin.example" } },
    caches: {},
    URL,
  };
  // Top-level consts are not context properties: hand them out explicitly.
  runInNewContext(`${source}\n;globalThis.__sw = { trim, MAX_ENTRIES, ICONS };`, context);
  return context.__sw as {
    trim: (cache: FakeCache) => Promise<void>;
    MAX_ENTRIES: number;
    ICONS: string[];
  };
}

class FakeCache {
  entries: string[];
  constructor(urls: string[]) {
    this.entries = [...urls];
  }
  async keys() {
    return this.entries.map((url) => ({ url }));
  }
  async delete(request: { url: string }) {
    this.entries = this.entries.filter((u) => u !== request.url);
    return true;
  }
}

describe("service worker cache cap", () => {
  it("drops the oldest build assets past the cap and keeps the icons", async () => {
    const sw = load();
    const origin = "https://admin.example";
    const icons = sw.ICONS.map((p) => `${origin}${p}`);
    const assets = Array.from(
      { length: sw.MAX_ENTRIES + 10 },
      (_, i) => `${origin}/_next/static/c${i}.js`,
    );
    const cache = new FakeCache([...icons, ...assets]);
    await sw.trim(cache);
    expect(cache.entries).toHaveLength(sw.MAX_ENTRIES);
    for (const icon of icons) expect(cache.entries).toContain(icon);
    expect(cache.entries).not.toContain(assets[0]);
    expect(cache.entries).toContain(assets.at(-1));
  });

  it("leaves a cache under the cap alone", async () => {
    const sw = load();
    const cache = new FakeCache(["https://admin.example/_next/static/a.js"]);
    await sw.trim(cache);
    expect(cache.entries).toHaveLength(1);
  });
});
