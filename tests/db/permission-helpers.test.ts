/**
 * Permission resolution in the database (DATA-MODEL §1; TESTING.md "Permission
 * resolution"): admin implies every permission; staff have only what was
 * granted; inactive staff have nothing; require_permission raises 42501.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import { asAnon, asStaff, asAuthUser, connect, scalar, staffClaims, withClaims } from "./harness";

let conn: pg.Client;
let ALL_PERMISSIONS: string[];

beforeAll(async () => {
  conn = await connect();
  ALL_PERMISSIONS = await scalar<string[]>(
    conn,
    "select array_agg(p::text order by p) from unnest(enum_range(null::public.permission_key)) p",
  );
});

async function permissionsOf(tx: pg.Client): Promise<string[]> {
  const { rows } = await tx.query<{ permission: string }>(
    `select p::text as permission
       from unnest(enum_range(null::public.permission_key)) p
      where private.has_permission(p)
      order by p`,
  );
  return rows.map((r) => r.permission);
}

/**
 * Setup step: deactivate as the owner with no session (a signed-in user may
 * never deactivate their own row, staff_enforce_rules), then restore the
 * test's claims.
 */
async function deactivate(tx: pg.Client, staffId: string) {
  const claims = await scalar<string | null>(
    tx,
    "select current_setting('request.jwt.claims', true)",
  );
  await tx.query("select set_config('request.jwt.claims', '', true)");
  await tx.query("update public.staff set active = false where id = $1", [staffId]);
  await tx.query("select set_config('request.jwt.claims', $1, true)", [claims ?? ""]);
}

describe("permission_key enum", () => {
  it("is exactly the seven permissions from SPEC §4.2 plus the three adventure ones (D169)", () => {
    expect([...ALL_PERMISSIONS].sort()).toEqual(
      [
        "adjust_stock",
        "facilitate_adventures",
        "manage_adventures",
        "verify_adventures",
        "manage_consignments",
        "manage_inventory",
        "manage_purchasing",
        "manage_staff",
        "view_costs",
        "view_financial_reports",
      ].sort(),
    );
  });
});

describe("private.has_permission / is_staff / is_admin / current_staff_id", () => {
  it("admin implies every permission", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.admin), async (tx) => {
      expect(await permissionsOf(tx)).toEqual(ALL_PERMISSIONS);
      expect(await scalar(tx, "select private.is_admin()")).toBe(true);
      expect(await scalar(tx, "select private.is_staff()")).toBe(true);
      expect(await scalar(tx, "select private.current_staff_id()")).toBe(STAFF.admin);
    });
  });

  it("admin implies permissions even with no staff_permissions rows", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.admin), async (tx) => {
      expect(
        await scalar(tx, "select count(*)::int from public.staff_permissions where staff_id = $1", [
          STAFF.admin,
        ]),
      ).toBe(0);
      expect(await scalar(tx, "select private.has_permission('manage_staff')")).toBe(true);
    });
  });

  it("staff have exactly the permissions granted to them", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.mechanic1), async (tx) => {
      expect(await permissionsOf(tx)).toEqual(["view_costs"]);
      expect(await scalar(tx, "select private.is_admin()")).toBe(false);
      expect(await scalar(tx, "select private.is_staff()")).toBe(true);
    });
    await withClaims(conn, staffClaims(AUTH_USER.mechanic2), async (tx) => {
      expect(await permissionsOf(tx)).toEqual([]);
      expect(await scalar(tx, "select private.is_staff()")).toBe(true);
      expect(await scalar(tx, "select private.current_staff_id()")).toBe(STAFF.mechanic2);
    });
  });

  it("inactive staff are not staff and have no permissions", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.mechanic1), async (tx) => {
      await deactivate(tx, STAFF.mechanic1);
      expect(await scalar(tx, "select private.is_staff()")).toBe(false);
      expect(await scalar(tx, "select private.current_staff_id()")).toBeNull();
      expect(await permissionsOf(tx)).toEqual([]);
    });
  });

  it("an inactive admin has no permissions", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.admin), async (tx) => {
      // Keep another active admin so the last-admin guard allows this.
      await tx.query("update public.staff set role = 'admin' where id = $1", [STAFF.mechanic2]);
      await deactivate(tx, STAFF.admin);
      expect(await scalar(tx, "select private.is_admin()")).toBe(false);
      expect(await scalar(tx, "select private.is_staff()")).toBe(false);
      expect(await permissionsOf(tx)).toEqual([]);
    });
  });

  it("no session and non-staff users have nothing", async () => {
    await withClaims(conn, null, async (tx) => {
      expect(await scalar(tx, "select private.is_staff()")).toBe(false);
      expect(await permissionsOf(tx)).toEqual([]);
    });
    const customer = "c0000000-0000-4000-8000-00000000ffff";
    await withClaims(conn, staffClaims(customer), async (tx) => {
      expect(await scalar(tx, "select private.is_staff()")).toBe(false);
      expect(await scalar(tx, "select private.current_staff_id()")).toBeNull();
      expect(await permissionsOf(tx)).toEqual([]);
    });
  });
});

describe("private.require_permission / require_staff", () => {
  it("returns the caller's staff id when the permission is held", async () => {
    await withClaims(conn, staffClaims(AUTH_USER.mechanic1), async (tx) => {
      expect(await scalar(tx, "select private.require_permission('view_costs')")).toBe(
        STAFF.mechanic1,
      );
    });
    await withClaims(conn, staffClaims(AUTH_USER.admin), async (tx) => {
      expect(await scalar(tx, "select private.require_permission('adjust_stock')")).toBe(
        STAFF.admin,
      );
    });
  });

  it("raises insufficient_privilege (42501) when it is not", async () => {
    await expect(
      withClaims(conn, staffClaims(AUTH_USER.mechanic2), (tx) =>
        tx.query("select private.require_permission('view_costs')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withClaims(conn, staffClaims(AUTH_USER.mechanic1), (tx) =>
        tx.query("select private.require_permission('adjust_stock')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("raises 42501 for inactive staff and for no session", async () => {
    await expect(
      withClaims(conn, staffClaims(AUTH_USER.mechanic1), async (tx) => {
        await deactivate(tx, STAFF.mechanic1);
        return tx.query("select private.require_permission('view_costs')");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withClaims(conn, null, (tx) => tx.query("select private.require_staff()")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("public.my_staff_profile()", () => {
  type Profile = { id: string; role: string; active: boolean; permissions: string[] };
  const profile = (tx: pg.Client) =>
    tx
      .query<Profile>("select id, role, active, permissions::text[] from public.my_staff_profile()")
      .then((r) => r.rows);

  it("admin: every permission", async () => {
    const rows = await asStaff(conn, STAFF.admin, profile);
    expect(rows).toEqual([
      { id: STAFF.admin, role: "admin", active: true, permissions: ALL_PERMISSIONS },
    ]);
  });

  it("staff: granted permissions only", async () => {
    expect(await asStaff(conn, STAFF.mechanic1, profile)).toEqual([
      { id: STAFF.mechanic1, role: "mechanic", active: true, permissions: ["view_costs"] },
    ]);
    expect(await asStaff(conn, STAFF.mechanic2, profile)).toEqual([
      { id: STAFF.mechanic2, role: "mechanic", active: true, permissions: [] },
    ]);
  });

  it("inactive: own row flagged inactive, no permissions", async () => {
    const rows = await asStaff(conn, STAFF.mechanic1, async (tx) => {
      await tx.query("reset role");
      await deactivate(tx, STAFF.mechanic1);
      await tx.query("set local role authenticated");
      return profile(tx);
    });
    expect(rows).toEqual([
      { id: STAFF.mechanic1, role: "mechanic", active: false, permissions: [] },
    ]);
  });

  it("non-staff user: no rows; anon: not executable", async () => {
    expect(await asAuthUser(conn, "c0000000-0000-4000-8000-00000000ffff", profile)).toEqual([]);
    await expect(asAnon(conn, profile)).rejects.toMatchObject({ code: "42501" });
  });
});
