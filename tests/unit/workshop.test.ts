import { describe, expect, it } from "vitest";

import {
  AFTER_COMPLETE_NOTES,
  BOARD_GROUPS,
  CLOSED_MAX,
  CLOSED_PAGE,
  DEFAULT_BOARD_FILTERS,
  OVERDUE_AFTER_DAYS,
  STATUS_LABELS,
  WORK_ORDER_STATUSES,
  afterCompleteMode,
  allowedTransitions,
  boardGroupOf,
  boardQuery,
  checkedInBefore,
  checkedInSince,
  formatAge,
  groupBoardJobs,
  hasBoardFilters,
  isClosedStatus,
  isOpenStatus,
  isOverdue,
  nextStatuses,
  normalizeJobNumber,
  parseBoardFilters,
  primaryActions,
  statusTone,
  transitionRule,
  visibleGroups,
  type WorkOrderStatus,
} from "@/lib/workshop";

describe("transitionRule (D15, D16; parity with the database in tests/db/work-orders.test.ts)", () => {
  it("lists the eleven statuses in enum order", () => {
    expect(WORK_ORDER_STATUSES).toEqual([
      "received",
      "diagnosing",
      "awaiting_customer",
      "awaiting_parts",
      "ready_to_start",
      "in_progress",
      "paused",
      "completed",
      "ready_for_collection",
      "collected",
      "cancelled",
    ]);
  });

  it("treats the same status as no move", () => {
    for (const s of WORK_ORDER_STATUSES) expect(transitionRule(s, s)).toBeNull();
  });

  it("never returns to received", () => {
    for (const s of WORK_ORDER_STATUSES) expect(transitionRule(s, "received")).toBeNull();
  });

  it("completes only from in progress or paused", () => {
    const from = WORK_ORDER_STATUSES.filter((s) => transitionRule(s, "completed") !== null);
    expect(from).toEqual(["in_progress", "paused"]);
  });

  it("collects only from completed or ready for collection (completed and collected differ)", () => {
    const from = WORK_ORDER_STATUSES.filter((s) => transitionRule(s, "collected") !== null);
    expect(from).toEqual(["completed", "ready_for_collection"]);
  });

  it("keeps collected and cancelled final", () => {
    expect(nextStatuses("collected")).toEqual([]);
    expect(nextStatuses("cancelled")).toEqual([]);
  });

  it("cancels from every open status, with a reason, and never after completion", () => {
    for (const s of WORK_ORDER_STATUSES) {
      if (s === "cancelled") continue;
      expect(transitionRule(s, "cancelled")).toBe(isOpenStatus(s) ? "reason_required" : null);
    }
  });

  it("reopens completed or ready-for-collection jobs to in progress with a reason", () => {
    expect(transitionRule("completed", "in_progress")).toBe("reason_required");
    expect(transitionRule("ready_for_collection", "in_progress")).toBe("reason_required");
    expect(transitionRule("ready_for_collection", "completed")).toBeNull();
    expect(transitionRule("collected", "in_progress")).toBeNull();
  });

  it("allows the documented moves between working statuses", () => {
    const table: Array<[WorkOrderStatus, WorkOrderStatus[]]> = [
      [
        "received",
        ["diagnosing", "awaiting_customer", "awaiting_parts", "ready_to_start", "in_progress"],
      ],
      ["in_progress", ["diagnosing", "awaiting_customer", "awaiting_parts", "paused", "completed"]],
      ["paused", ["diagnosing", "awaiting_customer", "awaiting_parts", "in_progress", "completed"]],
      ["completed", ["ready_for_collection", "collected"]],
    ];
    for (const [from, to] of table) {
      expect(WORK_ORDER_STATUSES.filter((s) => transitionRule(from, s) === "allowed")).toEqual(to);
    }
    expect(transitionRule("in_progress", "ready_to_start")).toBeNull();
    expect(transitionRule("received", "paused")).toBeNull();
  });
});

describe("open and closed statuses", () => {
  it("open = before completion; closed = collected or cancelled", () => {
    expect(WORK_ORDER_STATUSES.filter(isOpenStatus)).toEqual([
      "received",
      "diagnosing",
      "awaiting_customer",
      "awaiting_parts",
      "ready_to_start",
      "in_progress",
      "paused",
    ]);
    expect(WORK_ORDER_STATUSES.filter(isClosedStatus)).toEqual(["collected", "cancelled"]);
  });
});

describe("isOverdue (D20)", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it("is seven days", () => {
    expect(OVERDUE_AFTER_DAYS).toBe(7);
  });

  it("flags an open job checked in more than 7 x 24 hours ago", () => {
    expect(isOverdue({ status: "in_progress", checkedInAt: days(7.01) }, now)).toBe(true);
    expect(isOverdue({ status: "received", checkedInAt: new Date(days(30)) }, now)).toBe(true);
  });

  it("does not flag exactly 7 days or less", () => {
    expect(isOverdue({ status: "in_progress", checkedInAt: days(7) }, now)).toBe(false);
    expect(isOverdue({ status: "awaiting_parts", checkedInAt: days(1) }, now)).toBe(false);
  });

  it("never flags completed or closed jobs", () => {
    for (const status of ["completed", "ready_for_collection", "collected", "cancelled"] as const) {
      expect(isOverdue({ status, checkedInAt: days(60) }, now)).toBe(false);
    }
  });

  it("ignores an unreadable date", () => {
    expect(isOverdue({ status: "received", checkedInAt: "not a date" }, now)).toBe(false);
  });
});

describe("status labels, tones and board groups", () => {
  it("labels every status in staff words", () => {
    expect(STATUS_LABELS).toEqual({
      received: "Received",
      diagnosing: "Diagnosing",
      awaiting_customer: "Waiting on customer",
      awaiting_parts: "Waiting on parts",
      ready_to_start: "Ready to start",
      in_progress: "In progress",
      paused: "Paused",
      completed: "Completed",
      ready_for_collection: "Ready for collection",
      collected: "Collected",
      cancelled: "Cancelled",
    });
  });

  it("maps each status onto one of the five status tones or neutral", () => {
    const byTone = (tone: string) => WORK_ORDER_STATUSES.filter((s) => statusTone(s) === tone);
    expect(byTone("info")).toEqual(["received", "diagnosing", "ready_to_start"]);
    expect(byTone("waiting")).toEqual(["awaiting_customer", "awaiting_parts", "paused"]);
    expect(byTone("progress")).toEqual(["in_progress"]);
    expect(byTone("done")).toEqual(["completed", "ready_for_collection"]);
    expect(byTone("neutral")).toEqual(["collected"]);
    expect(byTone("danger")).toEqual(["cancelled"]);
  });

  it("puts every status in exactly one board group, in SPEC §7.2 order", () => {
    expect(BOARD_GROUPS.map((g) => g.id)).toEqual([
      "received",
      "waiting",
      "ready",
      "in_progress",
      "completed",
      "ready_for_collection",
      "closed",
    ]);
    const all = BOARD_GROUPS.flatMap((g) => g.statuses);
    expect([...all].sort()).toEqual([...WORK_ORDER_STATUSES].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(BOARD_GROUPS.find((g) => g.id === "received")?.statuses).toEqual([
      "received",
      "diagnosing",
    ]);
    expect(BOARD_GROUPS.find((g) => g.id === "waiting")?.statuses).toEqual([
      "awaiting_customer",
      "awaiting_parts",
      "paused",
    ]);
    expect(BOARD_GROUPS.find((g) => g.id === "closed")?.statuses).toEqual([
      "collected",
      "cancelled",
    ]);
  });
});

describe("allowedTransitions", () => {
  it("is exactly the moves transitionRule allows, with their reason rule", () => {
    for (const from of WORK_ORDER_STATUSES) {
      const moves = allowedTransitions(from);
      expect(moves.map((m) => m.to)).toEqual(nextStatuses(from));
      for (const m of moves) {
        expect(m.needsReason).toBe(transitionRule(from, m.to) === "reason_required");
      }
    }
  });

  it("calls cancelling a cancel and needs a reason for it", () => {
    const cancel = allowedTransitions("in_progress").find((m) => m.to === "cancelled");
    expect(cancel).toEqual({ to: "cancelled", needsReason: true, kind: "cancel" });
  });

  it("calls going back to in progress after completion a reopen, with a reason", () => {
    expect(allowedTransitions("completed")).toEqual([
      { to: "in_progress", needsReason: true, kind: "reopen" },
      { to: "ready_for_collection", needsReason: false, kind: "forward" },
      { to: "collected", needsReason: false, kind: "forward" },
    ]);
    expect(allowedTransitions("ready_for_collection")).toEqual([
      { to: "in_progress", needsReason: true, kind: "reopen" },
      { to: "collected", needsReason: false, kind: "forward" },
    ]);
  });

  it("offers nothing from a final status, and resuming from paused is a forward move", () => {
    expect(allowedTransitions("collected")).toEqual([]);
    expect(allowedTransitions("cancelled")).toEqual([]);
    expect(allowedTransitions("paused").find((m) => m.to === "in_progress")?.kind).toBe("forward");
  });
});

describe("primaryActions", () => {
  const labels = (s: Parameters<typeof primaryActions>[0]) =>
    primaryActions(s).map((a) => `${a.label} -> ${a.to}`);

  it("offers the usual next steps as one-tap buttons", () => {
    expect(labels("received")).toEqual(["Start work -> in_progress", "Diagnose -> diagnosing"]);
    expect(labels("diagnosing")).toEqual([
      "Start work -> in_progress",
      "Waiting on parts -> awaiting_parts",
    ]);
    for (const s of ["awaiting_customer", "awaiting_parts", "ready_to_start"] as const) {
      expect(labels(s)).toEqual(["Start work -> in_progress"]);
    }
    expect(labels("in_progress")).toEqual(["Complete -> completed", "Pause -> paused"]);
    expect(labels("paused")).toEqual(["Resume -> in_progress", "Complete -> completed"]);
    expect(labels("completed")).toEqual([
      "Ready for collection -> ready_for_collection",
      "Collected -> collected",
    ]);
    expect(labels("ready_for_collection")).toEqual(["Collected -> collected"]);
    expect(labels("collected")).toEqual([]);
    expect(labels("cancelled")).toEqual([]);
  });

  it("never offers a move that needs a reason or is not allowed", () => {
    for (const s of WORK_ORDER_STATUSES) {
      for (const a of primaryActions(s)) expect(transitionRule(s, a.to)).toBe("allowed");
    }
  });
});

const STAFF = "a0000000-0000-4000-8000-000000000002";
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";

describe("board filters from the URL (SPEC §7.2)", () => {
  it("defaults to every job, every open group, no narrowing", () => {
    expect(parseBoardFilters({})).toEqual({
      view: "all",
      group: null,
      statuses: [],
      mechanicId: null,
      customerId: null,
      bikeId: null,
      checkedIn: "any",
      age: "any",
      q: "",
      jobNumber: null,
      closedLimit: CLOSED_PAGE,
    });
    expect(hasBoardFilters(DEFAULT_BOARD_FILTERS)).toBe(false);
  });

  it("reads every filter", () => {
    const f = parseBoardFilters({
      view: "mine",
      group: "waiting",
      status: ["awaiting_parts", "paused"],
      mechanic: STAFF.toUpperCase(),
      customer: CUSTOMER,
      bike: "not-a-uuid",
      date: "7d",
      age: "overdue",
      q: " j000004 ",
      limit: "120",
    });
    expect(f).toMatchObject({
      view: "mine",
      group: "waiting",
      statuses: ["awaiting_parts", "paused"],
      mechanicId: STAFF,
      customerId: CUSTOMER,
      bikeId: null,
      checkedIn: "7d",
      age: "overdue",
      q: "j000004",
      jobNumber: "J-000004",
      closedLimit: 150,
    });
    expect(hasBoardFilters(f)).toBe(true);
  });

  it("drops unknown values instead of failing", () => {
    const f = parseBoardFilters({
      view: "everything",
      group: "bench",
      status: ["awaiting_parts", "lost", "AWAITING_CUSTOMER"],
      date: "yesterday",
      age: "ancient",
      limit: "-5",
    });
    expect(f.view).toBe("all");
    expect(f.group).toBeNull();
    expect(f.statuses).toEqual(["awaiting_customer", "awaiting_parts"]);
    expect(f.checkedIn).toBe("any");
    expect(f.age).toBe("any");
    expect(f.closedLimit).toBe(CLOSED_PAGE);
    expect(parseBoardFilters({ limit: "999999" }).closedLimit).toBe(CLOSED_MAX);
  });

  it("reads a job number however staff type it", () => {
    for (const typed of ["J-000123", "j-000123", "J000123", "j 000123", "000123"]) {
      expect(normalizeJobNumber(typed), typed).toBe("J-000123");
    }
    for (const typed of ["123", "J-12345", "J-0001234", "B-000123", "Priya"]) {
      expect(normalizeJobNumber(typed), typed).toBeNull();
    }
  });

  it("writes the query back, leaving defaults out, and round-trips", () => {
    expect(boardQuery(DEFAULT_BOARD_FILTERS)).toBe("");
    const f = parseBoardFilters({
      view: "unassigned",
      status: ["paused", "awaiting_parts"],
      q: "J-000004",
    });
    const q = boardQuery(f);
    expect(q).toBe("?view=unassigned&status=awaiting_parts&status=paused&q=J-000004");
    const back = parseBoardFilters(
      Object.fromEntries(
        [...new URLSearchParams(q).keys()].map((k) => [k, new URLSearchParams(q).getAll(k)]),
      ),
    );
    expect(back).toEqual(f);
    expect(boardQuery(f, { statuses: [], view: "all" })).toBe("?q=J-000004");
  });
});

describe("board time windows (D20, Singapore time)", () => {
  // 4 Oct 2026, 10:00 in Singapore.
  const now = new Date("2026-10-04T02:00:00Z");

  it("starts the checked-in presets at shop-local midnight", () => {
    expect(checkedInSince("any", now)).toBeNull();
    expect(checkedInSince("today", now)?.toISOString()).toBe("2026-10-03T16:00:00.000Z");
    expect(checkedInSince("7d", now)?.toISOString()).toBe("2026-09-27T16:00:00.000Z");
    expect(checkedInSince("30d", now)?.toISOString()).toBe("2026-09-04T16:00:00.000Z");
  });

  it("ages by 24-hour periods, overdue only while open", () => {
    expect(checkedInBefore("any", now)).toBeNull();
    expect(checkedInBefore("over3", now)?.toISOString()).toBe("2026-10-01T02:00:00.000Z");
    expect(checkedInBefore("overdue", now)?.toISOString()).toBe("2026-09-27T02:00:00.000Z");
    // The board's overdue filter is checkedInBefore("overdue") plus an open
    // status: the same jobs isOverdue (D20) marks.
    const eightDays = "2026-09-26T02:00:00Z";
    const before = checkedInBefore("overdue", now)!;
    for (const status of ["awaiting_customer", "completed"] as const) {
      const matched = Date.parse(eightDays) < before.getTime() && isOpenStatus(status);
      expect(matched).toBe(isOverdue({ status, checkedInAt: eightDays }, now));
    }
  });

  it("shows age in whole days", () => {
    expect(formatAge(0)).toBe("Today");
    expect(formatAge(3)).toBe("3 d");
  });
});

describe("board grouping", () => {
  it("sorts jobs into the groups in board order, keeping their order", () => {
    const jobs = [
      { id: "a", status: "awaiting_parts" as const },
      { id: "b", status: "received" as const },
      { id: "c", status: "paused" as const },
      { id: "d", status: "collected" as const },
      { id: "e", status: "diagnosing" as const },
    ];
    const sections = groupBoardJobs(jobs);
    expect(sections.map((s) => s.id)).toEqual(BOARD_GROUPS.map((g) => g.id));
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.jobs.map((j) => j.id)]));
    expect(byId).toMatchObject({
      received: ["b", "e"],
      waiting: ["a", "c"],
      closed: ["d"],
      ready: [],
    });
    expect(boardGroupOf("awaiting_customer").label).toBe("Waiting");
  });

  it("shows the open groups by default, the chosen one, or Closed for closed statuses", () => {
    const open = BOARD_GROUPS.filter((g) => g.id !== "closed").map((g) => g.id);
    expect(visibleGroups({ group: null, statuses: [], jobNumber: null })).toEqual(open);
    expect(visibleGroups({ group: "closed", statuses: [], jobNumber: null })).toEqual(["closed"]);
    expect(visibleGroups({ group: null, statuses: ["collected"], jobNumber: null })).toEqual([
      "closed",
    ]);
    expect(
      visibleGroups({ group: null, statuses: ["collected", "paused"], jobNumber: null }),
    ).toEqual(open);
    expect(visibleGroups({ group: null, statuses: [], jobNumber: "J-000001" })).toContain("closed");
  });
});

describe("afterCompleteMode (D269)", () => {
  // 2026-11-23 10:00 in Singapore.
  const now = new Date("2026-11-23T02:00:00Z");

  it("leaves open and closed jobs alone", () => {
    for (const status of WORK_ORDER_STATUSES) {
      if (status === "completed" || status === "ready_for_collection") continue;
      expect(afterCompleteMode({ status, completedAt: "2026-11-23T01:00:00Z" }, now)).toBeNull();
    }
  });

  it("is same_day when the job was completed on today's shop day", () => {
    // 00:30 on 23 Nov in Singapore is still 22 Nov in UTC.
    expect(
      afterCompleteMode({ status: "completed", completedAt: "2026-11-22T16:30:00Z" }, now),
    ).toBe("same_day");
    expect(
      afterCompleteMode(
        { status: "ready_for_collection", completedAt: "2026-11-23T01:00:00Z" },
        now,
      ),
    ).toBe("same_day");
  });

  it("is follow_up when it was completed on an earlier shop day", () => {
    // 23:30 on 22 Nov in Singapore.
    expect(
      afterCompleteMode({ status: "completed", completedAt: "2026-11-22T15:30:00Z" }, now),
    ).toBe("follow_up");
  });

  it("says beforehand what will happen", () => {
    expect(AFTER_COMPLETE_NOTES.same_day).toBe(
      "This job is completed: the line is added and the job completed again.",
    );
    expect(AFTER_COMPLETE_NOTES.follow_up).toBe(
      "Completed on an earlier day: this goes on a new follow-up job for the same bike.",
    );
  });
});
