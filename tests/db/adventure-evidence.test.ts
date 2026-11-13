/**
 * Adventures Phase B, slice 3: evidence (DATA-MODEL §20, D175-D177; handoff
 * §13, E01, E05, E06, A03, A04).
 *
 *   uploads      only to a path allocated to the rider's own draft of a
 *                paid booking; the size is Storage's, not the browser's
 *   parsing      the worker's result lands once; submission needs a
 *                recording with times
 *   freezing     a submitted version never changes; a correction opens a
 *                new version that starts with the earlier files
 *   access       riders see only their own evidence; only staff who verify
 *                or manage adventures read files and tracks
 *
 * Rolled-back transactions.
 */
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { AUTH_USER } from "../fixtures/ids";
import { offerOn125, openSales, makeRider, paidBooking, type Rider } from "./adventure-fixtures";
import { customerClaims, putStorageObject } from "./customer-fixtures";
import { actAs, connect, inTransaction, scalar, staffClaims, type Connection } from "./harness";
import { SERVICE } from "./payment-fixtures";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });

type Allocated = { file_id: string; storage_path: string; max_bytes: string };

async function allocate(
  tx: Connection,
  rider: Rider,
  bookingId: string,
  o: Partial<{ kind: string; checkpoint: number | null; name: string; bytes: number }> = {},
): Promise<Allocated> {
  await actAs(tx, customerClaims(rider.authUserId));
  const { rows } = await tx.query<Allocated>(
    `select file_id, storage_path, max_bytes::text
       from public.prepare_my_adventure_upload($1, $2, $3, $4, 'application/octet-stream', $5)`,
    [
      bookingId,
      o.kind ?? "activity",
      o.checkpoint ?? null,
      o.name ?? "ride.gpx",
      o.bytes ?? 120_000,
    ],
  );
  return rows[0];
}

/** The object the browser uploaded, then the rider confirms it. */
async function upload(
  tx: Connection,
  rider: Rider,
  file: Allocated,
  size = 120_000,
): Promise<void> {
  await tx.query("reset role");
  await putStorageObject(tx, "adventure-evidence", file.storage_path, {
    mimetype: "application/gpx+xml",
    size,
  });
  await actAs(tx, customerClaims(rider.authUserId));
  await tx.query("select public.finalise_my_adventure_upload($1)", [file.file_id]);
}

/** As the worker: claim, then record a timed two-point track (or a failure). */
async function parse(tx: Connection, fileId: string, ok = true, hasTimes = true): Promise<void> {
  await actAs(tx, SERVICE);
  const { rows } = await tx.query<{ file_id: string }>(
    "select file_id from public.claim_adventure_parse_jobs(10)",
  );
  expect(rows.map((r) => r.file_id)).toContain(fileId);
  await tx.query("select public.finish_adventure_parse($1, $2, $3, $4, 'test-1', $5::jsonb)", [
    fileId,
    ok,
    ok ? "" : "This file could not be read.",
    // A distinct digest per file (the same digest twice is a duplicate, D209).
    fileId.replace(/-/g, "").repeat(2),
    JSON.stringify(
      ok
        ? {
            format: "gpx",
            started_at: "2026-11-14T07:00:00Z",
            finished_at: "2026-11-14T15:00:00Z",
            distance_km: 126.4,
            has_times: hasTimes,
            points: [
              [hasTimes ? "2026-11-14T07:00:00Z" : "", 1.3, 103.8],
              [hasTimes ? "2026-11-14T15:00:00Z" : "", 1.31, 103.81],
            ],
          }
        : {},
    ),
  ]);
}

async function paid(tx: Connection): Promise<{ rider: Rider; bookingId: string }> {
  const sale = await offerOn125(tx);
  await openSales(tx);
  const rider = await makeRider(tx);
  return { rider, bookingId: await paidBooking(tx, rider, sale) };
}

describe("uploads (E05)", () => {
  it("are allocated only for the rider's own paid booking, with sensible types and sizes", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const rider = await makeRider(tx);
      const other = await makeRider(tx);
      const bookingId = await paidBooking(tx, rider, sale);

      const file = await allocate(tx, rider, bookingId);
      expect(file.storage_path).toMatch(new RegExp(`^${bookingId}/[0-9a-f-]{36}\\.gpx$`));
      expect(file.max_bytes).toBe("26214400");

      await failsWith(tx, () => allocate(tx, other, bookingId), { code: "42501" });
      await failsWith(
        tx,
        () => allocate(tx, rider, bookingId, { name: "ride.tcx" }),
        refused("adventure_file_type"),
      );
      await failsWith(
        tx,
        () => allocate(tx, rider, bookingId, { bytes: 30_000_000 }),
        refused("adventure_file_too_large"),
      );
      await failsWith(
        tx,
        () =>
          allocate(tx, rider, bookingId, {
            kind: "checkpoint_photo",
            checkpoint: 9,
            name: "p.jpg",
          }),
        refused("adventure_checkpoint_unknown"),
      );
      const photo = await allocate(tx, rider, bookingId, {
        kind: "checkpoint_photo",
        checkpoint: 1,
        name: "p.jpg",
      });
      expect(photo.storage_path).toMatch(/\.jpg$/);

      // An unpaid booking takes no evidence.
      await actAs(tx, customerClaims(other.authUserId));
      const { rows } = await tx.query<{ booking_id: string }>(
        `select booking_id from public.prepare_my_adventure_checkout(gen_random_uuid(), 'bicii-125', 'self_supported', $1, 'S', 'hidden', '2026-11-test')`,
        [sale.revisionNumber],
      );
      await failsWith(
        tx,
        () => allocate(tx, other, rows[0].booking_id),
        refused("adventure_booking_not_paid"),
      );
    });
  });

  it("Storage takes the object only at an allocated path, once; the size is Storage's", async () => {
    await inTransaction(conn, async (tx) => {
      const { rider, bookingId } = await paid(tx);
      const file = await allocate(tx, rider, bookingId);

      // As the rider through Storage's table (what the Storage API inserts).
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () =>
          tx.query(
            "insert into storage.objects (bucket_id, name, metadata) values ('adventure-evidence', $1, '{}')",
            [`${bookingId}/00000000-0000-4000-8000-000000000000.gpx`],
          ),
        { code: "42501" },
      );
      await tx.query(
        `insert into storage.objects (bucket_id, name, metadata)
         values ('adventure-evidence', $1, '{"size": 98765, "mimetype": "application/gpx+xml"}')`,
        [file.storage_path],
      );
      await failsWith(
        tx,
        () => tx.query("select public.finalise_my_adventure_upload($1)", [crypto.randomUUID()]),
        {
          code: "42501",
        },
      );
      await tx.query("select public.finalise_my_adventure_upload($1)", [file.file_id]);
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            "select state::text, size_bytes::int from public.adventure_evidence_files where id = $1",
            [file.file_id],
          )
        ).rows,
      ).toEqual([{ state: "uploaded", size_bytes: 98765 }]);
      // No second object at the same path once confirmed.
      await actAs(tx, customerClaims(rider.authUserId));
      expect(
        await scalar<boolean>(tx, "select private.adventure_upload_allowed($1)", [
          file.storage_path,
        ]),
      ).toBe(false);
    });
  });

  it("confirming a file that never arrived is refused", async () => {
    await inTransaction(conn, async (tx) => {
      const { rider, bookingId } = await paid(tx);
      const file = await allocate(tx, rider, bookingId);
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.finalise_my_adventure_upload($1)", [file.file_id]),
        refused("adventure_upload_missing"),
      );
    });
  });
});

describe("parsing and submitting (E01, E06)", () => {
  it("needs a parsed recording with times; then freezes the version", async () => {
    await inTransaction(conn, async (tx) => {
      const { rider, bookingId } = await paid(tx);
      const file = await allocate(tx, rider, bookingId);
      await upload(tx, rider, file);

      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.submit_my_adventure_evidence($1, '')", [bookingId]),
        refused("adventure_evidence_processing"),
      );
      await parse(tx, file.file_id, true, false); // a route without times
      await actAs(tx, customerClaims(rider.authUserId));
      await failsWith(
        tx,
        () => tx.query("select public.submit_my_adventure_evidence($1, '')", [bookingId]),
        refused("adventure_evidence_incomplete"),
      );

      const good = await allocate(tx, rider, bookingId, { name: "ride.fit" });
      await upload(tx, rider, good);
      await parse(tx, good.file_id);
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.submit_my_adventure_evidence($1, 'Rode it on Saturday')", [
        bookingId,
      ]);

      const evidence = await tx.query<{ state: string; version: number; files: unknown[] }>(
        "select state::text, version, files from public.my_adventure_evidence($1)",
        [bookingId],
      );
      expect(evidence.rows[0]).toMatchObject({ state: "submitted", version: 1 });
      expect(evidence.rows[0].files).toHaveLength(2);

      // Frozen: nothing added or removed.
      await failsWith(
        tx,
        () => allocate(tx, rider, bookingId),
        refused("adventure_submission_locked"),
      );
      await failsWith(
        tx,
        () => tx.query("select public.remove_my_adventure_file($1)", [good.file_id]),
        refused("adventure_evidence_immutable"),
      );
      await tx.query("reset role");
      expect(
        (
          await tx.query(
            `select t.state::text, t.ride_started_at is not null as started
               from public.adventure_attempts t where t.booking_id = $1`,
            [bookingId],
          )
        ).rows,
      ).toEqual([{ state: "finished", started: true }]);
    });
  });

  it("a correction request opens version 2 with the earlier files, re-read, without a new purchase", async () => {
    await inTransaction(conn, async (tx) => {
      const { rider, bookingId } = await paid(tx);
      const file = await allocate(tx, rider, bookingId);
      await upload(tx, rider, file);
      await parse(tx, file.file_id);
      await actAs(tx, customerClaims(rider.authUserId));
      await tx.query("select public.submit_my_adventure_evidence($1, '')", [bookingId]);

      // Slice 4's reviewer: here, as the owner, the state a correction request leaves.
      await tx.query("reset role");
      await tx.query(
        `update public.adventure_submissions s set state = 'changes_requested'
           from public.adventure_attempts t where t.id = s.attempt_id and t.booking_id = $1`,
        [bookingId],
      );
      const photo = await allocate(tx, rider, bookingId, {
        kind: "checkpoint_photo",
        checkpoint: 2,
        name: "s.jpg",
      });
      await tx.query("reset role");
      const { rows } = await tx.query<{ version: number; kinds: string[]; states: string[] }>(
        `select s.version, array_agg(f.kind::text order by f.created_at) as kinds,
                array_agg(f.state::text order by f.created_at) as states
           from public.adventure_submissions s
           join public.adventure_evidence_files f on f.submission_id = s.id
          where s.state = 'draft' and s.attempt_id = (select id from public.adventure_attempts where booking_id = $1)
          group by s.version`,
        [bookingId],
      );
      expect(rows).toEqual([
        {
          version: 2,
          kinds: ["activity", "checkpoint_photo"],
          states: ["uploaded", "awaiting_upload"],
        },
      ]);
      expect(photo.storage_path.startsWith(bookingId)).toBe(true);
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_bookings where customer_id = $1",
          [rider.customerId],
        ),
      ).toBe(1);
    });
  });

  it("a duplicate or late worker result changes nothing", async () => {
    await inTransaction(conn, async (tx) => {
      const { rider, bookingId } = await paid(tx);
      const file = await allocate(tx, rider, bookingId);
      await upload(tx, rider, file);
      await parse(tx, file.file_id);
      await actAs(tx, SERVICE);
      await tx.query(
        "select public.finish_adventure_parse($1, false, 'late', null, 'x', '{}'::jsonb)",
        [file.file_id],
      );
      await tx.query("reset role");
      expect(
        await scalar<string>(
          tx,
          "select state::text from public.adventure_evidence_files where id = $1",
          [file.file_id],
        ),
      ).toBe("parsed");
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_tracks where file_id = $1",
          [file.file_id],
        ),
      ).toBe(1);
    });
  });
});

describe("access (A03, A04)", () => {
  it("riders see only their own evidence; only verifying staff read files and tracks", async () => {
    await inTransaction(conn, async (tx) => {
      const sale = await offerOn125(tx);
      await openSales(tx);
      const a = await makeRider(tx);
      const b = await makeRider(tx);
      const bookingA = await paidBooking(tx, a, sale);
      const file = await allocate(tx, a, bookingA);
      await upload(tx, a, file);
      await parse(tx, file.file_id);

      await actAs(tx, customerClaims(b.authUserId));
      expect(
        (await tx.query("select * from public.my_adventure_evidence($1)", [bookingA])).rows,
      ).toEqual([]);
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_evidence_files"),
      ).toBe(0);
      expect(
        await scalar<boolean>(tx, "select private.adventure_evidence_readable($1)", [
          file.storage_path,
        ]),
      ).toBe(false);

      await actAs(tx, customerClaims(a.authUserId));
      expect(
        await scalar<boolean>(tx, "select private.adventure_evidence_readable($1)", [
          file.storage_path,
        ]),
      ).toBe(true);

      await actAs(tx, staffClaims(AUTH_USER.mechanic2));
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_evidence_files"),
      ).toBe(0);
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_track_points"),
      ).toBe(0);

      await actAs(tx, staffClaims(AUTH_USER.manager));
      expect(
        await scalar<number>(
          tx,
          "select count(*)::int from public.adventure_evidence_files where id = $1",
          [file.file_id],
        ),
      ).toBe(1);
      expect(
        await scalar<number>(tx, "select count(*)::int from public.adventure_track_points"),
      ).toBeGreaterThan(0);

      await actAs(tx, { role: "anon" });
      await failsWith(tx, () => tx.query("select 1 from public.adventure_tracks"), {
        code: "42501",
      });
    });
  });
});
