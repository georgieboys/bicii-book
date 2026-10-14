/**
 * Catalogue-wide invariants. These query the system catalogs, so they cover
 * every future migration automatically: a new table without RLS, a function
 * left executable by PUBLIC, an object anon or authenticated can reach that
 * the API surface fixture does not list, or a float or NaN-capable money
 * column fails here.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ANON_FUNCTIONS,
  ANON_PRIVATE_FUNCTIONS,
  ANON_RELATIONS,
  AUTHENTICATED_FUNCTIONS,
  AUTHENTICATED_RELATIONS,
  DEFINER_VIEWS,
  SERVICE_ROLE_FUNCTIONS,
} from "../fixtures/api-surface";
import { connect } from "./harness";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
  // Function signatures below print type names relative to this path.
  await conn.query("set search_path to public");
});

const APP_SCHEMAS = ["public", "private", "reporting"];

// Column names that hold (or will hold) money or money rates.
const MONEY_NAME =
  "(price|cost|amount|total|subtotal|yield|share|owed|paid|outstanding|balance|fee|charge|tax|discount|refund|payout|value|rate|money)";

describe("RLS", () => {
  it("is enabled on every table in public", async () => {
    const { rows } = await conn.query<{ table: string; rls: boolean }>(
      `select c.relname as table, c.relrowsecurity as rls
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by 1`,
    );
    expect(rows.map((r) => r.table)).toContain("staff");
    expect(rows.filter((r) => !r.rls).map((r) => r.table)).toEqual([]);
  });

  it("API roles have no privileges on any table in private", async () => {
    const { rows } = await conn.query(
      `select table_schema, table_name, privilege_type, grantee
         from information_schema.role_table_grants
        where table_schema in ('private')
          and grantee in ('PUBLIC', 'anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });
});

/** Schemas an API role can reach at all: exposed (`public`) and the view schema. */
const API_SCHEMAS = ["public", "reporting"];
const API_ROLES = ["anon", "authenticated"] as const;

async function reachableFunctions(role: string): Promise<string[]> {
  const { rows } = await conn.query<{ fn: string }>(
    `select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($2)
        and not exists (
          select 1 from pg_depend d
           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
        )
        and has_function_privilege($1, p.oid, 'EXECUTE')
      order by 1`,
    [role, API_SCHEMAS],
  );
  return rows.map((r) => r.fn);
}

/** Every privilege `role` holds on every relation (table, view, sequence...) in the API schemas. */
async function reachableRelations(role: string): Promise<Record<string, string[]>> {
  const { rows } = await conn.query<{ rel: string; privileges: string[] }>(
    `select n.nspname || '.' || c.relname as rel,
            array(
              select p from unnest(
                case when c.relkind = 'S'
                  then array['USAGE', 'SELECT', 'UPDATE']
                  else array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                end) p
               where case
                 when c.relkind = 'S' then has_sequence_privilege($1, c.oid, p)
                 when p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                   then has_any_column_privilege($1, c.oid, p)
                 else has_table_privilege($1, c.oid, p)
               end
               order by p
            ) as privileges
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($2) and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      order by 1`,
    [role, API_SCHEMAS],
  );
  return Object.fromEntries(
    rows.filter((r) => r.privileges.length > 0).map((r) => [r.rel, r.privileges]),
  );
}

const sorted = (record: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(
    Object.entries(record)
      .map(([k, v]) => [k, [...v].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

describe("API surface (tests/fixtures/api-surface.ts)", () => {
  // The devstack recreates hosted Supabase's default grants on `public`
  // (supabase/devstack/roles.sql), so anything a migration forgot to revoke
  // shows up here exactly as it would be exposed in production.
  it("anon can execute exactly the allow-listed functions", async () => {
    expect(await reachableFunctions("anon")).toEqual([...ANON_FUNCTIONS].sort());
  });

  it("authenticated can execute exactly the allow-listed functions", async () => {
    expect(await reachableFunctions("authenticated")).toEqual([...AUTHENTICATED_FUNCTIONS].sort());
  });

  // The service role gets exactly the sign-in counter (PLAN D72), the
  // Phase 10 Shopify webhook and queue RPCs and the Phase 14 Stripe RPCs,
  // and nothing in private (the purges and the exceptions helper are
  // owner-only).
  it("service_role can execute exactly the allow-listed functions in public", async () => {
    expect(await reachableFunctions("service_role")).toEqual([...SERVICE_ROLE_FUNCTIONS].sort());
    const { rows } = await conn.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')
        order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  // Phase 14 adds no private function an API role may execute: the
  // payment views run as the caller on tables and RLS only (payment_issues
  // reads each refund's own status_changed_at, not the admins-only
  // stripe_events), and the apply paths run inside the service-role RPCs.
  it("no API role can execute private.integration_exceptions, the purges or Phase 14's private functions", async () => {
    const { rows: phase14 } = await conn.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and (p.proname ~ '^(apply_stripe_|stripe_|payment|payments_|settle_payment|lock_stripe_)'
               or p.proname in ('quotes_deposit_snapshot', 'purge_stripe_events'))
        order by 1`,
    );
    expect(phase14.length).toBeGreaterThanOrEqual(15);
    for (const fn of [
      "private.integration_exceptions()",
      "private.purge_integration_events(interval)",
      "private.purge_stripe_events(interval)",
      ...phase14.map((r) => r.fn),
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const { rows } = await conn.query<{ ok: boolean }>(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok",
          [role, fn],
        );
        expect({ fn, role, ok: rows[0].ok }).toEqual({ fn, role, ok: false });
      }
    }
  });

  it("anon holds exactly the allow-listed privileges on tables, views and sequences", async () => {
    expect(await reachableRelations("anon")).toEqual(sorted(ANON_RELATIONS));
  });

  it("authenticated holds exactly the allow-listed privileges on tables, views and sequences", async () => {
    expect(await reachableRelations("authenticated")).toEqual(sorted(AUTHENTICATED_RELATIONS));
  });

  it("every view an API role can read runs as the caller (security_invoker) or is allow-listed", async () => {
    const { rows } = await conn.query<{ view: string }>(
      `select n.nspname || '.' || c.relname as view
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('v', 'm')
          and exists (
            select 1 from unnest($2::text[]) r(role)
             where has_any_column_privilege(r.role, c.oid, 'SELECT')
          )
          and not coalesce('security_invoker=true' = any(c.reloptions), false)
          and not coalesce('security_invoker=on' = any(c.reloptions), false)
        order by 1`,
      [API_SCHEMAS, API_ROLES],
    );
    expect(rows.map((r) => r.view)).toEqual([...DEFINER_VIEWS].sort());
  });
});

describe("functions", () => {
  it("no function in public or private is executable by PUBLIC", async () => {
    const { rows } = await conn.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and not exists (
            select 1 from pg_depend d
             where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
          )
          and (
            p.proacl is null  -- null ACL = default privileges = EXECUTE for PUBLIC
            or exists (
              select 1 from aclexplode(p.proacl) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
            )
          )
        order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  // A view's functions run as the caller, so reporting.public_items needs
  // anon to hold EXECUTE on private.selling_price (the single price
  // source). Nothing else in private, and anon has no USAGE on the schema
  // (see "schemas" below), so the view is anon's only way to it.
  it("anon can execute exactly the allow-listed functions in private (only through public_items)", async () => {
    const { rows } = await conn.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
        order by 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([...ANON_PRIVATE_FUNCTIONS].sort());
  });

  it("every security definer function pins search_path", async () => {
    const { rows } = await conn.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1)
          and p.prosecdef
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
          )`,
      [APP_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });
});

describe("money", () => {
  it("no money-like column is real or double precision", async () => {
    const { rows } = await conn.query<{ col: string; type: string }>(
      `select table_schema || '.' || table_name || '.' || column_name as col, data_type as type
         from information_schema.columns
        where table_schema = any($1)
          and column_name ~* $2
          and data_type in ('real', 'double precision')`,
      [APP_SCHEMAS, MONEY_NAME],
    );
    expect(rows).toEqual([]);
  });

  // Phase 5: report RPCs return money in result columns, which
  // information_schema.columns does not cover.
  it("no money-like function result (OUT/TABLE argument) is real or double precision", async () => {
    const { rows } = await conn.query<{ fn: string; arg: string; type: string }>(
      `select p.oid::regprocedure::text as fn, a.name as arg, format_type(a.type, null) as type
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral unnest(p.proallargtypes, p.proargmodes, p.proargnames)
           as a(type, mode, name)
        where n.nspname in ('public', 'private')
          and p.proallargtypes is not null
          and a.mode in ('o', 't', 'b')
          and a.name ~* $1
          and a.type in ('real'::regtype, 'double precision'::regtype)
        order by 1, 2`,
      [MONEY_NAME],
    );
    expect(rows).toEqual([]);
    // The check sees the Phase 5 report results it is meant for.
    const seen = await conn.query<{ n: number }>(
      `select count(*)::int as n
         from pg_proc p cross join lateral unnest(p.proallargtypes, p.proargmodes, p.proargnames) as a(type, mode, name)
        where p.oid = 'public.daily_summary(date, date)'::regprocedure and a.mode = 't' and a.name ~* $1`,
      [MONEY_NAME],
    );
    expect(seen.rows[0].n).toBeGreaterThan(0);
  });

  it("reporting holds views only (SPEC §19.2: derived, never a second truth)", async () => {
    const { rows } = await conn.query(
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'reporting' and c.relkind not in ('v')
        order by 1`,
    );
    expect(rows).toEqual([]);
  });

  it("money_amount is numeric(12,2) and rate_fraction numeric(5,4)", async () => {
    const { rows } = await conn.query(
      `select domain_name, data_type, numeric_precision, numeric_scale
         from information_schema.domains
        where domain_schema = 'public' and domain_name in ('money_amount', 'rate_fraction')
        order by domain_name`,
    );
    expect(rows).toEqual([
      {
        domain_name: "money_amount",
        data_type: "numeric",
        numeric_precision: 12,
        numeric_scale: 2,
      },
      {
        domain_name: "rate_fraction",
        data_type: "numeric",
        numeric_precision: 5,
        numeric_scale: 4,
      },
    ]);
  });

  it("money and rate domains reject NaN (23514) and still accept NULL", async () => {
    for (const domain of ["public.money_amount", "public.rate_fraction"]) {
      await expect(conn.query(`select 'NaN'::${domain}`)).rejects.toMatchObject({
        code: "23514",
      });
      const { rows } = await conn.query(`select null::${domain} as v, '0.3'::${domain} as ok`);
      expect(rows[0].v).toBeNull();
      expect(Number(rows[0].ok)).toBe(0.3);
    }
  });

  it("every numeric column of a table uses a domain, and every numeric domain rejects NaN", async () => {
    // A bare numeric column would accept 'NaN', which poisons sums and
    // passes range checks (NaN sorts above every number).
    const bare = await conn.query<{ col: string }>(
      `select c.table_schema || '.' || c.table_name || '.' || c.column_name as col
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = any($1)
          and t.table_type = 'BASE TABLE'
          and c.data_type = 'numeric'
          and c.domain_name is null
        order by 1`,
      [APP_SCHEMAS],
    );
    expect(bare.rows.map((r) => r.col)).toEqual([]);

    const unchecked = await conn.query<{ domain: string }>(
      `select n.nspname || '.' || t.typname as domain
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'd'
          and t.typbasetype = 'numeric'::regtype
          and n.nspname = any($1)
          and not exists (
            select 1 from pg_constraint k
             where k.contypid = t.oid and k.contype = 'c'
               and pg_get_constraintdef(k.oid) ilike '%NaN%'
          )
        order by 1`,
      [APP_SCHEMAS],
    );
    expect(unchecked.rows.map((r) => r.domain)).toEqual([]);
  });
});

describe("schemas", () => {
  // anon may use `reporting` (USAGE, never CREATE) because
  // reporting.public_items is the anonymous inventory surface (Phase 4);
  // which reporting views anon can read is pinned by ANON_RELATIONS in the
  // relations allow-list (public_items only). `private` stays closed to
  // anon, and PUBLIC holds nothing on either schema.
  it("anon uses reporting (for public_items only) but never private; PUBLIC holds nothing on either", async () => {
    const { rows } = await conn.query(
      `select n.nspname, has_schema_privilege(r.oid, n.oid, 'USAGE') as usage,
              has_schema_privilege(r.oid, n.oid, 'CREATE') as create
         from pg_namespace n
         cross join pg_roles r
        where n.nspname in ('private', 'reporting') and r.rolname = 'anon'
        order by 1`,
    );
    expect(rows).toEqual([
      { nspname: "private", usage: false, create: false },
      { nspname: "reporting", usage: true, create: false },
    ]);
    const pub = await conn.query(
      `select nspname from pg_namespace n, aclexplode(n.nspacl) a
        where n.nspname in ('private', 'reporting') and a.grantee = 0`,
    );
    expect(pub.rows).toEqual([]);
  });

  it("extensions live in the extensions schema", async () => {
    const { rows } = await conn.query(
      `select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname in ('pgcrypto', 'citext', 'pg_trgm') order by 1`,
    );
    expect(rows).toEqual([
      { extname: "citext", nspname: "extensions" },
      { extname: "pg_trgm", nspname: "extensions" },
      { extname: "pgcrypto", nspname: "extensions" },
    ]);
  });
});
