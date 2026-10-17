import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** A page whose path carries a link token: no referrer, not indexed, never cached. */
const customerPageHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "private, no-store" },
];

const nextConfig: NextConfig = {
  experimental: {
    // forbidden() / unauthorized() and forbidden.tsx / unauthorized.tsx
    // (ADR-001 A3).
    authInterrupts: true,
  },
  // `next dev` blocks dev resources for origins other than localhost; the
  // devstack and Playwright sometimes use 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        // The customer's quote page (D143): the token is in the path, so no
        // referrer leaves it, nothing caches it and search engines skip it.
        // Later rules override the catch-all's Referrer-Policy.
        source: "/quote/:token*",
        headers: customerPageHeaders,
      },
      {
        // The customer's payment link (D156f, R-091): the same, for the
        // same reason, with or without Stripe's ?balance= return marker.
        source: "/pay/:token*",
        headers: customerPageHeaders,
      },
      {
        // Per the PWA guide: never cache the service worker itself, so a new
        // deploy's worker is picked up; it may only load same-origin code.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
