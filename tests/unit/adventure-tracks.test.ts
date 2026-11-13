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
    const supabase = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_adventure_parse_jobs")
          return {
            data: jobs.map((j) => ({ ...j, original_name: j.storage_path, attempts: 1 })),
            error: null,
          };
        finished.push(args);
        return { data: null, error: null };
      },
      storage: {
        from: () => ({
          download: async (path: string) =>
            path in files
              ? { data: new Blob([files[path]]), error: null }
              : { data: null, error: new Error("missing") },
        }),
      },
    };
    return {
      deps: { supabase: supabase as never, log: pino({ level: "silent" }), now: () => 0 },
      finished,
    };
  }

  it("records a track, a rider-safe failure, and leaves a broken download for a retry", async () => {
    const { deps, finished } = worker(
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
