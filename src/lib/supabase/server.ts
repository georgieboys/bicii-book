import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import type { Database } from "@/lib/database.types";
import { getPublicEnv } from "@/lib/env";
import { CORRELATION_HEADER, REQUEST_ID_HEADER } from "@/lib/request-id";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

/**
 * The Supabase client for Server Components, Server Actions and Route
 * Handlers (ADR-001 A5): anon key + the signed-in user's session from the
 * request cookies, so RLS applies to every read. Deduplicated while a Server
 * Component tree renders (React cache()); a Server Action gets a new client
 * per call, so staffAction creates one and passes it down.
 *
 * Every request carries the correlation ID proxy.ts assigned (ADR-001 A8)
 * as `x-correlation-id`, which PostgREST exposes to SQL; RPCs store it on
 * the event rows they write (private.current_correlation_id()).
 *
 * Server Components cannot write cookies; a refreshed session is written
 * back by proxy.ts (which runs first) or by the next Server Action, so the
 * failed write there is safe to ignore.
 */
export const createClient = cache(async () => {
  const env = getPublicEnv();
  const cookieStore = await cookies();
  const correlationId = (await headers()).get(REQUEST_ID_HEADER);
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: correlationId ? { headers: { [CORRELATION_HEADER]: correlationId } } : undefined,
      cookieOptions: sessionCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component: cookies are read-only there.
          }
        },
      },
    },
  );
});
