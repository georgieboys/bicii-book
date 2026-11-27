// @vitest-environment node
/**
 * The Content-Security-Policy next.config.ts sends on every page: the
 * whole policy as Report-Only until it is enforced (docs/OPERATIONS.md
 * "Content Security Policy"), and frame-ancestors alone enforced (D275):
 * the Admin may be framed by itself and the Shopify admin only, a
 * customer's page by nobody. Run through Next's own custom-route matcher;
 * the config is re-imported per case because the policy is built when it
 * loads.
 */
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://admin.example.com";
const SUPABASE = "https://abcdefghijkl.supabase.co";
const SHOP = "example-shop.myshopify.com";
const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";

async function policyFor(path: string, supabaseUrl?: string, shopDomain: string | null = SHOP) {
  vi.resetModules();
  if (supabaseUrl === undefined) vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  else vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  vi.stubEnv("SHOPIFY_SHOP_DOMAIN", shopDomain ?? "");
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

const SHOPIFY_ANCESTORS = ["'self'", "https://admin.shopify.com", `https://${SHOP}`];

describe("Content-Security-Policy (report-only)", () => {
  it.each(["/", "/jobs/x", `/pay/${TOKEN}`, `/quote/${TOKEN}`, "/login"])(
    "%s carries the report-only policy",
    async (path) => {
      const headers = await policyFor(path, SUPABASE);
      const policy = headers.get("content-security-policy-report-only") ?? "";
      expect(policy).not.toBe("");
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

describe("frame-ancestors, enforced (D275)", () => {
  it.each(["/", "/jobs/x", "/login", "/payments", "/print/labels/x", "/jobs/pay/x"])(
    "%s may be framed by the Admin and the Shopify admin only",
    async (path) => {
      const headers = await policyFor(path, SUPABASE);
      // Enforced, and nothing else is: the rest stays report-only (A-25).
      expect(headers.get("content-security-policy")).toBe(
        `frame-ancestors ${SHOPIFY_ANCESTORS.join(" ")}`,
      );
      expect(headers.get("x-frame-options")).toBeNull();
      const reportOnly = headers.get("content-security-policy-report-only") ?? "";
      expect(directive(reportOnly, "frame-ancestors")).toEqual(SHOPIFY_ANCESTORS);
    },
  );

  it.each([
    `/quote/${TOKEN}`,
    `/quote/${TOKEN}?deposit=returned`,
    `/pay/${TOKEN}`,
    `/pay/${TOKEN}?balance=returned`,
  ])("%s may not be framed by anyone, Shopify included", async (path) => {
    const headers = await policyFor(path, SUPABASE);
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    const reportOnly = headers.get("content-security-policy-report-only") ?? "";
    expect(directive(reportOnly, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(reportOnly, "object-src")).toEqual(["'none'"]);
  });

  it("names only admin.shopify.com when the shop domain is missing or malformed", async () => {
    for (const value of [
      null,
      "bicii.sg",
      "https://example-shop.myshopify.com",
      "*.myshopify.com",
      "Example-Shop.myshopify.com",
    ]) {
      const headers = await policyFor("/", SUPABASE, value);
      expect(headers.get("content-security-policy"), String(value)).toBe(
        "frame-ancestors 'self' https://admin.shopify.com",
      );
    }
  });

  it("never names a wildcard", async () => {
    const headers = await policyFor("/", SUPABASE);
    expect(headers.get("content-security-policy")).not.toContain("*");
  });
});
