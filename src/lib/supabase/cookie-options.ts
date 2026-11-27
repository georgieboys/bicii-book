import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * The session cookie's name over HTTPS (D275). Not the library's
 * `sb-<project>-auth-token`: the session cookies before D275 were
 * unpartitioned SameSite=Lax cookies under that name, and a browser keeps a
 * partitioned and an unpartitioned cookie of the same name side by side and
 * sends both, so the server and the browser client could each read a
 * different one. A new name leaves the old cookies unread;
 * `legacySessionCookies` lets proxy.ts expire them.
 */
export const SESSION_COOKIE_NAME = "bicii-auth-token";

/**
 * Session cookie options over HTTPS (audit 2026-10-18; D275): Secure, so
 * the session never travels over plain http; SameSite=None, so the cookie
 * is sent inside the Shopify admin's iframe (Apps → BICII Admin), where the
 * Admin is a cross-site frame and a Lax cookie is withheld; Partitioned
 * (CHIPS), so it still works where third-party cookies are blocked. A
 * partitioned cookie is keyed by the top-level site, so a session signed in
 * inside Shopify is separate from one at the Admin's own address: staff sign
 * in once in each. CSRF does not rest on SameSite: Server Actions check
 * Origin against Host, and no cookie-authenticated GET changes anything
 * (R-136).
 */
export const HTTPS_SESSION_COOKIE_OPTIONS = {
  name: SESSION_COOKIE_NAME,
  secure: true,
  sameSite: "none",
  partitioned: true,
} as const satisfies CookieOptionsWithName;

/**
 * Session cookie options for the server Supabase clients: the HTTPS options
 * on Vercel, which serves only HTTPS. Locally and in CI (http://localhost)
 * the library's defaults stay, or no session could be kept there (a Secure
 * or SameSite=None cookie is refused over http).
 */
export function sessionCookieOptions(
  vercel = process.env.VERCEL,
): typeof HTTPS_SESSION_COOKIE_OPTIONS | undefined {
  return vercel === "1" ? HTTPS_SESSION_COOKIE_OPTIONS : undefined;
}

/** The library's default session cookie names, chunks and the PKCE verifier included. */
const LEGACY_SESSION_COOKIE = /^sb-[a-z0-9]+-auth-token(?:-code-verifier)?(?:\.\d+)?$/;

/**
 * The session cookies under the library's default name that a request
 * still carries on Vercel (written before D275), for proxy.ts to expire;
 * none elsewhere, where the default name is the live one.
 */
export function legacySessionCookies(names: string[], vercel = process.env.VERCEL): string[] {
  return vercel === "1" ? names.filter((name) => LEGACY_SESSION_COOKIE.test(name)) : [];
}

/** The library's default session name for a project (supabase-js `defaultStorageKey`). */
export function legacySessionName(supabaseUrl: string): string | null {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

type Cookie = { name: string; value: string };

/**
 * A session from before D275 carried over to BICII's own name, so nobody is
 * signed out by the rename: on Vercel, when the request has no cookie under
 * the new name, each chunk of the project's old session cookie
 * (`<legacy>` or `<legacy>.<n>`) under the same suffix of the new name. The
 * value does not depend on the name. None when there is nothing to carry.
 */
export function carriedSessionCookies(
  cookies: Cookie[],
  legacyName: string | null,
  vercel = process.env.VERCEL,
): Cookie[] {
  if (vercel !== "1" || !legacyName) return [];
  const isChunkOf = (name: string, key: string) =>
    name === key || (name.startsWith(`${key}.`) && /^\d+$/.test(name.slice(key.length + 1)));
  if (cookies.some((c) => isChunkOf(c.name, SESSION_COOKIE_NAME))) return [];
  return cookies
    .filter((c) => c.value !== "" && isChunkOf(c.name, legacyName))
    .map((c) => ({ name: SESSION_COOKIE_NAME + c.name.slice(legacyName.length), value: c.value }));
}

/**
 * How proxy.ts writes a carried-over cookie: the HTTPS options with the
 * library's defaults for the rest (path, readable by the browser client,
 * 400 days).
 */
export const CARRIED_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60,
  secure: HTTPS_SESSION_COOKIE_OPTIONS.secure,
  sameSite: HTTPS_SESSION_COOKIE_OPTIONS.sameSite,
  partitioned: HTTPS_SESSION_COOKIE_OPTIONS.partitioned,
} as const;
