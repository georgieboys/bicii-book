/**
 * Session cookies are Secure on Vercel only (src/lib/supabase/cookie-options.ts;
 * audit 2026-10-18): locally and in CI the app runs on plain http.
 */
import { describe, expect, it } from "vitest";

import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

describe("sessionCookieOptions", () => {
  it("is Secure on Vercel and the library default elsewhere", () => {
    expect(sessionCookieOptions("1")).toEqual({ secure: true });
    expect(sessionCookieOptions(undefined)).toBeUndefined();
    expect(sessionCookieOptions("")).toBeUndefined();
  });
});
