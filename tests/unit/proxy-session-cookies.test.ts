// @vitest-environment node
/**
 * proxy.ts and the D275 cookie rename: on Vercel a session found only under
 * the library's default name is carried to `bicii-auth-token` (so nobody is
 * signed out by the rename) and the old cookies are expired; off Vercel
 * nothing changes. The Supabase client is stubbed: only the cookies the
 * proxy reads and writes are under test.
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  options: undefined as unknown,
  signedIn: true,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookieOptions?: unknown; cookies: { getAll(): { name: string; value: string }[] } },
  ) => {
    seen.options = options.cookieOptions;
    seen.cookies = options.cookies.getAll();
    return {
      auth: {
        getClaims: async () => ({ data: seen.signedIn ? { claims: { sub: "staff-1" } } : null }),
      },
    };
  },
}));

vi.mock("@/lib/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijkl.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  }),
}));

const { proxy } = await import("@/proxy");

function requestWith(cookie: string, path = "/jobs"): NextRequest {
  return new NextRequest(`https://admin.example.com${path}`, { headers: { cookie } });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

afterEach(() => {
  vi.unstubAllEnvs();
  seen.signedIn = true;
});

describe("proxy: the D275 session cookie rename", () => {
  it("on Vercel carries an old session to the new name and expires the old cookies", async () => {
    vi.stubEnv("VERCEL", "1");
    const response = await proxy(
      requestWith(
        "sb-abcdefghijkl-auth-token.0=part0; sb-abcdefghijkl-auth-token.1=part1; theme=dark",
      ),
    );
    // The Supabase client read the carried session under the new name.
    expect(seen.cookies).toEqual(
      expect.arrayContaining([
        { name: "bicii-auth-token.0", value: "part0" },
        { name: "bicii-auth-token.1", value: "part1" },
      ]),
    );
    expect(seen.options).toMatchObject({ name: "bicii-auth-token", sameSite: "none" });
    const cookies = setCookies(response);
    const carried = cookies.find((c) => c.startsWith("bicii-auth-token.0=part0"));
    expect(carried).toBeDefined();
    expect(carried).toMatch(/Secure/i);
    expect(carried).toMatch(/SameSite=none/i);
    expect(carried).toMatch(/Partitioned/i);
    expect(carried).toMatch(/Path=\//);
    expect(carried).not.toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith("bicii-auth-token.1=part1"))).toBeDefined();
    for (const old of ["sb-abcdefghijkl-auth-token.0", "sb-abcdefghijkl-auth-token.1"]) {
      const expired = cookies.find((c) => c.startsWith(`${old}=`));
      expect(expired, old).toMatch(/Max-Age=0/i);
      expect(expired, old).not.toMatch(/Partitioned/i);
    }
    expect(cookies.some((c) => c.startsWith("theme="))).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("on Vercel leaves a session under the new name alone and only expires the old", async () => {
    vi.stubEnv("VERCEL", "1");
    const response = await proxy(
      requestWith("bicii-auth-token=fresh; sb-abcdefghijkl-auth-token=stale"),
    );
    expect(seen.cookies).toEqual(
      expect.arrayContaining([{ name: "bicii-auth-token", value: "fresh" }]),
    );
    const cookies = setCookies(response);
    expect(cookies.some((c) => c.startsWith("bicii-auth-token="))).toBe(false);
    expect(cookies.find((c) => c.startsWith("sb-abcdefghijkl-auth-token="))).toMatch(/Max-Age=0/i);
  });

  it("on Vercel expires the old cookies on the redirect to sign in too", async () => {
    vi.stubEnv("VERCEL", "1");
    seen.signedIn = false;
    const response = await proxy(requestWith("sb-abcdefghijkl-auth-token-code-verifier=v"));
    expect(response.status).toBe(307);
    expect(
      setCookies(response).find((c) => c.startsWith("sb-abcdefghijkl-auth-token-code-verifier=")),
    ).toMatch(/Max-Age=0/i);
  });

  it("off Vercel keeps the library's default name and touches no cookie", async () => {
    vi.stubEnv("VERCEL", "");
    const response = await proxy(requestWith("sb-abcdefghijkl-auth-token=local"));
    expect(seen.options).toBeUndefined();
    expect(seen.cookies).toEqual([{ name: "sb-abcdefghijkl-auth-token", value: "local" }]);
    expect(setCookies(response)).toEqual([]);
  });
});
