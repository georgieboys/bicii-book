/**
 * Staff roles (PLAN D90-D94, ADR-021; DATA-MODEL §1, §15, §16):
 *
 *   * D90/D91: the role x permission matrix. admin implies every
 *     permission, manager every permission except manage_staff, mechanic
 *     none; effective = role + exceptions, none while inactive. Checked
 *     through private.has_permission and my_staff_profile(), and
 *     private.role_implies is proved equal to roleImplies() in
 *     src/lib/auth/permissions.ts for every role x permission.
 *   * One representative gate per permission family, refunds (D94) and the
 *     admin-only settings, called as each kind of person: refused callers
 *     get 42501, allowed callers reach the business checks (bogus ids give
 *     P0002, missing arguments 22004, and so on: anything but 42501).
 *   * D92: exceptions the role implies are refused for every writer and
 *     dropped by a role change, with history.
 *   * D93: who administers which role.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  STAFF_ROLES,
  roleImplies,
  type PermissionKey,
  type StaffRole,
} from "@/lib/auth/permissions";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  scalar,
  staffClaims,
  type Connection,
} from "./harness";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ALL: PermissionKey[] = [
  "view_costs",
  "manage_inventory",
  "adjust_stock",
  "manage_consignments",
  "manage_purchasing",
  "manage_staff",
  "view_financial_reports",
  "manage_adventures",
  "verify_adventures",
  "facilitate_adventures",
];
// Written out, not derived from the code under test (D91).
const MANAGER_IMPLIES: PermissionKey[] = [
  "view_costs",
  "manage_inventory",
  "adjust_stock",
  "manage_consignments",
  "manage_purchasing",
  "view_financial_reports",
  "manage_adventures",
  "verify_adventures",
  "facilitate_adventures",
];

/** Superuser, no session: setup that records no actor. */
async function owner(tx: Connection): Promise<void> {
  await tx.query("reset role");
  await tx.query("select set_config('request.jwt.claims', '', true)");
}

type Person = { staffId: string; authUserId: string };

/** As the superuser: an Auth login plus a staff row with these exceptions. */
async function addStaff(
  tx: Connection,
  role: StaffRole,
  exceptions: PermissionKey[] = [],
  active = true,
): Promise<Person> {
  await owner(tx);
  const authUserId = randomUUID();
  const email = `roles-${authUserId.slice(0, 8)}@bicii.test`;
  await tx.query(
    `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
    [authUserId, email],
  );
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.staff (auth_user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, true) returning id`,
    [authUserId, `Roles ${role}`, email, role],
  );
  const staffId = rows[0].id;
  for (const p of exceptions) {
    await tx.query("insert into public.staff_permissions (staff_id, permission) values ($1, $2)", [
      staffId,
      p,
    ]);
  }
  if (!active) await tx.query("update public.staff set active = false where id = $1", [staffId]);
  return { staffId, authUserId };
}

const seeded = (who: keyof typeof STAFF): Person => ({
  staffId: STAFF[who],
  authUserId: AUTH_USER[who],
});

async function grantAsOwner(tx: Connection, staffId: string, permissions: PermissionKey[]) {
  await owner(tx);
  for (const p of permissions) {
    await tx.query("insert into public.staff_permissions (staff_id, permission) values ($1, $2)", [
      staffId,
      p,
    ]);
  }
}

async function become(tx: Connection, person: Person): Promise<void> {
  await actAs(tx, staffClaims(person.authUserId));
}

/**
 * A subject: who they are, built inside the transaction, and what they
 * should hold. `refunds` and `admin` are the role checks (D94, admin-only).
 */
type Subject = {
  name: string;
  build: (tx: Connection) => Promise<Person>;
  permissions: PermissionKey[];
  refunds: boolean;
  admin: boolean;
};

const SUBJECTS: Subject[] = [
  {
    name: "admin",
    build: async () => seeded("admin"),
    permissions: ALL,
    refunds: true,
    admin: true,
  },
  {
    name: "manager (seeded, no exceptions)",
    build: async () => seeded("manager"),
    permissions: MANAGER_IMPLIES,
    refunds: true,
    admin: false,
  },
  {
    name: "manager with manage_staff as an exception",
    build: async (tx) => {
      await grantAsOwner(tx, STAFF.manager, ["manage_staff"]);
      return seeded("manager");
    },
    permissions: ALL,
    refunds: true,
    admin: false,
  },
  {
    name: "mechanic2 (no exceptions)",
    build: async () => seeded("mechanic2"),
    permissions: [],
    refunds: false,
    admin: false,
  },
  {
    name: "mechanic1 (view_costs exception)",
    build: async () => seeded("mechanic1"),
    permissions: ["view_costs"],
    refunds: false,
    admin: false,
  },
  ...ALL.map((p): Subject => ({
    name: `mechanic granted ${p} alone`,
    build: (tx) => addStaff(tx, "mechanic", [p]),
    permissions: [p],
    refunds: false,
    admin: false,
  })),
  {
    name: "mechanic holding every permission as exceptions",
    build: (tx) => addStaff(tx, "mechanic", ALL),
    permissions: ALL,
    refunds: false,
    admin: false,
  },
  {
    name: "inactive manager",
    build: (tx) => addStaff(tx, "manager", ["manage_staff"], false),
    permissions: [],
    refunds: false,
    admin: false,
  },
  {
    name: "inactive admin (another admin stays active)",
    build: (tx) => addStaff(tx, "admin", [], false),
    permissions: [],
    refunds: false,
    admin: false,
  },
];

const inOrder = (ps: readonly PermissionKey[]) => ALL.filter((p) => ps.includes(p));

describe("role_implies is one rule, mirrored by the app (D91)", () => {
  it("the enums are admin | manager | mechanic and the seven permissions, in the app's order", async () => {
    expect(
      await scalar<string[]>(conn, "select enum_range(null::public.staff_role)::text[]"),
    ).toEqual(["admin", "manager", "mechanic"]);
    expect([...STAFF_ROLES]).toEqual(["admin", "manager", "mechanic"]);
    expect(
      await scalar<string[]>(conn, "select enum_range(null::public.permission_key)::text[]"),
    ).toEqual([...PERMISSIONS]);
  });

  it("private.role_implies equals roleImplies() for every role x permission", async () => {
    const { rows } = await conn.query<{
      role: StaffRole;
      permission: PermissionKey;
      implied: boolean;
    }>(
      `select r::text as role, p::text as permission, private.role_implies(r, p) as implied
         from unnest(enum_range(null::public.staff_role)) r,
              unnest(enum_range(null::public.permission_key)) p`,
    );
    expect(rows).toHaveLength(STAFF_ROLES.length * PERMISSIONS.length);
    for (const row of rows) {
      expect(row.implied, `${row.role} ${row.permission}`).toBe(
        roleImplies(row.role, row.permission),
      );
    }
    const expected: Record<StaffRole, PermissionKey[]> = {
      admin: ALL,
      manager: MANAGER_IMPLIES,
      mechanic: [],
    };
    for (const role of STAFF_ROLES) {
      expect(inOrder(PERMISSIONS.filter((p) => roleImplies(role, p))), role).toEqual(
        inOrder(expected[role]),
      );
    }
  });

  it("a null role implies nothing; nothing outside the owner may call role_implies", async () => {
    expect(await scalar(conn, "select private.role_implies(null, 'view_costs')")).toBe(false);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await scalar(
          conn,
          "select has_function_privilege($1, 'private.role_implies(public.staff_role, public.permission_key)', 'EXECUTE')",
          [role],
        ),
        role,
      ).toBe(false);
      expect(
        await scalar(
          conn,
          "select has_function_privilege($1, 'private.can_record_refunds()', 'EXECUTE')",
          [role],
        ),
        role,
      ).toBe(false);
    }
  });

  it("new staff default to mechanic: the column and create_staff's role argument (D90)", async () => {
    expect(
      await scalar(
        conn,
        `select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'staff' and column_name = 'role'`,
      ),
    ).toBe("'mechanic'::staff_role");
    expect(
      await scalar<string>(
        conn,
        "select pg_get_function_arguments('public.create_staff(uuid, text, text, public.staff_role)'::regprocedure)",
      ),
    ).toMatch(/role staff_role DEFAULT 'mechanic'::staff_role/);
  });
});

describe.skipIf(!isolatedDatabase())("the role x permission matrix (D91)", () => {
  for (const subject of SUBJECTS) {
    it(`${subject.name}: has_permission and my_staff_profile give ${subject.permissions.length} permission(s)`, async () => {
      await inTransaction(conn, async (tx) => {
        const person = await subject.build(tx);
        await become(tx, person);
        const held = await tx.query<{ permission: PermissionKey; held: boolean }>(
          `select e.p::text as permission, private.has_permission(e.p) as held
             from unnest(enum_range(null::public.permission_key)) as e (p) order by e.p`,
        );
        expect(held.rows).toHaveLength(ALL.length);
        expect(held.rows.filter((r) => r.held).map((r) => r.permission)).toEqual(
          inOrder(subject.permissions),
        );
        const profile = await tx.query<{ permissions: PermissionKey[] }>(
          "select permissions::text[] as permissions from public.my_staff_profile()",
        );
        expect(profile.rows).toEqual([{ permissions: inOrder(subject.permissions) }]);
        // The role checks are for the owner's functions only (EXECUTE
        // revoked from API roles); the session's claims stay.
        await tx.query("reset role");
        expect(await scalar(tx, "select private.can_record_refunds()")).toBe(subject.refunds);
        expect(await scalar(tx, "select private.is_admin()")).toBe(subject.admin);
      });
    });
  }
});

/** One gate: the family it belongs to and how to knock. */
type Family = PermissionKey | "refunds" | "admin_only";
type Gate = { name: string; family: Family; knock: (tx: Connection) => Promise<"in" | "out"> };

let savepoint = 0;

/** "out" when the call is refused with 42501, "in" otherwise (rolled back to a savepoint). */
async function call(tx: Connection, sql: string): Promise<"in" | "out"> {
  const name = `gate_${++savepoint}`;
  await tx.query(`savepoint ${name}`);
  try {
    await tx.query(sql);
    await tx.query(`release savepoint ${name}`);
    return "in";
  } catch (err) {
    await tx.query(`rollback to savepoint ${name}`);
    return (err as { code?: string }).code === "42501" ? "out" : "in";
  }
}

/** Rows visible under RLS: "in" when the view shows any. */
async function rows(tx: Connection, relation: string): Promise<"in" | "out"> {
  const n = await scalar<number>(tx, `select count(*)::int from ${relation}`);
  return n > 0 ? "in" : "out";
}

const knock =
  (sql: string) =>
  (tx: Connection): Promise<"in" | "out"> =>
    call(tx, sql);
const nil = "gen_random_uuid()";

const GATES: Gate[] = [
  // view_costs
  {
    name: "work_order_yield",
    family: "view_costs",
    knock: knock(`select public.work_order_yield(${nil})`),
  },
  {
    name: "product_costs rows",
    family: "view_costs",
    knock: (tx) => rows(tx, "public.product_costs"),
  },
  {
    name: "services_staff rows",
    family: "view_costs",
    knock: (tx) => rows(tx, "public.services_staff"),
  },
  // manage_inventory
  {
    name: "create_service",
    family: "manage_inventory",
    knock: knock(
      "select public.create_service(null::uuid, null::text, null::public.money_amount, null::text, null::uuid, null::public.money_amount, null::boolean, null::boolean)",
    ),
  },
  {
    name: "categories insert under RLS",
    family: "manage_inventory",
    knock: knock(
      "insert into public.categories (kind, name) values ('service', 'Roles test category')",
    ),
  },
  // adjust_stock
  {
    name: "adjust_stock",
    family: "adjust_stock",
    knock: knock(
      `select public.adjust_stock(${nil}, ${nil}, ${nil}, 1, 'stock_adjustment', 'Count', null::public.money_amount)`,
    ),
  },
  {
    name: "write_off_unit",
    family: "adjust_stock",
    knock: knock(`select public.write_off_unit(${nil}, ${nil}, 'Bent')`),
  },
  // manage_consignments
  {
    name: "consignor_payout_details",
    family: "manage_consignments",
    knock: knock(`select public.consignor_payout_details(${nil})`),
  },
  {
    name: "create_consignment_item",
    family: "manage_consignments",
    knock: knock(
      `select public.create_consignment_item(${nil}, ${nil}, ${nil}, 100::public.money_amount, null::public.money_amount,
         null::uuid, 'Roles test', null::text, null::text, null::uuid, 'unique'::public.tracking_type, null::integer,
         null::text, null::text, null::timestamptz, null::text, null::text, null::uuid, null::uuid, null::uuid, null::jsonb)`,
    ),
  },
  // manage_purchasing
  {
    name: "create_purchase_order",
    family: "manage_purchasing",
    knock: knock(
      `select public.create_purchase_order(${nil}, ${nil}, null::date, null::text, null::text)`,
    ),
  },
  {
    name: "purchase_cost_defaults",
    family: "manage_purchasing",
    knock: knock(`select * from public.purchase_cost_defaults(${nil}, array[${nil}])`),
  },
  // view_financial_reports
  {
    name: "financial_lines",
    family: "view_financial_reports",
    knock: knock("select count(*) from public.financial_lines(current_date - 7, current_date)"),
  },
  // manage_staff
  {
    name: "staff_roster",
    family: "manage_staff",
    knock: knock("select count(*) from public.staff_roster()"),
  },
  {
    name: "staff_history",
    family: "manage_staff",
    knock: knock(`select count(*) from public.staff_history(${nil})`),
  },
  {
    name: "grant_permission",
    family: "manage_staff",
    knock: knock(`select public.grant_permission(${nil}, 'view_costs')`),
  },
  {
    name: "create_staff",
    family: "manage_staff",
    knock: knock(`select public.create_staff(${nil}, 'Nobody', 'nobody@bicii.test', 'mechanic')`),
  },
  {
    name: "set_staff_active",
    family: "manage_staff",
    knock: knock(`select public.set_staff_active(${nil}, true)`),
  },
  {
    name: "update_staff",
    family: "manage_staff",
    knock: knock(`select public.update_staff(${nil}, display_name => 'Nobody')`),
  },
  // manage_adventures (D169): an invalid slug is a business refusal, not 42501
  {
    name: "create_adventure",
    family: "manage_adventures",
    knock: knock("select public.create_adventure('!', 'Nobody', 125)"),
  },
  // refunds (D94): a role check
  {
    name: "record_sale_refund",
    family: "refunds",
    knock: knock(`select public.record_sale_refund(${nil}, ${nil}, 1, 'Scratched')`),
  },
  // admin-only settings
  {
    name: "update_shop_settings",
    family: "admin_only",
    knock: knock("select public.update_shop_settings(null, null, null, null, null, null, null)"),
  },
  {
    name: "schedule_cult_commons_rate",
    family: "admin_only",
    knock: knock(
      `select public.schedule_cult_commons_rate(${nil}, 0.3, now() + interval '30 days')`,
    ),
  },
];

const expectedAt = (subject: Subject, family: Family): "in" | "out" => {
  if (family === "refunds") return subject.refunds ? "in" : "out";
  if (family === "admin_only") return subject.admin ? "in" : "out";
  return subject.permissions.includes(family) ? "in" : "out";
};

describe.skipIf(!isolatedDatabase())("every gate follows the role (D91, D94, admin-only)", () => {
  for (const subject of SUBJECTS) {
    it(`${subject.name}`, async () => {
      await inTransaction(conn, async (tx) => {
        const person = await subject.build(tx);
        await become(tx, person);
        const got: Record<string, "in" | "out"> = {};
        const want: Record<string, "in" | "out"> = {};
        for (const gate of GATES) {
          got[gate.name] = await gate.knock(tx);
          want[gate.name] = expectedAt(subject, gate.family);
        }
        expect(got).toEqual(want);
      });
    });
  }
});

type EventRow = {
  event_type: string;
  permission: string | null;
  actor_staff_id: string | null;
  payload: Record<string, unknown>;
  reason: string | null;
};

async function eventsOf(tx: Connection, staffId: string, since: string): Promise<EventRow[]> {
  await tx.query("reset role");
  const { rows: events } = await tx.query<EventRow>(
    `select event_type::text, permission::text, actor_staff_id, payload, reason
       from public.staff_events
      where staff_id = $1 and created_at > $2::timestamptz
      order by created_at, id`,
    [staffId, since],
  );
  return events;
}

async function exceptionsOf(tx: Connection, staffId: string): Promise<string[]> {
  await tx.query("reset role");
  const { rows: r } = await tx.query<{ permission: string }>(
    "select permission::text from public.staff_permissions where staff_id = $1 order by permission",
    [staffId],
  );
  return r.map((x) => x.permission);
}

const implied = { code: "P0001", message: "permission_implied_by_role" };

describe.skipIf(!isolatedDatabase())("exceptions on top of the role (D92)", () => {
  it("grant_permission refuses a permission the role implies (permission_implied_by_role)", async () => {
    await inTransaction(conn, async (tx) => {
      await become(tx, seeded("admin"));
      for (const p of MANAGER_IMPLIES) {
        await failsWith(
          tx,
          () => tx.query("select public.grant_permission($1, $2)", [STAFF.manager, p]),
          implied,
        );
      }
      for (const p of ALL) {
        await failsWith(
          tx,
          () => tx.query("select public.grant_permission($1, $2)", [STAFF.admin, p]),
          implied,
        );
      }
      // Revoking a row that cannot exist stays a replay-safe null.
      expect(
        await scalar(tx, "select public.revoke_permission($1, 'view_costs') is null", [
          STAFF.manager,
        ]),
      ).toBe(true);
    });
  });

  it("every writer is refused: a direct superuser insert too", async () => {
    await inTransaction(conn, async (tx) => {
      await owner(tx);
      await failsWith(
        tx,
        () =>
          tx.query(
            "insert into public.staff_permissions (staff_id, permission) values ($1, 'view_costs')",
            [STAFF.manager],
          ),
        { ...implied, detail: "Their role already includes that permission." },
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "insert into public.staff_permissions (staff_id, permission) values ($1, 'manage_staff')",
            [STAFF.admin],
          ),
        implied,
      );
    });
  });

  it("an admin grants manage_staff to a manager, who then holds every permission", async () => {
    await inTransaction(conn, async (tx) => {
      await become(tx, seeded("admin"));
      const { rows: granted } = await tx.query(
        "select staff_id, permission::text, granted_by from public.grant_permission($1, 'manage_staff')",
        [STAFF.manager],
      );
      expect(granted).toEqual([
        { staff_id: STAFF.manager, permission: "manage_staff", granted_by: STAFF.admin },
      ]);
      await become(tx, seeded("manager"));
      expect(
        await scalar<string[]>(tx, "select permissions::text[] from public.my_staff_profile()"),
      ).toEqual(ALL);
    });
  });

  it("promoting a mechanic to manager drops the exceptions the role implies, with history; a replay appends nothing; demoting brings nothing back", async () => {
    await inTransaction(conn, async (tx) => {
      const ana = await addStaff(tx, "mechanic", ["view_costs", "manage_purchasing"]);
      const since = await scalar<string>(tx, "select clock_timestamp()::text");
      await become(tx, seeded("admin"));
      await tx.query(
        "select public.update_staff($1, role => 'manager', reason => 'Runs the floor')",
        [ana.staffId],
      );
      expect(await exceptionsOf(tx, ana.staffId)).toEqual([]);
      const events = await eventsOf(tx, ana.staffId, since);
      expect(events[0]).toMatchObject({
        event_type: "role_changed",
        actor_staff_id: STAFF.admin,
        payload: { role: { from: "mechanic", to: "manager" } },
        reason: "Runs the floor",
      });
      expect(
        events
          .slice(1)
          .map((e) => e.permission)
          .sort(),
      ).toEqual(["manage_purchasing", "view_costs"]);
      for (const e of events.slice(1)) {
        expect(e).toMatchObject({
          event_type: "permission_revoked",
          actor_staff_id: STAFF.admin,
          reason: "Runs the floor",
        });
      }
      expect(events).toHaveLength(3);

      // The same role again: nothing changes, nothing is recorded.
      const replay = await scalar<string>(tx, "select clock_timestamp()::text");
      await become(tx, seeded("admin"));
      await tx.query("select public.update_staff($1, role => 'manager')", [ana.staffId]);
      expect(await eventsOf(tx, ana.staffId, replay)).toEqual([]);

      // Demoting does not restore the dropped exceptions.
      await become(tx, seeded("admin"));
      await tx.query("select public.update_staff($1, role => 'mechanic', reason => 'Back')", [
        ana.staffId,
      ]);
      expect(await exceptionsOf(tx, ana.staffId)).toEqual([]);
      await become(tx, ana);
      expect(
        await scalar<string[]>(tx, "select permissions::text[] from public.my_staff_profile()"),
      ).toEqual([]);
    });
  });

  it("promoting to admin drops every exception; a role change by SQL (no session) drops them too", async () => {
    await inTransaction(conn, async (tx) => {
      await grantAsOwner(tx, STAFF.manager, ["manage_staff"]);
      await become(tx, seeded("admin"));
      await tx.query("select public.update_staff($1, role => 'admin')", [STAFF.manager]);
      expect(await exceptionsOf(tx, STAFF.manager)).toEqual([]);

      const bo = await addStaff(tx, "mechanic", ["adjust_stock", "manage_staff"]);
      await owner(tx);
      await tx.query("update public.staff set role = 'manager' where id = $1", [bo.staffId]);
      expect(await exceptionsOf(tx, bo.staffId)).toEqual(["manage_staff"]);
    });
  });

  it("no exception row is implied by its person's role once the migrations and the seed have run", async () => {
    await inTransaction(conn, async (tx) => {
      await owner(tx);
      expect(
        await scalar<number>(
          tx,
          `select count(*)::int from public.staff_permissions sp
             join public.staff s on s.id = sp.staff_id
            where private.role_implies(s.role, sp.permission)`,
        ),
      ).toBe(0);
    });
  });

  it("the roles migration's clean-up removes implied rows written before the roles, with history, so a demotion brings nothing back", async () => {
    await inTransaction(conn, async (tx) => {
      // The pre-roles state of a database migrated step by step: an admin
      // granted to an admin, a promotion that kept its rows. Triggers off
      // (replica) to write what the BEFORE INSERT refusal now prevents.
      await owner(tx);
      await tx.query("set local session_replication_role = replica");
      for (const [staffId, permission] of [
        [STAFF.admin, "view_costs"],
        [STAFF.manager, "adjust_stock"],
        [STAFF.manager, "manage_staff"],
      ]) {
        await tx.query(
          "insert into public.staff_permissions (staff_id, permission) values ($1, $2)",
          [staffId, permission],
        );
      }
      await tx.query("set local session_replication_role = origin");
      const since = await scalar<string>(tx, "select clock_timestamp()::text");

      // The same function 20261006000200 runs once.
      expect(await scalar<number>(tx, "select private.drop_implied_exceptions()")).toBe(2);
      expect(await exceptionsOf(tx, STAFF.admin)).toEqual([]);
      // manage_staff is a real exception for a manager; Marcus's view_costs too.
      expect(await exceptionsOf(tx, STAFF.manager)).toEqual(["manage_staff"]);
      expect(await exceptionsOf(tx, STAFF.mechanic1)).toEqual(["view_costs"]);
      const reason = "Staff roles (D92): their role already includes this permission.";
      expect(await eventsOf(tx, STAFF.admin, since)).toEqual([
        expect.objectContaining({
          event_type: "permission_revoked",
          permission: "view_costs",
          actor_staff_id: null,
          reason,
        }),
      ]);
      expect(await eventsOf(tx, STAFF.manager, since)).toEqual([
        expect.objectContaining({
          event_type: "permission_revoked",
          permission: "adjust_stock",
          actor_staff_id: null,
          reason,
        }),
      ]);
      // The reason does not leak into later writes of the transaction.
      expect(await scalar(tx, "select current_setting('app.staff_event_reason', true)")).toBe("");

      // A later demotion keeps only the real exception.
      await tx.query("update public.staff set role = 'mechanic' where id = $1", [STAFF.manager]);
      expect(await exceptionsOf(tx, STAFF.manager)).toEqual(["manage_staff"]);
    });
  });
});

describe.skipIf(!isolatedDatabase())("who administers which role (D93)", () => {
  /** Runs the non-admin manage_staff holder's refused calls on `target`. */
  async function refusedOn(tx: Connection, actor: Person, target: string) {
    await become(tx, actor);
    for (const [sql, params] of [
      ["select public.grant_permission($1, 'view_costs')", [target]],
      ["select public.revoke_permission($1, 'view_costs')", [target]],
      ["select public.update_staff($1, display_name => 'Renamed')", [target]],
      ["select public.set_staff_active($1, false, 'Leaving')", [target]],
      ["select public.update_staff($1, role => 'mechanic')", [target]],
    ] as const) {
      await failsWith(tx, () => tx.query(sql, [...params]), { code: "42501" });
    }
  }

  async function newLogin(tx: Connection, email: string): Promise<string> {
    await owner(tx);
    const id = randomUUID();
    await tx.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now())`,
      [id, email],
    );
    return id;
  }

  it("only an admin invites a manager or an admin; a manage_staff holder invites mechanics", async () => {
    await inTransaction(conn, async (tx) => {
      const mo = await addStaff(tx, "mechanic", ["manage_staff", "view_costs"]);
      await grantAsOwner(tx, STAFF.manager, ["manage_staff"]);
      for (const inviter of [mo, seeded("manager")]) {
        for (const role of ["manager", "admin"]) {
          const login = await newLogin(
            tx,
            `invite-${role}-${inviter.staffId.slice(0, 6)}@bicii.test`,
          );
          await become(tx, inviter);
          await failsWith(
            tx,
            () =>
              tx.query("select public.create_staff($1, 'New', $2, $3)", [
                login,
                `invite-${role}-${inviter.staffId.slice(0, 6)}@bicii.test`,
                role,
              ]),
            { code: "42501" },
          );
        }
        const email = `invite-mechanic-${inviter.staffId.slice(0, 6)}@bicii.test`;
        const login = await newLogin(tx, email);
        await become(tx, inviter);
        expect(
          await scalar(tx, "select (public.create_staff($1, 'New', $2)).role::text", [
            login,
            email,
          ]),
        ).toBe("mechanic");
      }
      for (const role of ["manager", "admin"]) {
        const email = `admin-invites-${role}@bicii.test`;
        const login = await newLogin(tx, email);
        await become(tx, seeded("admin"));
        expect(
          await scalar(tx, "select (public.create_staff($1, 'New', $2, $3)).role::text", [
            login,
            email,
            role,
          ]),
        ).toBe(role);
      }
    });
  });

  it("a mechanic with manage_staff acts on mechanics within the ceiling, never on a manager's, an admin's or their own row", async () => {
    await inTransaction(conn, async (tx) => {
      const mo = await addStaff(tx, "mechanic", ["manage_staff", "view_costs"]);
      await become(tx, mo);
      // Mechanics: grant what they hold, rename, deactivate and reactivate.
      await tx.query("select public.grant_permission($1, 'view_costs')", [STAFF.mechanic2]);
      await tx.query("select public.revoke_permission($1, 'view_costs')", [STAFF.mechanic2]);
      await tx.query("select public.update_staff($1, display_name => 'Nur A.')", [STAFF.mechanic2]);
      await tx.query("select public.set_staff_active($1, false, 'Seasonal')", [STAFF.mechanic2]);
      await tx.query("select public.set_staff_active($1, true)", [STAFF.mechanic2]);
      // Not what they do not hold, never manage_staff, never a role.
      for (const p of ["adjust_stock", "manage_staff"]) {
        await failsWith(
          tx,
          () => tx.query("select public.grant_permission($1, $2)", [STAFF.mechanic2, p]),
          { code: "42501" },
        );
      }
      await failsWith(
        tx,
        () => tx.query("select public.update_staff($1, role => 'manager')", [STAFF.mechanic2]),
        { code: "42501" },
      );
      await refusedOn(tx, mo, STAFF.manager);
      await refusedOn(tx, mo, STAFF.admin);
      // Their own row: no exceptions, no deactivation, no role.
      await become(tx, mo);
      for (const sql of [
        "select public.grant_permission($1, 'view_costs')",
        "select public.revoke_permission($1, 'view_costs')",
        "select public.set_staff_active($1, false, 'Leaving')",
        "select public.update_staff($1, role => 'manager')",
      ]) {
        await failsWith(tx, () => tx.query(sql, [mo.staffId]), { code: "42501" });
      }
      // A rename of their own row is still allowed, as before the roles
      // (D93 build default; PRODUCT owner question 20, RISKS R-053).
      expect(
        await scalar(
          tx,
          "select (public.update_staff($1, display_name => 'Mo Self')).display_name",
          [mo.staffId],
        ),
      ).toBe("Mo Self");
    });
  });

  it("a manager with manage_staff grants what the role implies to a mechanic, but never acts on another manager, an admin or themselves", async () => {
    await inTransaction(conn, async (tx) => {
      await grantAsOwner(tx, STAFF.manager, ["manage_staff"]);
      const other = await addStaff(tx, "manager");
      await become(tx, seeded("manager"));
      await tx.query("select public.grant_permission($1, 'adjust_stock')", [STAFF.mechanic2]);
      await failsWith(
        tx,
        () => tx.query("select public.grant_permission($1, 'manage_staff')", [STAFF.mechanic2]),
        { code: "42501" },
      );
      await refusedOn(tx, seeded("manager"), other.staffId);
      await refusedOn(tx, seeded("manager"), STAFF.admin);
      await become(tx, seeded("manager"));
      for (const sql of [
        "select public.revoke_permission($1, 'manage_staff')",
        "select public.set_staff_active($1, false, 'Leaving')",
        "select public.update_staff($1, role => 'mechanic')",
      ]) {
        await failsWith(tx, () => tx.query(sql, [STAFF.manager]), { code: "42501" });
      }
    });
  });

  it("an admin changes roles and administers managers; nobody changes their own role; the last active admin cannot be demoted (55000)", async () => {
    await inTransaction(conn, async (tx) => {
      await become(tx, seeded("admin"));
      await tx.query("select public.update_staff($1, display_name => 'Kavya M.')", [STAFF.manager]);
      await tx.query("select public.set_staff_active($1, false, 'Leave')", [STAFF.manager]);
      await tx.query("select public.set_staff_active($1, true)", [STAFF.manager]);
      expect(
        await scalar(tx, "select (public.update_staff($1, role => 'mechanic')).role::text", [
          STAFF.manager,
        ]),
      ).toBe("mechanic");
      await failsWith(
        tx,
        () => tx.query("select public.update_staff($1, role => 'manager')", [STAFF.admin]),
        { code: "42501" },
      );
      await owner(tx);
      await failsWith(
        tx,
        () => tx.query("update public.staff set role = 'manager' where id = $1", [STAFF.admin]),
        { code: "55000" },
      );
    });
  });

  it("a role change confirmed against a role that changed meanwhile is refused (staff_role_changed), with no event", async () => {
    await inTransaction(conn, async (tx) => {
      const since = await scalar<string>(tx, "select clock_timestamp()::text");
      await become(tx, seeded("admin"));
      // The confirmation showed Manager; Nur Aisyah is a mechanic.
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.update_staff($1, role => 'admin', expected_role => 'manager', reason => 'Stale page')",
            [STAFF.mechanic2],
          ),
        { code: "P0001", message: "staff_role_changed" },
      );
      await owner(tx);
      expect(
        await scalar<string>(tx, "select role::text from public.staff where id = $1", [
          STAFF.mechanic2,
        ]),
      ).toBe("mechanic");
      expect(await eventsOf(tx, STAFF.mechanic2, since)).toEqual([]);

      // The role it showed: the change goes through.
      await become(tx, seeded("admin"));
      expect(
        await scalar<string>(
          tx,
          "select (public.update_staff($1, role => 'manager', expected_role => 'mechanic')).role::text",
          [STAFF.mechanic2],
        ),
      ).toBe("manager");
    });
  });

  it("a reason longer than 500 characters is refused on a role change", async () => {
    await inTransaction(conn, async (tx) => {
      await become(tx, seeded("admin"));
      await failsWith(
        tx,
        () =>
          tx.query("select public.update_staff($1, role => 'manager', reason => $2)", [
            STAFF.mechanic2,
            "x".repeat(501),
          ]),
        { code: "P0001", message: "reason_too_long" },
      );
    });
  });
});
