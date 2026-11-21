// @vitest-environment node
/**
 * The Content-Security-Policy next.config.ts sends on every page, as
 * Report-Only until it is enforced (docs/OPERATIONS.md "Content Security
 * Policy"). Run through Next's own custom-route matcher; the config is
 * re-imported per case because the policy is built when it loads.
 */
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://admin.example.com";
const SUPABASE = "https://abcdefghijkl.supabase.co";

async function policyFor(path: string, supabaseUrl?: string) {
  vi.resetModules();
  if (supabaseUrl === undefined) vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  else vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  const nextConfig = (await import("../../next.config")).default;
  const response = await unstable_getResponseFromNextConfig({
    url: `${ORIGIN}${path}`,
    nextConfig,
  });
  return response.headers;
}

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name);
  return found ? found.slice(1) : [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Content-Security-Policy (report-only)", () => {
  it.each(["/", "/jobs/x", "/pay/abc", "/quote/abc", "/login"])(
    "%s carries the report-only policy and no enforcing one",
    async (path) => {
      const headers = await policyFor(path, SUPABASE);
      const policy = headers.get("content-security-policy-report-only") ?? "";
      expect(policy).not.toBe("");
      expect(headers.get("content-security-policy")).toBeNull();
      expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
      expect(directive(policy, "object-src")).toEqual(["'none'"]);
      expect(directive(policy, "base-uri")).toEqual(["'self'"]);
      expect(directive(policy, "default-src")).toEqual(["'self'"]);
    },
  );

  it("allows the Supabase origin and its websocket, and photo previews", async () => {
    const policy =
      (await policyFor("/", SUPABASE)).get("content-security-policy-report-only") ?? "";
    expect(directive(policy, "connect-src")).toEqual([
      "'self'",
      SUPABASE,
      "wss://abcdefghijkl.supabase.co",
    ]);
    expect(directive(policy, "img-src")).toEqual(["'self'", "blob:", "data:", SUPABASE]);
    expect(directive(policy, "form-action")).toEqual(["'self'", "https://checkout.stripe.com"]);
  });

  it("uses ws: for a local http Supabase", async () => {
    const policy =
      (await policyFor("/", "http://127.0.0.1:54321")).get("content-security-policy-report-only") ??
      "";
    expect(directive(policy, "connect-src")).toEqual([
      "'self'",
      "http://127.0.0.1:54321",
      "ws://127.0.0.1:54321",
    ]);
  });

  it("names no Supabase source when the variable is missing or malformed", async () => {
    for (const value of [undefined, "not a url"]) {
      const policy = (await policyFor("/", value)).get("content-security-policy-report-only") ?? "";
      expect(directive(policy, "connect-src")).toEqual(["'self'"]);
      expect(directive(policy, "img-src")).toEqual(["'self'", "blob:", "data:"]);
    }
  });

  it("leaves the service worker's own enforcing policy alone", async () => {
    const headers = await policyFor("/sw.js", SUPABASE);
    expect(headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self'");
  });
});
