import "server-only";

import { cache } from "react";

import { getPublicEnv } from "@/lib/env";
import { isValidQrBase, qrPayload } from "@/lib/ids";
import { mergeScanBases, RETIRED_QR_BASES } from "@/lib/scan";
import { createClient } from "@/lib/supabase/server";

/**
 * The QR base: the one place the Admin decides what a QR URL starts with
 * (PLAN D9, ADR-017; DATA-MODEL §11). The payload is exactly
 * `{shop_settings.public_site_url}/q/{short_id}`.
 *
 * Printing never uses this module: the database computes every printed
 * payload (private.qr_payload, into print_jobs.qr_payload). What the Admin
 * DISPLAYS (the "QR label URL" on a record) comes from the same column
 * through here, validated by the same rule (isValidQrBase,
 * tests/fixtures/qr-bases.ts), with no fallback: when the address is
 * missing or malformed the screens say "QR address not set", as the
 * database refuses to print.
 *
 * The environment's NEXT_PUBLIC_PUBLIC_SITE_URL is only an extra base the
 * scanner accepts (scanBases), so labels printed against it keep scanning.
 */

/** The database QR base without trailing slashes, or null when unusable. Per render. */
export const getQrBase = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shop_settings")
    .select("public_site_url")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`shop_settings read failed: ${error.code} ${error.message}`);
  const base = data?.public_site_url ?? null;
  return isValidQrBase(base) ? base.replace(/\/+$/, "") : null;
});

/** A record's QR URL, `{base}/q/{shortId}`, or null while the QR address is not set. */
export async function qrUrl(shortId: string): Promise<string | null> {
  const base = await getQrBase();
  return base === null ? null : qrPayload(base, shortId);
}

/**
 * The public bases the scanner accepts as BICII labels (interpretScan,
 * src/lib/scan.ts): the database QR base, the environment's
 * NEXT_PUBLIC_PUBLIC_SITE_URL and RETIRED_QR_BASES, so labels printed
 * before a change of address still scan.
 */
export async function scanBases(): Promise<string[]> {
  return mergeScanBases(await getQrBase(), environmentScanBase(), RETIRED_QR_BASES);
}

/**
 * The environment's NEXT_PUBLIC_PUBLIC_SITE_URL as a scan base (trailing
 * slashes dropped), or null. Only for scanning and for the Labels and
 * printers settings' note when it differs from the QR base: never a QR URL.
 */
export function environmentScanBase(): string | null {
  return mergeScanBases(null, getPublicEnv().NEXT_PUBLIC_PUBLIC_SITE_URL)[0] ?? null;
}
