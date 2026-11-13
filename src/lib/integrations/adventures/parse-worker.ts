import "server-only";

import type { Logger } from "pino";

import { PARSER_VERSION, readTrack, sha256Hex, TrackError } from "@/lib/adventures/tracks";
import type { ServiceSupabase } from "@/lib/integrations/shopify/deps";

/**
 * The evidence parse worker (Adventures Phase B, D176): claims uploaded
 * activity files (claim_adventure_parse_jobs, SKIP LOCKED, a 5-minute
 * claim, 3 attempts), downloads each from the private bucket, reads it and
 * records the track or a rider-safe error (finish_adventure_parse). One
 * bad file never stops the others; nothing starts after the deadline.
 */

export const EVIDENCE_BUCKET = "adventure-evidence";

export type ParseWorkerDeps = {
  supabase: ServiceSupabase;
  log: Logger;
  now: () => number;
};

export type ParseSummary = { claimed: number; parsed: number; failed: number; errored: number };

export async function runAdventureParse(
  deps: ParseWorkerDeps,
  options: { max: number; deadlineMs: number },
): Promise<ParseSummary> {
  const summary: ParseSummary = { claimed: 0, parsed: 0, failed: 0, errored: 0 };
  const { data: jobs, error } = await deps.supabase.rpc("claim_adventure_parse_jobs", {
    max_jobs: options.max,
  });
  if (error) throw error;
  summary.claimed = jobs?.length ?? 0;

  for (const job of jobs ?? []) {
    if (deps.now() > options.deadlineMs) break; // left claimed; reclaimed after 5 minutes
    const log = deps.log.child({ fileId: job.file_id });
    try {
      const download = await deps.supabase.storage.from(EVIDENCE_BUCKET).download(job.storage_path);
      if (download.error || !download.data) throw download.error ?? new Error("no data");
      const bytes = new Uint8Array(await download.data.arrayBuffer());
      const sha256 = sha256Hex(bytes);
      let result:
        { ok: true; track: Awaited<ReturnType<typeof readTrack>> } | { ok: false; message: string };
      try {
        result = { ok: true, track: await readTrack(job.storage_path, bytes) };
      } catch (err) {
        if (!(err instanceof TrackError)) throw err;
        result = { ok: false, message: err.message };
      }
      const finished = await deps.supabase.rpc("finish_adventure_parse", {
        file_id: job.file_id,
        ok: result.ok,
        error: result.ok ? "" : result.message,
        sha256,
        parser_version: PARSER_VERSION,
        track: result.ok
          ? {
              format: result.track.format,
              started_at: result.track.startedAt,
              finished_at: result.track.finishedAt,
              distance_km: result.track.distanceKm,
              has_times: result.track.hasTimes,
              points: result.track.points.map((p) => [p.time ?? "", p.lat, p.lon]),
            }
          : {},
      });
      if (finished.error) throw finished.error;
      if (result.ok) summary.parsed += 1;
      else summary.failed += 1;
      log.info({ outcome: result.ok ? "parsed" : "unreadable" }, "adventure file parsed");
    } catch (err) {
      // Left 'parsing': reclaimed after its claim lapses, failed after 3 tries.
      summary.errored += 1;
      log.error({ error: err instanceof Error ? err.name : "unknown" }, "adventure parse failed");
    }
  }
  return summary;
}
