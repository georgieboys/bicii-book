/**
 * Staff management RPCs used by Staff settings (DATA-MODEL §1, §15, §16):
 *
 *   create_staff(auth_user_id, display_name, email, role)  A or P(manage_staff); only A creates A
 *   staff_roster()                                         A or P(manage_staff)
 *   set_staff_active(target, true)                         A; P(manage_staff) not A only
 *                                                          within the ceiling (audit A-06)
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF, STAFF_EMAIL } from "../fixtures/ids";
import {
  actAs,
  asAnon,
  asAuthUser,
  asStaff,
  connect,
  inTransaction,
  scalar,
  staffClaims,
} from "./harness";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

/** As the superuser: an Auth login with no staff row (what the admin API creates). */
async function createLogin(tx: pg.Client, email: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
    [id, email],
  );
  return id;
}

/** Superuser setup, then act as the given seeded staff member's login. */
async function asStaffAfter<T>(
  authUserId: string,
  setup: (tx: pg.Client) => Promise<void>,
  fn: (tx: pg.Client) => Promise<T>,
): Promise<T> {
  return inTransaction(conn, async (tx) => {
    await setup(tx);
    await actAs(tx, staffClaims(authUserId));
    return fn(tx);
  });
}

const createStaff = (
  tx: pg.Client,
  args: {
    authUserId: string;
    name: string;
    email: string;
    role?: "admin" | "manager" | "mechanic";
  },
) =>
  tx.query(
    "select * from public.create_staff(auth_user_id => $1, display_name => $2, email => $3, role => $4)",
    [args.authUserId, args.name, args.email, args.role ?? "mechanic"],
  );

describe("create_staff", () => {
  it("lets an admin link a new login as active staff with no permissions", async () => {
    let login = "";
    const row = await asStaffAfter(
      AUTH_USER.admin,
      async (tx) => {
        login = await createLogin(tx, "new.mechanic@bicii.test");
      },
      async (tx) => {
        const { rows } = await createStaff(tx, {
          authUserId: login,
          name: "  New Mechanic ",
          email: "New.Mechanic@bicii.test",
        });
        // The new colleague can sign in and is staff straight away.
        await actAs(tx, staffClaims(login));
        const profile = await tx.query(
          "select role, active, permissions::text[] as permissions from public.my_staff_profile()",
        );
        return { created: rows[0], profile: profile.rows[0] };
      },
    );
    expect(row.created).toMatchObject({
      auth_user_id: login,
      display_name: "New Mechanic",
      email: "new.mechanic@bicii.test",
      role: "mechanic",
      active: true,
    });
    expect(row.profile).toMatchObject({ role: "mechanic", active: true, permissions: [] });
  });

  it("refuses staff without manage_staff (42501)", async () => {
    await expect(
      asStaffAfter(
        AUTH_USER.mechanic2,
        async () => {},
        async (tx) => {
          const login = randomUUID();
          return createStaff(tx, { authUserId: login, name: "X", email: "x@bicii.test" });
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // mechanic1 has view_costs, which is not manage_staff.
    await expect(
      asStaff(conn, STAFF.mechanic1, (tx) =>
        createStaff(tx, { authUserId: randomUUID(), name: "X", email: "x@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses anonymous callers and signed-in non-staff", async () => {
    await expect(
      asAnon(conn, (tx) =>
        createStaff(tx, { authUserId: randomUUID(), name: "X", email: "x@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asAuthUser(conn, randomUUID(), (tx) =>
        createStaff(tx, { authUserId: randomUUID(), name: "X", email: "x@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets a manage_staff holder create staff but not admins", async () => {
    let login = "";
    const setup = async (tx: pg.Client) => {
      await tx.query(
        "insert into public.staff_permissions (staff_id, permission) values ($1, 'manage_staff')",
        [STAFF.mechanic1],
      );
      login = await createLogin(tx, "helper@bicii.test");
    };

    const created = await asStaffAfter(AUTH_USER.mechanic1, setup, async (tx) => {
      const { rows } = await createStaff(tx, {
        authUserId: login,
        name: "Helper",
        email: "helper@bicii.test",
      });
      return rows[0];
    });
    expect(created).toMatchObject({ role: "mechanic", active: true });

    await expect(
      asStaffAfter(AUTH_USER.mechanic1, setup, (tx) =>
        createStaff(tx, {
          authUserId: login,
          name: "Helper",
          email: "helper@bicii.test",
          role: "admin",
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects a duplicate email, case-insensitively (23505)", async () => {
    let login = "";
    await expect(
      asStaffAfter(
        AUTH_USER.admin,
        async (tx) => {
          // A second login cannot share the seeded admin's email in Auth
          // either, so give it a different case of the same address.
          login = await createLogin(tx, STAFF_EMAIL.mechanic2.toUpperCase());
        },
        (tx) =>
          createStaff(tx, {
            authUserId: login,
            name: "Duplicate",
            email: STAFF_EMAIL.mechanic2.toUpperCase(),
          }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "staff_email_key" });
  });

  it("rejects a second staff row for the same login (23505)", async () => {
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        createStaff(tx, {
          authUserId: AUTH_USER.mechanic2,
          name: "Again",
          email: STAFF_EMAIL.mechanic2,
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires an existing Auth login whose email matches", async () => {
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        createStaff(tx, { authUserId: randomUUID(), name: "Ghost", email: "ghost@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "P0002" });

    let login = "";
    await expect(
      asStaffAfter(
        AUTH_USER.admin,
        async (tx) => {
          login = await createLogin(tx, "real@bicii.test");
        },
        (tx) => createStaff(tx, { authUserId: login, name: "Other", email: "other@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "P0001", message: "staff_email_mismatch" });
  });

  it("rejects a blank display name (23514)", async () => {
    let login = "";
    await expect(
      asStaffAfter(
        AUTH_USER.admin,
        async (tx) => {
          login = await createLogin(tx, "blank@bicii.test");
        },
        (tx) => createStaff(tx, { authUserId: login, name: "   ", email: "blank@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a deactivated admin (inactive means no permissions)", async () => {
    let login = "";
    await expect(
      asStaffAfter(
        AUTH_USER.admin,
        async (tx) => {
          // A second admin keeps the shop from losing its last active admin.
          await tx.query("update public.staff set role = 'admin' where id = $1", [STAFF.mechanic1]);
          await tx.query("update public.staff set active = false where id = $1", [STAFF.admin]);
          login = await createLogin(tx, "late@bicii.test");
        },
        (tx) => createStaff(tx, { authUserId: login, name: "Late", email: "late@bicii.test" }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("staff_roster", () => {
  it("gives admins every staff row with granted permissions", async () => {
    const rows = await asStaff(conn, STAFF.admin, (tx) =>
      tx
        .query(
          "select id, email, role, active, granted_permissions::text[] as granted_permissions from public.staff_roster()",
        )
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(
      [STAFF.admin, STAFF.manager, STAFF.mechanic1, STAFF.mechanic2].sort(),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[STAFF.mechanic1]).toMatchObject({
      email: STAFF_EMAIL.mechanic1,
      role: "mechanic",
      active: true,
      granted_permissions: ["view_costs"],
    });
    // Admins and managers hold their permissions by role, not by rows (D91).
    expect(byId[STAFF.admin]).toMatchObject({ role: "admin", granted_permissions: [] });
    expect(byId[STAFF.manager]).toMatchObject({
      email: STAFF_EMAIL.manager,
      role: "manager",
      granted_permissions: [],
    });
  });

  it("is available to manage_staff holders", async () => {
    const rows = await asStaffAfter(
      AUTH_USER.mechanic2,
      async (tx) => {
        await tx.query(
          "insert into public.staff_permissions (staff_id, permission) values ($1, 'manage_staff')",
          [STAFF.mechanic2],
        );
      },
      (tx) => tx.query("select id from public.staff_roster()").then((r) => r.rows),
    );
    expect(rows).toHaveLength(4);
  });

  it("refuses other staff and anonymous callers (42501)", async () => {
    await expect(
      asStaff(conn, STAFF.mechanic1, (tx) => tx.query("select * from public.staff_roster()")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asAnon(conn, (tx) => tx.query("select * from public.staff_roster()")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("set_staff_active reactivation", () => {
  const grant = (tx: pg.Client, staffId: string, permission: string) =>
    tx.query("insert into public.staff_permissions (staff_id, permission) values ($1, $2)", [
      staffId,
      permission,
    ]);
  /** Back to the superuser with no session, as during setup. */
  const owner = async (tx: pg.Client) => {
    await tx.query("reset role");
    await tx.query("select set_config('request.jwt.claims', '', true)");
  };
  const isActive = async (tx: pg.Client, staffId: string) => {
    await owner(tx);
    return scalar<boolean>(tx, "select active from public.staff where id = $1", [staffId]);
  };

  it("refuses a non-admin manage_staff holder reactivating someone with access they cannot grant (42501); the admin still can", async () => {
    await inTransaction(conn, async (tx) => {
      // Marcus (mechanic1) already holds view_costs; the admin also gave him
      // manage_staff, then he was deactivated. Nur (mechanic2) holds only
      // manage_staff.
      await grant(tx, STAFF.mechanic1, "manage_staff");
      await grant(tx, STAFF.mechanic2, "manage_staff");
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic1]);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.set_staff_active($1, true)", [STAFF.mechanic1]),
        { code: "42501" },
      );
      expect(await isActive(tx, STAFF.mechanic1)).toBe(false);

      // Holding view_costs too is not enough: manage_staff is never delegated.
      await owner(tx);
      await grant(tx, STAFF.mechanic2, "view_costs");
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.set_staff_active($1, true)", [STAFF.mechanic1]),
        { code: "42501" },
      );
      expect(await isActive(tx, STAFF.mechanic1)).toBe(false);

      await actAs(tx, staffClaims(AUTH_USER.admin));
      expect(
        await scalar(tx, "select (public.set_staff_active($1, true)).active", [STAFF.mechanic1]),
      ).toBe(true);
    });
  });

  it("lets a non-admin manage_staff holder reactivate a mechanic whose exceptions they hold", async () => {
    await inTransaction(conn, async (tx) => {
      // Marcus holds only view_costs; Nur holds manage_staff and view_costs.
      await grant(tx, STAFF.mechanic2, "manage_staff");
      await grant(tx, STAFF.mechanic2, "view_costs");
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic1]);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(
        await scalar(tx, "select (public.set_staff_active($1, true)).active", [STAFF.mechanic1]),
      ).toBe(true);
    });
  });

  it("refuses a holder without the target's exception (42501)", async () => {
    await inTransaction(conn, async (tx) => {
      // Marcus holds view_costs, which Nur (manage_staff only) cannot grant.
      await grant(tx, STAFF.mechanic2, "manage_staff");
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic1]);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.set_staff_active($1, true)", [STAFF.mechanic1]),
        { code: "42501" },
      );
      expect(await isActive(tx, STAFF.mechanic1)).toBe(false);
    });
  });
});
