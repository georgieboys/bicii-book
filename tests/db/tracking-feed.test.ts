/**
 * Adventures Phase C, the tracking feed (DATA-MODEL §20 "Tracking feed",
 * D189-D190; handoff §12, gates T01-T09): messages stored once across
 * feeds, attributed by recorded time to the attempt that held the device
 * inside its ride window, Start/Finish Ride, staff corrections, and the
 * feed's lease, cursor and back-off.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { makeRider, type Rider } from "./adventure-fixtures";
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

/** A feed (as the admin), enabled and due. */
async function feed(tx: Connection, configName = "TRACKING_FEED_TEST"): Promise<string> {
  await actAs(tx, staffClaims(AUTH_USER.admin));
  return scalar<string>(
    tx,
    "select id from public.save_tracking_feed(null, 'fake', 'Test feed', $1, true)",
    [configName],
  );
}

async function claim(tx: Connection) {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query("select * from public.claim_tracking_feed()");
  return rows[0] as { feed_id: string; lease_token: string } | undefined;
}

type Msg = {
  id: string;
  device: string;
  at: string;
  kind?: string;
  lat?: number | null;
  lon?: number | null;
};

/** Claims a feed and stores messages as one complete window. Returns how many were new. */
async function deliverMessages(tx: Connection, feedId: string, msgs: Msg[]): Promise<number> {
  await tx.query("reset role");
  await tx.query(
    "update public.tracking_feeds set next_request_at = now() - interval '1 second', lease_until = null, lease_token = null where id = $1",
    [feedId],
  );
  const c = await claim(tx);
  return scalar<number>(
    tx,
    "select public.store_tracking_messages($1, $2, $3::jsonb, true, now(), null)",
    [
      c!.feed_id,
      c!.lease_token,
      JSON.stringify(
        msgs.map((m) => ({
          providerMessageId: m.id,
          providerDeviceId: m.device,
          recordedAt: m.at,
          kind: m.kind ?? "position",
          latitude: m.lat === undefined ? 1.3 : m.lat,
          longitude: m.lon === undefined ? 103.8 : m.lon,
        })),
      ),
    ],
  );
}

async function at(tx: Connection, offset: string): Promise<string> {
  return scalar<string>(tx, `select (now() + interval '${offset}')::text`);
}

/** A paid hire with a tracker given out 3 hours ago. */
async function rideWithTracker(
  tx: Connection,
  sale: Awaited<ReturnType<typeof setup>>["sale"],
  days: string[],
  deviceId: string,
) {
  const rider = await makeRider(tx);
  const p = await checkout(tx, rider, sale, days[0], days[1]);
  await pay(tx, p);
  const res = await reservation(tx, p.booking_id);
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const assignment = await scalar<string>(
    tx,
    "select id from public.issue_adventure_tracker($1, $2, '')",
    [res.id, deviceId],
  );
  await tx.query("reset role");
  await tx.query("set local session_replication_role = replica");
  await tx.query(
    "update public.tracker_assignments set issued_at = now() - interval '3 hours' where id = $1",
    [assignment],
  );
  await tx.query("set local session_replication_role = origin");
  const attempt = await scalar<string>(
    tx,
    "select attempt_id from public.tracker_assignments where id = $1",
    [assignment],
  );
  return { rider, bookingId: p.booking_id, assignment, attempt };
}

async function providerId(tx: Connection, deviceId: string): Promise<string> {
  await tx.query("reset role");
  return scalar<string>(
    tx,
    "select provider_device_id from public.tracking_devices where id = $1",
    [deviceId],
  );
}

async function correct(
  tx: Connection,
  attempt: string,
  from: string,
  to: string | null,
  staff = AUTH_USER.manager,
) {
  await actAs(tx, staffClaims(staff));
  await tx.query(
    "select public.correct_adventure_capture($1, $2::timestamptz, $3::timestamptz, 'Missed the Start button')",
    [attempt, from, to],
  );
}

async function attributed(tx: Connection) {
  await tx.query("reset role");
  const { rows } = await tx.query<{ provider_message_id: string; attempt_id: string | null }>(
    "select provider_message_id, attempt_id from public.tracking_messages order by provider_message_id",
  );
  return Object.fromEntries(rows.map((r) => [r.provider_message_id, r.attempt_id]));
}

describe("attribution by recorded time (D189; T01-T05)", () => {
  it("only points recorded inside the ride window, while the rider held the device", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const f = await feed(tx);
      const r = await rideWithTracker(tx, sale, days, devices[0]);
      const dev = await providerId(tx, devices[0]);
      await correct(tx, r.attempt, await at(tx, "-2 hours"), await at(tx, "-1 hour"));
      await deliverMessages(tx, f, [
        { id: "before", device: dev, at: await at(tx, "-150 minutes") },
        { id: "inside", device: dev, at: await at(tx, "-90 minutes") },
        { id: "after", device: dev, at: await at(tx, "-30 minutes") },
        { id: "unknown-device", device: "nobody", at: await at(tx, "-90 minutes") },
      ]);
      const owner = await attributed(tx);
      expect(owner).toEqual({
        after: null,
        before: null,
        inside: r.attempt,
        "unknown-device": null,
      });
    });
  });

  it("a late delivery recorded inside the window joins the ride, even after the device went to someone else", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const f = await feed(tx);
      const first = await rideWithTracker(tx, sale, days, devices[0]);
      const dev = await providerId(tx, devices[0]);
      await correct(tx, first.attempt, await at(tx, "-150 minutes"), await at(tx, "-100 minutes"));
      // Returned, then given to the next rider.
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.return_adventure_tracker($1, 'good', '')", [first.assignment]);
      await tx.query("reset role");
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        "update public.tracker_assignments set returned_at = now() - interval '90 minutes' where id = $1",
        [first.assignment],
      );
      await tx.query("set local session_replication_role = origin");
      const second = await rideWithTracker(tx, sale, [days[2], days[3]], devices[0]);
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        "update public.tracker_assignments set issued_at = now() - interval '60 minutes' where id = $1",
        [second.assignment],
      );
      await tx.query("set local session_replication_role = origin");
      await correct(tx, second.attempt, await at(tx, "-50 minutes"), null);
      // Both arrive now.
      await deliverMessages(tx, f, [
        { id: "first-ride", device: dev, at: await at(tx, "-120 minutes") },
        { id: "second-ride", device: dev, at: await at(tx, "-10 minutes") },
      ]);
      expect(await attributed(tx)).toEqual({
        "first-ride": first.attempt,
        "second-ride": second.attempt,
      });
    });
  });

  it("one message once across feeds; an invalid position is kept without a place", async () => {
    await inTransaction(conn, async (tx) => {
      const { devices } = await setup(tx, 1);
      const dev = await providerId(tx, devices[0]);
      const a = await feed(tx, "TRACKING_FEED_A");
      const b = await feed(tx, "TRACKING_FEED_B");
      const msg = { id: "m1", device: dev, at: await at(tx, "-5 minutes") };
      expect(await deliverMessages(tx, a, [msg])).toBe(1);
      expect(await deliverMessages(tx, b, [msg])).toBe(0);
      expect(
        await deliverMessages(tx, a, [
          {
            id: "m2",
            device: dev,
            at: await at(tx, "-4 minutes"),
            kind: "check_in",
            lat: -99999,
            lon: -99999,
          },
        ]),
      ).toBe(1);
      await tx.query("reset role");
      const { rows } = await tx.query(
        "select provider_message_id, kind::text, latitude is null as no_place from public.tracking_messages order by provider_message_id",
      );
      expect(rows).toEqual([
        { provider_message_id: "m1", kind: "position", no_place: false },
        { provider_message_id: "m2", kind: "check_in", no_place: true },
      ]);
    });
  });
});

describe("Start Ride and Finish Ride (D189; T06-T08)", () => {
  it("only with a tracker in hand, once each, and only the rider's own", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const noTracker = await makeRider(tx);
      const p = await checkout(tx, noTracker, sale, days[2], days[3]);
      await pay(tx, p);
      await actAs(tx, customerClaims(noTracker.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.start_my_adventure_ride($1)", [p.booking_id]),
        refused("adventure_tracker_not_issued"),
      );

      const r = await rideWithTracker(tx, sale, days, devices[0]);
      const other: Rider = noTracker;
      await actAs(tx, customerClaims(other.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.start_my_adventure_ride($1)", [r.bookingId]),
        { code: "42501" },
      );

      await actAs(tx, customerClaims(r.rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]),
        refused("adventure_ride_not_started"),
      );
      await tx.query("select public.start_my_adventure_ride($1)", [r.bookingId]);
      await failsWith(
        tx,
        () => tx.query("select public.start_my_adventure_ride($1)", [r.bookingId]),
        refused("adventure_ride_already_started"),
      );
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      await failsWith(
        tx,
        () => tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]),
        refused("adventure_ride_already_finished"),
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select kind::text from public.adventure_booking_events where booking_id = $1 and kind in ('ride_started','ride_finished') order by created_at, kind desc",
            [r.bookingId],
          )
        ).rows.map((e) => e.kind),
      ).toEqual(["ride_started", "ride_finished"]);
    });
  });

  it("a correction re-attributes the ride's points; it needs a reason and verifying staff", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const f = await feed(tx);
      const r = await rideWithTracker(tx, sale, days, devices[0]);
      const dev = await providerId(tx, devices[0]);
      await correct(tx, r.attempt, await at(tx, "-60 minutes"), null);
      await deliverMessages(tx, f, [
        { id: "early", device: dev, at: await at(tx, "-100 minutes") },
        { id: "late", device: dev, at: await at(tx, "-30 minutes") },
      ]);
      expect(await attributed(tx)).toEqual({ early: null, late: r.attempt });
      // The rider forgot Start: the ride began earlier.
      await correct(tx, r.attempt, await at(tx, "-110 minutes"), await at(tx, "-20 minutes"));
      expect(await attributed(tx)).toEqual({ early: r.attempt, late: r.attempt });

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.correct_adventure_capture($1, now() - interval '1 hour', null, 'x')",
            [r.attempt],
          ),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.correct_adventure_capture($1, now() - interval '1 hour', null, ' ')",
            [r.attempt],
          ),
        refused("reason_required"),
      );
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.correct_adventure_capture($1, now() - interval '1 hour', now() - interval '2 hours', 'x')",
            [r.attempt],
          ),
        refused("adventure_capture_invalid"),
      );

      // The rider sees their ride.
      await actAs(tx, customerClaims(r.rider.authUserId));
      const ride = await tx.query(
        "select positions, latest_at is not null as has_latest from public.my_adventure_ride($1)",
        [r.bookingId],
      );
      expect(ride.rows).toEqual([{ positions: 2, has_latest: true }]);
    });
  });
});

describe("the feed's lease, cursor and back-off (D190; T09)", () => {
  it("one claim at a time, no sooner than its interval; another lease writes nothing", async () => {
    await inTransaction(conn, async (tx) => {
      await setup(tx, 1);
      const f = await feed(tx);
      const c = await claim(tx);
      expect(c?.feed_id).toBe(f);
      expect(await claim(tx)).toBeUndefined(); // leased, and not due again for 150 s
      await tx.query("reset role");
      await tx.query(
        "update public.tracking_feeds set lease_until = now() - interval '1 second', next_request_at = now() - interval '1 second' where id = $1",
        [f],
      );
      const again = await claim(tx);
      expect(again!.lease_token).not.toBe(c!.lease_token);
      expect(
        await scalar<number>(
          tx,
          "select public.store_tracking_messages($1, $2, '[]'::jsonb, true, now(), null)",
          [f, c!.lease_token],
        ),
      ).toBe(-1);
    });
  });

  it("a full page moves the window back and keeps the watermark; a complete window moves the watermark", async () => {
    await inTransaction(conn, async (tx) => {
      await setup(tx, 1);
      const f = await feed(tx);
      await tx.query("reset role");
      const before = await scalar<string>(
        tx,
        "select watermark_at::text from public.tracking_feeds where id = $1",
        [f],
      );
      let c = await claim(tx);
      await tx.query(
        "select public.store_tracking_messages($1, $2, '[]'::jsonb, false, now(), now() - interval '30 minutes')",
        [f, c!.lease_token],
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select watermark_at::text as w, window_end_at is not null as cursor from public.tracking_feeds where id = $1",
            [f],
          )
        ).rows,
      ).toEqual([{ w: before, cursor: true }]);
      await tx.query(
        "update public.tracking_feeds set next_request_at = now() - interval '1 second' where id = $1",
        [f],
      );
      c = await claim(tx);
      await tx.query(
        "select public.store_tracking_messages($1, $2, '[]'::jsonb, true, now(), null)",
        [f, c!.lease_token],
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select watermark_at = now() as at_now, window_end_at is null as no_cursor from public.tracking_feeds where id = $1",
            [f],
          )
        ).rows,
      ).toEqual([{ at_now: true, no_cursor: true }]);
    });
  });

  it("a failure is recorded without detail beyond the reason and backs off", async () => {
    await inTransaction(conn, async (tx) => {
      await setup(tx, 1);
      const f = await feed(tx);
      const c = await claim(tx);
      await actAs(tx, SERVICE);
      expect(
        await scalar<boolean>(
          tx,
          "select public.fail_tracking_feed($1, $2, 'Provider unavailable (503)')",
          [f, c!.lease_token],
        ),
      ).toBe(true);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select failures, last_error, lease_token is null as released, next_request_at > now() + interval '149 seconds' as backed_off from public.tracking_feeds where id = $1",
            [f],
          )
        ).rows,
      ).toEqual([
        { failures: 1, last_error: "Provider unavailable (503)", released: true, backed_off: true },
      ]);
    });
  });

  it("feeds are set up by an admin; the worker's functions are the service role's", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () =>
          tx.query(
            "select public.save_tracking_feed(null, 'spot', 'x', 'SUPABASE_SERVICE_ROLE_KEY', true)",
          ),
        { code: "23514" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () =>
          tx.query("select public.save_tracking_feed(null, 'spot', 'x', 'TRACKING_FEED_1', true)"),
        { code: "42501" },
      );
      await failsWith(tx, () => tx.query("select * from public.claim_tracking_feed()"), {
        code: "42501",
      });
    });
  });
});

describe("the hired tracker as evidence (D191)", () => {
  it("a finished tracker ride can be sent without a file; the reviewer reads its track", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const f = await feed(tx);
      const r = await rideWithTracker(tx, sale, days, devices[0]);
      const dev = await providerId(tx, devices[0]);
      await correct(tx, r.attempt, await at(tx, "-2 hours"), null);
      await deliverMessages(tx, f, [
        { id: "p1", device: dev, at: await at(tx, "-110 minutes"), lat: 1.3, lon: 103.8 },
        { id: "p2", device: dev, at: await at(tx, "-60 minutes"), lat: 1.4, lon: 103.8 },
      ]);
      // Still open: Finish Ride first.
      await actAs(tx, customerClaims(r.rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.submit_my_adventure_evidence($1, '')", [r.bookingId]),
        refused("adventure_ride_still_open"),
      );
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      const sub = await scalar<string>(
        tx,
        "select id from public.submit_my_adventure_evidence($1, 'Tracker ride')",
        [r.bookingId],
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select ride_started_at = $2::timestamptz as starts, state::text from public.adventure_attempts where id = $1",
            [r.attempt, await at(tx, "-110 minutes")],
          )
        ).rows,
      ).toEqual([{ starts: true, state: "finished" }]);

      await actAs(tx, staffClaims(AUTH_USER.manager));
      const summary = await tx.query(
        "select points, distance_km::float as km from public.adventure_tracker_summary($1)",
        [sub],
      );
      expect(summary.rows[0].points).toBe(2);
      expect(summary.rows[0].km).toBeCloseTo(11.1, 0);
      expect(
        (await tx.query("select * from public.adventure_tracker_outline($1, 500)", [sub])).rows,
      ).toHaveLength(2);
      const passes = await tx.query(
        "select count(*)::int as n from public.adventure_checkpoint_passes($1)",
        [sub],
      );
      expect(passes.rows[0].n).toBeGreaterThan(0);
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(
        (await tx.query("select * from public.adventure_tracker_summary($1)", [sub])).rows,
      ).toEqual([]);
      expect(
        (await tx.query("select * from public.adventure_tracker_outline($1, 500)", [sub])).rows,
      ).toEqual([]);
    });
  });

  it("without a file or enough tracker points the ride is still incomplete", async () => {
    await inTransaction(conn, async (tx) => {
      const { sale, days, devices } = await setup(tx, 1);
      const r = await rideWithTracker(tx, sale, days, devices[0]);
      await actAs(tx, customerClaims(r.rider.authUserId));
      await tx.query("select public.start_my_adventure_ride($1)", [r.bookingId]);
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      await failsWith(
        tx,
        () => tx.query("select public.submit_my_adventure_evidence($1, '')", [r.bookingId]),
        refused("adventure_evidence_incomplete"),
      );
    });
  });
});
