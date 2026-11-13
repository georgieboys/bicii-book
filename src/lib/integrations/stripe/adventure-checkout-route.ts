import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { PARTICIPATIONS } from "@/lib/adventures";
import type { Database } from "@/lib/database.types";
import { customerSiteUrl, getPublicEnv } from "@/lib/env";
import { newRequestId } from "@/lib/request-id";

import { startAdventureCheckout, type AdventureCheckoutResult } from "./adventure-checkout";
import { defaultStripeDeps, type StripeDeps } from "./deps";

/**
 * POST /api/adventures/checkout (handoff §10.2): called server to server by
 * the public site's Server Action with the signed-in rider's access token
 * (`Authorization: Bearer …`). Not a staff route (proxy.ts skips it) and
 * not unauthenticated: the token is verified with Supabase Auth
 * (auth.getUser), never trusted by decoding it, and every database call is
 * made as that rider. A submitted customer id would be ignored: there is
 * none in the body. Limited to 20 starts per rider per 5 minutes.
 */

const MAX_BODY_BYTES = 4096;
const LIMIT = 20;
const WINDOW_SECONDS = 300;

export const checkoutBodySchema = z.object({
  requestId: z.guid(),
  adventureSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60),
  kind: z.enum(PARTICIPATIONS as [string, ...string[]]),
  revisionNumber: z.number().int().min(1).max(100_000),
  tshirtSize: z.string().trim().min(1).max(10),
  finisherName: z.enum(["first_name_initial", "full_name", "hidden"]),
  termsVersion: z.string().trim().min(1).max(40),
});

export type CheckoutRouteDeps = {
  stripe: (correlationId: string) => StripeDeps;
  /** Verifies the token with Supabase Auth: the user id, or null. */
  verify: (token: string) => Promise<string | null>;
  /** A client that acts as the rider (their token on every request). */
  riderClient: (token: string) => SupabaseClient<Database>;
  siteUrl: () => string | null;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function defaultDeps(): CheckoutRouteDeps {
  const env = getPublicEnv();
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  return {
    stripe: defaultStripeDeps,
    verify: async (token) => {
      const client = createClient<Database>(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        options,
      );
      const { data, error } = await client.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    riderClient: (token) =>
      createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        ...options,
        global: { headers: { Authorization: `Bearer ${token}` } },
      }),
    siteUrl: () => customerSiteUrl(env) || null,
  };
}

export async function handleAdventureCheckout(
  request: Request,
  deps: CheckoutRouteDeps = defaultDeps(),
): Promise<Response> {
  const correlationId = request.headers.get("x-request-id") ?? newRequestId();
  const stripe = deps.stripe(correlationId);
  const log = stripe.log.child({ route: "adventures.checkout" });

  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(auth)?.[1];
  if (!token) return json(401, { error: "sign_in_required" });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid" });
  }
  const parsed = checkoutBodySchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const userId = await deps.verify(token);
  if (!userId) return json(401, { error: "sign_in_required" });

  // Rate limit per rider (the shared attempt counter, service role).
  if (stripe.supabase) {
    const { data, error } = await stripe.supabase.rpc("note_sign_in_attempt", {
      buckets: [`adventure-checkout:user:${userId}`],
      window_seconds: WINDOW_SECONDS,
    });
    if (!error && data?.some((row) => row.hit_count > LIMIT)) {
      return json(429, { error: "too_many", message: "Too many attempts. Wait a few minutes." });
    }
  }

  const siteUrl = deps.siteUrl();
  if (!siteUrl) {
    log.error({}, "the public site's URL is not set");
    return json(503, { error: "unavailable", message: "Payments are not available right now." });
  }

  const result: AdventureCheckoutResult = await startAdventureCheckout(
    stripe,
    deps.riderClient(token),
    { ...parsed.data, kind: parsed.data.kind as never },
    siteUrl,
  );
  log.info({ outcome: result.ok ? "redirect" : result.reason }, "adventure checkout");
  if (!result.ok) return json(result.status, { error: result.reason, message: result.message });
  return json(200, { url: result.url, bookingId: result.bookingId, reference: result.reference });
}
