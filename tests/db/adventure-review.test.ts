/**
 * Adventures Phase B, slice 4: review, certificates, finisher board and
 * packs (DATA-MODEL §20, D178-D180; handoff §13.4, §14, E07, E08, E10,
 * E12, E13, A10).
 *
 * Rolled-back transactions; the two-reviewer race commits on this file's
 * own clone.
 */

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import {
  makeRider,
  offerOn125,
  openSales,
  signWaiver,
  submitted,
  type Rider,
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
const ALL_TRUE = {
  identity: true,
  coverage: true,
  checkpoints: true,
  chronology: true,
  time_window: true,
  distance: true,
};

async function decide(
  tx: Connection,
  submissionId: string,
  decision: string,
  o: Partial<{
    checklist: object;
    distance: number | null;
    on: string | null;
    message: string;
    staff: string;
  }> = {},
) {
  await actAs(tx, staffClaims(o.staff ?? AUTH_USER.manager));
  return tx.query(
    "select * from public.decide_adventure_review($1, $2, $3::jsonb, $4, $5, $6, 'internal')",
    [
      submissionId,
      decision,
      JSON.stringify(o.checklist ?? ALL_TRUE),
      o.distance === undefined ? 128.5 : o.distance,
      o.on === undefined ? "2026-11-15" : o.on,
      o.message ?? "",
    ],
  );
}

async function setName(tx: Connection, rider: Rider, first: string, last: string): Promise<void> {
  await tx.query("reset role");
  await tx.query("update public.customers set first_name = $2, last_name = $3 where id = $1", [
    rider.customerId,
    first,
    last,
  ]);
}

describe("review (E07, E08, E10)", () => {
  it("only verifying staff claim and decide; approval needs the whole checklist and the distance", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const { submissionId } = await submitted(tx, await makeRider(tx), sale);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.claim_adventure_review($1)", [submissionId]),
        { code: "42501" },
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved", { staff: AUTH_USER.mechanic2 }),
        { code: "42501" },
      );

      await actAs(tx, staffClaims(AUTH_USER.manager));
      const claimed = await tx.query("select state::text from public.claim_adventure_review($1)", [
        submissionId,
      ]);
      expect(claimed.rows).toEqual([{ state: "in_review" }]);

      await failsWith(
        tx,
        () =>
          decide(tx, submissionId, "approved", { checklist: { ...ALL_TRUE, checkpoints: false } }),
        refused("review_checklist_incomplete"),
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved", { checklist: { identity: true } }),
        refused("review_checklist_incomplete"),
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved", { distance: 110 }),
        refused("review_distance_short"),
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved", { distance: null }),
        refused("review_approval_incomplete"),
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "changes_requested"),
        refused("reason_required"),
      );
    });
  });

  it("approval issues exactly one certificate, badge and pack; a second decision is refused (E07)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const { bookingId, submissionId } = await submitted(tx, rider, sale);
      await decide(tx, submissionId, "approved");
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved"),
        refused("submission_version_conflict"),
      );

      await tx.query("reset role");
      const { rows } = await tx.query(
        `select c.reference, c.completed_on::text, c.accepted_distance_km::text, c.status::text,
                b.label, f.status::text as pack, f.tshirt_size, f.items
           from public.adventure_certificates c
           join public.adventure_badge_awards b on b.certificate_id = c.id
           join public.adventure_fulfilments f on f.certificate_id = c.id
          where c.booking_id = $1`,
        [bookingId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        completed_on: "2026-11-15",
        accepted_distance_km: "128.5",
        status: "active",
        label: "BICII 125 · 125 km",
        pack: "awaiting_pack",
        tshirt_size: "M",
        items: ["T-shirt", "Patch", "Pin", "Sticker"],
      });
      expect(rows[0].reference).toMatch(/^BC-\d{6}$/);
      expect(
        await scalar<string>(
          tx,
          "select state::text from public.adventure_submissions where id = $1",
          [submissionId],
        ),
      ).toBe("approved");

      // The rider sees their outcome; another rider sees nothing.
      await actAs(tx, customerClaims(rider.authUserId));
      const outcome = await tx.query(
        "select decision::text, certificate_status::text, pack_status::text from public.my_adventure_outcome($1)",
        [bookingId],
      );
      expect(outcome.rows).toEqual([
        { decision: "approved", certificate_status: "active", pack_status: "awaiting_pack" },
      ]);
      const other = await makeRider(tx);
      await actAs(tx, customerClaims(other.authUserId));
      expect(
        (await tx.query("select * from public.my_adventure_outcome($1)", [bookingId])).rows,
      ).toEqual([]);
    });
  });

  it("nobody reviews their own ride (E08)", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      // The manager rides too: their staff login is also a customer's login.
      await tx.query("reset role");
      const { rows } = await tx.query<{ id: string }>(
        "insert into public.customers (display_name, auth_user_id) values ('Manager riding', $1) returning id",
        [AUTH_USER.manager],
      );
      const rider = { customerId: rows[0].id, authUserId: AUTH_USER.manager };
      const { submissionId } = await submitted(tx, rider, sale);
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved"),
        refused("review_not_permitted"),
      );
      // Another verifying reviewer may.
      await decide(tx, submissionId, "approved", { staff: AUTH_USER.admin });
    });
  });

  it("a booking flagged for its payment cannot be certified until staff clear it", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const { bookingId, submissionId } = await submitted(tx, await makeRider(tx), sale);
      await tx.query("reset role");
      await tx.query(
        "update public.adventure_bookings set needs_attention = true, attention_reason = 'Paid twice' where id = $1",
        [bookingId],
      );
      await failsWith(
        tx,
        () => decide(tx, submissionId, "approved"),
        refused("adventure_booking_attention"),
      );
      await decide(tx, submissionId, "changes_requested", {
        message: "Waiting on your payment query.",
      });
    });
  });

  it("changes requested lets the rider send a new version; rejected tells them why", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const { bookingId, submissionId } = await submitted(tx, rider, sale);
      await decide(tx, submissionId, "changes_requested", { message: "Add the Seletar photo." });
      await actAs(tx, customerClaims(rider.authUserId));
      const outcome = await tx.query(
        "select decision::text, message_to_rider from public.my_adventure_outcome($1)",
        [bookingId],
      );
      expect(outcome.rows).toEqual([
        { decision: "changes_requested", message_to_rider: "Add the Seletar photo." },
      ]);
      const next = await tx.query("select version from public.my_adventure_evidence($1)", [
        bookingId,
      ]);
      expect(next.rows[0].version).toBe(1);
      await tx.query(
        `select * from public.prepare_my_adventure_upload($1, 'checkpoint_photo', 2, 'seletar.jpg', 'image/jpeg', 2000)`,
        [bookingId],
      );
      const v2 = await tx.query(
        "select version, state::text from public.my_adventure_evidence($1)",
        [bookingId],
      );
      expect(v2.rows).toEqual([{ version: 2, state: "draft" }]);
    });
  });
});

describe("clearing a payment flag (D181)", () => {
  it("an admin clears it with a note, kept in the history; then the ride can be certified", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const { bookingId, submissionId } = await submitted(tx, await makeRider(tx), sale);
      await tx.query("reset role");
      await tx.query(
        "update public.adventure_bookings set needs_attention = true, attention_reason = 'Paid twice' where id = $1",
        [bookingId],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () =>
          tx.query("select public.clear_adventure_booking_attention($1, 'Refunded')", [bookingId]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.clear_adventure_booking_attention($1, ' ')", [bookingId]),
        refused("reason_required"),
      );
      await tx.query(
        "select public.clear_adventure_booking_attention($1, 'Refunded the second payment')",
        [bookingId],
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select needs_attention, attention_reason from public.adventure_bookings where id = $1",
            [bookingId],
          )
        ).rows,
      ).toEqual([{ needs_attention: false, attention_reason: null }]);
      expect(
        await scalar<string>(
          tx,
          "select detail ->> 'note' from public.adventure_booking_events where booking_id = $1 and kind = 'attention_cleared'",
          [bookingId],
        ),
      ).toBe("Refunded the second payment");
      await decide(tx, submissionId, "approved");
    });
  });
});

describe("the review workspace's reads (D182)", () => {
  it("thin a track for drawing and find each checkpoint's nearest point, for verifying staff only", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const { submissionId } = await submitted(tx, await makeRider(tx), sale);
      await tx.query("reset role");
      // The fixture's checkpoints have no coordinates; give one a place (the
      // sealed revision's guard is a trigger, bypassed for this setup only).
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        `update public.adventure_checkpoints c set latitude = 1.3, longitude = 103.81
           from public.adventure_bookings b join public.adventure_attempts a on a.booking_id = b.id
           join public.adventure_submissions s on s.attempt_id = a.id
          where s.id = $1 and c.revision_id = b.revision_id and c.position = 1`,
        [submissionId],
      );
      await tx.query("set local session_replication_role = origin");
      const track = await scalar<string>(
        tx,
        `select k.id from public.adventure_tracks k join public.adventure_evidence_files f on f.id = k.file_id
          where f.submission_id = $1`,
        [submissionId],
      );

      await actAs(tx, staffClaims(AUTH_USER.manager));
      const outline = await tx.query("select seq from public.adventure_track_outline($1, 500)", [
        track,
      ]);
      expect(outline.rows.map((r: { seq: number }) => r.seq)).toEqual([0, 1]);
      const passes = await tx.query(
        "select checkpoint_position, label, nearest_m::float as m from public.adventure_checkpoint_passes($1)",
        [submissionId],
      );
      expect(passes.rows).toHaveLength(2);
      expect(passes.rows[0]).toMatchObject({ checkpoint_position: 1, label: "Lim Chu Kang" });
      // 0.01 degrees of longitude from (1.3, 103.8): about 1.1 km.
      expect(passes.rows[0].m).toBeGreaterThan(1000);
      expect(passes.rows[0].m).toBeLessThan(1200);
      expect(passes.rows[1].m).toBeNull();

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(
        (await tx.query("select * from public.adventure_track_outline($1, 500)", [track])).rows,
      ).toEqual([]);
      expect(
        (await tx.query("select * from public.adventure_checkpoint_passes($1)", [submissionId]))
          .rows,
      ).toEqual([]);
    });
  });
});

describe("finisher board and revocation (E12, E13)", () => {
  it("lists active certificates by completion date with the chosen name, and nothing else", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const a = await makeRider(tx);
      const b = await makeRider(tx);
      await setName(tx, a, "Aisha", "Tan");
      await setName(tx, b, "Ben", "Lim");
      const sa = await submitted(tx, a, sale);
      const sb = await submitted(tx, b, sale);
      await decide(tx, sa.submissionId, "approved", { on: "2026-11-15" });
      await decide(tx, sb.submissionId, "approved", { on: "2026-11-20" });
      // D218: on the board only under a chosen name; a rider who chose none isn't listed.
      const c = await makeRider(tx);
      const sc = await submitted(tx, c, sale);
      await decide(tx, sc.submissionId, "approved", { on: "2026-11-18" });
      await actAs(tx, customerClaims(a.authUserId));
      await tx.query("select public.set_my_board_name($1, 'Aisha T.')", [sa.bookingId]);
      await actAs(tx, customerClaims(b.authUserId));
      await tx.query("select public.set_my_board_name($1, '  Ben   L. ')", [sb.bookingId]);

      await actAs(tx, { role: "anon" });
      const board = await tx.query(
        "select * from public.public_adventure_finishers('bicii-125', 50)",
      );
      expect(board.rows).toEqual(
        [
          { rider_name: "Ben L.", completed_on: "2026-11-20", badge: "BICII 125 · 125 km" },
          { rider_name: "Aisha T.", completed_on: "2026-11-15", badge: "BICII 125 · 125 km" },
        ].map((r) => ({ ...r, completed_on: expect.anything() })),
      );
      expect(Object.keys(board.rows[0]).sort()).toEqual(["badge", "completed_on", "rider_name"]);
      expect(board.rows.map((r: { rider_name: string }) => r.rider_name)).toEqual([
        "Ben L.",
        "Aisha T.",
      ]);

      // Revoking (admin only, with a reason) takes it off the board; history stays.
      await tx.query("reset role");
      const cert = await scalar<string>(
        tx,
        "select id from public.adventure_certificates where booking_id = $1",
        [sb.bookingId],
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await failsWith(
        tx,
        () => tx.query("select public.revoke_adventure_certificate($1, 'x')", [cert]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.admin));
      await failsWith(
        tx,
        () => tx.query("select public.revoke_adventure_certificate($1, ' ')", [cert]),
        refused("reason_required"),
      );
      await tx.query("select public.revoke_adventure_certificate($1, 'Evidence was not theirs')", [
        cert,
      ]);
      await actAs(tx, { role: "anon" });
      const after = await tx.query(
        "select rider_name from public.public_adventure_finishers('bicii-125', 50)",
      );
      expect(after.rows).toEqual([{ rider_name: "Aisha T." }]);
      await tx.query("reset role");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_reviews where submission_id = $1",
          [sb.submissionId],
        ),
      ).toBe(1);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_fulfilments where certificate_id = $1",
          [cert],
        ),
      ).toBe(1);
      await failsWith(
        tx,
        () => tx.query("delete from public.adventure_certificates where id = $1", [cert]),
        refused("adventure_certificate_immutable"),
      );
    });
  });

  it("a hidden name shows as a BICII rider", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      await setName(tx, rider, "Chen", "Wei");
      await actAs(tx, customerClaims(rider.authUserId));
      const { rows } = await tx.query<{ booking_id: string; payment_id: string }>(
        `select booking_id, payment_id from public.prepare_my_adventure_checkout($1, 'bicii-125', 'self_supported', $2, 'L', 'hidden', '2026-11-test')`,
        [await signWaiver(tx), sale.revisionNumber],
      );
      expect(rows).toHaveLength(1);
      await tx.query("reset role");
      expect(
        await scalar<string>(
          tx,
          "select private.finisher_display_name(c, 'hidden') from public.customers c where c.id = $1",
          [rider.customerId],
        ),
      ).toBe("A BICII rider");
      expect(
        await scalar<string>(
          tx,
          "select private.finisher_display_name(c, 'full_name') from public.customers c where c.id = $1",
          [rider.customerId],
        ),
      ).toBe("Chen Wei");
    });
  });
});

describe("packs", () => {
  it("manage_adventures moves a pack along; a mechanic cannot", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const { bookingId, submissionId } = await submitted(tx, await makeRider(tx), sale);
      await decide(tx, submissionId, "approved");
      await tx.query("reset role");
      const pack = await scalar<string>(
        tx,
        "select id from public.adventure_fulfilments where booking_id = $1",
        [bookingId],
      );
      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      await failsWith(
        tx,
        () => tx.query("select public.set_adventure_pack_status($1, 'ready', '')", [pack]),
        { code: "42501" },
      );
      await actAs(tx, staffClaims(AUTH_USER.manager));
      await tx.query("select public.set_adventure_pack_status($1, 'ready', 'Size M packed')", [
        pack,
      ]);
      await tx.query("select public.set_adventure_pack_status($1, 'fulfilled', 'Collected')", [
        pack,
      ]);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select status::text, ready_at is not null as ready, fulfilled_at is not null as done from public.adventure_fulfilments where id = $1",
            [pack],
          )
        ).rows,
      ).toEqual([{ status: "fulfilled", ready: true, done: true }]);
    });
  });
});

describe.skipIf(!isolatedDatabase())("committed race (E07)", () => {
  it("two reviewers approving at once issue one certificate", async () => {
    const setup = await connect();
    const [one, two] = await openConnections(2);
    try {
      const { submissionId, bookingId } = await inTransaction(
        setup,
        async (tx) => {
          const sale = await offerOn125(tx);
          await openSales(tx);
          return submitted(tx, await makeRider(tx), sale);
        },
        { commit: true },
      );
      const results = await Promise.allSettled([
        inTransaction(
          one,
          (tx) => decide(tx, submissionId, "approved", { staff: AUTH_USER.manager }),
          { commit: true },
        ),
        inTransaction(
          two,
          (tx) => decide(tx, submissionId, "approved", { staff: AUTH_USER.admin }),
          { commit: true },
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await scalar<number>(
          setup,
          "select count(*)::int from public.adventure_certificates where booking_id = $1",
          [bookingId],
        ),
      ).toBe(1);
      expect(
        await scalar<number>(
          setup,
          "select count(*)::int from public.adventure_fulfilments where booking_id = $1",
          [bookingId],
        ),
      ).toBe(1);
    } finally {
      await Promise.all([setup.end(), one.end(), two.end()]);
    }
  });
});
