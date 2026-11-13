/**
 * Adventures Phase F, the handoff's acceptance gaps (DATA-MODEL §20
 * "Evidence integrity", D208-D211; handoff §20.1-§20.5): a decided ride's
 * tracker evidence is frozen (E09) and sparse tracks are flagged (E03); a
 * duplicate file is refused (E02); hires the fleet can no longer cover are
 * flagged (S07); failed emails can be retried (A09). Also P09 (finishing a
 * ride does not end the hire), E11 (the export holds only the rider's own
 * ride), A07 (the board name and live sharing are independent) and A08 (a
 * share link reveals no provider details and nothing after the ride).
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { makeRider, type Rider } from "./adventure-fixtures";
import { customerClaims, putStorageObject } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { SERVICE } from "./payment-fixtures";
import { checkout, pay, reservation, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const ALL_TRUE = {
  identity: true,
  coverage: true,
  checkpoints: true,
  chronology: true,
  time_window: true,
  distance: true,
};

type Setup = Awaited<ReturnType<typeof setup>>;

/** A paid hire with the tracker given out and the ride started; returns the attempt. */
async function riding(tx: Connection, s: Setup, device: string, dayIndex = 0) {
  const rider = await makeRider(tx);
  await tx.query("reset role");
  await tx.query(
    "update public.customers set first_name = 'Rae', last_name = 'Tan' where id = $1",
    [rider.customerId],
  );
  const p = await checkout(tx, rider, s.sale, s.days[dayIndex], s.days[dayIndex + 1]);
  await pay(tx, p);
  const res = await reservation(tx, p.booking_id);
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const assignment = await scalar<string>(
    tx,
    "select id from public.issue_adventure_tracker($1, $2, '')",
    [res.id, device],
  );
  await actAs(tx, customerClaims(rider.authUserId));
  await tx.query("select public.start_my_adventure_ride($1)", [p.booking_id]);
  await tx.query("reset role");
  const attempt = await scalar<string>(
    tx,
    "select attempt_id from public.tracker_assignments where id = $1",
    [assignment],
  );
  // The tracker went out and the ride started two hours ago.
  await tx.query("set local session_replication_role = replica");
  await tx.query(
    "update public.tracker_assignments set issued_at = now() - interval '3 hours' where id = $1",
    [assignment],
  );
  await tx.query(
    "update public.adventure_attempts set capture_started_at = now() - interval '2 hours' where id = $1",
    [attempt],
  );
  await tx.query("set local session_replication_role = origin");
  return { rider, bookingId: p.booking_id, attempt, assignment, reservationId: res.id };
}

/** `n` positions on the attempt, `gapMinutes` apart, ending a minute ago. */
async function points(
  tx: Connection,
  attempt: string,
  device: string,
  n: number,
  gapMinutes: number,
  tag: string,
) {
  await tx.query("reset role");
  await tx.query(
    `insert into public.tracking_messages (provider, provider_message_id, provider_device_id, device_id, recorded_at, received_at, kind, latitude, longitude, attempt_id)
     select 'fake', $5 || g, 'x', $2, now() - make_interval(mins => 1 + ($3 - g) * $4), now() - interval '1 second', 'position',
            1.30 + g / 500.0, 103.80 + g / 500.0, $1
     from generate_series(1, $3) g`,
    [attempt, device, n, gapMinutes, tag],
  );
}

async function summary(tx: Connection, submissionId: string) {
  await actAs(tx, staffClaims(AUTH_USER.manager));
  const { rows } = await tx.query<{ points: number; approximate: boolean; late_points: number }>(
    "select points, approximate, late_points from public.adventure_tracker_summary($1)",
    [submissionId],
  );
  return rows[0];
}

describe("a decided ride's tracker evidence (E09, E03; D208)", () => {
  it("is frozen at the decision; later points stay with the ride as late points; sparse points are approximate", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const r = await riding(tx, s, s.devices[0]);
      await points(tx, r.attempt, s.devices[0], 6, 5, "e09-");
      await actAs(tx, customerClaims(r.rider.authUserId));
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      await tx.query("select public.submit_my_adventure_evidence($1, 'Tracker only')", [
        r.bookingId,
      ]);
      await tx.query("reset role");
      const submissionId = await scalar<string>(
        tx,
        "select s.id from public.adventure_submissions s where s.attempt_id = $1 and s.state = 'submitted'",
        [r.attempt],
      );
      expect(await summary(tx, submissionId)).toEqual({
        points: 6,
        approximate: true,
        late_points: 0,
      });

      await tx.query(
        "select * from public.decide_adventure_review($1, 'approved', $2::jsonb, 128.5, (now() at time zone 'Asia/Singapore')::date, '', 'internal')",
        [submissionId, JSON.stringify(ALL_TRUE)],
      );
      // A point recorded during the ride arrives after the decision.
      await tx.query("reset role");
      await tx.query(
        `insert into public.tracking_messages (provider, provider_message_id, provider_device_id, device_id, recorded_at, received_at, kind, latitude, longitude, attempt_id)
         values ('fake', 'e09-late', 'x', $2, now() - interval '3 minutes', clock_timestamp() + interval '1 second', 'position', 1.4, 103.9, $1)`,
        [r.attempt, s.devices[0]],
      );
      expect(await summary(tx, submissionId)).toEqual({
        points: 6,
        approximate: true,
        late_points: 1,
      });
      await actAs(tx, staffClaims(AUTH_USER.manager));
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_tracker_outline($1, 1000)",
          [submissionId],
        ),
      ).toBe(6);
    });
  });

  it("dense points are not approximate", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const r = await riding(tx, s, s.devices[0]);
      await points(tx, r.attempt, s.devices[0], 10, 1, "dense-");
      await actAs(tx, customerClaims(r.rider.authUserId));
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      await tx.query("select public.submit_my_adventure_evidence($1, '')", [r.bookingId]);
      await tx.query("reset role");
      const submissionId = await scalar<string>(
        tx,
        "select id from public.adventure_submissions where attempt_id = $1 and state = 'submitted'",
        [r.attempt],
      );
      expect((await summary(tx, submissionId)).approximate).toBe(false);
    });
  });
});

describe("a duplicate file (E02; D209)", () => {
  it("the same recording twice on one version: the second is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const rider = await makeRider(tx);
      const p = await checkout(tx, rider, s.sale, null, null);
      await pay(tx, p);
      const states: string[] = [];
      for (const name of ["ride.gpx", "ride-copy.gpx"]) {
        await actAs(tx, customerClaims(rider.authUserId));
        const { rows } = await tx.query<{ file_id: string; storage_path: string }>(
          `select file_id, storage_path from public.prepare_my_adventure_upload($1, 'activity', null, $2, 'application/gpx+xml', 1000)`,
          [p.booking_id, name],
        );
        await tx.query("reset role");
        await putStorageObject(tx, "adventure-evidence", rows[0].storage_path, {
          mimetype: "application/gpx+xml",
          size: 1000,
        });
        await actAs(tx, customerClaims(rider.authUserId));
        await tx.query("select public.finalise_my_adventure_upload($1)", [rows[0].file_id]);
        await actAs(tx, SERVICE);
        await tx.query("select public.claim_adventure_parse_jobs(10)");
        await tx.query("select public.finish_adventure_parse($1, true, '', $2, 't', $3::jsonb)", [
          rows[0].file_id,
          "c".repeat(64),
          JSON.stringify({
            format: "gpx",
            started_at: "2026-11-14T07:00:00Z",
            finished_at: "2026-11-14T17:00:00Z",
            distance_km: 130,
            has_times: true,
            points: [
              ["2026-11-14T07:00:00Z", 1.3, 103.8],
              ["2026-11-14T17:00:00Z", 1.31, 103.81],
            ],
          }),
        ]);
        await tx.query("reset role");
        states.push(
          await scalar<string>(
            tx,
            "select state::text || coalesce(':' || parse_error, '') from public.adventure_evidence_files where id = $1",
            [rows[0].file_id],
          ),
        );
      }
      expect(states).toEqual(["parsed", "failed:This file is already added to this ride."]);
    });
  });
});

describe("a tracker leaving service (S07; D210)", () => {
  it("flags each confirmed hire the remaining fleet can't cover", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const rider: Rider = await makeRider(tx);
      const p = await checkout(tx, rider, s.sale, s.days[2], s.days[3]);
      await pay(tx, p);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.set_tracking_device_state($1, 'maintenance', 'Cracked case')", [
        s.devices[0],
      ]);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select needs_attention, attention_reason from public.adventure_bookings where id = $1",
            [p.booking_id],
          )
        ).rows,
      ).toEqual([
        {
          needs_attention: true,
          attention_reason: "Not enough trackers in service for this hire's days.",
        },
      ]);
    });
  });
});

describe("failed emails (A09; D211)", () => {
  it("an admin puts them back in the queue; the booking is untouched", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const rider = await makeRider(tx);
      await tx.query("reset role");
      await tx.query("update public.customers set email = 'fail@example.com' where id = $1", [
        rider.customerId,
      ]);
      const p = await checkout(tx, rider, s.sale, null, null);
      await pay(tx, p);
      await tx.query("reset role");
      await tx.query(
        "update private.adventure_notices set status = 'failed', attempts = 5, last_error = 'bounced' where booking_id = $1",
        [p.booking_id],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(tx, () => tx.query("select public.retry_failed_adventure_notices()"), {
        code: "42501",
      });
      await actAs(tx, staffClaims(AUTH_USER.admin));
      expect(await scalar<number>(tx, "select public.adventure_health() ->> 'emails_failed'")).toBe(
        "1" as never,
      );
      expect(
        await scalar<number>(tx, "select public.retry_failed_adventure_notices()"),
      ).toBeGreaterThanOrEqual(1);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select n.status::text as notice, b.status::text as booking from private.adventure_notices n join public.adventure_bookings b on b.id = n.booking_id where n.booking_id = $1",
            [p.booking_id],
          )
        ).rows,
      ).toEqual([{ notice: "pending", booking: "confirmed" }]);
    });
  });
});

describe("riding with a hired tracker (P09, E11, A07, A08)", () => {
  it("finishing keeps the hire; the export and the share link hold only this rider's ride, without provider details", async () => {
    await inTransaction(conn, async (tx) => {
      const s = await setup(tx, 1);
      const a = await riding(tx, s, s.devices[0]);
      await points(tx, a.attempt, s.devices[0], 3, 1, "mine-");
      // A07: the rider hides their board name; live sharing is separate.
      await tx.query("reset role");
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        "update public.adventure_bookings set finisher_name = 'hidden' where id = $1",
        [a.bookingId],
      );
      await tx.query("set local session_replication_role = origin");
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await tx.query("select public.set_adventure_public_surfaces(true, false)");
      await actAs(tx, customerClaims(a.rider.authUserId));
      const token = await scalar<string>(
        tx,
        "select token from public.create_my_ride_share($1, 6)",
        [a.bookingId],
      );
      await actAs(tx, { role: "anon" });
      const shared = await scalar<Record<string, unknown>>(
        tx,
        "select public.public_shared_ride($1)",
        [token],
      );
      expect(shared.rider).toBe("Rae T.");
      expect(JSON.stringify(shared)).not.toMatch(/ESN|provider|feed|TRACKING_FEED/i);

      await actAs(tx, customerClaims(a.rider.authUserId));
      await tx.query("select public.finish_my_adventure_ride($1)", [a.bookingId]);
      // P09: the tracker is still out and the hire still stands.
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            `select r.status::text as hire, x.returned_at is null as still_out
               from public.tracker_reservations r join public.tracker_assignments x on x.reservation_id = r.id
              where r.id = $1`,
            [a.reservationId],
          )
        ).rows,
      ).toEqual([{ hire: "confirmed", still_out: true }]);

      // The tracker goes back and on to another rider, who rides with it.
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.return_adventure_tracker($1, 'good', '')", [a.assignment]);
      const b = await riding(tx, s, s.devices[0], 2);
      await points(tx, b.attempt, s.devices[0], 4, 1, "theirs-");

      // E11: A's export is A's three points with their recorded times.
      await actAs(tx, customerClaims(a.rider.authUserId));
      const exported = await tx.query<{ recorded_at: Date }>(
        "select recorded_at from public.my_adventure_ride_points($1)",
        [a.bookingId],
      );
      await tx.query("reset role");
      const recorded = await tx.query<{ recorded_at: Date }>(
        "select recorded_at from public.tracking_messages where provider_message_id like 'mine-%' order by recorded_at",
      );
      expect(exported.rows.map((x) => x.recorded_at.toISOString())).toEqual(
        recorded.rows.map((x) => x.recorded_at.toISOString()),
      );
      // A08: A's old link shows only that A's ride finished, nothing of B's.
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_shared_ride($1)", [token])).toMatchObject({
        status: "finished",
        points: [],
      });
    });
  });
});
