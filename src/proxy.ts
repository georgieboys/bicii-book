import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { loginUrlFor } from "@/lib/auth/redirect";
import { isPublicPath } from "@/lib/auth/routes";
import type { Database } from "@/lib/database.types";
import { getPublicEnv } from "@/lib/env";
import { newRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";
import {
  CARRIED_COOKIE_OPTIONS,
  carriedSessionCookies,
  legacySessionCookies,
  legacySessionName,
  sessionCookieOptions,
} from "@/lib/supabase/cookie-options";

/**
 * Runs before every matched request (ADR-001 A3, A8):
 *
 * 1. Tags the request with a correlation ID (`x-request-id`) for the server
 *    code downstream (getCorrelationId) and echoes it on the response.
 * 2. Refreshes the Supabase session cookie (the @supabase/ssr pattern):
 *    refreshed tokens are written to the upstream request, so this render
 *    sees them, and to the response, so the browser keeps them.
 * 3. Sends signed-out requests for staff routes to /login?next=…
 * 4. On Vercel, carries a session from the library's default cookie name
 *    to BICII's own and expires the old cookies (D275,
 *    src/lib/supabase/cookie-options.ts).
 *
 * It is an optimisation, never the guard: every page and Server Action
 * calls requireStaff(), and the database checks again (RLS, RPC guards).
 */
export async function proxy(request: NextRequest) {
  const requestId = newRequestId();

  const upstreamHeaders = () => {
    const h = new Headers(request.headers);
    h.set(REQUEST_ID_HEADER, requestId);
    return h;
  };

  const env = getPublicEnv();

  // D275: on Vercel the session moved from the library's default cookie
  // name to BICII's own (src/lib/supabase/cookie-options.ts). The old
  // cookies are expired on the way out; a session found only under the old
  // name is carried to the new one first, so nobody is signed out by it.
  const legacy = legacySessionCookies(request.cookies.getAll().map((c) => c.name));
  const carried = carriedSessionCookies(
    request.cookies.getAll(),
    legacySessionName(env.NEXT_PUBLIC_SUPABASE_URL),
  );
  for (const { name, value } of carried) request.cookies.set(name, value);
  const finish = (res: NextResponse) => {
    for (const name of legacy) {
      // Unpartitioned and SameSite=Lax, as they were written.
      res.cookies.set(name, "", { path: "/", maxAge: 0, secure: true, sameSite: "lax" });
    }
    for (const { name, value } of carried) {
      // Unless the session refresh below already rewrote or cleared it.
      if (!res.cookies.has(name)) res.cookies.set(name, value, CARRIED_COOKIE_OPTIONS);
    }
    if (legacy.length > 0 || carried.length > 0) {
      res.headers.set("cache-control", "private, no-store");
    }
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  };

  let response = NextResponse.next({ request: { headers: upstreamHeaders() } });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: sessionCookieOptions(),
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
    redirect.headers.set("cache-control", "private, no-store");
    return finish(redirect);
  }

  return finish(response);
}

export const config = {
  matcher: [
    // Everything except static assets, the PWA files, health checks,
    // Shopify webhooks (authenticated by HMAC, not by session), Stripe
    // webhooks (authenticated by signature) and the integration cron (a
    // bearer secret; a signed-out GET must reach the route, not be
    // redirected to /login), and the adventure checkout (a customer's
    // bearer token, checked by the route; never a staff session).
    "/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|manifest\\.webmanifest|icons/|apple-touch-icon|logo\\.svg|api/health|api/shopify/webhooks|api/stripe/webhooks|api/cron|api/adventures).*)",
  ],
};
