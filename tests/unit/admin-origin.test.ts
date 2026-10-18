// @vitest-environment node
/**
 * Links sent outside the Admin (quote links, the Shopify webhook address)
 * are built on the validated ADMIN_ORIGIN, never on a host taken from the
 * request, whenever ADMIN_ORIGIN is set (R-088, R-091; audit 2026-10-18).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

import { adminOrigin, linkOriginFrom, requestOrigin } from "@/lib/admin-origin";

const hostile = new Headers({
  host: "admin.example.com",
  "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "https",
});

describe("linkOriginFrom", () => {
  it("uses ADMIN_ORIGIN and ignores the forwarded host", () => {
    expect(
      linkOriginFrom(
        { ADMIN_ORIGIN: "https://admin.example.com", VERCEL_ENV: "production" },
        hostile,
      ),
    ).toBe("https://admin.example.com");
  });

  it("falls back to the request only when ADMIN_ORIGIN is unset or invalid", () => {
    expect(linkOriginFrom({ ADMIN_ORIGIN: undefined, VERCEL_ENV: undefined }, hostile)).toBe(
      "https://evil.example",
    );
    expect(
      linkOriginFrom(
        { ADMIN_ORIGIN: "https://admin.example.com/path", VERCEL_ENV: undefined },
        hostile,
      ),
    ).toBe("https://evil.example");
    expect(linkOriginFrom(null, new Headers({ host: "localhost:3000" }))).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses an http or loopback ADMIN_ORIGIN in production", () => {
    const env = { ADMIN_ORIGIN: "http://localhost:3000", VERCEL_ENV: "production" as const };
    expect(linkOriginFrom(env, hostile)).toBe("https://evil.example");
    expect(linkOriginFrom({ ...env, VERCEL_ENV: undefined }, hostile)).toBe(
      "http://localhost:3000",
    );
  });
});

describe("adminOrigin", () => {
  it("accepts an https origin and normalises a trailing slash", () => {
    expect(adminOrigin("https://admin.example.com/", true)).toBe("https://admin.example.com");
  });

  it("rejects paths, queries, credentials and non-http schemes", () => {
    for (const bad of [
      "https://admin.example.com/x",
      "https://admin.example.com/?a=1",
      "https://u:p@admin.example.com",
      "ftp://admin.example.com",
      "http://admin.example.com",
      "not a url",
    ]) {
      expect(adminOrigin(bad, false), bad).toBeNull();
    }
  });
});

describe("requestOrigin", () => {
  it("prefers the forwarded host and protocol", () => {
    expect(requestOrigin(hostile)).toBe("https://evil.example");
    expect(requestOrigin(new Headers({ host: "127.0.0.1:3100" }))).toBe("http://127.0.0.1:3100");
  });
});
