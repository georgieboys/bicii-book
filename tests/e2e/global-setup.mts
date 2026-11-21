/**
 * E2E global setup: make sure the devstack serves a freshly seeded
 * bicii_dev before any test runs.
 *
 *   1. Reset bicii_dev (roles -> Auth -> Storage -> migrations -> seed)
 *      unless E2E_RESET=0.
 *   2. Start the devstack services if they are not running (idempotent).
 *   3. Wait until a seeded login works end to end through the gateway:
 *      staff sign in with email codes (PLAN D10), so the service-role
 *      admin API generates the admin's code (generateLink, no email) and
 *      Auth verifies it (verifyOtp), then PostgREST answers
 *      my_staff_profile with the session's JWT. The mail catcher must
 *      answer too (GET <MAIL_URL>/health): the tests read sign-in codes
 *      from it.
 *   4. Hand the gateway URL and keys to the workers (E2E_GATEWAY_URL,
 *      E2E_ANON_KEY, E2E_SERVICE_ROLE_KEY) for tests/e2e/api.ts:
 *      Playwright loads specs as CommonJS, which cannot import
 *      scripts/devstack/config.mjs.
 *   5. Read the seed's anchor day once (the shop day `db:reset` ran, from
 *      REPORT_JOB.todayReceived's check-in) into E2E_SEED_ANCHOR, which the
 *      Playwright workers inherit (helpers.ts seedAnchor(), anchorDay()).
 *
 * Needs Postgres 16 and the devstack cache (`npm run devstack:setup`, once).
 * E2E_EXTERNAL_STACK=1 skips steps 1 and 2 for a stack this script does not
 * manage (`supabase start`, already reset and seeded); steps 3 to 5 still
 * run (same DATABASE_URL), and the mail check runs only when BICII_MAIL_KIND
 * says which mail API to read (mailpit: Mailpit's on :54324,
 * scripts/devstack/mail-client.mjs). With E2E_RESET=0 or an external stack the anchor
 * may be an earlier day than today: tests count days from it.
 */
import { execFileSync } from "node:child_process";

import pg from "pg";

import {
  ANON_KEY,
  GATEWAY_URL,
  ROOT,
  SERVICE_ROLE_KEY,
  assertLocalDatabase,
  databaseName,
  devDatabaseUrl,
} from "../../scripts/devstack/config.mjs";
import { mailKind, mailUrl } from "../../scripts/devstack/mail-client.mjs";
import { REPORT_JOB, STAFF_EMAIL } from "../fixtures/ids";

function run(script: string, args: string[], env: Record<string, string>) {
  execFileSync(process.execPath, [`scripts/devstack/${script}`, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

/** The mail API answers (the catcher's /health, or Mailpit's /api/v1/info). */
async function mailWorks(): Promise<boolean> {
  if (process.env.E2E_EXTERNAL_STACK === "1" && !process.env.BICII_MAIL_KIND) return true;
  const probe = mailKind() === "mailpit" ? "/api/v1/info" : "/health";
  try {
    const res = await fetch(`${mailUrl()}${probe}`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function stackWorks(): Promise<boolean> {
  try {
    if (!(await mailWorks())) return false;
    // The admin's code, without email (as tests/db/stack.ts otpClient does).
    const link = await fetch(`${GATEWAY_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", email: STAFF_EMAIL.admin }),
    });
    if (!link.ok) return false;
    const { email_otp } = (await link.json()) as { email_otp: string };
    const token = await fetch(`${GATEWAY_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ type: "email", email: STAFF_EMAIL.admin, token: email_otp }),
    });
    if (!token.ok) return false;
    const { access_token } = (await token.json()) as { access_token: string };
    const profile = await fetch(`${GATEWAY_URL}/rest/v1/rpc/my_staff_profile`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!profile.ok) return false;
    const rows = (await profile.json()) as Array<{ role: string }>;
    return rows[0]?.role === "admin";
  } catch {
    return false;
  }
}

/** The seed's anchor day ('YYYY-MM-DD'), read the way tests/db seedToday() reads it. */
async function readSeedAnchor(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ d: string }>(
      `select (checked_in_at at time zone 'Asia/Singapore')::date::text as d
         from public.work_orders where id = $1`,
      [REPORT_JOB.todayReceived],
    );
    if (rows.length === 0) {
      throw new Error(
        "[e2e] the seed's anchor job (REPORT_JOB.todayReceived) is missing: reset the database (`npm run db:reset`).",
      );
    }
    return rows[0].d;
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  const env = { DATABASE_URL: devDatabaseUrl() };
  // The reset below drops and rebuilds this database: never a hosted one.
  assertLocalDatabase(env.DATABASE_URL);

  if (process.env.E2E_EXTERNAL_STACK === "1") {
    // `supabase start` (Docker) or another stack on the same URL and demo
    // keys: the caller resets and seeds it (`supabase db reset`).
    console.info(`[e2e] using the external stack at ${GATEWAY_URL} as it is`);
  } else {
    if (process.env.E2E_RESET !== "0") {
      console.info(`[e2e] resetting ${databaseName(env.DATABASE_URL)} (set E2E_RESET=0 to skip)`);
      run("db.mjs", ["reset"], env);
    }
    run("start.mjs", [], env);
  }

  // After a reset the services reconnect and PostgREST reloads its schema
  // cache; give them a moment.
  const deadline = Date.now() + 60_000;
  while (!(await stackWorks())) {
    if (Date.now() > deadline) {
      throw new Error(
        `[e2e] the devstack at ${GATEWAY_URL} did not accept the seeded admin's sign-in code, ` +
          `or its mail catcher at ${mailUrl()} did not answer. ` +
          "Check `npm run devstack:status` and the logs in .devstack/logs.",
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.info("[e2e] devstack ready");

  process.env.E2E_GATEWAY_URL = GATEWAY_URL;
  process.env.E2E_ANON_KEY = ANON_KEY;
  process.env.E2E_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  process.env.E2E_SEED_ANCHOR = await readSeedAnchor(env.DATABASE_URL);
  console.info(`[e2e] seed anchor (day 0): ${process.env.E2E_SEED_ANCHOR}`);
}
