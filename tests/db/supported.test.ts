/**
 * Adventures Phase E, supported departures (DATA-MODEL §20 "Departures",
 * D196-D199; handoff §6.5; gates P04, S04, S10, A05): buying a seat on a
 * supported date with its included tracker, the seat and tracker held and
 * confirmed together, the separate sales switch, staff on a departure, and
 * facilitators' check-ins and observations.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER, STAFF } from "../fixtures/ids";
import { makeRider, TERMS, type Rider } from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { pay, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

/** BICII 125 with a supported offer (S$149, one day) published, supported sales on, `fleet` trackers. */
async function supportedSetup(tx: Connection, fleet = 1) {
  const base = await setup(tx, fleet);
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const { rows } = await tx.query<{ id: string; revision_number: number }>(
    "select id, revision_number from public.start_adventure_draft($1)",
    [base.sale.adventureId],
  );
  await tx.query(
    "select public.set_adventure_offer($1, 'supported', 149, null, 1, 'Support van, tracker')",
    [rows[0].id],
  );
  await tx.query("select public.publish_adventure_revision($1, null)", [rows[0].id]);
  await actAs(tx, staffClaims(AUTH_USER.admin));
  await tx.query("select public.set_adventure_supported_sales(true)");
  return { ...base, revision: rows[0].revision_number };
}

async function supportedDate(tx: Connection, adventureId: string, capacity = 2): Promise<string> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  return scalar<string>(
    tx,
    `select id from public.create_adventure_departure($1, 'supported', now() + interval '10 days',
       now() + interval '10 days 12 hours', '294 River Valley', $2, 'Van leaves at 6', '')`,
    [adventureId, capacity],
  );
}

type Prepared = { booking_id: string; payment_id: string; amount: string; amount_cents: string };

async function buySeat(
  tx: Connection,
  rider: Rider,
  revision: number,
  departureId: string | null,
): Promise<Prepared> {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<Prepared>(
    `select booking_id, payment_id, amount::text, amount_cents::text from public.prepare_my_adventure_checkout(
       $1, 'bicii-125', 'supported', $2, 'M', 'first_name_initial', $3, departure_id => $4)`,
    [randomUUID(), revision, TERMS, departureId],
  );
  return rows[0];
}

async function seat(tx: Connection, bookingId: string) {
  await tx.query("reset role");
  const { rows } = await tx.query(
    `select p.hold_until is not null as held, p.left_at is not null as left_, r.status::text as tracker
       from public.adventure_departure_participants p
       join public.tracker_reservations r on r.booking_id = p.booking_id
      where p.booking_id = $1`,
    [bookingId],
  );
  return rows[0] as { held: boolean; left_: boolean; tracker: string };
}

describe("buying a supported seat (D196, D197; P04, S04)", () => {
  it("is off until an admin turns supported sales on", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, revision } = await supportedSetup(tx);
      const d = await supportedDate(tx, sale.adventureId);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(tx, () => tx.query("select public.set_adventure_supported_sales(false)"), {
        code: "42501",
      });
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.set_adventure_supported_sales(false)");
      const late = await makeRiderAs(tx);
      await failsWith(
        tx,
        () => buySeat(tx, late, revision, d),
        refused("adventure_supported_closed"),
      );
    });
  });

  it("prices the seat all-inclusive and holds the seat and its tracker together", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, revision } = await supportedSetup(tx);
      const d = await supportedDate(tx, sale.adventureId);
      const rider = await makeRiderAs(tx);
      await failsWith(
        tx,
        () => buySeat(tx, rider, revision, null),
        refused("departure_unavailable"),
      );
      const p = await buySeat(tx, rider, revision, d);
      expect(p.amount).toBe("149.00");
      expect(await seat(tx, p.booking_id)).toEqual({ held: true, left_: false, tracker: "held" });
      const days = await tx.query(
        `select r.collect_on = (d.starts_at at time zone 'Asia/Singapore')::date as same_day,
                r.return_on = (d.expected_finish_at at time zone 'Asia/Singapore')::date + 1 as next_day
           from public.tracker_reservations r, public.adventure_departures d where r.booking_id = $1 and d.id = $2`,
        [p.booking_id, d],
      );
      expect(days.rows).toEqual([{ same_day: true, next_day: true }]);
      expect(
        (
          await tx.query("select kind from public.adventure_booking_lines where booking_id = $1", [
            p.booking_id,
          ])
        ).rows,
      ).toEqual([{ kind: "certification" }]);
    });
  });

  it("never sells more seats than places, nor a seat without a tracker", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, revision } = await supportedSetup(tx, 2);
      const d = await supportedDate(tx, sale.adventureId, 1);
      const a = await buySeat(tx, await makeRiderAs(tx), revision, d);
      const b = await makeRiderAs(tx);
      await failsWith(tx, () => buySeat(tx, b, revision, d), refused("departure_full"));
      // A's hold lapses: the place is free again.
      await tx.query("reset role");
      await tx.query(
        "update public.adventure_departure_participants set hold_until = now() - interval '1 second' where booking_id = $1",
        [a.booking_id],
      );
      await tx.query(
        "update public.tracker_reservations set hold_until = now() - interval '1 second' where booking_id = $1",
        [a.booking_id],
      );
      await buySeat(tx, b, revision, d);

      // Another date, but no tracker free on its day.
      const other = await supportedDate(tx, sale.adventureId, 5);
      await tx.query("reset role");
      await tx.query("update public.tracking_devices set service_state = 'maintenance'");
      const nobody = await makeRiderAs(tx);
      await failsWith(
        tx,
        () => buySeat(tx, nobody, revision, other),
        refused("adventure_trackers_unavailable"),
      );
    });
  });

  it("paid confirms the seat and tracker and emails the date; an expired checkout releases both; no leaving online", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, revision } = await supportedSetup(tx, 2);
      const d = await supportedDate(tx, sale.adventureId);
      const rider = await makeRiderAs(tx);
      const p = await buySeat(tx, rider, revision, d);
      await pay(tx, p);
      expect(await seat(tx, p.booking_id)).toEqual({
        held: false,
        left_: false,
        tracker: "confirmed",
      });
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_booking_events where booking_id = $1 and kind = 'departure_joined'",
          [p.booking_id],
        ),
      ).toBe(1);
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.leave_adventure_departure($1)", [p.booking_id]),
        refused("departure_supported_seat"),
      );

      const q = await buySeat(tx, await makeRiderAs(tx), revision, d);
      await tx.query("reset role");
      await tx.query(
        "update public.adventure_bookings set status = 'expired', expired_at = now() where id = $1",
        [q.booking_id],
      );
      expect(await seat(tx, q.booking_id)).toEqual({
        held: false,
        left_: true,
        tracker: "cancelled",
      });
    });
  });
});

describe("staff on a departure (D199; S10, A05)", () => {
  it("an assigned facilitator checks riders in and records observations; others cannot; observations stay as written", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, revision } = await supportedSetup(tx, 2);
      const d = await supportedDate(tx, sale.adventureId);
      const rider = await makeRiderAs(tx);
      const p = await buySeat(tx, rider, revision, d);
      await pay(tx, p);
      // mechanic2 gets facilitate_adventures, but is not yet on this date.
      await tx.query("reset role");
      await tx.query(
        "insert into public.staff_permissions (staff_id, permission) values ($1, 'facilitate_adventures')",
        [STAFF.mechanic2],
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.check_in_departure_rider($1, $2)", [d, p.booking_id]),
        { code: "42501" },
      );
      await failsWith(
        tx,
        () =>
          tx.query("select public.assign_departure_staff($1, $2, 'lead')", [d, STAFF.mechanic2]),
        {
          code: "42501",
        },
      );

      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.assign_departure_staff($1, $2, 'facilitator')", [
        d,
        STAFF.mechanic2,
      ]);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await tx.query("select public.check_in_departure_rider($1, $2)", [d, p.booking_id]);
      await tx.query(
        "select public.record_departure_observation($1, $2, 'deviation', 'Took the coast road after Changi')",
        [d, p.booking_id],
      );
      await failsWith(
        tx,
        () => tx.query("select public.record_departure_observation($1, null, 'note', ' ')", [d]),
        refused("reason_required"),
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select kind::text, body from public.adventure_departure_observations where departure_id = $1 order by created_at, kind",
            [d],
          )
        ).rows,
      ).toEqual([
        { kind: "attendance", body: "Checked in" },
        { kind: "deviation", body: "Took the coast road after Changi" },
      ]);
      expect(
        await scalar<boolean>(
          tx,
          "select checked_in_at is not null from public.adventure_departure_participants where booking_id = $1",
          [p.booking_id],
        ),
      ).toBe(true);
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.adventure_departure_observations where departure_id = $1", [
            d,
          ]),
        refused("departure_observation_immutable"),
      );
      // Observations never certify: the attempt has no certificate.
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_certificates where booking_id = $1",
          [p.booking_id],
        ),
      ).toBe(0);
    });
  });
});

/** makeRider leaves the connection as the table owner; the checkout acts as the rider. */
async function makeRiderAs(tx: Connection): Promise<Rider> {
  await tx.query("reset role");
  return makeRider(tx);
}
