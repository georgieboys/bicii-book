/**
 * Adventures Phase F, the rider's optional surfaces (DATA-MODEL §20 "The
 * rider's optional surfaces", D204-D206; handoff §6.6): GPX points of the
 * rider's own ride, revocable live-share links behind their switch, and
 * opt-in public profiles behind theirs.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { makeRider, offerOn125, openSales, submitted, type Rider } from "./adventure-fixtures";
import { customerClaims } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { checkout, pay, reservation, setup } from "./tracker-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

async function surfaces(tx: Connection, live: boolean, profiles: boolean) {
  await actAs(tx, staffClaims(AUTH_USER.admin));
  await tx.query("select public.set_adventure_public_surfaces($1, $2)", [live, profiles]);
}

/** A hired tracker given out, the ride started, and three positions on it. */
async function ridingWithPoints(tx: Connection) {
  const { sale, days, devices } = await setup(tx, 1);
  const rider = await makeRider(tx);
  await tx.query("reset role");
  await tx.query(
    "update public.customers set first_name = 'Rae', last_name = 'Tan' where id = $1",
    [rider.customerId],
  );
  const p = await checkout(tx, rider, sale, days[0], days[1]);
  await pay(tx, p);
  const res = await reservation(tx, p.booking_id);
  await actAs(tx, staffClaims(AUTH_USER.manager));
  await tx.query("select public.issue_adventure_tracker($1, $2, '')", [res.id, devices[0]]);
  await actAs(tx, customerClaims(rider.authUserId));
  await tx.query("select public.start_my_adventure_ride($1)", [p.booking_id]);
  await tx.query("reset role");
  const attempt = await scalar<string>(
    tx,
    "select id from public.adventure_attempts where booking_id = $1 order by attempt_number desc limit 1",
    [p.booking_id],
  );
  await tx.query(
    `insert into public.tracking_messages (provider, provider_message_id, provider_device_id, device_id, recorded_at, kind, latitude, longitude, attempt_id)
     select 'fake', 'rs-' || g, 'x', $2, now() - make_interval(mins => 30 - g), 'position', 1.30 + g / 100.0, 103.80 + g / 100.0, $1
     from generate_series(1, 3) g`,
    [attempt, devices[0]],
  );
  return { rider, bookingId: p.booking_id, attempt };
}

describe("GPX export (D204)", () => {
  it("returns the rider's own ride positions in order; nobody else's", async () => {
    await inTransaction(conn, async (tx) => {
      const r = await ridingWithPoints(tx);
      const other = await makeRider(tx);
      await actAs(tx, customerClaims(other.authUserId));
      await failsWith(
        tx,
        () => tx.query("select * from public.my_adventure_ride_points($1)", [r.bookingId]),
        { code: "42501" },
      );
      await actAs(tx, customerClaims(r.rider.authUserId));
      const { rows } = await tx.query<{ latitude: string }>(
        "select latitude::text from public.my_adventure_ride_points($1)",
        [r.bookingId],
      );
      expect(rows.map((x) => Number(x.latitude))).toEqual([1.31, 1.32, 1.33]);
    });
  });
});

describe("live-share links (D205)", () => {
  it("are off until an admin turns them on; the link shows the open ride, then only that it finished", async () => {
    await inTransaction(conn, async (tx) => {
      const r = await ridingWithPoints(tx);
      await actAs(tx, customerClaims(r.rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select * from public.create_my_ride_share($1, 24)", [r.bookingId]),
        refused("live_sharing_off"),
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.set_adventure_public_surfaces(true, false)"),
        {
          code: "42501",
        },
      );
      await surfaces(tx, true, false);

      await actAs(tx, customerClaims(r.rider.authUserId));
      const { rows } = await tx.query<{ token: string }>(
        "select token from public.create_my_ride_share($1, 999)",
        [r.bookingId],
      );
      const token = rows[0].token;
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      // Capped at 48 hours; only the hash is stored.
      await tx.query("reset role");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_ride_shares where expires_at = created_at + interval '48 hours' and position(convert_to($1, 'UTF8') in token_hash) = 0",
          [token],
        ),
      ).toBe(1);

      await actAs(tx, { role: "anon" });
      const shown = await scalar<{ rider: string; status: string; points: unknown[] }>(
        tx,
        "select public.public_shared_ride($1)",
        [token],
      );
      expect(shown).toMatchObject({ rider: "Rae T.", status: "riding" });
      expect(shown.points).toHaveLength(3);
      expect(JSON.stringify(shown)).not.toMatch(/@|Tan/);
      expect(await scalar(tx, "select public.public_shared_ride('nope')")).toBeNull();
      expect(await scalar(tx, "select public.public_shared_ride($1)", ["A".repeat(32)])).toBeNull();

      await actAs(tx, customerClaims(r.rider.authUserId));
      await tx.query("select public.finish_my_adventure_ride($1)", [r.bookingId]);
      await actAs(tx, { role: "anon" });
      const finished = await scalar<{ status: string; points: unknown[] }>(
        tx,
        "select public.public_shared_ride($1)",
        [token],
      );
      expect(finished).toMatchObject({ status: "finished", points: [] });

      // Turning sharing off hides every link.
      await surfaces(tx, false, false);
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_shared_ride($1)", [token])).toBeNull();
    });
  });

  it("a new link revokes the old; the rider revokes; only their own", async () => {
    await inTransaction(conn, async (tx) => {
      const r = await ridingWithPoints(tx);
      await surfaces(tx, true, false);
      await actAs(tx, customerClaims(r.rider.authUserId));
      const first = await scalar<string>(
        tx,
        "select token from public.create_my_ride_share($1, 2)",
        [r.bookingId],
      );
      const second = await scalar<string>(
        tx,
        "select token from public.create_my_ride_share($1, 2)",
        [r.bookingId],
      );
      expect(
        (await tx.query("select * from public.my_ride_share($1)", [r.bookingId])).rows,
      ).toHaveLength(1);
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_shared_ride($1)", [first])).toBeNull();
      expect(await scalar(tx, "select public.public_shared_ride($1)", [second])).not.toBeNull();

      const other = await makeRider(tx);
      await actAs(tx, customerClaims(other.authUserId));
      await failsWith(tx, () => tx.query("select public.revoke_my_ride_share($1)", [r.bookingId]), {
        code: "42501",
      });
      await actAs(tx, customerClaims(r.rider.authUserId));
      await tx.query("select public.revoke_my_ride_share($1)", [r.bookingId]);
      expect(
        (await tx.query("select * from public.my_ride_share($1)", [r.bookingId])).rows,
      ).toEqual([]);
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_shared_ride($1)", [second])).toBeNull();
    });
  });
});

describe("public rider profiles (D206)", () => {
  it("opt in only while profiles are on; shows the name and active certificates; opting out hides it", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider: Rider = await makeRider(tx);
      await tx.query("reset role");
      await tx.query(
        "update public.customers set first_name = 'Uma', last_name = 'Rao' where id = $1",
        [rider.customerId],
      );
      const { submissionId } = await submitted(tx, rider, sale);
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query(
        "select * from public.decide_adventure_review($1, 'approved', $2::jsonb, 128.5, '2026-11-15', '', 'internal')",
        [
          submissionId,
          JSON.stringify({
            identity: true,
            coverage: true,
            checkpoints: true,
            chronology: true,
            time_window: true,
            distance: true,
          }),
        ],
      );

      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.set_my_rider_profile(true)"),
        refused("public_profiles_off"),
      );
      await surfaces(tx, false, true);
      await actAs(tx, customerClaims(rider.authUserId));
      const id = await scalar<string>(tx, "select public.set_my_rider_profile(true)");

      await actAs(tx, { role: "anon" });
      const profile = await scalar<{ rider: string; certificates: { completed_on: string }[] }>(
        tx,
        "select public.public_rider_profile($1)",
        [id],
      );
      expect(profile.rider).toBe("Uma R.");
      expect(profile.certificates).toHaveLength(1);
      expect(JSON.stringify(profile)).not.toMatch(/@|Rao/);

      await actAs(tx, customerClaims(rider.authUserId));
      expect(await scalar<string>(tx, "select public.set_my_rider_profile(false)")).toBe(id);
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_rider_profile($1)", [id])).toBeNull();

      // Switched off: hidden even for a rider who opted in.
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.set_my_rider_profile(true)");
      await surfaces(tx, false, false);
      await actAs(tx, { role: "anon" });
      expect(await scalar(tx, "select public.public_rider_profile($1)", [id])).toBeNull();
    });
  });
});
