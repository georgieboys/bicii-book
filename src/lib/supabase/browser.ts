"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";
import { getPublicEnv } from "@/lib/env";

import { HTTPS_SESSION_COOKIE_OPTIONS } from "./cookie-options";
import { progressFetch } from "./upload-progress";

let client: ReturnType<typeof createBrowserClient<Database>> | undefined;

/**
 * Browser client (anon key, cookie session shared with the server). Only
 * for Storage uploads from the camera and realtime subscriptions
 * (ADR-001 A5). Business reads and every write go through Server Actions.
 * Its fetch reports upload progress for signed uploads someone watches
 * (src/lib/supabase/upload-progress.ts); every other request is plain fetch.
 */
export function getBrowserClient() {
  const env = getPublicEnv();
  client ??= createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { fetch: progressFetch },
      // The server's options wherever the page itself is HTTPS: the same
      // name and attributes, or the two would keep different sessions
      // (src/lib/supabase/cookie-options.ts, D275).
      cookieOptions:
        typeof location !== "undefined" && location.protocol === "https:"
          ? HTTPS_SESSION_COOKIE_OPTIONS
          : undefined,
    },
  );
  return client;
}
