import { describe, expect, it } from "vitest";

import { afterKeyset, decodeKeyset, encodeKeyset } from "@/lib/keyset";
import { plural } from "@/lib/plural";

const ID = "4f1c2b3a-0000-4000-8000-000000000001";

describe("keyset cursors (Adventures bookings and packs, labels)", () => {
  it("round-trips a cursor and refuses a malformed one", () => {
    const c = { createdAt: "2026-11-20T08:15:00.123456+00:00", id: ID };
    expect(decodeKeyset(encodeKeyset(c))).toEqual(c);
    expect(decodeKeyset("yesterday_" + ID)).toBeNull();
    expect(decodeKeyset(null)).toBeNull();
  });

  it("filters the rows after the cursor, newest first or oldest first", () => {
    const c = { createdAt: "2026-11-20T08:15:00Z", id: ID };
    expect(afterKeyset(c, false)).toBe(
      `created_at.lt."2026-11-20T08:15:00Z",and(created_at.eq."2026-11-20T08:15:00Z",id.lt.${ID})`,
    );
    expect(afterKeyset(c, true)).toBe(
      `created_at.gt."2026-11-20T08:15:00Z",and(created_at.eq."2026-11-20T08:15:00Z",id.gt.${ID})`,
    );
  });
});

describe("plural", () => {
  it("is singular for exactly one", () => {
    expect(plural(0, "no-show", "no-shows")).toBe("0 no-shows");
    expect(plural(1, "no-show", "no-shows")).toBe("1 no-show");
    expect(plural(2, "item", "items")).toBe("2 items");
  });
});
