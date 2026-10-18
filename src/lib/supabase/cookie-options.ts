/**
 * Session cookie options for the Supabase clients (audit 2026-10-18):
 * Secure on Vercel, which serves only HTTPS, so the session cookie never
 * travels over plain http. Locally and in CI (http://localhost) the
 * library's defaults stay, or no session could be kept there.
 */
export function sessionCookieOptions(vercel = process.env.VERCEL): { secure: true } | undefined {
  return vercel === "1" ? { secure: true } : undefined;
}
