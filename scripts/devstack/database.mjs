// Building a database the way Supabase has it, on plain Postgres:
//   roles.sql -> Supabase Auth migrations -> Supabase Storage migrations
//   -> supabase/migrations/*.sql -> supabase/seed.sql
// Used by `npm run db:reset` / `db:migrate` and by the DB test harness
// (tests/db/global-setup.ts builds its template database with buildDatabase).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  GATEWAY_URL,
  JWT_SECRET,
  PATHS,
  assertLocalDatabase,
  databaseName,
  requireCache,
  withDatabase,
  withLogin,
} from "./config.mjs";

const MIGRATION_FILE_RE = /^(\d{14})_(.+)\.sql$/;

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Drop (terminating connections) and create `url`'s database.
 * @param {string} url
 * @param {{ template?: string }} [options]
 */
export async function recreateDatabase(url, { template } = {}) {
  assertLocalDatabase(url);
  const name = databaseName(url);
  await withClient(withDatabase(url, "postgres"), async (c) => {
    await c.query(`drop database if exists ${quoteIdent(name)} with (force)`);
    await c.query(
      `create database ${quoteIdent(name)}${template ? ` template ${quoteIdent(template)}` : ""}`,
    );
  });
}

/** @param {string} url */
export async function dropDatabase(url) {
  assertLocalDatabase(url);
  const name = databaseName(url);
  await withClient(withDatabase(url, "postgres"), (c) =>
    c.query(`drop database if exists ${quoteIdent(name)} with (force)`),
  );
}

/** @param {string} url */
export async function databaseExists(url) {
  const name = databaseName(url);
  return withClient(withDatabase(url, "postgres"), async (c) => {
    const r = await c.query("select 1 from pg_database where datname = $1", [name]);
    return r.rowCount > 0;
  });
}

export async function applyRoles(url) {
  assertLocalDatabase(url);
  const sql = readFileSync(PATHS.rolesSql, "utf8");
  await withClient(url, async (c) => {
    // Role DDL notices ("already a member") are expected on re-runs.
    c.on("notice", () => {});
    await c.query(sql);
  });
}

function run(command, args, { env, cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${label} failed (exit ${code}):\n${output.slice(-4000)}`));
    });
  });
}

/** Environment Supabase Auth needs (also used by start.mjs). */
export function authEnv(url) {
  const authUrl = new URL(withLogin(url, "supabase_auth_admin"));
  authUrl.searchParams.set("sslmode", "disable");
  return {
    GOTRUE_DB_DRIVER: "postgres",
    DATABASE_URL: authUrl.toString(),
    GOTRUE_DB_NAMESPACE: "auth",
    GOTRUE_DB_MIGRATIONS_PATH: PATHS.authMigrations,
    GOTRUE_JWT_SECRET: JWT_SECRET,
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
  };
}

export async function runAuthMigrations(url) {
  requireCache("auth");
  await run(PATHS.auth, ["migrate"], {
    cwd: PATHS.authDir,
    env: {
      ...authEnv(url),
      API_EXTERNAL_URL: `${GATEWAY_URL}/auth/v1`,
      GOTRUE_SITE_URL: "http://localhost:3000",
    },
    label: "Supabase Auth migrations",
  });
}

/** Environment Supabase Storage needs (also used by start.mjs). */
export function storageEnv(url) {
  return {
    DATABASE_URL: withLogin(url, "supabase_storage_admin"),
    DB_INSTALL_ROLES: "false",
    AUTH_JWT_SECRET: JWT_SECRET,
    PGRST_JWT_SECRET: JWT_SECRET,
    STORAGE_BACKEND: "file",
    STORAGE_FILE_BACKEND_PATH: PATHS.storageData,
    TENANT_ID: "stub",
    REGION: "stub",
    STORAGE_S3_BUCKET: "stub",
    IMAGE_TRANSFORMATION_ENABLED: "false",
  };
}

/**
 * Storage ships its own migration runner (dist/scripts/migrate-call.js, the
 * `migration:run` script upstream). It reads DATABASE_URL and exits non-zero
 * on failure.
 */
export async function runStorageMigrations(url) {
  requireCache("node24", "storage");
  await run(PATHS.node24, [PATHS.storageMigrate], {
    cwd: PATHS.storageDir,
    env: { ...storageEnv(url), NODE_ENV: "production" },
    label: "Supabase Storage migrations",
  });
  const count = await withClient(url, async (c) => {
    const r = await c.query("select count(*)::int as n from storage.migrations");
    return r.rows[0].n;
  });
  if (count === 0) throw new Error("Supabase Storage migrations recorded nothing");
}

// ---------------------------------------------------------------------------
// App migrations, recorded like the Supabase CLI records them.
// ---------------------------------------------------------------------------

/**
 * Split a SQL script into statements, respecting quotes, dollar quoting and
 * comments, so each migration's statements can be stored the way the
 * Supabase CLI stores them (supabase_migrations.schema_migrations.statements).
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end + 1;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      current += sql.slice(i, j);
      i = j;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
      } else {
        current += ch;
        i++;
      }
    } else if (ch === ";") {
      current += ch;
      if (current.trim() !== ";") statements.push(current.trim());
      current = "";
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  if (stripComments(current).trim() !== "") statements.push(current.trim());
  return statements.filter((s) => stripComments(s).replace(/;$/, "").trim() !== "");
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function listMigrations(dir = PATHS.migrationsDir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const m = MIGRATION_FILE_RE.exec(file);
      if (!m)
        throw new Error(`Migration file name must be <14-digit timestamp>_<name>.sql: ${file}`);
      return { version: m[1], name: m[2], file: path.join(dir, file) };
    });
}

async function ensureMigrationTable(c) {
  // Same shape as the Supabase CLI's history table.
  await c.query(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
    alter table supabase_migrations.schema_migrations add column if not exists statements text[];
    alter table supabase_migrations.schema_migrations add column if not exists name text;
    create table if not exists supabase_migrations.seed_files (path text not null primary key, hash text not null);
  `);
}

function describeError(err, statement) {
  const where = err.position ? ` at character ${err.position}` : "";
  const code = err.code ? ` [SQLSTATE ${err.code}]` : "";
  return `${err.message}${code}${where}\n--- statement ---\n${statement.slice(0, 2000)}`;
}

/**
 * Apply pending migrations in filename order, each in its own transaction;
 * stops at the first error. Returns the versions applied.
 */
export async function applyMigrations(url, { onApply } = {}) {
  const migrations = listMigrations();
  return withClient(url, async (c) => {
    c.on("notice", () => {});
    await ensureMigrationTable(c);
    const applied = new Set(
      (await c.query("select version from supabase_migrations.schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const done = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      const statements = splitStatements(readFileSync(m.file, "utf8"));
      await c.query("begin");
      try {
        for (const s of statements) {
          try {
            await c.query(s);
          } catch (err) {
            throw new Error(`${path.basename(m.file)}: ${describeError(err, s)}`, { cause: err });
          }
        }
        await c.query(
          "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
          [m.version, m.name, statements],
        );
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        throw err;
      }
      done.push(m.version);
      onApply?.(m);
    }
    return done;
  });
}

export async function applySeed(url, file = PATHS.seedSql) {
  const sql = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  await withClient(url, async (c) => {
    c.on("notice", () => {});
    await ensureMigrationTable(c);
    await c.query("begin");
    try {
      for (const s of splitStatements(sql)) {
        try {
          await c.query(s);
        } catch (err) {
          throw new Error(`seed.sql: ${describeError(err, s)}`, { cause: err });
        }
      }
      await c.query(
        `insert into supabase_migrations.seed_files (path, hash) values ('supabase/seed.sql', $1)
         on conflict (path) do update set hash = excluded.hash`,
        [hash],
      );
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      throw err;
    }
  });
}

/**
 * Full rebuild: drop/create, platform layer, app migrations, seed.
 * @param {string} url
 * @param {{ seed?: boolean, onStep?: (step: string) => void }} [options]
 */
export async function buildDatabase(url, { seed = true, onStep = () => {} } = {}) {
  assertLocalDatabase(url);
  requireCache("auth", "node24", "storage");
  onStep(`create database ${databaseName(url)}`);
  await recreateDatabase(url);
  onStep("bootstrap roles and platform schemas (supabase/devstack/roles.sql)");
  await applyRoles(url);
  onStep("Supabase Auth migrations");
  await runAuthMigrations(url);
  onStep("Supabase Storage migrations");
  await runStorageMigrations(url);
  onStep("app migrations (supabase/migrations)");
  await applyMigrations(url, { onApply: (m) => onStep(`  applied ${m.version}_${m.name}`) });
  if (seed) {
    onStep("seed (supabase/seed.sql)");
    await applySeed(url);
  }
}
