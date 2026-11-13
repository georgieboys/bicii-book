/**
 * Adventures Phase A in TypeScript (D164-D166): the editor's helpers and
 * the Server Action input schemas. The database decides again
 * (tests/db/adventure-catalogue.test.ts); these prove the forms send what
 * the RPCs expect and refuse what they would refuse.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  adventureCheckpointsSchema,
  adventureDraftSchema,
  adventureOfferSchema,
  adventureSalesSchema,
  clearAttentionSchema,
  createAdventureSchema,
  decideReviewSchema,
  packStatusSchema,
  registerDeviceSchema,
  returnTrackerSchema,
  revokeCertificateSchema,
  trackerHireSchema,
} from "@/lib/adventure-forms";
import {
  canManageAdventures,
  canVerifyAdventures,
  formatDistance,
  formatElapsed,
  formatMetres,
  minutesBetween,
  isCertifiableDistance,
  suggestedPrice,
} from "@/lib/adventures";

const REVISION = "6a6a6a6a-0000-4000-8000-000000000001";

describe("suggestedPrice (D165, handoff P03, P04)", () => {
  it("self-supported, solo or group: 49 + 10 per extra day", () => {
    for (const [days, price] of [
      [1, "49.00"],
      [2, "59.00"],
      [4, "79.00"],
      [8, "119.00"],
    ] as const) {
      expect(suggestedPrice("self_supported", days, null)).toBe(price);
      expect(suggestedPrice("self_supported_group", days, null)).toBe(price);
    }
  });

  it("supported: 49 + 100 per day, ignoring the nominal days", () => {
    for (const [days, price] of [
      [1, "149.00"],
      [2, "249.00"],
      [4, "449.00"],
      [8, "849.00"],
    ] as const) {
      expect(suggestedPrice("supported", 99, days)).toBe(price);
    }
  });

  it("gives nothing without the days it needs", () => {
    expect(suggestedPrice("self_supported", null, 3)).toBeNull();
    expect(suggestedPrice("supported", 3, null)).toBeNull();
  });
});

describe("helpers", () => {
  it("certification starts at 125 km (D164)", () => {
    expect(isCertifiableDistance(124.9)).toBe(false);
    expect(isCertifiableDistance("125")).toBe(true);
    expect(isCertifiableDistance(3000)).toBe(true);
  });

  it("formats distances and times", () => {
    expect(formatDistance("125")).toBe("125 km");
    expect(formatDistance(1000)).toBe("1,000 km");
    expect(formatDistance("12.5")).toBe("12.5 km");
    expect(formatElapsed(1440)).toBe("24 h");
    expect(formatElapsed(2190)).toBe("36 h 30 min");
    expect(formatElapsed(45)).toBe("45 min");
    expect(formatElapsed(null)).toBeNull();
  });

  it("only manage_adventures may edit", () => {
    expect(canManageAdventures({ permissions: ["manage_adventures"] })).toBe(true);
    expect(canManageAdventures({ permissions: ["verify_adventures", "view_costs"] })).toBe(false);
  });
});

describe("createAdventureSchema", () => {
  it("lowercases the web address and parses the distance", () => {
    expect(
      createAdventureSchema.parse({ slug: " BICII-250 ", name: "BICII 250", distanceKm: "250" }),
    ).toEqual({ slug: "bicii-250", name: "BICII 250", distanceKm: 250 });
  });

  it("refuses a bad web address or distance", () => {
    expect(
      createAdventureSchema.safeParse({ slug: "has space", name: "X", distanceKm: "1" }).success,
    ).toBe(false);
    expect(
      createAdventureSchema.safeParse({ slug: "ok-1", name: "X", distanceKm: "12.55" }).success,
    ).toBe(false);
    expect(
      createAdventureSchema.safeParse({ slug: "ok-1", name: "X", distanceKm: "0" }).success,
    ).toBe(false);
  });
});

const draft = (overrides: Record<string, unknown> = {}) => ({
  revisionId: REVISION,
  expectedVersion: "3",
  name: "BICII 125",
  summary: "",
  description: "",
  note: "",
  region: "",
  terrain: "Road",
  whenToStart: "",
  startFinish: "",
  distanceKm: "125",
  nominalDays: "1",
  timeZone: "Asia/Singapore",
  minElapsedMinutes: "",
  maxElapsedMinutes: "24",
  checkpointOrder: "any",
  routeUrl: "",
  rules: "",
  equipment: "",
  riderInstructions: "",
  emergencyProcedure: "",
  staffNotes: "",
  ...overrides,
});

describe("adventureDraftSchema", () => {
  it("sends hours as minutes, blanks as null, and the switch as a boolean", () => {
    const parsed = adventureDraftSchema.parse(draft({ isPlanned: "on" }));
    expect(parsed).toMatchObject({
      expectedVersion: 3,
      distanceKm: 125,
      nominalDays: 1,
      minElapsedMinutes: null,
      maxElapsedMinutes: 1440,
      routeUrl: null,
      isPlanned: true,
    });
    expect(adventureDraftSchema.parse(draft()).isPlanned).toBe(false);
  });

  it("refuses a route link that is not https, and a minimum above the maximum", () => {
    const http = adventureDraftSchema.safeParse(draft({ routeUrl: "http://strava.com/routes/1" }));
    expect(http.success).toBe(false);
    const window = adventureDraftSchema.safeParse(draft({ minElapsedMinutes: "30" }));
    expect(window.success).toBe(false);
    if (!window.success) expect(window.error.issues[0].path).toEqual(["minElapsedMinutes"]);
  });
});

describe("adventureCheckpointsSchema", () => {
  it("parses the editor's JSON list", () => {
    const parsed = adventureCheckpointsSchema.parse({
      revisionId: REVISION,
      checkpoints: JSON.stringify([
        {
          label: " Lim Chu Kang ",
          latitude: "1.43",
          longitude: "103.71",
          mandatory: true,
          photoRequired: false,
        },
        {
          label: "Seletar",
          latitude: null,
          longitude: null,
          mandatory: false,
          photoRequired: true,
        },
      ]),
    });
    expect(parsed.checkpoints).toEqual([
      {
        label: "Lim Chu Kang",
        instructions: "",
        latitude: 1.43,
        longitude: 103.71,
        mandatory: true,
        photoRequired: false,
      },
      {
        label: "Seletar",
        instructions: "",
        latitude: null,
        longitude: null,
        mandatory: false,
        photoRequired: true,
      },
    ]);
  });

  it("refuses a checkpoint without a name, half a coordinate, or broken JSON", () => {
    const one = (c: object) =>
      adventureCheckpointsSchema.safeParse({
        revisionId: REVISION,
        checkpoints: JSON.stringify([c]),
      }).success;
    expect(one({ label: " " })).toBe(false);
    expect(one({ label: "A", latitude: "1.4" })).toBe(false);
    expect(one({ label: "A", latitude: "91", longitude: "103" })).toBe(false);
    expect(
      adventureCheckpointsSchema.safeParse({ revisionId: REVISION, checkpoints: "[" }).success,
    ).toBe(false);
  });
});

describe("adventureOfferSchema", () => {
  it("keeps tracker hire for self-supported and drops supported days", () => {
    expect(
      adventureOfferSchema.parse({
        revisionId: REVISION,
        kind: "self_supported",
        price: "49",
        trackerHirePrice: "20",
        supportedDays: "3",
        inclusions: "",
      }),
    ).toMatchObject({ price: "49.00", trackerHirePrice: "20.00", supportedDays: null });
  });

  it("never sends tracker hire with a supported offer, and needs its days", () => {
    expect(
      adventureOfferSchema.parse({
        revisionId: REVISION,
        kind: "supported",
        price: "149",
        trackerHirePrice: "20",
        supportedDays: "1",
        inclusions: "",
      }),
    ).toMatchObject({ price: "149.00", trackerHirePrice: null, supportedDays: 1 });
    expect(
      adventureOfferSchema.safeParse({
        revisionId: REVISION,
        kind: "supported",
        price: "149",
        supportedDays: "",
      }).success,
    ).toBe(false);
  });

  it("refuses a zero price or an unknown kind", () => {
    expect(
      adventureOfferSchema.safeParse({ revisionId: REVISION, kind: "self_supported", price: "0" })
        .success,
    ).toBe(false);
    expect(
      adventureOfferSchema.safeParse({ revisionId: REVISION, kind: "race", price: "49" }).success,
    ).toBe(false);
  });
});

// ------------------------------------------- review, packs, sales (D178-D182) ----

const SUBMISSION = "6a6a6a6a-0000-4000-8000-000000000002";
const ALL_TICKED = {
  identity: "on",
  coverage: "on",
  checkpoints: "on",
  chronology: "on",
  time_window: "on",
  distance: "on",
};

describe("decideReviewSchema (D178)", () => {
  it("an approval sends the checklist as booleans with the distance and day", () => {
    const parsed = decideReviewSchema.parse({
      submissionId: SUBMISSION,
      decision: "approved",
      ...ALL_TICKED,
      chronology: undefined,
      acceptedDistanceKm: "1,128.45",
      completedOn: "2026-11-15",
    });
    expect(parsed).toMatchObject({
      identity: true,
      chronology: false,
      acceptedDistanceKm: "1128.45",
      completedOn: "2026-11-15",
      messageToRider: "",
    });
  });

  it("an approval needs the distance and the day; anything else needs a message", () => {
    const approval = decideReviewSchema.safeParse({
      submissionId: SUBMISSION,
      decision: "approved",
      ...ALL_TICKED,
    });
    expect(approval.success).toBe(false);
    expect(Object.keys(z.flattenError(approval.error!).fieldErrors).sort()).toEqual([
      "acceptedDistanceKm",
      "completedOn",
    ]);
    const changes = decideReviewSchema.safeParse({
      submissionId: SUBMISSION,
      decision: "changes_requested",
      messageToRider: "  ",
    });
    expect(z.flattenError(changes.error!).fieldErrors.messageToRider).toBeDefined();
    expect(
      decideReviewSchema.safeParse({
        submissionId: SUBMISSION,
        decision: "rejected",
        messageToRider: "The track stops at 80 km.",
      }).success,
    ).toBe(true);
  });

  it("refuses a bad distance, day or decision", () => {
    for (const bad of [
      { acceptedDistanceKm: "12.3456" },
      { acceptedDistanceKm: "-5" },
      { completedOn: "15/11/2026" },
      { decision: "maybe" },
    ]) {
      expect(
        decideReviewSchema.safeParse({
          submissionId: SUBMISSION,
          decision: "approved",
          ...ALL_TICKED,
          acceptedDistanceKm: "128",
          completedOn: "2026-11-15",
          ...bad,
        }).success,
      ).toBe(false);
    }
  });
});

describe("the other review and sales forms", () => {
  it("pack status, revoking, clearing a flag and the sales switch", () => {
    expect(
      packStatusSchema.parse({ fulfilmentId: SUBMISSION, status: "ready", note: null }),
    ).toEqual({ fulfilmentId: SUBMISSION, status: "ready", note: "" });
    expect(packStatusSchema.safeParse({ fulfilmentId: SUBMISSION, status: "lost" }).success).toBe(
      false,
    );
    expect(
      revokeCertificateSchema.safeParse({ certificateId: SUBMISSION, reason: " " }).success,
    ).toBe(false);
    expect(
      clearAttentionSchema.safeParse({ bookingId: SUBMISSION, note: "Refunded" }).success,
    ).toBe(true);
    expect(adventureSalesSchema.safeParse({ salesEnabled: "on", termsVersion: "" }).success).toBe(
      false,
    );
    expect(adventureSalesSchema.parse({ termsVersion: "" })).toEqual({
      salesEnabled: false,
      termsVersion: "",
    });
  });
});

describe("review helpers", () => {
  it("minutesBetween, formatMetres and canVerifyAdventures", () => {
    expect(minutesBetween("2026-11-14T07:00:00Z", "2026-11-15T01:30:00Z")).toBe(1110);
    expect(minutesBetween(null, "2026-11-15T01:30:00Z")).toBeNull();
    expect(formatMetres(87)).toBe("87 m");
    expect(formatMetres("1234")).toBe("1.2 km");
    expect(formatMetres(null)).toBeNull();
    expect(canVerifyAdventures({ permissions: ["verify_adventures"] })).toBe(true);
    expect(canVerifyAdventures({ permissions: ["manage_adventures"] })).toBe(false);
  });
});

describe("tracker hire forms (D186-D188)", () => {
  it("registering, returning and the hire switch", () => {
    expect(
      registerDeviceSchema.parse({
        label: " T-01 ",
        provider: "spot",
        providerDeviceId: " 0-123 ",
        model: "",
      }),
    ).toEqual({ label: "T-01", provider: "spot", providerDeviceId: "0-123", model: "" });
    expect(
      registerDeviceSchema.safeParse({ label: "T/01", provider: "spot", providerDeviceId: "1" })
        .success,
    ).toBe(false);
    expect(
      registerDeviceSchema.safeParse({ label: "T-01", provider: "tack", providerDeviceId: "1" })
        .success,
    ).toBe(false);
    expect(
      returnTrackerSchema.safeParse({ assignmentId: SUBMISSION, condition: "broken", note: "" })
        .success,
    ).toBe(false);
    expect(trackerHireSchema.parse({ enabled: "on", maxDays: "7" })).toEqual({
      enabled: true,
      maxDays: 7,
    });
    expect(trackerHireSchema.safeParse({ maxDays: "31" }).success).toBe(false);
  });
});

describe("tracking feed form (D190)", () => {
  it("only TRACKING_FEED_ variable names, upper-cased", async () => {
    const { trackingFeedSchema } = await import("@/lib/adventure-forms");
    expect(
      trackingFeedSchema.parse({
        provider: "spot",
        label: "Shop feed",
        configName: " tracking_feed_shop ",
        enabled: "on",
      }),
    ).toEqual({
      feedId: null,
      provider: "spot",
      label: "Shop feed",
      configName: "TRACKING_FEED_SHOP",
      enabled: true,
    });
    for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "TRACKING_FEED_", "STRIPE_SECRET_KEY"]) {
      expect(
        trackingFeedSchema.safeParse({ provider: "spot", label: "x", configName: name }).success,
      ).toBe(false);
    }
  });
});
