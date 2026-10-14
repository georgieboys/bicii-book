import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { loginUrlFor } from "@/lib/auth/redirect";
import { isPublicPath } from "@/lib/auth/routes";
import type { Database } from "@/lib/database.types";
import { getPublicEnv } from "@/lib/env";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";

/**
 * Runs before every matched request (ADR-001 A3, A8):
 *
 * 1. Tags the request with a correlation ID (`x-request-id`) for the server
 *    code downstream (getCorrelationId) and echoes it on the response.
 * 2. Refreshes the Supabase session cookie (the @supabase/ssr pattern):
 *    refreshed tokens are written to the upstream request, so this render
 *    sees them, and to the response, so the browser keeps them.
 * 3. Sends signed-out requests for staff routes to /login?next=…
 *
 * It is an optimisation, never the guard: every page and Server Action
 * calls requireStaff(), and the database checks again (RLS, RPC guards).
 */
export async function proxy(request: NextRequest) {
  const requestId = requestIdFrom(request.headers.get(REQUEST_ID_HEADER));

  const upstreamHeaders = () => {
    const h = new Headers(request.headers);
    h.set(REQUEST_ID_HEADER, requestId);
    return h;
  };

  let response = NextResponse.next({ request: { headers: upstreamHeaders() } });

  const env = getPublicEnv();
  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, cacheHeaders) {
          // Upstream request first (updates its Cookie header), then a fresh
          // response carrying that request, then the Set-Cookie headers.
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: upstreamHeaders() } });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          // Cache-Control etc. so a CDN never caches a response with a session.
          for (const [key, value] of Object.entries(cacheHeaders ?? {})) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // Do not put code between createServerClient and getClaims(): this call
  // is what refreshes an expired session.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const { pathname, search } = request.nextUrl;
  // Only page loads are redirected. A signed-out Server Action POST goes
  // through so the action's own requireStaff() answers it properly.
  const isNavigation = request.method === "GET" || request.method === "HEAD";
  if (!signedIn && isNavigation && !isPublicPath(pathname)) {
    const redirect = NextResponse.redirect(
      new URL(loginUrlFor(`${pathname}${search}`), request.url),
    );
    // Keep any cookie changes (e.g. a cleared, unrefreshable session).
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    redirect.headers.set("cache-control", "private, no-store");
    return redirect;
  }

  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, the PWA files, health checks,
    // Shopify webhooks (authenticated by HMAC, not by session), Stripe
    // webhooks (authenticated by signature) and the integration cron (a
    // bearer secret; a signed-out GET must reach the route, not be
    // redirected to /login).
    "/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|manifest\\.webmanifest|icons/|apple-touch-icon|logo\\.svg|api/health|api/shopify/webhooks|api/stripe/webhooks|api/cron).*)",
  ],
};
