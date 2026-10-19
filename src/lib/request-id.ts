/**
 * Correlation IDs (ADR-001 A8). proxy.ts, the webhook routes and the cron
 * route mint a fresh UUID for every request. An incoming `x-request-id` is
 * not kept: Vercel sets none, so on the hosted app it could only come from
 * the client, and the value ends up in logs and database rows (audit
 * 2026-10-18).
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The same ID on requests from the server to Supabase. A header name of our
 * own, so no gateway in between rewrites it; PostgREST hands it to SQL in
 * `request.headers` (private.current_correlation_id()).
 */
export const CORRELATION_HEADER = "x-correlation-id";

export function newRequestId(): string {
  return crypto.randomUUID();
}
