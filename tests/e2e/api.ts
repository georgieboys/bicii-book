/**
 * Direct API calls for E2E setup and for acting as a customer (the public
 * site's frontend is Phase 11): email-code sign-in through the devstack's
 * Auth (PLAN D10; nobody has a password), PostgREST RPCs and RLS reads
 * through the gateway, exactly as tests/e2e/global-setup.mts reaches them
 * (it hands the gateway URL and the keys from scripts/devstack/config.mjs to
 * the workers as E2E_GATEWAY_URL, E2E_ANON_KEY and E2E_SERVICE_ROLE_KEY:
 * specs load as CommonJS and cannot import that ES module). Everything
 * after sign-in runs as the signed-in user, so RLS and the RPCs' own checks
 * apply; the service-role key only generates the code.
 */
import { createServerClient } from "@supabase/ssr";

import { noteCodeIssued } from "./helpers";

function env(name: "E2E_GATEWAY_URL" | "E2E_ANON_KEY" | "E2E_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: tests/e2e/global-setup.mts sets it; run \`npm run test:e2e\`.`,
    );
  }
  return value;
}

const GATEWAY_URL = () => env("E2E_GATEWAY_URL");
const ANON_KEY = () => env("E2E_ANON_KEY");

const SERVICE_ROLE_KEY = () => env("E2E_SERVICE_ROLE_KEY");

/**
 * A one-time code for an existing login, made without sending email (as
 * tests/db/stack.ts otpClient does): the service-role admin API generates
 * it (generate_link, type magiclink, which emails nothing).
 */
async function generateCode(email: string): Promise<string> {
  const link = await fetch(`${GATEWAY_URL()}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY(),
      authorization: `Bearer ${SERVICE_ROLE_KEY()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!link.ok) throw new Error(`a code for ${email} failed: ${link.status} ${await link.text()}`);
  // Auth counts a generated code toward the address's sending interval.
  noteCodeIssued(email);
  const { email_otp } = (await link.json()) as { email_otp: string };
  return email_otp;
}

/**
 * An access token for a seeded or test login, signed in with an email code
 * without sending email: generateCode, then Auth verifies it (POST /verify,
 * type email), exactly as a person typing the code would. The login must
 * already exist. The UI path (code read from the mail catcher) is
 * helpers.ts signIn().
 */
export async function signInApi(email: string): Promise<string> {
  const token = await generateCode(email);
  const res = await fetch(`${GATEWAY_URL()}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), "content-type": "application/json" },
    body: JSON.stringify({ type: "email", email, token }),
  });
  if (!res.ok) throw new Error(`sign-in as ${email} failed: ${res.status} ${await res.text()}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/**
 * The Admin's session cookies for a login the login form would refuse (a
 * customer: the form signs anyone who is not active staff out straight
 * after the code, D70). The code is verified through @supabase/ssr's own
 * server client on the app's Supabase URL, so the cookies are named and
 * encoded exactly as the app's (src/lib/supabase/server.ts) are; add them
 * to a browser context to reach the app's own staff checks with a real
 * non-staff session.
 */
export async function sessionCookiesFor(email: string): Promise<{ name: string; value: string }[]> {
  const token = await generateCode(email);
  const jar = new Map<string, string>();
  const supabase = createServerClient(GATEWAY_URL(), ANON_KEY(), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await supabase.auth.verifyOtp({ type: "email", email, token });
  if (error) throw new Error(`sign-in as ${email} failed: ${error.message}`);
  // The client writes the session cookies from its auth-state listener.
  for (let i = 0; i < 50 && jar.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
  if (jar.size === 0) throw new Error(`sign-in as ${email} wrote no session cookie`);
  return [...jar].map(([name, value]) => ({ name, value }));
}

function headers(token: string): Record<string, string> {
  return {
    apikey: ANON_KEY(),
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

/** Calls public.<name>(args) as the token's user; throws with PostgREST's error on failure. */
export async function rpc<T = unknown>(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${GATEWAY_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} failed: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** GET /rest/v1/<pathAndQuery> as the token's user (RLS reads), e.g. "appointments?select=id&id=eq.…". */
export async function select<T = unknown>(token: string, pathAndQuery: string): Promise<T[]> {
  const res = await fetch(`${GATEWAY_URL()}/rest/v1/${pathAndQuery}`, { headers: headers(token) });
  const text = await res.text();
  if (!res.ok) throw new Error(`select ${pathAndQuery} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T[];
}

/**
 * POST /rest/v1/<table> as the token's user (an RLS insert, as the Admin's
 * customer and bike forms make it), e.g. insert(token, "customers", {...}).
 * Throws with PostgREST's error on failure; returns nothing.
 */
export async function insert(
  token: string,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${GATEWAY_URL()}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(token), prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert into ${table} failed: ${res.status} ${await res.text()}`);
}
