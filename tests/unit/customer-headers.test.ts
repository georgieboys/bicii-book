// @vitest-environment node
/**
 * The response headers next.config.ts gives the customer pages (D143,
 * D156f; R-081, R-091): the token is in the path, so /quote/<token> and
 * /pay/<token>, with or without Stripe's return marker, send no referrer,
 * are not indexed and are never cached. Every other page keeps the
 * catch-all's headers. Run through Next's own custom-route matcher.
 */
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";
const ORIGIN = "https://admin.example.com";

async function headersFor(path: string): Promise<Headers> {
  const response = await unstable_getResponseFromNextConfig({
    url: `${ORIGIN}${path}`,
    nextConfig,
  });
  return response.headers;
}

describe("customer page headers", () => {
  it.each([
    `/pay/${TOKEN}`,
    `/pay/${TOKEN}?balance=returned`,
    `/pay/${TOKEN}?balance=cancelled`,
    `/quote/${TOKEN}`,
    `/quote/${TOKEN}?deposit=returned`,
  ])("%s: no referrer, not indexed, never cached", async (path) => {
    const headers = await headersFor(path);
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(headers.get("cache-control")).toBe("private, no-store");
    // The catch-all still applies.
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  it.each(["/", "/jobs/x", "/payments", "/reports/payments", "/jobs/pay/x"])(
    "%s keeps the catch-all's headers only",
    async (path) => {
      const headers = await headersFor(path);
      expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(headers.get("x-robots-tag")).toBeNull();
      expect(headers.get("cache-control")).toBeNull();
    },
  );
});

describe("every page's hardening headers (audit 2026-10-18)", () => {
  it.each(["/", "/jobs/x", `/pay/${TOKEN}`, `/quote/${TOKEN}`, "/login"])(
    "%s allows the camera to the Admin only and refuses other powerful features",
    async (path) => {
      const policy = (await headersFor(path)).get("permissions-policy") ?? "";
      expect(policy).toContain("camera=(self)");
      for (const feature of ["microphone", "geolocation", "payment", "usb", "display-capture"]) {
        expect(policy, feature).toContain(`${feature}=()`);
      }
    },
  );

  it("does not announce the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
