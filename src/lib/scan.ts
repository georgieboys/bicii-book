/**
 * What a scanned QR code (or a typed code) means to the Admin (SPEC §20,
 * PLAN D9). Pure, so the scanner and its tests share it.
 *
 * Recognised, as a record to open through the /q resolver:
 *   - `{base}/q/{shortId}` for every accepted public QR base (the
 *     database QR base, shop_settings.public_site_url, and the
 *     environment's public site URL: scanBases in src/lib/qr.ts);
 *   - `{adminOrigin}/q/{shortId}`, the Admin's own /q route;
 *   - a bare short ID in any case ("p-000123").
 *
 * Anything else is `foreign`: the scanner says "Not a BICII label" and
 * never opens, follows or links the text, whatever it is (a URL on another
 * host, javascript:, data:, a Wi-Fi code).
 */
import { parseScan, parseShortId } from "@/lib/ids";

export type ScanInterpretation =
  { kind: "record"; shortId: string } | { kind: "foreign"; text: string };

export type ScanContext = {
  /** Accepted public QR bases, e.g. ["https://bicii.sg"]. */
  publicBases: readonly string[];
  /** The Admin's own origin (window.location.origin), e.g. "https://admin.bicii.sg". */
  adminOrigin: string | null;
};

export function interpretScan(
  raw: string,
  { publicBases, adminOrigin }: ScanContext,
): ScanInterpretation {
  const text = raw.trim();
  const bare = parseShortId(text);
  if (bare) return { kind: "record", shortId: bare.shortId };
  if (text === "") return { kind: "foreign", text: raw };
  const bases = adminOrigin ? [...publicBases, adminOrigin] : publicBases;
  for (const base of bases) {
    if (!base) continue;
    const hit = parseScan(text, { base });
    if (hit) return { kind: "record", shortId: hit.shortId };
  }
  return { kind: "foreign", text: raw };
}

/** "https://example.com/a-very-long…" for showing a foreign code without trusting it. */
export function truncateScan(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * QR bases that labels were printed with before the address changed
 * (R-013). Only ever scanned, never printed or displayed: the scanner keeps
 * accepting labels that are still on shelves. The Admin's old alias carried
 * the 29 product labels printed on 2026-10-28 before the address became the
 * public site's; that alias also redirects /q to the public site
 * (next.config.ts), for customers.
 */
export const RETIRED_QR_BASES: readonly string[] = ["https://bicii-book.vercel.app"];

/**
 * The accepted public scan bases (scanBases, src/lib/qr.ts): the database
 * QR base when usable, then the environment's public site URL, then any
 * retired bases, trailing slashes dropped, without duplicates.
 */
export function mergeScanBases(
  dbBase: string | null,
  envBase: string | null,
  retired: readonly string[] = [],
): string[] {
  const bases: string[] = [];
  for (const b of [dbBase, envBase, ...retired]) {
    const clean = b?.trim().replace(/\/+$/, "") ?? "";
    if (clean && !bases.includes(clean)) bases.push(clean);
  }
  return bases;
}
