// Shared configuration for the Docker-free Supabase devstack.
//
// The devstack runs the real Supabase services (Auth, PostgREST, Storage)
// against a plain Postgres 16, plus a tiny gateway that gives them the same
// URL layout as `supabase start` (http://127.0.0.1:54321/{auth,rest,storage}/v1).
// Everything here is local-only; nothing is a secret.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STATE_DIR = path.join(ROOT, ".devstack");
export const CACHE_DIR = process.env.BICII_DEVSTACK_CACHE
  ? path.resolve(process.env.BICII_DEVSTACK_CACHE)
  : path.join(homedir(), ".cache", "bicii-devstack");

export const VERSIONS = {
  postgrest: "12.2.3",
  auth: "2.178.0",
  storage: "1.79.31",
  node: "24.21.0",
  npm: "11",
};

export const PATHS = {
  postgrest: path.join(CACHE_DIR, "bin", "postgrest"),
  authDir: path.join(CACHE_DIR, "auth"),
  auth: path.join(CACHE_DIR, "auth", "auth"),
  authMigrations: path.join(CACHE_DIR, "auth", "migrations"),
  node24Dir: path.join(CACHE_DIR, "node24"),
  node24Bin: path.join(CACHE_DIR, "node24", "node_modules", ".bin"),
  node24: path.join(CACHE_DIR, "node24", "node_modules", ".bin", "node"),
  storageDir: path.join(CACHE_DIR, "storage"),
  storageServer: path.join(CACHE_DIR, "storage", "dist", "start", "server.js"),
  storageMigrate: path.join(CACHE_DIR, "storage", "dist", "scripts", "migrate-call.js"),
  rolesSql: path.join(ROOT, "supabase", "devstack", "roles.sql"),
  migrationsDir: path.join(ROOT, "supabase", "migrations"),
  seedSql: path.join(ROOT, "supabase", "seed.sql"),
  storageData: path.join(STATE_DIR, "storage"),
};

export const PORTS = {
  gateway: Number(process.env.BICII_GATEWAY_PORT ?? 54321),
  auth: Number(process.env.BICII_AUTH_PORT ?? 9999),
  rest: Number(process.env.BICII_REST_PORT ?? 3001),
  storage: Number(process.env.BICII_STORAGE_PORT ?? 5000),
  // The mail catcher (scripts/devstack/mailcatcher.mjs): Supabase Auth sends
  // sign-in codes to its SMTP port; tests and people read them over HTTP.
  smtp: Number(process.env.BICII_SMTP_PORT ?? 2525),
  mailHttp: Number(process.env.BICII_MAIL_HTTP_PORT ?? 8025),
};

export const GATEWAY_URL = `http://127.0.0.1:${PORTS.gateway}`;

/** The mail catcher's HTTP API (GET /messages/latest?to=...). Local only. */
export const MAIL_URL = `http://127.0.0.1:${PORTS.mailHttp}`;
/** Where the mail catcher keeps the messages it received (<id>.json + <id>.eml). */
export const MAIL_DIR = path.join(STATE_DIR, "mail");
/** Supabase Auth's email templates; the catcher serves them to the devstack's Auth. */
export const TEMPLATES_DIR = path.join(ROOT, "supabase", "templates");

/** The well-known Supabase local demo secret. Local only. */
export const JWT_SECRET =
  process.env.BICII_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

/** Password roles.sql gives the Supabase service login roles. Local only. */
export const SERVICE_ROLE_PASSWORD = process.env.BICII_SERVICE_ROLE_PASSWORD ?? "postgres";

// ---------------------------------------------------------------------------
// Database connection. DATABASE_URL wins; otherwise the libpq variables
// (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) override the defaults, so
// CI can point everything at its own Postgres service. Read from the
// process environment only: no .env file is loaded here (on purpose, so a
// .env.local pointing the app somewhere never redirects db:reset).
// ---------------------------------------------------------------------------
export const DEFAULT_DB_NAME = "bicii_dev";

export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const u = new URL("postgres://127.0.0.1:5432/");
  u.hostname = process.env.PGHOST ?? "127.0.0.1";
  u.port = process.env.PGPORT ?? "5432";
  u.username = process.env.PGUSER ?? "postgres";
  u.password = process.env.PGPASSWORD ?? "postgres";
  u.pathname = `/${process.env.PGDATABASE ?? DEFAULT_DB_NAME}`;
  return u.toString();
}

/**
 * The devstack's own database (what db:reset builds and the services use):
 * DATABASE_URL's server with PGDATABASE as the name, else bicii_dev. Lets a
 * second checkout (a git worktree) run its own stack beside the first.
 */
export function devDatabaseUrl() {
  return withDatabase(databaseUrl(), process.env.PGDATABASE ?? DEFAULT_DB_NAME);
}

/**
 * Same server and credentials, different database.
 * @param {string} url
 * @param {string} dbName
 */
export function withDatabase(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Same server and database, different login role (password from roles.sql).
 * @param {string} url
 * @param {string} user
 */
export function withLogin(url, user, password = SERVICE_ROLE_PASSWORD) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  u.search = "";
  return u.toString();
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Refuse to touch a database that is not on this machine. Everything that
 * creates, drops, resets or migrates a database calls this before it
 * connects, because the scripts read only the shell environment and a
 * DATABASE_URL or PG* variable left over from a session against a hosted
 * project would otherwise retarget them. Allowed: loopback hosts and unix
 * sockets; any other host only with BICII_ALLOW_REMOTE_DB=1; a Supabase
 * hosted address never.
 * @param {string} url
 * @param {Record<string, string | undefined>} [env]
 */
export function assertLocalDatabase(url, env = process.env) {
  const u = new URL(url);
  // libpq's ?host= wins over the authority; a path there is a unix socket.
  const host = (u.searchParams.get("host") ?? u.hostname).toLowerCase();
  if (host === "" || host.startsWith("/")) return;
  if (/\.supabase\.(co|com)$/.test(host)) {
    throw new Error(
      `refusing to touch ${redact(url)}: a hosted Supabase database is never a devstack or test target`,
    );
  }
  if (LOCAL_HOSTS.has(host)) return;
  if (env.BICII_ALLOW_REMOTE_DB === "1") return;
  throw new Error(
    `refusing to touch ${redact(url)}: not a local database. ` +
      "Unset DATABASE_URL / PGHOST, or set BICII_ALLOW_REMOTE_DB=1 for a disposable server.",
  );
}

/** @param {string} url */
export function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/**
 * postgres:// URL with the password masked, for logs.
 * @param {string} url
 */
export function redact(url) {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

// ---------------------------------------------------------------------------
// JWT keys (HS256). The payloads match the Supabase CLI demo keys, so with
// the demo secret these are byte-for-byte the well-known local keys.
// ---------------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(payload, secret = JWT_SECRET) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const DEMO_EXPIRY = 1983812996; // 2032-11-12, as in the Supabase CLI demo keys

export const ANON_KEY = signJwt({ iss: "supabase-demo", role: "anon", exp: DEMO_EXPIRY });
export const SERVICE_ROLE_KEY = signJwt({
  iss: "supabase-demo",
  role: "service_role",
  exp: DEMO_EXPIRY,
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function log(message) {
  process.stdout.write(`[devstack] ${message}\n`);
}

export function fail(message) {
  process.stderr.write(`[devstack] ERROR: ${message}\n`);
  process.exit(1);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Which cached components exist (no version checks; setup.mjs does those). */
export function cacheStatus() {
  return {
    postgrest: existsSync(PATHS.postgrest),
    auth: existsSync(PATHS.auth) && existsSync(PATHS.authMigrations),
    node24: existsSync(PATHS.node24),
    storage: existsSync(PATHS.storageServer) && existsSync(PATHS.storageMigrate),
  };
}

export function requireCache(...components) {
  const status = cacheStatus();
  const missing = components.filter((c) => !status[c]);
  if (missing.length > 0) {
    throw new Error(
      `devstack components missing from ${CACHE_DIR}: ${missing.join(", ")}. ` +
        "Run `npm run devstack:setup` first.",
    );
  }
}
