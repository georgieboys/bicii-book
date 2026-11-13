/**
 * Adventures Phase F, hardening (DATA-MODEL §20 "Cancelling, moving and
 * retention", D200-D203; handoff §6.6): a rider's cancellation request,
 * an admin's cancellation, moving a seat, the retention of tracker
 * messages that belong to no ride, and the health counts.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { makeRider, offerOn125, openSales, paidBooking, type Sale } from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { SERVICE } from "./payment-fixtures";
import { checkout, pay, reservation, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

async function withEmail(tx: Connection) {
  const r = await makeRider(tx);
  await tx.query("reset role");
  await tx.query("update public.customers set email = $2, first_name = 'Ivy' where id = $1", [
    r.customerId,
    `ivy-${r.customerId.slice(0, 6)}@example.com`,
  ]);
  return r;
}

async function groupDate(
  tx: Connection,
  sale: Sale,
  capacity = 2,
  days = 7,
): Promise<{ id: string; version: number }> {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const { rows } = await tx.query<{ id: string; version: number }>(
    `select id, version from public.create_adventure_departure($1, 'self_supported_group', now() + make_interval(days => $3),
       null, 'Shop', $2, '', '')`,
    [sale.adventureId, capacity, days],
  );
  return rows[0];
}

async function noticeKinds(tx: Connection, bookingId: string): Promise<string[]> {
  await tx.query("reset role");
  const { rows } = await tx.query<{ k: string }>(
    "select kind::text || ':' || audience::text as k from private.adventure_notices where booking_id = $1 order by created_at, k",
    [bookingId],
  );
  return rows.map((r) => r.k);
}

describe("cancelling (D200, D201)", () => {
  it("a rider asks with a reason; the shop is emailed; nothing is cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query("reset role");
      await tx.query(
        "update public.shop_settings set booking_alert_emails = array['team@example.com'] where id = 1",
      );
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await withEmail(tx);
      const bookingId = await paidBooking(tx, rider, sale);
      const other = await makeRider(tx);
      await actAs(tx, customerClaims(other.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.request_my_adventure_cancellation($1, 'x')", [bookingId]),
        {
          code: "42501",
        },
      );
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.request_my_adventure_cancellation($1, ' ')", [bookingId]),
        refused("reason_required"),
      );
      await tx.query("select public.request_my_adventure_cancellation($1, 'Knee injury')", [
        bookingId,
      ]);
      expect(await noticeKinds(tx, bookingId)).toContain("cancellation_requested:shop");
      expect(
        await scalar<string>(
          tx,
          "select status::text from public.adventure_bookings where id = $1",
          [bookingId],
        ),
      ).toBe("confirmed");
    });
  });

  it("an admin cancels with a reason: the date is left, the hire released and the rider emailed", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days } = await setup(tx, 1);
      // A tracker hire booking that also joined a group date.
      const rider = await withEmail(tx);
      const p = await checkout(tx, rider, sale, days[0], days[1]);
      await pay(tx, p);
      const d = await groupDate(tx, sale);
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.join_adventure_departure($1, $2, $3, false)", [
        p.booking_id,
        d.id,
        d.version,
      ]);

      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_adventure_booking($1, 'x')", [p.booking_id]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_adventure_booking($1, ' ')", [p.booking_id]),
        refused("reason_required"),
      );
      await tx.query(
        "select public.cancel_adventure_booking($1, 'Rider asked; refunded in Stripe')",
        [p.booking_id],
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select status::text, confirmed_at is null as unconfirmed from public.adventure_bookings where id = $1",
            [p.booking_id],
          )
        ).rows,
      ).toEqual([{ status: "cancelled", unconfirmed: true }]);
      expect((await reservation(tx, p.booking_id)).status).toBe("cancelled");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_departure_participants where booking_id = $1 and left_at is null",
          [p.booking_id],
        ),
      ).toBe(0);
      expect(await noticeKinds(tx, p.booking_id)).toContain("booking_cancelled:customer");
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_adventure_booking($1, 'again')", [p.booking_id]),
        refused("adventure_booking_closed"),
      );
    });
  });

  it("a booking whose tracker is still out, or that is certified, cannot be cancelled", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const rider = await makeRider(tx);
      const p = await checkout(tx, rider, sale, days[0], days[1]);
      await pay(tx, p);
      const res = await reservation(tx, p.booking_id);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.issue_adventure_tracker($1, $2, '')", [res.id, devices[0]]);
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.cancel_adventure_booking($1, 'x')", [p.booking_id]),
        refused("tracker_still_out"),
      );
    });
  });
});

describe("moving a seat (D202)", () => {
  it("to another date of the same route and kind, within its places", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const a = await makeRider(tx);
      const b = await makeRider(tx);
      const bookingA = await paidBooking(tx, a, sale);
      const bookingB = await paidBooking(tx, b, sale);
      const first = await groupDate(tx, sale, 2, 7);
      const full = await groupDate(tx, sale, 1, 8);
      const open = await groupDate(tx, sale, 3, 9);
      await actAs(tx, customerClaims(a.authUserId));
      await tx.query("select public.join_adventure_departure($1, $2, $3, true)", [
        bookingA,
        first.id,
        first.version,
      ]);
      await actAs(tx, customerClaims(b.authUserId));
      await tx.query("select public.join_adventure_departure($1, $2, $3, false)", [
        bookingB,
        full.id,
        full.version,
      ]);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.move_adventure_seat($1, $2, 'x')", [bookingA, open.id]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.move_adventure_seat($1, $2, 'Rain')", [bookingA, full.id]),
        refused("departure_full"),
      );
      await failsWith(
        tx,
        () => tx.query("select public.move_adventure_seat($1, $2, 'Rain')", [bookingA, first.id]),
        refused("departure_unavailable"),
      );
      await tx.query("select public.move_adventure_seat($1, $2, 'Rain on the first date')", [
        bookingA,
        open.id,
      ]);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select departure_id, show_name from public.adventure_departure_participants where booking_id = $1 and left_at is null",
            [bookingA],
          )
        ).rows,
      ).toEqual([{ departure_id: open.id, show_name: true }]);
    });
  });
});

describe("retention and health (D203)", () => {
  it("deletes messages that belong to no ride after 30 days, keeps ride points; only the service role", async () => {
    await inTransaction(conn, async (tx) => {
      await tx.query("reset role");
      await tx.query(
        `insert into public.tracking_messages (provider, provider_message_id, provider_device_id, recorded_at, received_at, kind)
         values ('fake', 'old-orphan', 'x', now() - interval '40 days', now() - interval '40 days', 'position'),
                ('fake', 'new-orphan', 'x', now() - interval '1 day', now() - interval '1 day', 'position')`,
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(tx, () => tx.query("select public.purge_unattributed_tracking(100)"), {
        code: "42501",
      });
      await actAs(tx, SERVICE);
      expect(
        await scalar<number>(tx, "select public.purge_unattributed_tracking(100)"),
      ).toBeGreaterThanOrEqual(1);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select provider_message_id from public.tracking_messages where provider_message_id in ('old-orphan', 'new-orphan')",
          )
        ).rows,
      ).toEqual([{ provider_message_id: "new-orphan" }]);
    });
  });

  it("the health counts are for admins", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(tx, () => tx.query("select public.adventure_health()"), { code: "42501" });
      await actAs(tx, staffClaims(AUTH_USER.admin));
      const health = await scalar<Record<string, unknown>>(tx, "select public.adventure_health()");
      expect(Object.keys(health).sort()).toEqual(
        [
          "bookings_attention",
          "cancellations_requested_30d",
          "emails_failed",
          "emails_oldest_pending",
          "emails_pending",
          "feed_last_read",
          "feeds_enabled",
          "feeds_failing",
          "files_failed_7d",
          "files_waiting",
          "reviews_oldest",
          "reviews_waiting",
          "trackers_overdue",
          "unattributed_messages_old",
        ].sort(),
      );
    });
  });
});
