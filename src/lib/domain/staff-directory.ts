import "server-only";

import { cache } from "react";

import { unwrap } from "@/lib/db-errors";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * staff_directory(): every staff member who ever worked here, with their
 * display name and whether they are active (mechanics cannot read other
 * staff rows, so names come from this RPC). Memoised with React cache():
 * one request per render however many loaders on the page ask (the job
 * page used to send it three times); createClient() is memoised too, so
 * the client argument is the same object throughout a render. In a Server
 * Action cache() runs it every time. The raw `{ data, error }` result, so
 * a loader that reports a failed read itself (getJobPayments) can.
 */
export const staffDirectory = cache(
  async (supabase: ServerSupabase) => await supabase.rpc("staff_directory"),
);

/** Staff id -> display name, for everyone who ever worked here. */
export async function staffNames(supabase: ServerSupabase): Promise<Map<string, string>> {
  const rows = unwrap(await staffDirectory(supabase)) ?? [];
  return new Map(rows.map((s) => [s.id, s.display_name]));
}
