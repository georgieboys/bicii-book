import { describe, expect, it } from "vitest";

import { isValidQrBase, qrPayload } from "@/lib/ids";
import { interpretScan, mergeScanBases, RETIRED_QR_BASES } from "@/lib/scan";

import { QR_BASE_CASES } from "../fixtures/qr-bases";

// PLAN D9, ADR-017: the Admin shows a QR URL exactly when the database
// would print one. tests/db/labels.test.ts runs the same cases through the
// column check and private.qr_payload.
describe("isValidQrBase (parity with private.qr_payload)", () => {
  for (const c of QR_BASE_CASES) {
    it(`${c.valid ? "accepts" : "refuses"} ${JSON.stringify(c.base.slice(0, 60))}`, () => {
      expect(isValidQrBase(c.base)).toBe(c.valid);
      if (c.valid) {
        expect(qrPayload(c.base, "P-000123")).toBe(`${c.payloadBase}/q/P-000123`);
      }
    });
  }

  it("refuses non-strings and empty values", () => {
    expect(isValidQrBase(null)).toBe(false);
    expect(isValidQrBase(undefined)).toBe(false);
    expect(isValidQrBase("")).toBe(false);
    expect(isValidQrBase(42)).toBe(false);
  });

  it("counts characters, not UTF-16 units, against the 200 limit", () => {
    const base = `https://bicii.sg/${"é".repeat(183)}`;
    expect([...base].length).toBe(200);
    expect(isValidQrBase(base)).toBe(true);
    expect(isValidQrBase(`${base}é`)).toBe(false);
  });
});

describe("mergeScanBases", () => {
  it("puts the database base first and keeps the environment's", () => {
    expect(mergeScanBases("http://localhost:4000", "http://localhost:4001")).toEqual([
      "http://localhost:4000",
      "http://localhost:4001",
    ]);
  });

  it("drops duplicates after trailing slashes", () => {
    expect(mergeScanBases("https://bicii.sg/", "https://bicii.sg")).toEqual(["https://bicii.sg"]);
  });

  it("keeps the environment's base alone when the database base is unusable", () => {
    expect(mergeScanBases(null, "https://bicii.sg")).toEqual(["https://bicii.sg"]);
    expect(mergeScanBases(null, null)).toEqual([]);
  });

  it("adds the retired bases last, without duplicates", () => {
    expect(
      mergeScanBases("https://bicii.sg", null, ["https://old.example/", "https://bicii.sg"]),
    ).toEqual(["https://bicii.sg", "https://old.example"]);
  });
});

describe("RETIRED_QR_BASES (R-013)", () => {
  it("lets the scanner read a label printed with the Admin's old alias", () => {
    const publicBases = mergeScanBases("https://bicii.sg", null, RETIRED_QR_BASES);
    expect(
      interpretScan("https://bicii-book.vercel.app/q/P-000123", {
        publicBases,
        adminOrigin: "https://admin.example.com",
      }),
    ).toEqual({ kind: "record", shortId: "P-000123" });
  });

  it("are valid QR bases, so they parse like the current one", () => {
    for (const base of RETIRED_QR_BASES) expect(isValidQrBase(base), base).toBe(true);
  });
});
