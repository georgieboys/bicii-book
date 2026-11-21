#!/usr/bin/env node
// Database commands for the devstack.
//
//   node scripts/devstack/db.mjs reset           npm run db:reset
//   node scripts/devstack/db.mjs migrate         npm run db:migrate
//   node scripts/devstack/db.mjs types [--fresh] npm run db:types
//
// Connection: DATABASE_URL, else PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE,
// else postgres://postgres:postgres@127.0.0.1:5432/bicii_dev. The user must
// be a superuser (it creates databases and the Supabase platform roles).

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import {
  MAIL_URL,
  ROOT,
  assertLocalDatabase,
  databaseUrl,
  fail,
  log,
  redact,
  withDatabase,
} from "./config.mjs";
import { applyMigrations, buildDatabase, dropDatabase } from "./database.mjs";

const SUPABASE_CLI = "supabase@2.119.0";
const TYPES_FILE = path.join(ROOT, "src", "lib", "database.types.ts");

/**
 * A running PostgREST reconnects to a recreated database as soon as it
 * exists, which can be before the migrations ran, and then serves an empty
 * schema cache. NOTIFY makes it reload (it LISTENs on "pgrst"); harmless
 * when PostgREST is not running.
 */
async function reloadPostgrest(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("notify pgrst, 'reload schema'");
  } finally {
    await client.end();
  }
}

async function reset() {
  const url = databaseUrl();
  assertLocalDatabase(url);
  log(`resetting ${redact(url)}`);
  const started = Date.now();
  await buildDatabase(url, { onStep: (s) => log(s) });
  await reloadPostgrest(url);
  log(`database ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log(
    `seeded logins (sign in with an emailed code; read codes at ${MAIL_URL}): ` +
      "admin@, manager@, mechanic1@, mechanic2@bicii.test",
  );
}

async function migrate() {
  const url = databaseUrl();
  assertLocalDatabase(url);
  log(`migrating ${redact(url)}`);
  const applied = await applyMigrations(url, {
    onApply: (m) => log(`applied ${m.version}_${m.name}`),
  });
  if (applied.length > 0) await reloadPostgrest(url);
  log(applied.length === 0 ? "already up to date" : `${applied.length} migration(s) applied`);
}

/**
 * The Supabase CLI insists on TLS unless the URL says otherwise, and a local
 * or CI Postgres (the postgres:16 image) usually has SSL off. Loopback hosts
 * get sslmode=disable (the CLI treats "prefer" as "require"); PGSSLMODE or
 * an explicit ?sslmode= wins.
 */
function cliDatabaseUrl(url) {
  const u = new URL(url);
  if (!u.searchParams.has("sslmode")) {
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    const mode = process.env.PGSSLMODE ?? (loopback ? "disable" : undefined);
    if (mode) u.searchParams.set("sslmode", mode);
  }
  return u.toString();
}

/**
 * Generates src/lib/database.types.ts with the Supabase CLI's own generator.
 * `supabase gen types typescript --db-url` runs without Docker. With
 * --fresh, generates from a throwaway database built from the migrations
 * (what CI diffs against) instead of the dev database.
 */
async function types(args) {
  const fresh = args.includes("--fresh");
  let url = databaseUrl();
  if (fresh) {
    url = withDatabase(url, `bicii_typegen_${process.pid}`);
    log(`building throwaway database ${redact(url)}`);
    await buildDatabase(url, { seed: false, onStep: () => {} });
  }
  try {
    log(`generating types from ${redact(url)}`);
    const result = spawnSync(
      "npx",
      [
        "-y",
        SUPABASE_CLI,
        "gen",
        "types",
        "typescript",
        "--db-url",
        cliDatabaseUrl(url),
        "--schema",
        "public,reporting",
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0 || !result.stdout.includes("export type Database")) {
      throw new Error(`supabase gen types failed:\n${result.stderr}\n${result.stdout}`);
    }
    writeFileSync(TYPES_FILE, result.stdout);
    execFileSync(path.join(ROOT, "node_modules", ".bin", "prettier"), ["--write", TYPES_FILE], {
      cwd: ROOT,
      stdio: "ignore",
    });
    log(`wrote ${path.relative(ROOT, TYPES_FILE)}`);
  } finally {
    if (fresh) await dropDatabase(url);
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = { reset, migrate, types };
if (!commands[command]) fail(`usage: db.mjs <${Object.keys(commands).join("|")}> [--fresh]`);
commands[command](args).catch((err) => fail(err.message));
