/**
 * Adventures Phase A: the catalogue (docs/ADVENTURES.md, ADR-026, PLAN
 * D164-D171; DATA-MODEL §20).
 *
 *   seed            the nine public-site routes: four free, five planned,
 *                   none certifiable, all published
 *   access          anon and customers read only public_adventures /
 *                   public_adventure (published, public columns); staff
 *                   read the tables; only manage_adventures changes them
 *   certification   offers only from 125 km, not on planned routes, and a
 *                   revision with offers publishes only with nominal days
 *                   and a maximum time (handoff P02)
 *   revisions       a published revision never changes; the next edit is a
 *                   copied draft; the public keeps seeing the old one until
 *                   the new one is published (D166)
 *   prices          the owner's formulas (handoff P03, P04, D165)
 *
 * Every case runs in a rolled-back transaction.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { STAFF } from "../fixtures/ids";
import { actAs, asAnon, asStaff, connect, inTransaction, scalar, type Connection } from "./harness";
import { failsWith } from "./workshop-fixtures";

let conn: pg.Client;

beforeAll(async () => {
  conn = await connect();
});

const refused = (message: string) => ({ code: "P0001", message });
const denied = { code: "42501" };

type PublicRow = {
  slug: string;
  name: string;
  distance_km: string;
  is_planned: boolean;
  certifiable: boolean;
  offers: {
    kind: string;
    price: number;
    tracker_hire_price: number | null;
    supported_days: number | null;
  }[];
};

async function publicList(tx: Connection): Promise<PublicRow[]> {
  const { rows } = await tx.query<PublicRow>("select * from public.public_adventures()");
  return rows;
}

async function publicOne(tx: Connection, slug: string): Promise<Record<string, unknown> | null> {
  const { rows } = await tx.query("select * from public.public_adventure($1)", [slug]);
  return rows[0] ?? null;
}

/** As the manager (role implies manage_adventures): a new draft adventure. */
async function createAdventure(
  tx: Connection,
  slug: string,
  km: number,
): Promise<{ adventureId: string; revisionId: string; version: number }> {
  const { rows } = await tx.query<{ id: string; adventure_id: string; version: number }>(
    "select id, adventure_id, version from public.create_adventure($1, $2, $3)",
    [slug, `Test ${km}`, km],
  );
  return {
    adventureId: rows[0].adventure_id,
    revisionId: rows[0].id,
    version: rows[0].version,
  };
}

/** Saves a draft with the given changes on top of sensible certifiable defaults. */
async function saveDraft(
  tx: Connection,
  revisionId: string,
  expectedVersion: number,
  changes: Partial<{
    name: string;
    distance_km: number;
    nominal_days: number | null;
    max_elapsed_minutes: number | null;
    min_elapsed_minutes: number | null;
    time_zone: string;
    is_planned: boolean;
    staff_notes: string;
    rider_instructions: string;
    emergency_procedure: string;
  }> = {},
): Promise<number> {
  const v = {
    name: "BICII 125 test",
    distance_km: 125,
    nominal_days: 1,
    max_elapsed_minutes: 1440,
    min_elapsed_minutes: null,
    time_zone: "Asia/Singapore",
    is_planned: false,
    staff_notes: "",
    rider_instructions: "",
    emergency_procedure: "",
    ...changes,
  };
  const { rows } = await tx.query<{ version: number }>(
    `select version from public.update_adventure_draft(
       revision_id => $1, expected_version => $2, name => $3, summary => 'A summary',
       description => 'A description', note => '', region => 'Singapore', terrain => 'Road',
       when_to_start => 'Around 3pm', start_finish => '294 River Valley',
       distance_km => $4, nominal_days => $5, time_zone => $6,
       min_elapsed_minutes => $7, max_elapsed_minutes => $8, checkpoint_order => 'any',
       route_url => 'https://www.strava.com/routes/1', rules => 'Ride it all',
       equipment => 'Lights', rider_instructions => $9, emergency_procedure => $10,
       staff_notes => $11, is_planned => $12)`,
    [
      revisionId,
      expectedVersion,
      v.name,
      v.distance_km,
      v.nominal_days,
      v.time_zone,
      v.min_elapsed_minutes,
      v.max_elapsed_minutes,
      v.rider_instructions,
      v.emergency_procedure,
      v.staff_notes,
      v.is_planned,
    ],
  );
  return rows[0].version;
}

async function setOffer(
  tx: Connection,
  revisionId: string,
  kind: string,
  price: number,
  trackerHire: number | null = null,
  supportedDays: number | null = null,
): Promise<void> {
  await tx.query("select public.set_adventure_offer($1, $2, $3, $4, $5, 'Finisher pack')", [
    revisionId,
    kind,
    price,
    trackerHire,
    supportedDays,
  ]);
}

describe("seed: the public site's routes", () => {
  it("publishes the nine routes, four free and five planned, none certifiable", async () => {
    await asAnon(conn, async (tx) => {
      const rows = await publicList(tx);
      const seeded = rows.filter((r) =>
        [
          "30k-east-coast",
          "50k-green-corridor",
          "80k-changi-village",
          "bicii-125",
          "bicii-250",
          "bicii-500",
          "bicii-1000",
          "bicii-2000",
          "bicii-3000",
        ].includes(r.slug),
      );
      expect(seeded.map((r) => [r.slug, Number(r.distance_km), r.is_planned])).toEqual([
        ["30k-east-coast", 30, false],
        ["50k-green-corridor", 50, false],
        ["80k-changi-village", 80, false],
        ["bicii-125", 125, false],
        ["bicii-250", 250, true],
        ["bicii-500", 500, true],
        ["bicii-1000", 1000, true],
        ["bicii-2000", 2000, true],
        ["bicii-3000", 3000, true],
      ]);
      expect(seeded.every((r) => !r.certifiable && r.offers.length === 0)).toBe(true);
    });
  });
});

describe("access", () => {
  it("anon reads only the public functions, never the tables", async () => {
    await asAnon(conn, async (tx) => {
      for (const table of [
        "adventures",
        "adventure_revisions",
        "adventure_checkpoints",
        "adventure_offers",
        "adventure_events",
      ]) {
        await failsWith(tx, () => tx.query(`select 1 from public.${table}`), denied);
      }
      await failsWith(
        tx,
        () => tx.query("select public.create_adventure('x-1', 'X', 125)"),
        denied,
      );
      expect((await publicList(tx)).length).toBeGreaterThanOrEqual(9);
    });
  });

  it("a signed-in customer sees no rows in the tables and cannot change anything", async () => {
    await inTransaction(conn, async (tx) => {
      await actAs(tx, { role: "authenticated", aud: "authenticated", sub: randomUUID() });
      expect(await scalar(tx, "select count(*)::int from public.adventures")).toBe(0);
      expect(await scalar(tx, "select count(*)::int from public.adventure_revisions")).toBe(0);
      await failsWith(
        tx,
        () => tx.query("select public.create_adventure('x-1', 'X', 125)"),
        denied,
      );
      expect((await publicList(tx)).length).toBeGreaterThanOrEqual(9);
    });
  });

  it("any staff member reads the catalogue; a mechanic without the permission cannot change it", async () => {
    await asStaff(conn, STAFF.mechanic2, async (tx) => {
      expect(
        await scalar(tx, "select count(*)::int from public.adventures"),
      ).toBeGreaterThanOrEqual(9);
      await failsWith(
        tx,
        () => tx.query("select public.create_adventure('x-1', 'X', 125)"),
        denied,
      );
      const id = await scalar<string>(
        tx,
        "select id from public.adventures where slug = 'bicii-125'",
      );
      await failsWith(tx, () => tx.query("select public.start_adventure_draft($1)", [id]), denied);
      await failsWith(tx, () => tx.query("select public.archive_adventure($1, 'x')", [id]), denied);
      await failsWith(
        tx,
        () => tx.query("select public.suggested_adventure_price('supported', null, 1)"),
        denied,
      );
    });
  });

  it("nobody writes the tables directly, not even an admin", async () => {
    await asStaff(conn, STAFF.admin, async (tx) => {
      await failsWith(
        tx,
        () => tx.query("insert into public.adventures (slug) values ('direct')"),
        denied,
      );
      await failsWith(
        tx,
        () => tx.query("update public.adventures set sort_order = 1 where slug = 'bicii-125'"),
        denied,
      );
      await failsWith(tx, () => tx.query("delete from public.adventure_events"), denied);
    });
  });
});

describe("drafts and publishing", () => {
  it("a draft is invisible to the public until it is published", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId, version } = await createAdventure(tx, "draft-test", 125);
      await saveDraft(tx, revisionId, version, {
        staff_notes: "Staff only",
        rider_instructions: "Buyers only",
      });
      await actAs(tx, { role: "anon" });
      expect(await publicOne(tx, "draft-test")).toBeNull();
      expect((await publicList(tx)).some((r) => r.slug === "draft-test")).toBe(false);
    });
  });

  it("publishing seals the revision and shows only public columns", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId, version } = await createAdventure(tx, "publish-test", 125);
      await saveDraft(tx, revisionId, version, {
        staff_notes: "Staff only",
        rider_instructions: "Buyers only",
        emergency_procedure: "Call the shop",
      });
      await tx.query("select public.set_adventure_checkpoints($1, $2::jsonb)", [
        revisionId,
        JSON.stringify([
          { label: "Lim Chu Kang", latitude: 1.43, longitude: 103.71, photo_required: true },
          { label: "Seletar", instructions: "The aerospace park sign", mandatory: false },
        ]),
      ]);
      await setOffer(tx, revisionId, "self_supported", 49, 20);
      await tx.query("select public.publish_adventure_revision($1, 'First version')", [revisionId]);

      await actAs(tx, { role: "anon" });
      const one = await publicOne(tx, "PUBLISH-TEST");
      expect(one).not.toBeNull();
      expect(one).not.toHaveProperty("staff_notes");
      expect(one).not.toHaveProperty("rider_instructions");
      expect(one).not.toHaveProperty("emergency_procedure");
      expect(one!.certifiable).toBe(true);
      expect(one!.offers).toEqual([
        {
          kind: "self_supported",
          price: 49,
          tracker_hire_price: 20,
          supported_days: null,
          inclusions: "Finisher pack",
        },
      ]);
      expect(
        (one!.checkpoints as { label: string; position: number }[]).map((c) => [
          c.position,
          c.label,
        ]),
      ).toEqual([
        [1, "Lim Chu Kang"],
        [2, "Seletar"],
      ]);
    });
  });

  it("refuses a save from a stale screen", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId, version } = await createAdventure(tx, "stale-test", 125);
      // Another tab saved first: this editor still holds version 1.
      const next = await saveDraft(tx, revisionId, version);
      expect(next).toBe(version + 1);
      await failsWith(
        tx,
        () => saveDraft(tx, revisionId, version),
        refused("adventure_draft_changed"),
      );
      expect(await saveDraft(tx, revisionId, next)).toBe(next + 1);
    });
  });

  it("refuses an unknown time zone", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId, version } = await createAdventure(tx, "zone-test", 125);
      await failsWith(
        tx,
        () => saveDraft(tx, revisionId, version, { time_zone: "Mars/Olympus" }),
        refused("adventure_time_zone_invalid"),
      );
      expect(await saveDraft(tx, revisionId, version, { time_zone: "Asia/Bangkok" })).toBe(
        version + 1,
      );
    });
  });

  it("refuses an invalid or taken slug", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      await failsWith(
        tx,
        () => createAdventure(tx, "Not Valid", 125),
        refused("adventure_slug_invalid"),
      );
      await failsWith(
        tx,
        () => createAdventure(tx, "bicii-125", 125),
        refused("adventure_slug_taken"),
      );
    });
  });
});

describe("certification offers (D164, handoff P02)", () => {
  it("are refused under 125 km and on planned routes", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      for (const km of [30, 50, 80, 124.9]) {
        const { revisionId } = await createAdventure(
          tx,
          `short-${String(km).replace(".", "-")}`,
          km,
        );
        await failsWith(
          tx,
          () => setOffer(tx, revisionId, "self_supported", 49),
          refused("adventure_not_certifiable"),
        );
      }
      const planned = await createAdventure(tx, "planned-test", 250);
      await saveDraft(tx, planned.revisionId, planned.version, {
        distance_km: 250,
        is_planned: true,
      });
      await failsWith(
        tx,
        () => setOffer(tx, planned.revisionId, "self_supported", 59),
        refused("adventure_planned"),
      );
    });
  });

  it("publish needs nominal days and a maximum time, and still 125 km", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId, version } = await createAdventure(tx, "rules-test", 125);
      let at = await saveDraft(tx, revisionId, version, { max_elapsed_minutes: null });
      await setOffer(tx, revisionId, "self_supported", 49);
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_revision($1, null)", [revisionId]),
        refused("adventure_rules_incomplete"),
      );
      // Distance lowered after the offer was added: publish still refuses.
      at = await saveDraft(tx, revisionId, at, { distance_km: 100 });
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_revision($1, null)", [revisionId]),
        refused("adventure_not_certifiable"),
      );
      await saveDraft(tx, revisionId, at);
      await tx.query("select public.publish_adventure_revision($1, null)", [revisionId]);
    });
  });

  it("a supported offer carries its days and never a tracker hire price", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { revisionId } = await createAdventure(tx, "supported-test", 125);
      await setOffer(tx, revisionId, "supported", 149, 20, 1);
      const row = await tx.query(
        "select tracker_hire_price, supported_days from public.adventure_offers where revision_id = $1 and kind = 'supported'",
        [revisionId],
      );
      expect(row.rows).toEqual([{ tracker_hire_price: null, supported_days: 1 }]);
    });
  });
});

describe("revisions (D166)", () => {
  it("a published revision cannot change; the next edit is a copied draft the public does not see", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const { adventureId, revisionId, version } = await createAdventure(tx, "revision-test", 125);
      await saveDraft(tx, revisionId, version);
      await tx.query("select public.set_adventure_checkpoints($1, $2::jsonb)", [
        revisionId,
        JSON.stringify([{ label: "Checkpoint A" }]),
      ]);
      await setOffer(tx, revisionId, "self_supported", 49);
      await tx.query("select public.publish_adventure_revision($1, null)", [revisionId]);

      // The sealed revision refuses every change, through the RPCs and directly.
      await failsWith(
        tx,
        () => saveDraft(tx, revisionId, version),
        refused("adventure_revision_sealed"),
      );
      await failsWith(
        tx,
        () => setOffer(tx, revisionId, "self_supported", 99),
        refused("adventure_revision_sealed"),
      );
      await tx.query("reset role");
      await failsWith(
        tx,
        () =>
          tx.query("update public.adventure_offers set price = 1 where revision_id = $1", [
            revisionId,
          ]),
        refused("adventure_revision_sealed"),
      );
      await failsWith(
        tx,
        () =>
          tx.query("delete from public.adventure_checkpoints where revision_id = $1", [revisionId]),
        refused("adventure_revision_sealed"),
      );
      await failsWith(
        tx,
        () =>
          tx.query("update public.adventure_revisions set name = 'x' where id = $1", [revisionId]),
        refused("adventure_revision_sealed"),
      );

      // A new draft copies content, checkpoints and offers; calling again returns it.
      await actAs(tx, { role: "authenticated", aud: "authenticated", sub: await managerAuth(tx) });
      const draft = await tx.query<{ id: string; revision_number: number; version: number }>(
        "select id, revision_number, version from public.start_adventure_draft($1)",
        [adventureId],
      );
      expect(draft.rows[0].revision_number).toBe(2);
      expect(
        await scalar(tx, "select id from public.start_adventure_draft($1)", [adventureId]),
      ).toBe(draft.rows[0].id);
      expect(
        await scalar(
          tx,
          "select count(*)::int from public.adventure_checkpoints where revision_id = $1",
          [draft.rows[0].id],
        ),
      ).toBe(1);
      await setOffer(tx, draft.rows[0].id, "self_supported", 59);

      // The public still sees revision 1 at 49 until revision 2 is published.
      await actAs(tx, { role: "anon" });
      let one = await publicOne(tx, "revision-test");
      expect(one!.revision_number).toBe(1);
      expect((one!.offers as { price: number }[])[0].price).toBe(49);

      await actAs(tx, { role: "authenticated", aud: "authenticated", sub: await managerAuth(tx) });
      await tx.query("select public.publish_adventure_revision($1, 'Price change')", [
        draft.rows[0].id,
      ]);
      await actAs(tx, { role: "anon" });
      one = await publicOne(tx, "revision-test");
      expect(one!.revision_number).toBe(2);
      expect((one!.offers as { price: number }[])[0].price).toBe(59);

      // Revision 1 is untouched.
      await tx.query("reset role");
      expect(
        await scalar(
          tx,
          "select price::text from public.adventure_offers where revision_id = $1 and kind = 'self_supported'",
          [revisionId],
        ),
      ).toBe("49.00");
    });
  });

  it("archiving hides an adventure from the public; unarchiving shows it again; both are recorded", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const id = await scalar<string>(
        tx,
        "select id from public.adventures where slug = 'bicii-250'",
      );
      await failsWith(
        tx,
        () => tx.query("select public.archive_adventure($1, ' ')", [id]),
        refused("reason_required"),
      );
      await tx.query("select public.archive_adventure($1, 'Not planned any more')", [id]);
      await actAs(tx, { role: "anon" });
      expect(await publicOne(tx, "bicii-250")).toBeNull();

      await actAs(tx, { role: "authenticated", aud: "authenticated", sub: await managerAuth(tx) });
      const draft = await scalar<string>(tx, "select id from public.start_adventure_draft($1)", [
        id,
      ]);
      await failsWith(
        tx,
        () => tx.query("select public.publish_adventure_revision($1, null)", [draft]),
        refused("adventure_archived"),
      );
      await tx.query("select public.unarchive_adventure($1)", [id]);
      await actAs(tx, { role: "anon" });
      expect(await publicOne(tx, "bicii-250")).not.toBeNull();

      await tx.query("reset role");
      const { rows } = await tx.query<{
        kind: string;
        reason: string | null;
        staff_id: string | null;
      }>(
        "select kind::text, reason, staff_id from public.adventure_events where adventure_id = $1 order by created_at, id",
        [id],
      );
      expect(rows.map((r) => r.kind)).toEqual([
        "published",
        "archived",
        "draft_started",
        "unarchived",
      ]);
      expect(rows[1]).toMatchObject({ reason: "Not planned any more", staff_id: STAFF.manager });
    });
  });
});

describe("suggested prices (D165, handoff P03, P04)", () => {
  it("self-supported is 49 + 10 per extra day; supported is 49 + 100 per day", async () => {
    await asStaff(conn, STAFF.manager, async (tx) => {
      const price = async (kind: string, nominal: number | null, supported: number | null) =>
        scalar<string>(tx, "select public.suggested_adventure_price($1, $2, $3)::text", [
          kind,
          nominal,
          supported,
        ]);
      for (const [days, self, supported] of [
        [1, "49.00", "149.00"],
        [2, "59.00", "249.00"],
        [4, "79.00", "449.00"],
        [8, "119.00", "849.00"],
      ] as const) {
        expect(await price("self_supported", days, null)).toBe(self);
        expect(await price("self_supported_group", days, null)).toBe(self);
        expect(await price("supported", null, days)).toBe(supported);
      }
      expect(await price("self_supported", null, null)).toBeNull();
    });
  });
});

/** The manager's auth user id, for switching back after actAs(anon). */
async function managerAuth(tx: Connection): Promise<string> {
  await tx.query("reset role");
  return scalar<string>(tx, "select auth_user_id::text from public.staff where id = $1", [
    STAFF.manager,
  ]);
}
