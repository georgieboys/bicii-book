import { describe, expect, it } from "vitest";

import {
  PUBLICATION_STATUSES,
  PUBLICATION_TRANSITIONS,
  UNIT_STATUSES,
  UNIT_STATUS_TRANSITIONS,
  canChangePublication,
  canChangeUnitStatus,
  manualPublicationTargets,
  missingRequirements,
  publicAvailabilityLabel,
  publicationActions,
  publicationChecklist,
  MOVEMENT_FILTERS,
  adjustmentPreview,
  defaultLocation,
  isMovementFilter,
  movementLabel,
  overdrawWarning,
  publicationLabel,
  publicationTone,
  signedQuantity,
  stockLabel,
  stockTone,
  unitStatusLabel,
  unitStatusTone,
} from "@/lib/inventory";

describe("publication machine (D26)", () => {
  it("covers every status and never lists a same-status move", () => {
    expect(Object.keys(PUBLICATION_TRANSITIONS).sort()).toEqual([...PUBLICATION_STATUSES].sort());
    for (const s of PUBLICATION_STATUSES) expect(canChangePublication(s, s)).toBe(false);
  });

  it("allows exactly the documented moves", () => {
    const allowed = PUBLICATION_STATUSES.flatMap((from) =>
      PUBLICATION_STATUSES.filter((to) => canChangePublication(from, to)).map(
        (to) => `${from}->${to}`,
      ),
    ).sort();
    expect(allowed).toEqual(
      [
        "draft->internal_only",
        "draft->archived",
        "internal_only->public",
        "internal_only->archived",
        "public->internal_only",
        "public->sold",
        "public->archived",
        "sold->public",
        "sold->archived",
        "archived->internal_only",
      ].sort(),
    );
  });

  it("never offers sold by hand; from sold only archived; no public without an available unit", () => {
    expect(
      manualPublicationTargets("public", { trackingType: "unique", availableUnits: 1 }),
    ).toEqual(["internal_only", "archived"]);
    expect(manualPublicationTargets("sold", { trackingType: "unique", availableUnits: 3 })).toEqual(
      ["archived"],
    );
    expect(
      manualPublicationTargets("internal_only", { trackingType: "unique", availableUnits: 0 }),
    ).toEqual(["archived"]);
    expect(
      manualPublicationTargets("internal_only", { trackingType: "unique", availableUnits: 1 }),
    ).toEqual(["public", "archived"]);
    expect(
      manualPublicationTargets("internal_only", { trackingType: "quantity", availableUnits: 0 }),
    ).toEqual(["public", "archived"]);
    expect(
      manualPublicationTargets("draft", { trackingType: "quantity", availableUnits: 0 }),
    ).toEqual(["internal_only", "archived"]);
    expect(
      manualPublicationTargets("archived", { trackingType: "quantity", availableUnits: 0 }),
    ).toEqual(["internal_only"]);
  });
});

describe("unit status machine", () => {
  it("covers every status and never lists a same-status move", () => {
    expect(Object.keys(UNIT_STATUS_TRANSITIONS).sort()).toEqual([...UNIT_STATUSES].sort());
    for (const s of UNIT_STATUSES) expect(canChangeUnitStatus(s, s)).toBe(false);
  });

  it("returns a sold unit to held_for_customer only (the reopen rule, D25) or available", () => {
    expect(canChangeUnitStatus("sold", "held_for_customer")).toBe(true);
    expect(canChangeUnitStatus("sold", "available")).toBe(true);
    expect(canChangeUnitStatus("sold", "reserved")).toBe(false);
    expect(canChangeUnitStatus("held_for_customer", "sold")).toBe(true);
    expect(canChangeUnitStatus("held_for_customer", "written_off")).toBe(false);
    expect(UNIT_STATUS_TRANSITIONS.returned_to_consignor).toEqual([]);
    expect(canChangeUnitStatus("written_off", "available")).toBe(true);
  });
});

describe("stock display (Phase 4 screens)", () => {
  it("colours stock: none or below zero anywhere is danger, at the reorder point waiting (D23)", () => {
    expect(stockTone(0, 3)).toBe("danger");
    expect(stockTone(-2, null)).toBe("danger");
    expect(stockTone(40, 20, 1)).toBe("danger");
    expect(stockTone(3, 3)).toBe("waiting");
    expect(stockTone(2, 3)).toBe("waiting");
    expect(stockTone(4, 3)).toBe("done");
    expect(stockTone(1, null)).toBe("done");
  });

  it("labels counts with a real minus sign", () => {
    expect(stockLabel(34)).toBe("34 in stock");
    expect(stockLabel(1200)).toBe("1,200 in stock");
    expect(stockLabel(0)).toBe("Out of stock");
    expect(stockLabel(-2)).toBe("\u22122 (recount needed)");
    expect(signedQuantity(3)).toBe("+3");
    expect(signedQuantity(-2)).toBe("\u22122");
    expect(signedQuantity(0)).toBe("0");
  });

  it("names and colours unit statuses like staff_search does", () => {
    expect(unitStatusLabel("available")).toBe("Available");
    expect(unitStatusTone("available")).toBe("done");
    expect(unitStatusLabel("held_for_customer")).toBe("On a job");
    expect(unitStatusTone("held_for_customer")).toBe("waiting");
    expect(unitStatusTone("reserved")).toBe("info");
    expect(unitStatusTone("sold")).toBe("progress");
    expect(unitStatusTone("written_off")).toBe("danger");
    expect(unitStatusTone("returned_to_consignor")).toBe("info");
    for (const s of UNIT_STATUSES) expect(unitStatusLabel(s)).toBeTruthy();
  });

  it("names and colours every publication status", () => {
    expect(publicationLabel("internal_only")).toBe("Internal only");
    expect(publicationTone("public")).toBe("done");
    expect(publicationTone("sold")).toBe("progress");
    for (const s of PUBLICATION_STATUSES) expect(publicationLabel(s)).toBeTruthy();
  });

  it("names movements, splitting transfers and returns from a job", () => {
    expect(movementLabel("job_consumption", -2)).toBe("Used on job");
    expect(movementLabel("reversal", 2, { onJob: true })).toBe("Returned from job");
    expect(movementLabel("reversal", 2)).toBe("Reversal");
    expect(movementLabel("stock_adjustment", 10)).toBe("Adjustment");
    expect(movementLabel("damaged", -1)).toBe("Damaged");
    expect(movementLabel("transfer", 3)).toBe("Transfer in");
    expect(movementLabel("transfer", -3)).toBe("Transfer out");
    expect(movementLabel("purchase_received", 5)).toBe("Received");
    // D149a: an indent part bought outside BICII, fitted at once.
    expect(movementLabel("outside_purchase", 2)).toBe("Bought outside BICII");
  });

  it("filters movements by kind", () => {
    expect(MOVEMENT_FILTERS.jobs.types).toEqual([
      "job_consumption",
      "reversal",
      "outside_purchase",
    ]);
    expect(MOVEMENT_FILTERS.all.types).toBeNull();
    expect(isMovementFilter("transfers")).toBe(true);
    expect(isMovementFilter("toString")).toBe(false);
  });

  it("picks the default location like add_inventory_line: active, sort order, then name", () => {
    const locations = [
      { id: "c", name: "Basement", active: false, sortOrder: 1 },
      { id: "b", name: "Workshop store", active: true, sortOrder: 20 },
      { id: "a2", name: "Shop floor", active: true, sortOrder: 10 },
      { id: "a1", name: "Annex", active: true, sortOrder: 10 },
    ];
    expect(defaultLocation(locations)?.id).toBe("a1");
    expect(defaultLocation(locations.filter((l) => l.id !== "a1"))?.id).toBe("a2");
    expect(defaultLocation([locations[0]])).toBeNull();
    // The caller's list is left as it was.
    expect(locations[0].id).toBe("c");
  });

  it("previews an adjustment and flags a result below zero (insufficient_stock)", () => {
    expect(adjustmentPreview(34, -3)).toEqual({ after: 31, wouldGoNegative: false });
    expect(adjustmentPreview(2, -3)).toEqual({ after: -1, wouldGoNegative: true });
    expect(adjustmentPreview(0, 10)).toEqual({ after: 10, wouldGoNegative: false });
  });

  it("warns, never blocks, when a part takes a location below zero (D23)", () => {
    expect(overdrawWarning(2, 1, "Shop floor")).toBe(
      "Only 1 at Shop floor. Adding 2 takes the count below zero; ask whoever does stock counts to recount.",
    );
    expect(overdrawWarning(1, 0, "Shop floor")).toMatch(/^None counted at Shop floor\./);
    expect(overdrawWarning(1, 1, "Shop floor")).toBeNull();
  });
});

describe("publicationActions (the publication card's buttons, D26)", () => {
  type Options = Parameters<typeof publicationActions>[1];
  const counted: Options = { trackingType: "quantity", availableUnits: 0 };
  const labels = (from: Parameters<typeof publicationActions>[0], o: Options = counted) =>
    publicationActions(from, o).map((a) => `${a.label}:${a.to}`);

  it("names every manual move", () => {
    expect(labels("draft")).toEqual(["Make internal:internal_only", "Archive listing:archived"]);
    expect(labels("internal_only")).toEqual(["Publish:public", "Archive listing:archived"]);
    expect(labels("public")).toEqual(["Unpublish:internal_only", "Archive listing:archived"]);
    expect(labels("archived")).toEqual(["Restore:internal_only"]);
  });

  it("offers a sold product only Archive listing, and never Sold", () => {
    expect(labels("sold")).toEqual(["Archive listing:archived"]);
    for (const from of PUBLICATION_STATUSES) {
      expect(publicationActions(from, counted).some((a) => a.to === "sold")).toBe(false);
    }
  });

  it("has no Publish for a unique product without an available unit", () => {
    expect(labels("internal_only", { trackingType: "unique", availableUnits: 0 })).toEqual([
      "Archive listing:archived",
    ]);
    expect(labels("internal_only", { trackingType: "unique", availableUnits: 1 })).toContain(
      "Publish:public",
    );
  });
});

describe("publicationChecklist and missingRequirements", () => {
  it("lists name, price and a public photo, plus an available unit for unique products", () => {
    expect(
      publicationChecklist({ name: true, price: true, publicPhoto: false }).map((r) => r.label),
    ).toEqual(["A name", "A sale price", "A public photo"]);
    expect(
      publicationChecklist({ name: true, price: true, publicPhoto: true, availableUnit: false }),
    ).toEqual([
      { key: "name", label: "A name", met: true },
      { key: "price", label: "A sale price", met: true },
      { key: "publicPhoto", label: "A public photo", met: true },
      { key: "availableUnit", label: "An available unit", met: false },
    ]);
  });

  it("names what is missing, or nothing when all is met", () => {
    expect(missingRequirements({ name: true, price: true, publicPhoto: false })).toBe(
      "Still needed: A public photo.",
    );
    expect(
      missingRequirements({ name: true, price: false, publicPhoto: false, availableUnit: false }),
    ).toBe("Still needed: A sale price, A public photo, An available unit.");
    expect(missingRequirements({ name: true, price: true, publicPhoto: true })).toBeNull();
  });
});

describe("publicAvailabilityLabel", () => {
  it("names reporting.public_items availability", () => {
    expect(publicAvailabilityLabel("available")).toBe("Available");
    expect(publicAvailabilityLabel("sold_out")).toBe("Sold out");
    expect(publicAvailabilityLabel("sold")).toBe("Sold");
    expect(publicAvailabilityLabel("unavailable")).toBe("Unavailable");
    expect(publicAvailabilityLabel(null)).toBe("Unavailable");
  });
});
