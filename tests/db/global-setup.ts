/**
 * DB project global setup: builds ONE template database per run, exactly as
 * `npm run db:reset` builds the dev database (roles.sql -> Supabase Auth
 * migrations -> Supabase Storage migrations -> supabase/migrations -> seed).
 * Every test file then gets its own clone of it (tests/db/setup.ts), so files
 * are independent and concurrency tests can open several real connections.
 *
 * Server: DATABASE_URL (any database on it; only host/port/credentials are
 * used), else PGHOST/PGPORT/PGUSER/PGPASSWORD, else postgres:postgres@127.0.0.1:5432.
 * The user must be able to create databases and roles (a superuser).
 *
 * Existing database mode: set BICII_TEST_DATABASE_URL to an already migrated
 * and seeded database (for example the one `supabase start` gives you) and no
 * template or clones are made; tests run against it directly, each inside a
 * transaction that is rolled back unless the test asks to commit.
 *
 * The server and BICII_TEST_DATABASE_URL must both be local (loopback or a
 * unix socket; another host only with BICII_ALLOW_REMOTE_DB=1, a hosted
 * Supabase address never): the run stops before it connects otherwise.
 */
import type { TestProject } from "vitest/node";

import {
  assertLocalDatabase,
  databaseUrl,
  redact,
  withDatabase,
} from "../../scripts/devstack/config.mjs";
import { buildDatabase, dropDatabase } from "../../scripts/devstack/database.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    /** postgres:// URL of the server, pointing at its `postgres` database. */
    dbServerUrl: string;
    /** Template database name, or "" in existing-database mode. */
    dbTemplate: string;
    /** BICII_TEST_DATABASE_URL when set, else "". */
    dbExistingUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const existing = process.env.BICII_TEST_DATABASE_URL ?? "";
  const server = withDatabase(databaseUrl(), "postgres");
  // Clones, templates and committed test writes land on these: never a
  // hosted project (scripts/devstack/config.mjs assertLocalDatabase).
  assertLocalDatabase(server);
  if (existing) assertLocalDatabase(existing);
  project.provide("dbServerUrl", server);
  project.provide("dbExistingUrl", existing);

  if (existing) {
    project.provide("dbTemplate", "");
    console.info(`[db tests] using existing database ${redact(existing)}`);
    return;
  }

  const template = `bicii_test_template_${process.pid}`;
  const templateUrl = withDatabase(server, template);
  const started = Date.now();
  try {
    await buildDatabase(templateUrl);
  } catch (err) {
    await dropDatabase(templateUrl).catch(() => {});
    throw new Error(
      `[db tests] could not build the template database on ${redact(server)}.\n` +
        "Is Postgres running (pg_ctlcluster 16 main start) and has `npm run devstack:setup` been run?\n" +
        String(err instanceof Error ? err.message : err),
      { cause: err },
    );
  }
  console.info(
    `[db tests] template ${template} built in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  project.provide("dbTemplate", template);

  return async () => {
    await dropDatabase(templateUrl);
  };
}
