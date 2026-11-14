/**
 * Adventures Phase D, group departures (DATA-MODEL §20 "Departures",
 * D193-D195; handoff §6.4; gates C08, S08, S09): dates for a route,
 * joining with a self-supported ticket, places under the departure's lock,
 * the version a rider saw, leaving, cancelling, and what the public sees.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import {
  makeRider,
  offerOn125,
  openSales,
  paidBooking,
  signWaiver,
  type Rider,
  type Sale,
} from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import {
  actAs,
  connect,
  inTransaction,
  isolatedDatabase,
  openConnections,
  scalar,
  staffClaims,
  type Connection,
} from "./harness";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

async function departure(
  tx: Connection,
  sale: Sale,
  capacity = 2,
): Promise<{ id: string; version: number }> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const { rows } = await tx.query<{ id: string; version: number }>(
    `select id, version from public.create_adventure_departure($1, 'self_supported_group', now() + interval '7 days',
       now() + interval '7 days 10 hours', '294 River Valley', $2, 'Coffee first', 'Bring the first-aid kit')`,
    [sale.adventureId, capacity],
  );
  return rows[0];
}

async function join(
  tx: Connection,
  rider: Rider,
  bookingId: string,
  d: { id: string; version: number },
  show = true,
) {
  await actAs(tx, customerClaims(rider.authUserId));
  return tx.query("select * from public.join_adventure_departure($1, $2, $3, $4)", [
    bookingId,
    d.id,
    d.version,
    show,
  ]);
}

async function rider(tx: Connection, sale: Sale, first: string, last: string) {
  const r = await makeRider(tx);
  await tx.query("reset role");
  await tx.query(
    "update public.customers set first_name = $2, last_name = $3, email = $4 where id = $1",
    [r.customerId, first, last, `${first.toLowerCase()}@example.com`],
  );
  return { rider: r, bookingId: await paidBooking(tx, r, sale) };
}

describe("departures (D193)", () => {
  it("staff with manage_adventures add dates; the past and a route without the offer are refused", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.create_adventure_departure($1, 'self_supported_group', now() + interval '1 day', null, 'Shop', 5, '', '')",
            [sale.adventureId],
          ),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.create_adventure_departure($1, 'self_supported_group', now() - interval '1 day', null, 'Shop', 5, '', '')",
            [sale.adventureId],
          ),
        refused("departure_in_past"),
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.create_adventure_departure($1, 'supported', now() + interval '1 day', null, 'Shop', 5, '', '')",
            [sale.adventureId],
          ),
        refused("departure_needs_offer"),
      );
      const d = await departure(tx, sale);
      expect(d.version).toBe(1);
    });
  });
});

describe("joining with a ticket (C08, S08, S09)", () => {
  it("one date per ticket, within its places, at the version the rider saw; leaving keeps the ticket", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const d = await departure(tx, sale, 2);
      const a = await rider(tx, sale, "Aisha", "Tan");
      const b = await rider(tx, sale, "Ben", "Lim");
      const c = await rider(tx, sale, "Chen", "Wei");

      await join(tx, a.rider, a.bookingId, d, true);
      await failsWith(
        tx,
        () => join(tx, a.rider, a.bookingId, d),
        refused("departure_already_joined"),
      );
      // Someone else's booking.
      await failsWith(tx, () => join(tx, a.rider, b.bookingId, d), { code: "42501" });
      await join(tx, b.rider, b.bookingId, d, false);
      await failsWith(tx, () => join(tx, c.rider, c.bookingId, d), refused("departure_full"));

      // Staff move the date: a rider who saw the old version must look again.
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.update_adventure_departure($1, $2, now() + interval '8 days', null, 'Shop', 1, '', '')",
            [d.id, d.version],
          ),
        refused("departure_capacity_below_riders"),
      );
      await tx.query(
        "select public.update_adventure_departure($1, $2, now() + interval '8 days', null, 'Shop', 3, '', '')",
        [d.id, d.version],
      );
      await failsWith(tx, () => join(tx, c.rider, c.bookingId, d), refused("departure_changed"));
      await join(tx, c.rider, c.bookingId, { id: d.id, version: d.version + 1 }, true);

      // The public: places and consenting names, nothing else.
      await actAs(tx, { role: "anon" });
      const pub = await tx.query("select * from public.public_adventure_departures('bicii-125')");
      expect(pub.rows).toHaveLength(1);
      expect(pub.rows[0]).toMatchObject({
        capacity: 3,
        taken: 3,
        meeting_point: "Shop",
        riders: ["Aisha T.", "Chen W."],
      });
      expect(JSON.stringify(pub.rows)).not.toMatch(/@example\.com|first-aid/);

      // Leaving keeps the paid booking.
      await actAs(tx, customerClaims(a.rider.authUserId));
      await tx.query("select public.leave_adventure_departure($1)", [a.bookingId]);
      expect(
        (await tx.query("select * from public.my_adventure_departure($1)", [a.bookingId])).rows,
      ).toEqual([]);
      await tx.query("reset role");
      expect(
        await scalar<string>(
          tx,
          "select status::text from public.adventure_bookings where id = $1",
          [a.bookingId],
        ),
      ).toBe("confirmed");
    });
  });

  it("an unpaid booking, another route's date and a past or cancelled date are refused", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const d = await departure(tx, sale);
      const unpaid = await makeRider(tx);
      await actAs(tx, customerClaims(unpaid.authUserId));
      const { rows } = await tx.query<{ booking_id: string }>(
        `select booking_id from public.prepare_my_adventure_checkout($2, 'bicii-125', 'self_supported', $1, 'M', 'first_name_initial', '2026-11-test')`,
        [sale.revisionNumber, await signWaiver(tx)],
      );
      await failsWith(
        tx,
        () => join(tx, unpaid, rows[0].booking_id, d),
        refused("departure_needs_ticket"),
      );

      const paid = await rider(tx, sale, "Dana", "Ng");
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.cancel_adventure_departure($1, 'Storm warning')", [d.id]);
      await failsWith(
        tx,
        () => join(tx, paid.rider, paid.bookingId, { id: d.id, version: 2 }),
        refused("departure_unavailable"),
      );
    });
  });

  it("cancelling tells every rider by email, keeps their tickets and empties the date", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const d = await departure(tx, sale);
      const a = await rider(tx, sale, "Eve", "Ong");
      await join(tx, a.rider, a.bookingId, d);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_adventure_departure($1, ' ')", [d.id]),
        refused("reason_required"),
      );
      await tx.query("select public.cancel_adventure_departure($1, 'Storm warning')", [d.id]);
      await tx.query("reset role");
      const kinds = await tx.query(
        "select kind::text from private.adventure_notices where booking_id = $1 order by created_at",
        [a.bookingId],
      );
      expect(kinds.rows.map((r) => r.kind)).toEqual([
        "ticket_paid",
        "departure_joined",
        "departure_cancelled",
      ]);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_departure_participants where departure_id = $1 and left_at is null",
          [d.id],
        ),
      ).toBe(0);
      // The email gets the date and meeting point.
      await actAs(tx, { role: "service_role" });
      const claimed = await tx.query(
        "select kind::text, departure_meeting_point from public.claim_adventure_notices(10) where booking_id = $1 order by kind",
        [a.bookingId],
      );
      expect(claimed.rows).toContainEqual({
        kind: "departure_cancelled",
        departure_meeting_point: "294 River Valley",
      });
    });
  });
});

describe.skipIf(!isolatedDatabase())("committed race (S08)", () => {
  it("two riders taking the last place at once: one gets it", async () => {
    const setup = await connect();
    const [one, two] = await openConnections(2);
    try {
      const { d, a, b } = await inTransaction(
        setup,
        async (tx) => {
          const sale = await offerOn125(tx);
          await openSales(tx);
          const dep = await departure(tx, sale, 1);
          return {
            d: dep,
            a: await rider(tx, sale, "Fay", "Koh"),
            b: await rider(tx, sale, "Gus", "Lee"),
          };
        },
        { commit: true },
      );
      const results = await Promise.allSettled([
        inTransaction(one, (tx) => join(tx, a.rider, a.bookingId, d), { commit: true }),
        inTransaction(two, (tx) => join(tx, b.rider, b.bookingId, d), { commit: true }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await scalar<number>(
          setup,
          "select count(*)::int from public.adventure_departure_participants where departure_id = $1 and left_at is null",
          [d.id],
        ),
      ).toBe(1);
    } finally {
      await Promise.all([setup.end(), one.end(), two.end()]);
    }
  });
});
