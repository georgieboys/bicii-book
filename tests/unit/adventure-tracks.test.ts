// @vitest-environment node
/**
 * Adventures Phase B, slice 3: reading ride files (D176; handoff E01, E04)
 * and the parse worker and its cron (fails closed, handoff A11). Synthetic
 * GPX text and a FIT file built with the library's encoder; no rider data.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { haversineKm, parseFit, parseGpx, readTrack, TrackError, MAX_POINTS } =
  await import("@/lib/adventures/tracks");
const { runAdventureParse } = await import("@/lib/integrations/adventures/parse-worker");
const { handleAdventureWork } = await import("@/lib/integrations/adventures/work-cron");
const { FitEncoder, FitBaseType } = await import("fit-file-parser");

const gpx = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

const TRACK = gpx(`<trk><name>BICII 125</name><trkseg>
  <trkpt lat="1.3000" lon="103.8000"><ele>10</ele><time>2026-11-14T07:00:00Z</time></trkpt>
  <trkpt lat="1.3100" lon="103.8000"><time>2026-11-14T07:05:00Z</time></trkpt>
  <trkpt lat='1.3200' lon='103.8000'><time>2026-11-14T07:10:00Z</time></trkpt>
</trkseg></trk>`);

describe("GPX (E01, E04)", () => {
  it("reads a recorded track with times and a point-to-point distance", () => {
    const track = parseGpx(TRACK);
    expect(track.format).toBe("gpx");
    expect(track.points).toHaveLength(3);
    expect(track.hasTimes).toBe(true);
    expect(track.startedAt).toBe("2026-11-14T07:00:00.000Z");
    expect(track.finishedAt).toBe("2026-11-14T07:10:00.000Z");
    // 0.02 degrees of latitude is about 2.2 km.
    expect(track.distanceKm).toBeCloseTo(2.2, 1);
  });

  it("flags a track without times (it cannot certify a ride)", () => {
    const track = parseGpx(
      gpx(
        '<trk><trkseg><trkpt lat="1.3" lon="103.8"/><trkpt lat="1.31" lon="103.8"/></trkseg></trk>',
      ),
    );
    expect(track.hasTimes).toBe(false);
    expect(track.startedAt).toBeNull();
  });

  it("refuses a planned route, an empty file, and anything that is not GPX", () => {
    expect(() => parseGpx(gpx('<rte><rtept lat="1.3" lon="103.8"/></rte>'))).toThrow(
      /planned route/,
    );
    expect(() => parseGpx(gpx("<trk/>"))).toThrow(TrackError);
    expect(() => parseGpx("hello")).toThrow(/not a GPX/);
  });

  it("refuses DTDs and entity declarations before reading anything (E04)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx><trk><trkseg><trkpt lat="1" lon="1"><name>&x;</name></trkpt></trkseg></trk></gpx>`;
    expect(() => parseGpx(xxe)).toThrow(/declarations/);
    expect(() => parseGpx(`<!ENTITY a "b">${TRACK}`)).toThrow(/declarations/);
  });

  it("drops impossible positions and refuses more points than it reads", () => {
    const track = parseGpx(
      gpx(
        '<trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="91" lon="1"/><trkpt lat="1.3" lon="103.8"/></trkseg></trk>',
      ),
    );
    expect(track.points).toHaveLength(1);
    const many = gpx(
      `<trk><trkseg>${'<trkpt lat="1.3" lon="103.8"/>'.repeat(MAX_POINTS + 2)}</trkseg></trk>`,
    );
    expect(() => parseGpx(many)).toThrow(/more points/);
  });

  it("haversine: one degree of latitude is about 111 km", () => {
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.2, 0);
  });
});

/** A FIT activity: a file_id and timed, positioned records (semicircles). */
function fitFile(points: Array<{ at: Date; lat: number; lon: number }>): Uint8Array {
  const semicircles = (deg: number) => Math.round((deg * 2 ** 31) / 180);
  const encoder = new FitEncoder();
  encoder.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 }, // type: activity
    {
      number: 4,
      size: 4,
      baseType: FitBaseType.Uint32,
      value: FitEncoder.toFitTimestamp(points[0].at),
    },
  ]);
  for (const p of points) {
    encoder.writeMessage(20, [
      {
        number: 253,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: FitEncoder.toFitTimestamp(p.at),
      },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semicircles(p.lat) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semicircles(p.lon) },
    ]);
  }
  return encoder.close();
}

describe("GPX reading time (audit A-37)", () => {
  it("reads hostile files with unclosed point tags in linear time", () => {
    for (const hostile of [
      "<gpx>" + "<trkpt>".repeat(300_000),
      "<gpx>" + "<trkpt ".repeat(300_000),
      "<gpx>" + '<trkpt lat="1" lon="2">'.repeat(150_000),
      "<gpx>" + "<trkpt lat=".repeat(200_000),
    ]) {
      const started = Date.now();
      try {
        parseGpx(hostile);
      } catch (err) {
        expect(err).toBeInstanceOf(TrackError);
      }
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("still reads points whose tags are split, self-closing, or missing their close", () => {
    const track = parseGpx(
      gpx(
        '<trk><trkseg><trkpt\n lat="1.30" lon="103.80">\n<time>2026-11-14T22:00:00Z</time></trkpt>' +
          '<trkpt lat="1.31" lon="103.81"/>' +
          '<trkpt lat="1.32" lon="103.82"><time>2026-11-14T22:10:00Z</time>' +
          '<trkpt lat="1.33" lon="103.83"><time>2026-11-14T22:15:00Z</time></trkpt></trkseg></trk>',
      ),
    );
    expect(track.points).toEqual([
      { lat: 1.3, lon: 103.8, time: "2026-11-14T22:00:00.000Z" },
      { lat: 1.31, lon: 103.81, time: null },
      { lat: 1.32, lon: 103.82, time: "2026-11-14T22:10:00.000Z" },
      { lat: 1.33, lon: 103.83, time: "2026-11-14T22:15:00.000Z" },
    ]);
  });

  it("ignores a <trkpts> lookalike and a point with an oversized body", () => {
    const track = parseGpx(
      gpx(
        '<trkpts lat="9" lon="9"/>' +
          `<trkpt lat="1.30" lon="103.80"><time>2026-11-14T22:00:00Z</time>${" ".repeat(5000)}</trkpt>` +
          '<trkpt lat="1.31" lon="103.81"/>',
      ),
    );
    expect(track.points).toEqual([
      { lat: 1.3, lon: 103.8, time: null },
      { lat: 1.31, lon: 103.81, time: null },
    ]);
  });
});

describe("FIT (E01, E04)", () => {
  it("reads positioned records with their times", async () => {
    const bytes = fitFile([
      { at: new Date("2026-11-14T07:00:00Z"), lat: 1.3, lon: 103.8 },
      { at: new Date("2026-11-14T07:05:00Z"), lat: 1.31, lon: 103.8 },
    ]);
    const track = await parseFit(bytes);
    expect(track.format).toBe("fit");
    expect(track.points).toHaveLength(2);
    expect(track.points[0].lat).toBeCloseTo(1.3, 4);
    expect(track.hasTimes).toBe(true);
    expect(track.startedAt).toBe("2026-11-14T07:00:00.000Z");
    expect(track.distanceKm).toBeCloseTo(1.1, 1);
  });

  it("refuses garbage and a file with no positions, without throwing anything else", async () => {
    await expect(parseFit(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(TrackError);
    await expect(
      readTrack("ride.fit", new TextEncoder().encode("not a fit file at all")),
    ).rejects.toBeInstanceOf(TrackError);
  });

  it("reads by extension and refuses other types", async () => {
    expect((await readTrack("ride.GPX", new TextEncoder().encode(TRACK))).points).toHaveLength(3);
    await expect(readTrack("ride.tcx", new Uint8Array([1]))).rejects.toThrow(/GPX or FIT/);
  });
});

describe("the parse worker", () => {
  function worker(
    files: Record<string, string>,
    jobs: Array<{ file_id: string; storage_path: string }>,
  ) {
    const finished: Array<Record<string, unknown>> = [];
    const released: string[] = [];
    const queue = [...jobs];
    const supabase = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_adventure_parse_jobs") {
          // One file per claim (D228).
          const next = queue.shift();
          return {
            data: next ? [{ ...next, original_name: next.storage_path, attempts: 1 }] : [],
            error: null,
          };
        }
        if (name === "release_adventure_parse") {
          released.push(args.file_id as string);
          return { data: null, error: null };
        }
        finished.push(args);
        return { data: null, error: null };
      },
      storage: {
        from: () => ({
          download: (path: string) =>
            path === "b/slow.gpx"
              ? new Promise(() => {})
              : Promise.resolve(
                  path in files
                    ? { data: new Blob([files[path]]), error: null }
                    : { data: null, error: new Error("missing") },
                ),
        }),
      },
    };
    return {
      deps: { supabase: supabase as never, log: pino({ level: "silent" }), now: () => 0 },
      finished,
      released,
    };
  }

  it("records a track, a rider-safe failure, and gives a broken download's attempt back", async () => {
    const { deps, finished, released } = worker(
      { "b/1.gpx": TRACK, "b/2.gpx": gpx('<rte><rtept lat="1" lon="1"/></rte>') },
      [
        { file_id: "f1", storage_path: "b/1.gpx" },
        { file_id: "f2", storage_path: "b/2.gpx" },
        { file_id: "f3", storage_path: "b/3.gpx" },
      ],
    );
    expect(await runAdventureParse(deps, { max: 3, deadlineMs: 1 })).toEqual({
      claimed: 3,
      parsed: 1,
      failed: 1,
      errored: 1,
    });
    expect(finished[0]).toMatchObject({ file_id: "f1", ok: true });
    expect((finished[0].track as { points: unknown[] }).points).toHaveLength(3);
    expect(finished[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finished[1]).toMatchObject({ file_id: "f2", ok: false });
    expect(finished[1].error).toMatch(/planned route/);
    expect(finished).toHaveLength(2);
    expect(released).toEqual(["f3"]);
  });

  it("gives back the attempt of a download that hangs (audit A-43)", async () => {
    const { deps, released } = worker({}, [{ file_id: "f9", storage_path: "b/slow.gpx" }]);
    expect(await runAdventureParse(deps, { max: 3, deadlineMs: 1, downloadTimeoutMs: 20 })).toEqual(
      {
        claimed: 1,
        parsed: 0,
        failed: 0,
        errored: 1,
      },
    );
    expect(released).toEqual(["f9"]);
  });
});

describe("GET /api/cron/adventure-work (A11)", () => {
  const run = vi.fn(async () => ({ claimed: 0, parsed: 0, failed: 0, errored: 0 }));
  const request = (auth?: string) =>
    new Request("https://admin.example/api/cron/adventure-work", {
      headers: auth ? { authorization: auth } : {},
    });

  it("fails closed without CRON_SECRET, refuses a wrong bearer, runs with the right one", async () => {
    expect(
      (await handleAdventureWork(request("Bearer x"), { secret: undefined, run, now: () => 0 }))
        .status,
    ).toBe(503);
    expect(
      (await handleAdventureWork(request(), { secret: "s3cret-value", run, now: () => 0 })).status,
    ).toBe(401);
    expect(
      (
        await handleAdventureWork(request("Bearer nope"), {
          secret: "s3cret-value",
          run,
          now: () => 0,
        })
      ).status,
    ).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const ok = await handleAdventureWork(request("Bearer s3cret-value"), {
      secret: "s3cret-value",
      run,
      now: () => 0,
    });
    expect(ok.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("adventure-work steps (audit A-44)", () => {
  it("runs every step even when one fails, and logs the failure", async () => {
    const { runWorkSteps } = await import("@/lib/integrations/adventures/work-cron");
    const ran: string[] = [];
    const errors: unknown[] = [];
    const summary = await runWorkSteps(
      {
        emails: async () => {
          ran.push("emails");
          throw Object.assign(new Error("claim failed"), { code: "PGRST202" });
        },
        feeds: async () => {
          ran.push("feeds");
          return { feeds: 1, stored: 2, failed: 0 };
        },
        files: async () => {
          ran.push("files");
          throw new Error("parse failed");
        },
        purge: async () => {
          ran.push("purge");
          return 3;
        },
      },
      { error: (obj: unknown) => errors.push(obj) } as never,
    );
    expect(ran).toEqual(["emails", "feeds", "files", "purge"]);
    expect(summary.failed).toEqual(["emails", "files"]);
    expect(summary.feeds).toEqual({ feeds: 1, stored: 2, failed: 0 });
    expect(summary.purged).toBe(3);
    expect(errors).toEqual([
      { step: "emails", error: "Error", code: "PGRST202" },
      { step: "files", error: "Error", code: null },
    ]);
  });

  it("answers 500 when a step failed, after trying them all", async () => {
    const { handleAdventureWork } = await import("@/lib/integrations/adventures/work-cron");
    const res = await handleAdventureWork(
      new Request("https://admin.example/api/cron/adventure-work", {
        headers: { authorization: "Bearer s3cret" },
      }),
      {
        secret: "s3cret",
        now: () => 0,
        run: async () => ({ files: null, emails: null, feeds: null, purged: 0, failed: ["files"] }),
      },
    );
    expect(res.status).toBe(500);
  });
});
