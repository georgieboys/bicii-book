import "server-only";

import { headers } from "next/headers";

import { getServerEnv, type ServerEnv } from "@/lib/env";

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * ADMIN_ORIGIN when it is this Admin's address: an https origin with no
 * path, query or credentials (http only for localhost or 127.0.0.1, and in
 * production never http or a loopback host); else null.
 */
export function adminOrigin(value: string | undefined, production: boolean): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  if (production && (url.protocol !== "https:" || isLoopback(url.hostname))) return null;
  return url.origin;
}

/** The origin this request arrived on (its Host, or the proxy's forwarded host). */
export function requestOrigin(h: Headers): string {
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Pure: the origin a link sent to someone outside the Admin is built on.
 * The validated ADMIN_ORIGIN whenever it is set, so a link never carries a
 * host taken from the request (R-088, R-091); without one (development, or
 * an Admin not yet configured), this request's own origin.
 */
export function linkOriginFrom(
  env: Pick<ServerEnv, "ADMIN_ORIGIN" | "VERCEL_ENV"> | null,
  h: Headers,
): string {
  const configured = env ? adminOrigin(env.ADMIN_ORIGIN, env.VERCEL_ENV === "production") : null;
  return configured ?? requestOrigin(h);
}

/** linkOriginFrom over this deployment's environment and this request. */
export async function linkOrigin(): Promise<string> {
  let env: ServerEnv | null;
  try {
    env = getServerEnv();
  } catch {
    // A server environment that does not parse falls back to the request.
    env = null;
  }
  return linkOriginFrom(env, await headers());
}
