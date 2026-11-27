/**
 * Session cookies (src/lib/supabase/cookie-options.ts; audit 2026-10-18,
 * D275): on Vercel they are Secure, SameSite=None and Partitioned, under
 * BICII's own name, so they are sent inside the Shopify admin's iframe;
 * locally and in CI the app runs on plain http and keeps the library's
 * defaults.
 */
import { describe, expect, it } from "vitest";

import {
  CARRIED_COOKIE_OPTIONS,
  carriedSessionCookies,
  HTTPS_SESSION_COOKIE_OPTIONS,
  legacySessionCookies,
  legacySessionName,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/supabase/cookie-options";

describe("sessionCookieOptions", () => {
  it("on Vercel: Secure, SameSite=None, Partitioned, BICII's own name", () => {
    expect(sessionCookieOptions("1")).toEqual({
      name: "bicii-auth-token",
      secure: true,
      sameSite: "none",
      partitioned: true,
    });
    expect(sessionCookieOptions("1")).toBe(HTTPS_SESSION_COOKIE_OPTIONS);
  });

  it("is the library default elsewhere", () => {
    expect(sessionCookieOptions(undefined)).toBeUndefined();
    expect(sessionCookieOptions("")).toBeUndefined();
    expect(sessionCookieOptions("0")).toBeUndefined();
  });

  it("keeps httpOnly, path and maxAge at the library's defaults", () => {
    // The browser client reads the session from document.cookie.
    expect(HTTPS_SESSION_COOKIE_OPTIONS).not.toHaveProperty("httpOnly");
    expect(HTTPS_SESSION_COOKIE_OPTIONS).not.toHaveProperty("path");
    expect(HTTPS_SESSION_COOKIE_OPTIONS).not.toHaveProperty("maxAge");
    expect(HTTPS_SESSION_COOKIE_OPTIONS).not.toHaveProperty("domain");
  });
});

describe("legacySessionCookies", () => {
  const names = [
    "sb-abcdefghijkl-auth-token",
    "sb-abcdefghijkl-auth-token.0",
    "sb-abcdefghijkl-auth-token.1",
    "sb-abcdefghijkl-auth-token-code-verifier",
    SESSION_COOKIE_NAME,
    `${SESSION_COOKIE_NAME}.0`,
    "sb-abcdefghijkl-other",
    "theme",
  ];

  it("on Vercel picks only the library's default session cookies", () => {
    expect(legacySessionCookies(names, "1")).toEqual([
      "sb-abcdefghijkl-auth-token",
      "sb-abcdefghijkl-auth-token.0",
      "sb-abcdefghijkl-auth-token.1",
      "sb-abcdefghijkl-auth-token-code-verifier",
    ]);
  });

  it("never picks BICII's own session cookie", () => {
    expect(legacySessionCookies([SESSION_COOKIE_NAME, `${SESSION_COOKIE_NAME}.3`], "1")).toEqual(
      [],
    );
  });

  it("picks nothing off Vercel, where the default name is the live session", () => {
    expect(legacySessionCookies(names, undefined)).toEqual([]);
    expect(legacySessionCookies(names, "")).toEqual([]);
  });
});

describe("legacySessionName", () => {
  it("is supabase-js's default storage key for the project", () => {
    expect(legacySessionName("https://abcdefghijkl.supabase.co")).toBe(
      "sb-abcdefghijkl-auth-token",
    );
    expect(legacySessionName("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
    expect(legacySessionName("not a url")).toBeNull();
  });
});

describe("carriedSessionCookies", () => {
  const legacy = "sb-abcdefghijkl-auth-token";

  it("on Vercel carries each chunk of the old session to the same suffix of the new name", () => {
    expect(
      carriedSessionCookies(
        [
          { name: `${legacy}.0`, value: "a" },
          { name: `${legacy}.1`, value: "b" },
          { name: `${legacy}-code-verifier`, value: "v" },
          { name: "sb-otherproject-auth-token", value: "x" },
          { name: "theme", value: "dark" },
        ],
        legacy,
        "1",
      ),
    ).toEqual([
      { name: "bicii-auth-token.0", value: "a" },
      { name: "bicii-auth-token.1", value: "b" },
    ]);
    expect(carriedSessionCookies([{ name: legacy, value: "whole" }], legacy, "1")).toEqual([
      { name: "bicii-auth-token", value: "whole" },
    ]);
  });

  it("carries nothing when the request already has a session under the new name", () => {
    for (const name of [SESSION_COOKIE_NAME, `${SESSION_COOKIE_NAME}.0`]) {
      expect(
        carriedSessionCookies(
          [
            { name, value: "new" },
            { name: legacy, value: "old" },
          ],
          legacy,
          "1",
        ),
      ).toEqual([]);
    }
  });

  it("carries nothing off Vercel, without a project, or for an empty value", () => {
    const cookies = [{ name: legacy, value: "old" }];
    expect(carriedSessionCookies(cookies, legacy, undefined)).toEqual([]);
    expect(carriedSessionCookies(cookies, null, "1")).toEqual([]);
    expect(carriedSessionCookies([{ name: legacy, value: "" }], legacy, "1")).toEqual([]);
    // A name that only starts like a chunk is not one.
    expect(carriedSessionCookies([{ name: `${legacy}.x`, value: "y" }], legacy, "1")).toEqual([]);
  });

  it("writes carried cookies like the library would, with the HTTPS attributes", () => {
    expect(CARRIED_COOKIE_OPTIONS).toEqual({
      path: "/",
      httpOnly: false,
      maxAge: 400 * 24 * 60 * 60,
      secure: true,
      sameSite: "none",
      partitioned: true,
    });
  });
});
