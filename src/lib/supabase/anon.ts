import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getPublicEnv } from "@/lib/env";

/**
 * A server client with the anon key and no session: for the customer's
 * quote page (D143), which must act as anon whoever opens it, a signed-in
 * staff member included. It reaches only what anon is granted
 * (`quote_by_token`, `answer_quote`).
 */
export function createAnonClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getPublicEnv();
  return createClient<Database>(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
