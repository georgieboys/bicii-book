/**
 * Customers, bikes and bike ownership history (SPEC §4.1, §5; DATA-MODEL §2,
 * §15, §16, §17):
 *
 *   * base tables are for active staff only (customers use the my_* RPCs,
 *     customer-access.test.ts); anonymous users can touch nothing;
 *   * customer email is not a key; blanks are stored as null; the Auth and
 *     Shopify links are not writable by signed-in users; no deletes;
 *   * bike short IDs (B-######) are assigned by the server, unique and
 *     immutable; clients cannot supply them;
 *   * every owner change appends a bike_ownership_events row with actor and
 *     reason (registration on create, transfers through
 *     transfer_bike_ownership, which needs a reason); history is
 *     append-only and earlier events are never rewritten.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, BIKE, BIKE_SHORT_ID, CUSTOMER, STAFF } from "../fixtures/ids";
import { archiveCustomerUnguarded, customerClaims, linkCustomerLogin } from "./customer-fixtures";
import {
  actAs,
  asAnon,
  asServiceRole,
  asStaff,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
  staffClaims,
} from "./harness";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const PHASE1_TABLES = [
  "customers",
  "bikes",
  "bike_ownership_events",
  "attachments",
  "attachment_events",
] as const;

// Inserting a bike calls nextval (short IDs are never reused), so tests that
// create bikes run only on a per-file clone (TESTING.md).
const createsBikes = it.skipIf(!isolatedDatabase());

type OwnershipEvent = {
  id: string;
  event_type: string;
  from_customer_id: string | null;
  to_customer_id: string | null;
  reason: string | null;
  actor_staff_id: string | null;
  correlation_id: string | null;
};

async function ownershipEvents(tx: pg.Client, bikeId: string): Promise<OwnershipEvent[]> {
  const { rows } = await tx.query<OwnershipEvent>(
    `select id, event_type::text, from_customer_id, to_customer_id, reason, actor_staff_id, correlation_id
       from public.bike_ownership_events where bike_id = $1 order by created_at, id`,
    [bikeId],
  );
  return rows;
}

const transfer = (tx: pg.Client, bikeId: string, to: string | null, reason: string | null) =>
  tx
    .query(
      "select (t).customer_id, (t).short_id from (select public.transfer_bike_ownership($1, $2, $3) t) s",
      [bikeId, to, reason],
    )
    .then((r) => r.rows[0] as { customer_id: string | null; short_id: string });

describe("anonymous", () => {
  it("cannot read any Phase 1 table", async () => {
    for (const table of PHASE1_TABLES) {
      await expect(
        asAnon(conn, (tx) => tx.query(`select * from public.${table}`)),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("cannot write customers or bikes, or transfer a bike", async () => {
    for (const sql of [
      "insert into public.customers (first_name) values ('Anon')",
      "insert into public.bikes (brand, model) values ('Anon', 'Bike')",
      `select public.transfer_bike_ownership('${BIKE.tanTarmac}', null, 'Taking it')`,
    ]) {
      await expect(asAnon(conn, (tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("staff access", () => {
  it("any active staff member, without permissions, sees every customer, bike and event", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      expect(await scalar(tx, "select count(*)::int from public.customers")).toBe(6);
      // Every seeded bike (Phase 4 adds three shop bikes, which have no owner
      // and so no ownership event; Phase 5 four customers' bikes, one
      // `registered` event each).
      expect(await scalar(tx, "select count(*)::int from public.bikes")).toBe(
        Object.keys(BIKE).length,
      );
      expect(await scalar(tx, "select count(*)::int from public.bike_ownership_events")).toBe(14);
      expect(
        await scalar(tx, "select internal_notes from public.customers where id = $1", [
          CUSTOMER.tan,
        ]),
      ).toMatch(/WhatsApp/);
    });
  });

  it("inactive staff see nothing and cannot transfer", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query("update public.staff set active = false where id = $1", [STAFF.mechanic2]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      for (const table of PHASE1_TABLES) {
        expect(await scalar(tx, `select count(*)::int from public.${table}`)).toBe(0);
      }
      await expect(transfer(tx, BIKE.tanTarmac, null, "Leaving")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  it("the service role reads but cannot write", async () => {
    await asServiceRole(conn, async (tx) => {
      expect(await scalar(tx, "select count(*)::int from public.bikes")).toBe(
        Object.keys(BIKE).length,
      );
    });
    await expect(
      asServiceRole(conn, (tx) => tx.query("update public.customers set phone = '1'")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("customers", () => {
  it("staff create customers; email is not a key and blanks become null", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      const { rows } = await tx.query(
        `insert into public.customers (first_name, last_name, email, phone)
         values ('  Ah Kow ', '', 'Weiming.Tan@Example.com', '   ')
         returning first_name, last_name, email, phone, internal_notes`,
      );
      expect(rows[0]).toEqual({
        first_name: "Ah Kow",
        last_name: null,
        email: "Weiming.Tan@Example.com",
        phone: null,
        internal_notes: null,
      });
      // Same email as the seeded Tan Wei Ming, in another case: allowed.
      // (operator(extensions.=): citext's own equality, which PostgREST
      // finds through its search path; plain `=` here would compare text.)
      expect(
        await scalar(
          tx,
          `select count(*)::int from public.customers
            where email operator(extensions.=) 'weiming.tan@example.com'::extensions.citext`,
        ),
      ).toBe(2);
    });
  });

  it("a customer must identify somebody", async () => {
    await expect(
      asStaff(conn, STAFF.mechanic2, (tx) =>
        tx.query("insert into public.customers (first_name, phone) values (' ', '')"),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "customers_identifies_someone" });
  });

  it("staff edit and archive customers but cannot delete them", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      await tx.query("update public.customers set phone = '+65 9999 0000' where id = $1", [
        CUSTOMER.chloe,
      ]);
      const { rows } = await tx.query<{ id: string }>(
        "insert into public.customers (display_name) values ('Archive Me') returning id",
      );
      await tx.query(
        "update public.customers set phone = '+65 9999 0001', archived_at = now() where id = $1",
        [rows[0].id],
      );
      const chloe = await tx.query("select phone from public.customers where id = $1", [
        CUSTOMER.chloe,
      ]);
      expect(chloe.rows[0].phone).toBe("+65 9999 0000");
      const row = await tx.query("select phone, archived_at from public.customers where id = $1", [
        rows[0].id,
      ]);
      expect(row.rows[0].phone).toBe("+65 9999 0001");
      expect(row.rows[0].archived_at).not.toBeNull();
    });
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query("delete from public.customers where id = $1", [CUSTOMER.chloe]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("signed-in users cannot set the Auth login or Shopify links", async () => {
    for (const sql of [
      `update public.customers set auth_user_id = '${AUTH_USER.mechanic1}' where id = '${CUSTOMER.tan}'`,
      `update public.customers set shopify_customer_id = 'gid://shopify/Customer/1' where id = '${CUSTOMER.tan}'`,
      `insert into public.customers (first_name, auth_user_id) values ('X', '${AUTH_USER.mechanic1}')`,
    ]) {
      await expect(asStaff(conn, STAFF.admin, (tx) => tx.query(sql))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });

  it("keeps search keys: lower-cased names and email, phone digits", async () => {
    const { rows } = await conn.query(
      "select search_text, phone_digits from public.customers where id = $1",
      [CUSTOMER.tan],
    );
    expect(rows[0]).toEqual({
      search_text: "wei ming tan tan wei ming weiming.tan@example.com",
      phone_digits: "6591234567",
    });
  });
});

describe("bike short IDs", () => {
  it("the seed's bikes were numbered by the server in insert order", async () => {
    const { rows } = await conn.query<{ id: string; short_id: string }>(
      "select id, short_id from public.bikes",
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.short_id]));
    for (const [key, id] of Object.entries(BIKE)) {
      expect(byId[id]).toBe(BIKE_SHORT_ID[key as keyof typeof BIKE]);
    }
  });

  createsBikes("are assigned B-###### by the server, increasing and unique", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      const ids: string[] = [];
      for (const model of ["One", "Two", "Three"]) {
        const { rows } = await tx.query(
          "insert into public.bikes (brand, model) values ('Test', $1) returning short_id",
          [model],
        );
        ids.push(rows[0].short_id);
      }
      for (const id of ids) expect(id).toMatch(/^B-\d{6}$/);
      const n = ids.map((id) => Number(id.slice(2)));
      expect(n[1]).toBeGreaterThan(n[0]);
      expect(n[2]).toBeGreaterThan(n[1]);
      expect(n[0]).toBeGreaterThan(10);
      expect(await scalar(tx, "select count(*) = count(distinct short_id) from public.bikes")).toBe(
        true,
      );
    });
  });

  it("cannot be supplied by a signed-in user", async () => {
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query("insert into public.bikes (short_id, brand, model) values ('B-999999', 'X', 'Y')"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  createsBikes("are replaced by the sequence even when the owner supplies one", async () => {
    await inTransaction(conn, async (tx) => {
      const { rows } = await tx.query(
        "insert into public.bikes (short_id, brand, model) values ('B-999999', 'X', 'Y') returning short_id",
      );
      expect(rows[0].short_id).not.toBe("B-999999");
      expect(rows[0].short_id).toMatch(/^B-\d{6}$/);
    });
  });

  it("never change, for any writer", async () => {
    await expect(
      inTransaction(conn, (tx) =>
        tx.query("update public.bikes set short_id = 'B-123456' where id = $1", [BIKE.tanTarmac]),
      ),
    ).rejects.toMatchObject({ code: "P0001", message: "bike_short_id_immutable" });
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query("update public.bikes set short_id = 'B-123456' where id = $1", [BIKE.tanTarmac]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("bikes", () => {
  it("need a brand and a model", async () => {
    await expect(
      asStaff(conn, STAFF.mechanic2, (tx) =>
        tx.query("insert into public.bikes (brand, model) values ('  ', 'Domane')"),
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  createsBikes("may share a serial number (duplicates exist in the real world)", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      await tx.query(
        "insert into public.bikes (brand, model, serial_number) values ('Trek', 'Domane', 'wtu-291c1234k')",
      );
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.bikes where serial_key = 'WTU291C1234K'",
        ),
      ).toBe(2);
    });
  });

  createsBikes("created with an owner, record a registration event with the actor", async () => {
    await asStaff(conn, STAFF.mechanic1, async (tx) => {
      const { rows } = await tx.query(
        "insert into public.bikes (customer_id, brand, model) values ($1, 'Brompton', 'G Line') returning id",
        [CUSTOMER.priya],
      );
      expect(await ownershipEvents(tx, rows[0].id)).toEqual([
        expect.objectContaining({
          event_type: "registered",
          from_customer_id: null,
          to_customer_id: CUSTOMER.priya,
          reason: null,
          actor_staff_id: STAFF.mechanic1,
        }),
      ]);
    });
  });

  createsBikes("created without an owner (a shop bike) record no ownership event", async () => {
    await asStaff(conn, STAFF.mechanic1, async (tx) => {
      const { rows } = await tx.query(
        "insert into public.bikes (brand, model) values ('Cervelo', 'R5') returning id",
      );
      expect(await ownershipEvents(tx, rows[0].id)).toEqual([]);
    });
  });

  createsBikes("cannot be given to an archived customer", async () => {
    await inTransaction(conn, async (tx) => {
      await archiveCustomerUnguarded(tx, CUSTOMER.chloe);
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      await expect(
        tx.query("insert into public.bikes (customer_id, brand, model) values ($1, 'X', 'Y')", [
          CUSTOMER.chloe,
        ]),
      ).rejects.toMatchObject({ code: "P0001", message: "customer_archived" });
    });
  });

  it("change owner only through transfer_bike_ownership, never by a plain update", async () => {
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query("update public.bikes set customer_id = $1 where id = $2", [
          CUSTOMER.priya,
          BIKE.tanTarmac,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Even the owner (SQL editor) needs a reason, so history is never silent.
    await expect(
      inTransaction(conn, (tx) =>
        tx.query("update public.bikes set customer_id = $1 where id = $2", [
          CUSTOMER.priya,
          BIKE.tanTarmac,
        ]),
      ),
    ).rejects.toMatchObject({ code: "P0001", message: "reason_required" });
  });

  it("staff edit details and archive bikes, but cannot delete them", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      const { rows } = await tx.query(
        `update public.bikes set colour = 'Matte Black', serial_number = ' ab-12 3 ', archived_at = now()
         where id = $1 returning colour, serial_number, serial_key`,
        [BIKE.chloeGiant],
      );
      expect(rows[0]).toEqual({
        colour: "Matte Black",
        serial_number: "ab-12 3",
        serial_key: "AB123",
      });
    });
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query("delete from public.bikes where id = $1", [BIKE.chloeGiant]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("transfer_bike_ownership", () => {
  it("moves the bike and appends one event with actor and reason, keeping earlier events", async () => {
    await inTransaction(conn, async (tx) => {
      const before = await ownershipEvents(tx, BIKE.nurulBianchi);
      expect(before.map((e) => e.event_type)).toEqual(["registered", "transferred"]);

      await tx.query(
        `select set_config('request.headers', '{"x-correlation-id": "req-transfer-0001"}', true)`,
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      const bike = await transfer(
        tx,
        BIKE.nurulBianchi,
        CUSTOMER.priya,
        "  Bought it from Nurul  ",
      );
      expect(bike).toEqual({ customer_id: CUSTOMER.priya, short_id: BIKE_SHORT_ID.nurulBianchi });

      const after = await ownershipEvents(tx, BIKE.nurulBianchi);
      expect(after).toHaveLength(3);
      expect(after.slice(0, 2)).toEqual(before);
      expect(after[2]).toEqual({
        id: expect.any(String),
        event_type: "transferred",
        from_customer_id: CUSTOMER.nurul,
        to_customer_id: CUSTOMER.priya,
        reason: "Bought it from Nurul",
        actor_staff_id: STAFF.mechanic2,
        correlation_id: "req-transfer-0001",
      });
    });
  });

  it("moves a bike to the shop (null) and back, each with its own event", async () => {
    await asStaff(conn, STAFF.mechanic1, async (tx) => {
      expect((await transfer(tx, BIKE.tanBrompton, null, "Traded in")).customer_id).toBeNull();
      expect((await transfer(tx, BIKE.tanBrompton, CUSTOMER.hafiz, "Sold")).customer_id).toBe(
        CUSTOMER.hafiz,
      );
      const events = await ownershipEvents(tx, BIKE.tanBrompton);
      expect(events.map((e) => [e.event_type, e.from_customer_id, e.to_customer_id])).toEqual([
        ["registered", null, CUSTOMER.tan],
        ["transferred", CUSTOMER.tan, null],
        ["transferred", null, CUSTOMER.hafiz],
      ]);
    });
  });

  it("needs a reason: null, empty and blank are refused and nothing changes", async () => {
    for (const reason of [null, "", "   "]) {
      await expect(
        asStaff(conn, STAFF.mechanic1, (tx) =>
          transfer(tx, BIKE.tanTarmac, CUSTOMER.priya, reason),
        ),
      ).rejects.toMatchObject({ code: "P0001", message: "reason_required" });
    }
    expect(
      await scalar(conn, "select customer_id from public.bikes where id = $1", [BIKE.tanTarmac]),
    ).toBe(CUSTOMER.tan);
    expect(
      await scalar(
        conn,
        "select count(*)::int from public.bike_ownership_events where bike_id = $1",
        [BIKE.tanTarmac],
      ),
    ).toBe(1);
  });

  it("refuses a reason over 500 characters", async () => {
    await expect(
      asStaff(conn, STAFF.mechanic1, (tx) =>
        transfer(tx, BIKE.tanTarmac, CUSTOMER.priya, "x".repeat(501)),
      ),
    ).rejects.toMatchObject({ code: "P0001", message: "reason_too_long" });
  });

  it("is a no-op when the bike already belongs to that customer", async () => {
    await asStaff(conn, STAFF.mechanic1, async (tx) => {
      expect((await transfer(tx, BIKE.tanTarmac, CUSTOMER.tan, "Again")).customer_id).toBe(
        CUSTOMER.tan,
      );
      expect(await ownershipEvents(tx, BIKE.tanTarmac)).toHaveLength(1);
    });
  });

  it("raises P0002 for an unknown bike or customer", async () => {
    const nobody = "00000000-0000-4000-8000-000000000000";
    for (const [bike, to] of [
      [nobody, CUSTOMER.tan],
      [BIKE.tanTarmac, nobody],
    ]) {
      await expect(
        asStaff(conn, STAFF.mechanic1, (tx) => transfer(tx, bike, to, "Reason")),
      ).rejects.toMatchObject({ code: "P0002" });
    }
  });

  it("refuses archived customers and archived bikes", async () => {
    await inTransaction(conn, async (tx) => {
      await archiveCustomerUnguarded(tx, CUSTOMER.chloe);
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      await expect(transfer(tx, BIKE.tanTarmac, CUSTOMER.chloe, "Sold")).rejects.toMatchObject({
        code: "P0001",
        message: "customer_archived",
      });
    });
    await inTransaction(conn, async (tx) => {
      await tx.query("update public.bikes set archived_at = now() where id = $1", [BIKE.tanTarmac]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic1));
      await expect(transfer(tx, BIKE.tanTarmac, CUSTOMER.priya, "Sold")).rejects.toMatchObject({
        code: "P0001",
        message: "bike_archived",
      });
    });
  });

  it("is for active staff only: a signed-in customer is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const login = await linkCustomerLogin(tx, CUSTOMER.tan);
      await actAs(tx, customerClaims(login));
      await expect(
        transfer(tx, BIKE.tanTarmac, CUSTOMER.priya, "Mine to give"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});

describe("bike_ownership_events", () => {
  it("is append-only for every writer, the owner included", async () => {
    for (const sql of [
      "update public.bike_ownership_events set reason = 'Rewritten'",
      "delete from public.bike_ownership_events",
    ]) {
      await expect(inTransaction(conn, (tx) => tx.query(sql))).rejects.toMatchObject({
        code: "P0001",
        message: "bike_history_append_only",
      });
      await expect(asStaff(conn, STAFF.admin, (tx) => tx.query(sql))).rejects.toMatchObject({
        code: "42501",
      });
    }
    await expect(
      asStaff(conn, STAFF.admin, (tx) =>
        tx.query(
          "insert into public.bike_ownership_events (bike_id, event_type, to_customer_id) values ($1, 'registered', $2)",
          [BIKE.shopCervelo, CUSTOMER.tan],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

// Commits: runs last in this file and only on a per-file clone.
describe.skipIf(!isolatedDatabase())("concurrent transfers", () => {
  it("serialise on the bike row, so the history stays one unbroken chain", async () => {
    const [a, b] = await openConnections(2);
    const run = (c: pg.Client, to: string, reason: string) =>
      inTransaction(
        c,
        async (tx) => {
          await actAs(tx, staffClaims(AUTH_USER.mechanic1));
          return transfer(tx, BIKE.chloeSurly, to, reason);
        },
        { commit: true },
      );
    const results = await Promise.all([
      run(a, CUSTOMER.priya, "Sold to Priya"),
      run(b, CUSTOMER.hafiz, "Sold to Hafiz"),
    ]);
    expect(results.map((r) => r.customer_id).sort()).toEqual(
      [CUSTOMER.priya, CUSTOMER.hafiz].sort(),
    );

    const events = await ownershipEvents(conn, BIKE.chloeSurly);
    expect(events).toHaveLength(3);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].from_customer_id).toBe(events[i - 1].to_customer_id);
    }
    expect(
      await scalar(conn, "select customer_id from public.bikes where id = $1", [BIKE.chloeSurly]),
    ).toBe(events[2].to_customer_id);
  });
});
