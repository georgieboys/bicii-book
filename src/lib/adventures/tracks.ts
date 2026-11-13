import "server-only";

import { createHash } from "node:crypto";

import FitParser from "fit-file-parser";

/**
 * Reading a rider's activity file into a track (Adventures Phase B, D176;
 * handoff §13.1-13.3). Pure apart from the FIT library: bytes in, a track
 * or a rider-safe error out. Nothing here decides certification.
 *
 *   GPX: read without an XML parser. A file with a DOCTYPE or an entity
 *        declaration is refused outright, so no entity can be expanded or
 *        fetched. Track points (<trkpt>) are the ride; a file with only
 *        route points (<rtept>) is a planned route, refused as not a ride.
 *   FIT: decoded by fit-file-parser (MIT, pinned); its record messages with
 *        a position are the points.
 *
 * Points are kept as recorded, in order, never interpolated. The distance
 * is point to point (haversine), a derived figure the reviewer weighs.
 */

export const PARSER_VERSION = "bicii-tracks-1";
export const MAX_POINTS = 200_000;
export const MAX_BYTES = 26_214_400;

export type TrackPoint = { time: string | null; lat: number; lon: number };

export type ParsedTrack = {
  format: "gpx" | "fit";
  points: TrackPoint[];
  startedAt: string | null;
  finishedAt: string | null;
  distanceKm: number;
  hasTimes: boolean;
};

export class TrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres between two points (haversine). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validPoint(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** The track's figures from its points. */
export function summarise(format: "gpx" | "fit", points: TrackPoint[]): ParsedTrack {
  if (points.length === 0) throw new TrackError("This file has no positions in it.");
  if (points.length > MAX_POINTS) {
    throw new TrackError("This file has more points than BICII can read. Ask BICII for help.");
  }
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += haversineKm(points[i - 1], points[i]);
  const times = points.map((p) => p.time).filter((t): t is string => t !== null);
  const sorted = [...times].sort();
  return {
    format,
    points,
    startedAt: sorted[0] ?? null,
    finishedAt: sorted[sorted.length - 1] ?? null,
    distanceKm: Math.round(distance * 10) / 10,
    hasTimes: times.length === points.length,
  };
}

const TRKPT = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`);
const TIME = /<time>\s*([^<\s]+)\s*<\/time>/;

/** A GPX file's track points; refuses DTDs, entities and route-only files. */
export function parseGpx(text: string): ParsedTrack {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new TrackError("This GPX file contains declarations BICII does not read. Export it again.");
  }
  if (!/<gpx\b/i.test(text)) throw new TrackError("This is not a GPX file.");
  const points: TrackPoint[] = [];
  for (const match of text.matchAll(TRKPT)) {
    if (points.length > MAX_POINTS) break;
    const attrs = match[1] ?? "";
    const lat = Number(ATTR("lat").exec(attrs)?.[1]);
    const lon = Number(ATTR("lon").exec(attrs)?.[1]);
    if (!validPoint(lat, lon)) continue;
    const raw = TIME.exec(match[2] ?? "")?.[1] ?? null;
    const at = raw ? new Date(raw) : null;
    points.push({ time: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null, lat, lon });
  }
  if (points.length === 0) {
    if (/<rtept\b/i.test(text)) {
      throw new TrackError("This is a planned route, not a recorded ride. Upload the recording of your ride.");
    }
    throw new TrackError("This GPX file has no recorded track in it.");
  }
  return summarise("gpx", points);
}

type FitRecord = { timestamp?: Date | string; position_lat?: number; position_long?: number };

/** A FIT file's positioned records. */
export async function parseFit(bytes: Uint8Array): Promise<ParsedTrack> {
  const parser = new FitParser({ force: true, mode: "list" });
  let parsed: { records?: FitRecord[] };
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    parsed = (await parser.parseAsync(buffer)) as { records?: FitRecord[] };
  } catch {
    throw new TrackError("This FIT file could not be read. Export it again from your device or app.");
  }
  const points: TrackPoint[] = [];
  for (const r of parsed.records ?? []) {
    if (points.length > MAX_POINTS) break;
    const lat = Number(r.position_lat);
    const lon = Number(r.position_long);
    if (!validPoint(lat, lon)) continue;
    const at = r.timestamp ? new Date(r.timestamp) : null;
    points.push({ time: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null, lat, lon });
  }
  if (points.length === 0) throw new TrackError("This FIT file has no positions in it.");
  return summarise("fit", points);
}

/** Reads a file by its extension; throws TrackError with a rider-safe sentence. */
export async function readTrack(name: string, bytes: Uint8Array): Promise<ParsedTrack> {
  if (bytes.byteLength > MAX_BYTES) throw new TrackError("This file is larger than BICII reads.");
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "gpx") return parseGpx(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  if (ext === "fit") return parseFit(bytes);
  throw new TrackError("Upload your ride as a GPX or FIT file.");
}
