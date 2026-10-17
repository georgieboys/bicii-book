// @vitest-environment node
/**
 * Which paths proxy.ts runs on (ADR-001 A3): every page, but not the
 * routes that authenticate without a session (the Shopify webhooks by
 * HMAC, the Stripe webhooks by signature, the integration cron by bearer)
 * or static assets. A signed-out GET of the cron must reach the route, not
 * be redirected to /login.
 */
import * as testing from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { config } from "@/proxy";

// The Next 16 docs (proxy.md "Unit testing") name it unstable_doesProxyMatch;
// next 16.3.8 ships it only as unstable_doesMiddlewareMatch. Use whichever
// the installed version exports.
type Matcher = typeof testing.unstable_doesMiddlewareMatch;
const doesProxyMatch: Matcher =
  (testing as unknown as { unstable_doesProxyMatch?: Matcher }).unstable_doesProxyMatch ??
  testing.unstable_doesMiddlewareMatch;

const matches = (url: string) => doesProxyMatch({ config, nextConfig, url });

describe("proxy matcher", () => {
  it.each([
    "/api/cron/integrations",
    "/api/shopify/webhooks",
    "/api/stripe/webhooks",
    "/api/health",
    "/_next/static/chunk.js",
    "/sw.js",
  ])("does not run on %s", (url) => {
    expect(matches(url)).toBe(false);
  });

  it.each([
    "/",
    "/shopify",
    "/products/x",
    "/login",
    "/api/labels/x/pdf",
    "/settings/shopify",
    "/api/stripe",
    // The customer pages run it too: no session is needed there, but the
    // request still gets its correlation id (isPublicPath lets it through).
    "/quote/x",
    "/pay/x",
  ])("runs on %s", (url) => {
    expect(matches(url)).toBe(true);
  });
});
