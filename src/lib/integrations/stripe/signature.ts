import { createHmac, timingSafeEqual } from "node:crypto";

import { SIGNATURE_TOLERANCE_SECONDS } from "./config";

/**
 * Stripe webhook signatures (D153, D159a). `Stripe-Signature` is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, each v1 the HMAC-SHA256 of
 * `${t}.${raw body}` under the endpoint's signing secret (the whole
 * `whsec_…` string, used as is). The check runs on the exact bytes
 * received, before anything is decoded or parsed, and compares in constant
 * time. Several v1 values arrive while Stripe rolls the secret (24 hours);
 * any one matching is enough. v0 and other schemes are ignored, so there
 * is no downgrade.
 *
 * The signature is checked before the timestamp, so a forged stale header
 * stays `invalid`; a genuine one outside the tolerance (either way) is
 * `expired`. Never throws.
 */
export function verifyStripeSignature(
  raw: Uint8Array,
  header: string | null | undefined,
  secret: string,
  nowSeconds: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): "ok" | "invalid" | "expired" {
  try {
    if (!secret || !header || header.length > 2048) return "invalid";
    const timestamps: string[] = [];
    const signatures: Buffer[] = [];
    for (const part of header.split(",")) {
      const at = part.indexOf("=");
      if (at < 0) continue;
      const key = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (key === "t") timestamps.push(value);
      else if (key === "v1" && /^[0-9a-f]{64}$/.test(value) && signatures.length < 8) {
        signatures.push(Buffer.from(value, "hex"));
      }
    }
    if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0])) return "invalid";
    if (signatures.length === 0) return "invalid";
    const t = timestamps[0];
    const expected = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), Buffer.from(raw)]))
      .digest();
    let matched = false;
    for (const candidate of signatures) {
      // Every candidate is compared, so the time taken does not say which matched.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    }
    if (!matched) return "invalid";
    const tolerance = toleranceSeconds > 0 ? toleranceSeconds : SIGNATURE_TOLERANCE_SECONDS;
    if (Math.abs(nowSeconds - Number(t)) > tolerance) return "expired";
    return "ok";
  } catch {
    return "invalid";
  }
}
