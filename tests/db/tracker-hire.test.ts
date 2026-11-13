/**
 * Adventures Phase C, tracker hire (DATA-MODEL §20 "Tracker hire",
 * D185-D188; handoff §9.6 capacity and history, §11.3, §11.4; gates P06,
 * C09-C11): hire at checkout, the fleet capacity rule, the hire following
 * its booking, and issuing, replacing and returning a tracker.
 *
 * Rolled-back transactions; the race commits on this file's own clone.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { makeRider, offerOn125, openSales, type Sale } from "./adventure-fixtures";
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
import { checkout, openDays, pay, reservation, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

describe("hire at checkout (D186, D187)", () => {
  it("is off until an admin turns it on; a manager cannot", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const [d1, d2] = await openDays(tx, 2);
      const rider = await makeRider(tx);
      await failsWith(
        tx,
        () => checkout(tx, rider, sale, d1, d2),
        refused("adventure_tracker_hire_closed"),
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(tx, () => tx.query("select public.set_adventure_tracker_hire(true, 7)"), {
        code: "42501",
      });
    });
  });

  it("prices the days on a second line and holds a tracker until the payment page expires", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx);
      const rider = await makeRider(tx);
      const p = await checkout(tx, rider, sale, days[0], days[2]);
      const r = await reservation(tx, p.booking_id);
      const hireDays = r.days;
      expect(p.amount).toBe((49 + 20 * hireDays).toFixed(2));
      expect(r).toMatchObject({
        status: "held",
        held: true,
        collect_on: days[0],
        return_on: days[2],
      });
      const lines = await tx.query(
        "select kind, quantity, unit_price::text from public.adventure_booking_lines where booking_id = $1 order by position",
        [p.booking_id],
      );
      expect(lines.rows).toEqual([
        { kind: "certification", quantity: 1, unit_price: "49.00" },
        { kind: "tracker_hire", quantity: hireDays, unit_price: "20.00" },
      ]);
      expect(
        await scalar<boolean>(
          tx,
          `select r.hold_until = p.stripe_session_expires_at from public.tracker_reservations r
             join public.adventure_payments p on p.booking_id = r.booking_id where r.booking_id = $1`,
          [p.booking_id],
        ),
      ).toBe(true);
    });
  });

  it("refuses bad dates and closed days", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx);
      const rider = await makeRider(tx);
      const today = await scalar<string>(tx, "select private.shop_today()::text");
      await failsWith(
        tx,
        () => checkout(tx, rider, sale, today, days[1]),
        refused("adventure_hire_dates_invalid"),
      );
      await failsWith(
        tx,
        () => checkout(tx, rider, sale, days[1], days[1]),
        refused("adventure_hire_dates_invalid"),
      );
      const far = await scalar<string>(tx, "select ($1::date + 8)::text", [days[0]]);
      await failsWith(
        tx,
        () => checkout(tx, rider, sale, days[0], far),
        refused("adventure_hire_dates_invalid"),
      );
      // Close the shop on the return day.
      await tx.query("reset role");
      await tx.query(
        `insert into public.closure_overrides (kind, starts_at, ends_at, reason)
         values ('closed', private.shop_day_start($1::date), private.shop_day_start($1::date + 1), 'Test')`,
        [days[1]],
      );
      await failsWith(
        tx,
        () => checkout(tx, rider, sale, days[0], days[1]),
        refused("adventure_hire_day_closed"),
      );
    });
  });

  it("never sells more overlapping hires than trackers in service (P06)", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      const a = await checkout(tx, await makeRider(tx), sale, days[0], days[2]);
      const other = await makeRider(tx);
      // Overlapping: refused while A's hold runs.
      await failsWith(
        tx,
        () => checkout(tx, other, sale, days[1], days[3]),
        refused("adventure_trackers_unavailable"),
      );
      // Touching (A returns on days[2], B collects then): fine.
      const b = await checkout(tx, other, sale, days[2], days[4]);
      expect((await reservation(tx, b.booking_id)).status).toBe("held");
      // A's hold lapses: its days are free again.
      await tx.query("reset role");
      await tx.query(
        "update public.tracker_reservations set hold_until = now() - interval '1 second' where booking_id = $1",
        [a.booking_id],
      );
      const c = await checkout(tx, await makeRider(tx), sale, days[0], days[1]);
      expect((await reservation(tx, c.booking_id)).status).toBe("held");
    });
  });

  it("the hire follows the booking: paid confirms it, an expired checkout releases it", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      const p = await checkout(tx, await makeRider(tx), sale, days[0], days[1]);
      await pay(tx, p);
      expect(await reservation(tx, p.booking_id)).toMatchObject({
        status: "confirmed",
        held: false,
      });

      const q = await checkout(tx, await makeRider(tx), sale, days[2], days[3]);
      await tx.query("reset role");
      await tx.query(
        "update public.adventure_bookings set status = 'expired', expired_at = now() where id = $1",
        [q.booking_id],
      );
      expect(await reservation(tx, q.booking_id)).toMatchObject({
        status: "cancelled",
        held: false,
      });
    });
  });

  it("a payment after the hold lapsed, with the tracker gone, is kept and flagged (C10)", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      const late = await checkout(tx, await makeRider(tx), sale, days[0], days[2]);
      await tx.query("reset role");
      await tx.query(
        "update public.tracker_reservations set hold_until = now() - interval '1 second' where booking_id = $1",
        [late.booking_id],
      );
      const taken = await checkout(tx, await makeRider(tx), sale, days[0], days[2]);
      await pay(tx, taken);
      await pay(tx, late);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select status::text, needs_attention from public.adventure_bookings where id = $1",
            [late.booking_id],
          )
        ).rows,
      ).toEqual([{ status: "confirmed", needs_attention: true }]);
    });
  });
});

describe("issue, replace and return (D188; C11)", () => {
  async function paidHire(tx: Connection, sale: Sale, collect: string, back: string) {
    const rider = await makeRider(tx);
    const p = await checkout(tx, rider, sale, collect, back);
    await pay(tx, p);
    return {
      rider,
      bookingId: p.booking_id,
      reservationId: (await reservation(tx, p.booking_id)).id,
    };
  }

  async function issue(tx: Connection, reservationId: string, deviceId: string) {
    await actAs(tx, staffClaims(AUTH_USER.manager));
    return scalar<string>(
      tx,
      "select id from public.issue_adventure_tracker($1, $2, 'Charged, case ok')",
      [reservationId, deviceId],
    );
  }

  it("issues once, to a paid hire, a device in service that nobody holds", async () => {
    await inTransaction(conn, async (tx) => {
      const {
        sale,
        days,
        devices: [d1, d2],
      } = await setup(tx, 2);
      const unpaid = await checkout(tx, await makeRider(tx), sale, days[2], days[3]);
      const hire = await paidHire(tx, sale, days[0], days[1]);
      const other = await paidHire(tx, sale, days[0], days[1]);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () =>
          tx.query("select public.issue_adventure_tracker($1, $2, '')", [hire.reservationId, d1]),
        {
          code: "42501",
        },
      );
      const unpaidId = (await reservation(tx, unpaid.booking_id)).id;
      await failsWith(tx, () => issue(tx, unpaidId, d1), refused("tracker_hire_not_confirmed"));

      await issue(tx, hire.reservationId, d1);
      await failsWith(
        tx,
        () => issue(tx, hire.reservationId, d2),
        refused("tracker_already_issued"),
      );
      await failsWith(tx, () => issue(tx, other.reservationId, d1), refused("tracker_in_use"));
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.set_tracking_device_state($1, 'maintenance', '')", [d1]),
        refused("tracker_in_use"),
      );
      await tx.query("select public.set_tracking_device_state($1, 'maintenance', 'Battery')", [d2]);
      await failsWith(
        tx,
        () => issue(tx, other.reservationId, d2),
        refused("tracker_not_in_service"),
      );

      // The rider sees their tracker; another rider sees nothing.
      await actAs(tx, customerClaims(hire.rider.authUserId));
      const mine = await tx.query(
        "select status::text, device_label is not null as has_device from public.my_adventure_tracker($1)",
        [hire.bookingId],
      );
      expect(mine.rows).toEqual([{ status: "confirmed", has_device: true }]);
      await actAs(tx, customerClaims(other.rider.authUserId));
      expect(
        (await tx.query("select * from public.my_adventure_tracker($1)", [hire.bookingId])).rows,
      ).toEqual([]);
    });
  });

  it("a replacement keeps both assignments on the same attempt and sends the old one to maintenance", async () => {
    await inTransaction(conn, async (tx) => {
      const {
        sale,
        days,
        devices: [d1, d2],
      } = await setup(tx, 2);
      const hire = await paidHire(tx, sale, days[0], days[1]);
      const first = await issue(tx, hire.reservationId, d1);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.replace_adventure_tracker($1, $2, ' ')", [first, d2]),
        refused("reason_required"),
      );
      await tx.query("select public.replace_adventure_tracker($1, $2, 'No fixes since noon')", [
        first,
        d2,
      ]);
      await tx.query("reset role");
      const { rows } = await tx.query(
        `select x.device_id = $2 as is_second, x.returned_at is null as open, x.return_condition::text as cond,
                (select pg_catalog.count(distinct y.attempt_id) from public.tracker_assignments y where y.reservation_id = $1) as attempts
           from public.tracker_assignments x where x.reservation_id = $1 order by x.issued_at, x.returned_at nulls last`,
        [hire.reservationId, d2],
      );
      expect(rows).toEqual([
        { is_second: false, open: false, cond: "faulty", attempts: "1" },
        { is_second: true, open: true, cond: null, attempts: "1" },
      ]);
      expect(
        await scalar<string>(
          tx,
          "select service_state::text from public.tracking_devices where id = $1",
          [d1],
        ),
      ).toBe("maintenance");
      await failsWith(
        tx,
        () => tx.query("delete from public.tracker_assignments where id = $1", [first]),
        refused("tracker_assignment_immutable"),
      );
    });
  });

  it("a good return frees the tracker; a lost one leaves the fleet; a late one says so", async () => {
    await inTransaction(conn, async (tx) => {
      const {
        sale,
        days,
        devices: [d1],
      } = await setup(tx, 1);
      const hire = await paidHire(tx, sale, days[0], days[1]);
      const a = await issue(tx, hire.reservationId, d1);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.return_adventure_tracker($1, 'good', '')", [a]);
      await failsWith(
        tx,
        () => tx.query("select public.return_adventure_tracker($1, 'good', '')", [a]),
        refused("tracker_already_returned"),
      );
      expect((await reservation(tx, hire.bookingId)).status).toBe("completed");
      expect(
        await scalar<string>(
          tx,
          "select service_state::text from public.tracking_devices where id = $1",
          [d1],
        ),
      ).toBe("in_service");

      // The same tracker goes out again, and is lost: the fleet shrinks to none.
      const next = await paidHire(tx, sale, days[2], days[3]);
      const b = await issue(tx, next.reservationId, d1);
      await tx.query("reset role");
      await tx.query(
        "update public.tracker_reservations set return_on = private.shop_today() - 1, collect_on = private.shop_today() - 2 where id = $1",
        [next.reservationId],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.return_adventure_tracker($1, 'lost', 'Left at a checkpoint')", [
        b,
      ]);
      await tx.query("reset role");
      expect(
        await scalar<string>(
          tx,
          "select service_state::text from public.tracking_devices where id = $1",
          [d1],
        ),
      ).toBe("lost");
      expect(
        await scalar<string>(
          tx,
          "select detail ->> 'note' from public.adventure_booking_events where booking_id = $1 and kind = 'tracker_returned'",
          [next.bookingId],
        ),
      ).toMatch(/after its return day/);
      const latecomer = await makeRider(tx);
      await failsWith(
        tx,
        () => checkout(tx, latecomer, sale, days[4], days[5]),
        refused("adventure_trackers_unavailable"),
      );
    });
  });

  it("a tracker still out after its return day keeps blocking later days", async () => {
    await inTransaction(conn, async (tx) => {
      const {
        sale,
        days,
        devices: [d1],
      } = await setup(tx, 1);
      const hire = await paidHire(tx, sale, days[0], days[1]);
      await issue(tx, hire.reservationId, d1);
      // Its return day passes without a return.
      await tx.query("reset role");
      await tx.query(
        "update public.tracker_reservations set collect_on = private.shop_today() - 3, return_on = private.shop_today() - 1 where id = $1",
        [hire.reservationId],
      );
      const latecomer = await makeRider(tx);
      await failsWith(
        tx,
        () => checkout(tx, latecomer, sale, days[4], days[5]),
        refused("adventure_trackers_unavailable"),
      );
    });
  });

  it("an admin cancels a hire nobody collected, with a reason", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      const hire = await paidHire(tx, sale, days[0], days[1]);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_tracker_hire($1, 'x')", [hire.reservationId]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.cancel_tracker_hire($1, 'Rider brings their own Garmin')", [
        hire.reservationId,
      ]);
      expect((await reservation(tx, hire.bookingId)).status).toBe("cancelled");
      // Free again.
      const p = await checkout(tx, await makeRider(tx), sale, days[0], days[1]);
      expect((await reservation(tx, p.booking_id)).status).toBe("held");
    });
  });
});

describe("public availability hint", () => {
  it("says whether hire is on and a tracker is free on those days", async () => {
    await inTransaction(conn, async (tx) => {
      const { days } = await setup(tx, 1);
      await actAs(tx, { role: "anon" });
      const { rows } = await tx.query("select * from public.adventure_tracker_hire_state($1, $2)", [
        days[0],
        days[1],
      ]);
      expect(rows).toEqual([{ enabled: true, max_days: 7, available: true }]);
      const bare = await tx.query("select available from public.adventure_tracker_hire_state()");
      expect(bare.rows).toEqual([{ available: null }]);
    });
  });
});

describe.skipIf(!isolatedDatabase())("committed race (P06)", () => {
  it("two riders asking for the last tracker at once: one holds it", async () => {
    const setupConn = await connect();
    const [one, two] = await openConnections(2);
    try {
      const { sale, days, riders } = await inTransaction(
        setupConn,
        async (tx) => {
          const s = await setup(tx, 1);
          return { ...s, riders: [await makeRider(tx), await makeRider(tx)] };
        },
        { commit: true },
      );
      const results = await Promise.allSettled([
        inTransaction(one, (tx) => checkout(tx, riders[0], sale, days[0], days[2]), {
          commit: true,
        }),
        inTransaction(two, (tx) => checkout(tx, riders[1], sale, days[1], days[3]), {
          commit: true,
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await scalar<number>(
          setupConn,
          "select count(*)::int from public.tracker_reservations where status = 'held' and collect_on in ($1::date, $2::date)",
          [days[0], days[1]],
        ),
      ).toBe(1);
    } finally {
      await Promise.all([setupConn.end(), one.end(), two.end()]);
    }
  });
});
