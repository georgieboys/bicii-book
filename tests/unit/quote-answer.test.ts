/**
 * The quote form's refusal names the items still unanswered
 * (src/lib/quote-answer.ts; U2-1).
 */
import { describe, expect, it } from "vitest";

import { missingItemsText } from "@/lib/quote-answer";

describe("missingItemsText", () => {
  it("names one, two or three items and counts the rest", () => {
    expect(missingItemsText([])).toBe("");
    expect(missingItemsText(["Brake pads"])).toBe("Brake pads");
    expect(missingItemsText(["Brake pads", "Chain"])).toBe("Brake pads and Chain");
    expect(missingItemsText(["Brake pads", "Chain", "Tyres"])).toBe("Brake pads, Chain and Tyres");
    expect(missingItemsText(["Brake pads", "Chain", "Tyres", "Cables", "Bar tape"])).toBe(
      "Brake pads, Chain and 3 more",
    );
  });
});
