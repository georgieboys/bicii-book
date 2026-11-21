import { describe, expect, it } from "vitest";

import {
  DRAFT_MAX_AGE_MS,
  INTAKE_DRAFT_KEY,
  clearDraft,
  draftHasContent,
  parseDraft,
  pruneDraft,
  prunedMessage,
  readDraft,
  saveDraft,
  serializeDraft,
  type IntakeDraft,
} from "@/lib/intake-draft";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const STAFF = ID(11);
const OTHER_STAFF = ID(12);

const draft: IntakeDraft = {
  v: 2,
  staffId: STAFF,
  startedAt: "2026-10-04T02:42:00.000Z",
  workOrderId: ID(1),
  step: 3,
  customer: { id: ID(2), label: "Tan Wei Ming" },
  bike: { id: ID(3), shortId: "B-000001", title: "Specialized Tarmac" },
  requestedWork: "Full service",
  intakeNotes: "Scratch on top tube",
  leadId: ID(4),
  additionalIds: [ID(5)],
  services: [{ lineId: ID(6), serviceId: ID(7), quantity: "2" }],
};

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("full");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("intake draft (de)serialiser", () => {
  it("round-trips a draft", () => {
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("holds ids, labels and typed text only", () => {
    expect(Object.keys(JSON.parse(serializeDraft(draft))).sort()).toEqual(
      [
        "additionalIds",
        "bike",
        "customer",
        "intakeNotes",
        "leadId",
        "requestedWork",
        "services",
        "staffId",
        "startedAt",
        "step",
        "v",
        "workOrderId",
      ].sort(),
    );
  });

  it("refuses anything malformed, from another version, or without a job id", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("")).toBeNull();
    expect(parseDraft("{not json")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, v: 1 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, staffId: undefined }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, staffId: "nope" }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, workOrderId: "nope" }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, startedAt: "yesterday" }))).toBeNull();
  });

  it("drops the parts that do not make sense and keeps the rest", () => {
    const parsed = parseDraft(
      JSON.stringify({
        ...draft,
        step: 42,
        customer: { id: "x", label: "Someone" },
        bike: { id: ID(3) },
        leadId: 7,
        additionalIds: [ID(5), "bad"],
        services: [
          { lineId: ID(6), serviceId: ID(7), quantity: "2" },
          { lineId: ID(8), serviceId: ID(9), quantity: "-1" },
          { lineId: "x", serviceId: ID(9), quantity: "1" },
        ],
        requestedWork: 12,
      }),
    );
    expect(parsed).toEqual({
      ...draft,
      step: 0,
      customer: null,
      bike: null,
      leadId: null,
      additionalIds: [ID(5)],
      services: [{ lineId: ID(6), serviceId: ID(7), quantity: "2" }],
      requestedWork: "",
    });
  });

  it("knows an empty draft from one worth offering back", () => {
    const empty: IntakeDraft = {
      ...draft,
      customer: null,
      bike: null,
      requestedWork: " ",
      intakeNotes: "",
      services: [],
    };
    expect(draftHasContent(empty)).toBe(false);
    expect(draftHasContent({ ...empty, requestedWork: "Brakes" })).toBe(true);
    expect(draftHasContent(draft)).toBe(true);
  });
});

describe("intake draft storage", () => {
  /** An hour after the draft started. */
  const NOW = Date.parse(draft.startedAt) + 60 * 60 * 1000;

  it("saves one draft per device, reads it back, and clears it", () => {
    const storage = memory();
    saveDraft(draft, storage);
    expect([...storage.data.keys()]).toEqual([INTAKE_DRAFT_KEY]);
    expect(INTAKE_DRAFT_KEY).toBe("bicii.intake-draft.v2");
    expect(readDraft(STAFF, storage, NOW)).toEqual(draft);
    clearDraft(storage);
    expect(readDraft(STAFF, storage, NOW)).toBeNull();
  });

  it("never offers another staff member's draft, and removes it", () => {
    const storage = memory();
    saveDraft(draft, storage);
    expect(readDraft(OTHER_STAFF, storage, NOW)).toBeNull();
    expect(storage.data.size).toBe(0);
    // Not to its author afterwards either: it is gone from the device.
    expect(readDraft(STAFF, storage, NOW)).toBeNull();
  });

  it("offers a draft for 24 hours after it started, and removes it after", () => {
    const storage = memory();
    saveDraft(draft, storage);
    const started = Date.parse(draft.startedAt);
    expect(readDraft(STAFF, storage, started + DRAFT_MAX_AGE_MS)).toEqual(draft);
    expect(readDraft(STAFF, storage, started + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("removes an unreadable draft and any version-1 draft", () => {
    const storage = memory();
    storage.setItem("bicii.intake-draft.v1", JSON.stringify({ ...draft, v: 1 }));
    storage.setItem(INTAKE_DRAFT_KEY, "{not json");
    expect(readDraft(STAFF, storage, NOW)).toBeNull();
    expect(storage.data.size).toBe(0);
    storage.setItem("bicii.intake-draft.v1", JSON.stringify({ ...draft, v: 1 }));
    clearDraft(storage);
    expect(storage.data.size).toBe(0);
  });

  it("removes the stored draft instead of saving an empty one", () => {
    const storage = memory();
    saveDraft(draft, storage);
    saveDraft(
      { ...draft, customer: null, bike: null, requestedWork: "", intakeNotes: "", services: [] },
      storage,
    );
    expect(storage.data.size).toBe(0);
  });

  it("never throws when storage is missing or blocked", () => {
    expect(readDraft(STAFF, null)).toBeNull();
    expect(readDraft(STAFF, throwing)).toBeNull();
    expect(() => saveDraft(draft, throwing)).not.toThrow();
    expect(() => clearDraft(throwing)).not.toThrow();
    expect(() => saveDraft(draft, null)).not.toThrow();
  });
});

describe("a restored draft is checked against what can be chosen now", () => {
  const withMore: IntakeDraft = {
    ...draft,
    additionalIds: [ID(5), ID(8)],
    services: [
      { lineId: ID(6), serviceId: ID(7), quantity: "2" },
      { lineId: ID(9), serviceId: ID(10), quantity: "1" },
    ],
  };

  it("keeps everything that is still offered and active", () => {
    const pruned = pruneDraft(withMore, {
      serviceIds: new Set([ID(7), ID(10)]),
      staffIds: new Set([ID(4), ID(5), ID(8)]),
    });
    expect(pruned).toEqual({ draft: withMore, removedServices: 0, removedStaff: 0 });
    expect(prunedMessage(pruned)).toBeNull();
  });

  it("drops archived services and staff no longer active, and says so", () => {
    // Brake Bleed (ID 10) was archived, the lead (ID 4) and a helper (ID 8) deactivated.
    const pruned = pruneDraft(withMore, {
      serviceIds: new Set([ID(7)]),
      staffIds: new Set([ID(5)]),
    });
    expect(pruned.draft).toEqual({
      ...withMore,
      leadId: null,
      additionalIds: [ID(5)],
      services: [{ lineId: ID(6), serviceId: ID(7), quantity: "2" }],
    });
    expect(pruned).toMatchObject({ removedServices: 1, removedStaff: 2 });
    expect(prunedMessage(pruned)).toBe(
      "Removed from the draft: 1 service is no longer offered, and 2 people are no longer active staff.",
    );
  });
});
