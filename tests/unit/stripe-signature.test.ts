// @vitest-environment node
/**
 * Stripe-Signature on the raw body (D153, D159a; ADR-025): the exact
 * bytes, every v1 during a secret roll, the 5-minute tolerance either way,
 * and no downgrade to v0. The expected headers come from
 * tests/fixtures/stripe.ts, an independent implementation of Stripe's
 * scheme.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyStripeSignature } from "@/lib/integrations/stripe/signature";

import { signStripeBody, STRIPE_TEST_WEBHOOK_SECRET } from "../fixtures/stripe";

const NOW = 1_800_000_000;
const SECRET = STRIPE_TEST_WEBHOOK_SECRET;
const raw = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed" });
const bytes = (s: string) => new TextEncoder().encode(s);

function v1(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
}

describe("verifyStripeSignature", () => {
  it("accepts the exact bytes Stripe signed", () => {
    const header = signStripeBody(raw, { timestamp: NOW });
    expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("ok");
  });

  it("accepts multibyte UTF-8 bodies (the bytes, never a re-serialisation)", () => {
    const body = JSON.stringify({ id: "evt_2", name: "Zoë 自転車 🚲" });
    const header = signStripeBody(body, { timestamp: NOW });
    expect(verifyStripeSignature(bytes(body), header, SECRET, NOW)).toBe("ok");
    // The same object re-serialised with spaces is other bytes.
    const spaced = JSON.stringify(JSON.parse(body), null, 1);
    expect(verifyStripeSignature(bytes(spaced), header, SECRET, NOW)).toBe("invalid");
  });

  it("refuses one flipped byte, another secret and an empty secret", () => {
    const header = signStripeBody(raw, { timestamp: NOW });
    const flipped = bytes(raw);
    flipped[5] ^= 1;
    expect(verifyStripeSignature(flipped, header, SECRET, NOW)).toBe("invalid");
    expect(verifyStripeSignature(bytes(raw), header, "whsec_another", NOW)).toBe("invalid");
    expect(verifyStripeSignature(bytes(raw), header, "", NOW)).toBe("invalid");
  });

  it("refuses a missing, empty, garbled or oversized header", () => {
    for (const header of [
      null,
      undefined,
      "",
      "garbage",
      "t=,v1=",
      `t=${NOW}`,
      `v1=${v1(SECRET, NOW, raw)}`,
      `t=abc,v1=${v1(SECRET, NOW, raw)}`,
      `t=${NOW},v1=${v1(SECRET, NOW, raw)},${"x".repeat(2100)}`,
    ]) {
      expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("invalid");
    }
  });

  it("refuses two timestamps, a non-hex v1 and a v0 alone (no downgrade)", () => {
    const good = v1(SECRET, NOW, raw);
    expect(verifyStripeSignature(bytes(raw), `t=${NOW},t=${NOW},v1=${good}`, SECRET, NOW)).toBe(
      "invalid",
    );
    expect(
      verifyStripeSignature(bytes(raw), `t=${NOW},v1=${good.toUpperCase()}`, SECRET, NOW),
    ).toBe("invalid");
    expect(verifyStripeSignature(bytes(raw), `t=${NOW},v0=${good}`, SECRET, NOW)).toBe("invalid");
    // A v0 beside a good v1 is simply ignored.
    expect(verifyStripeSignature(bytes(raw), `t=${NOW},v0=00,v1=${good}`, SECRET, NOW)).toBe("ok");
  });

  it("accepts either v1 during a secret roll, with either secret", () => {
    const oldSecret = "whsec_oldOldOldOld";
    const header = `t=${NOW},v1=${v1(SECRET, NOW, raw)},v1=${v1(oldSecret, NOW, raw)}`;
    expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("ok");
    expect(verifyStripeSignature(bytes(raw), header, oldSecret, NOW)).toBe("ok");
    expect(verifyStripeSignature(bytes(raw), header, "whsec_third", NOW)).toBe("invalid");
  });

  it("is expired 301 s in the past or ahead, ok at 300 s", () => {
    for (const t of [NOW - 301, NOW + 301]) {
      const header = signStripeBody(raw, { timestamp: t });
      expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("expired");
    }
    for (const t of [NOW - 300, NOW + 300]) {
      const header = signStripeBody(raw, { timestamp: t });
      expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("ok");
    }
  });

  it("keeps a forged stale header invalid (the signature is checked first)", () => {
    const header = `t=${NOW - 10_000},v1=${"0".repeat(64)}`;
    expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).toBe("invalid");
  });

  it("never throws", () => {
    const pieces = ["t=", "v1=", ",", "=", "1", "a", "f".repeat(64), " ", "v0=", "\u0000", "é"];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 500; i += 1) {
      let header = "";
      const n = Math.floor(rand() * 12);
      for (let j = 0; j < n; j += 1) header += pieces[Math.floor(rand() * pieces.length)];
      expect(() => verifyStripeSignature(bytes(raw), header, SECRET, NOW)).not.toThrow();
      expect(verifyStripeSignature(bytes(raw), header, SECRET, NOW)).not.toBe("ok");
    }
  });
});
