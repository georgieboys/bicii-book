import { realpathSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

/**
 * This directory, or the nearest directory above it that also holds the real
 * node_modules: Turbopack resolves nothing outside its root, and a git
 * worktree may share the main checkout's node_modules through a symlink.
 */
function projectRoot(): string {
  let root: string;
  let modules: string;
  try {
    root = realpathSync(__dirname);
    modules = realpathSync(path.join(__dirname, "node_modules"));
  } catch {
    return __dirname;
  }
  while (root !== path.dirname(root) && !modules.startsWith(root + path.sep)) {
    root = path.dirname(root);
  }
  return root;
}

/**
 * The Supabase project's origin and its Realtime websocket, read from
 * NEXT_PUBLIC_SUPABASE_URL when the config loads (build time). Missing or
 * malformed, the policy names no Supabase source.
 */
function supabaseSources(): { origin: string[]; connect: string[] } {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return { origin: [], connect: [] };
  try {
    const url = new URL(raw);
    const ws = url.protocol === "http:" ? "ws:" : "wss:";
    return { origin: [url.origin], connect: [url.origin, `${ws}//${url.host}`] };
  } catch {
    return { origin: [], connect: [] };
  }
}

/**
 * The Content-Security-Policy, sent as Report-Only for now
 * (docs/OPERATIONS.md "Content Security Policy"): browsers log what it would
 * block without blocking it. Next's own inline scripts and styles need
 * 'unsafe-inline' under a static header (a nonce needs a per-request policy
 * in src/proxy.ts); React needs 'unsafe-eval' in development only. Photos
 * are blob:/data: previews and Supabase Storage URLs. Stripe Checkout is a
 * top-level navigation and needs no source, except form-action for a form
 * posted before hydration that the server redirects there.
 */
function contentSecurityPolicy(): string {
  const supabase = supabaseSources();
  const dev = process.env.NODE_ENV === "development";
  const directives: string[][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "blob:", "data:", ...supabase.origin],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...supabase.connect],
    ["media-src", "'self'", "blob:"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["frame-src", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'", "https://checkout.stripe.com"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera is the only powerful feature the Admin uses (the scanner);
  // everything else is refused for the page and anything it embeds.
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=()",
  },
  // Not enforced yet: browsers report what it would block (audit A-25).
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
];

/** A page whose path carries a link token: no referrer, not indexed, never cached. */
const customerPageHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "private, no-store" },
];

const nextConfig: NextConfig = {
  // No X-Powered-By: nothing gains from knowing the framework.
  poweredByHeader: false,
  // Pin the root (next-config-js/turbopack.md, output.md): otherwise Next
  // infers it from the outermost lockfile it finds, which on a workstation
  // can be the home directory, watched and traced as a whole.
  turbopack: { root: projectRoot() },
  outputFileTracingRoot: projectRoot(),
  // Every <Image> already passes `unoptimized`: images are served as they
  // are from Supabase Storage or /public. Saying so here keeps the image
  // optimizer, an unauthenticated endpoint nothing uses, out of the picture.
  images: { unoptimized: true },
  experimental: {
    // forbidden() / unauthorized() and forbidden.tsx / unauthorized.tsx
    // (ADR-001 A3).
    authInterrupts: true,
  },
  // `next dev` blocks dev resources for origins other than localhost; the
  // devstack and Playwright sometimes use 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  async redirects() {
    return [
      {
        // Labels printed on 2026-10-28 before the QR address was set to the
        // public site encode the Admin's old alias, whose /q route is
        // staff-only (R-013). Scanned there, they go to the public site's
        // item page instead of the staff sign-in; the Admin's own address
        // keeps answering /q for staff (D9).
        source: "/q/:shortId",
        has: [{ type: "host", value: "bicii-book.vercel.app" }],
        destination: "https://bicii.sg/q/:shortId",
        permanent: true,
      },
    ];
  },
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
