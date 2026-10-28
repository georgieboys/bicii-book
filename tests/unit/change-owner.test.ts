import { describe, expect, it } from "vitest";

import { stockToMove } from "@/lib/consignment";

describe("Change owner: the stock it moves (D162)", () => {
  const at = (name: string, onHand: number) => ({ locationId: name, name, onHand });

  it("is every location whose count is not zero", () => {
    expect(stockToMove([at("Shop floor", 9), at("Workshop", 0)])).toEqual([at("Shop floor", 9)]);
    expect(stockToMove([at("Shop floor", 0)])).toEqual([]);
  });

  it("counts a location below zero, so the sheet asks to move it to one place first", () => {
    expect(stockToMove([at("Shop floor", 4), at("Workshop", -1)])).toHaveLength(2);
  });
});
