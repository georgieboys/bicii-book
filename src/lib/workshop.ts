/**
 * The work order status machine and the overdue rule, mirrored from the
 * database (PLAN D15, D16, D20; DATA-MODEL §4). The database is
 * authoritative: private.work_order_transition_rule decides in
 * set_work_order_status, and tests/db/work-orders.test.ts compares this
 * table with it for all 121 (from, to) pairs. The app uses this copy to
 * offer only the moves the database will accept. Pure.
 */
import { Constants, type Database } from "@/lib/database.types";
import { shopDateKey, shopDayStart } from "@/lib/dates";
import { isUuid } from "@/lib/uuid";

export type WorkOrderStatus = Database["public"]["Enums"]["work_order_status"];

export const WORK_ORDER_STATUSES: readonly WorkOrderStatus[] =
  Constants.public.Enums.work_order_status;

/** "allowed", "reason_required" (cancel, reopen) or null (not allowed). */
export type TransitionRule = "allowed" | "reason_required" | null;

const ALLOWED: Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>> = {
  received: ["diagnosing", "awaiting_customer", "awaiting_parts", "ready_to_start", "in_progress"],
  diagnosing: ["awaiting_customer", "awaiting_parts", "ready_to_start", "in_progress"],
  awaiting_customer: ["diagnosing", "awaiting_parts", "ready_to_start", "in_progress"],
  awaiting_parts: ["diagnosing", "awaiting_customer", "ready_to_start", "in_progress"],
  ready_to_start: ["diagnosing", "awaiting_customer", "awaiting_parts", "in_progress"],
  in_progress: ["diagnosing", "awaiting_customer", "awaiting_parts", "paused", "completed"],
  paused: ["diagnosing", "awaiting_customer", "awaiting_parts", "in_progress", "completed"],
  completed: ["ready_for_collection", "collected"],
  ready_for_collection: ["collected"],
  collected: [],
  cancelled: [],
};

/**
 * Whether a job may move from `from` to `to`. Same status → null (a replay,
 * not a move). Cancelling (from any open status) and reopening (completed or
 * ready for collection → in progress) need a reason. Nothing returns to
 * received; collected and cancelled are final.
 */
export function transitionRule(from: WorkOrderStatus, to: WorkOrderStatus): TransitionRule {
  if (from === to) return null;
  if (ALLOWED[from].includes(to)) return "allowed";
  if (to === "cancelled" && isOpenStatus(from)) return "reason_required";
  if (to === "in_progress" && (from === "completed" || from === "ready_for_collection")) {
    return "reason_required";
  }
  return null;
}

/** Statuses reachable from `from`, in enum order. */
export function nextStatuses(from: WorkOrderStatus): WorkOrderStatus[] {
  return WORK_ORDER_STATUSES.filter((to) => transitionRule(from, to) !== null);
}

/** Open: before completion, so lines may still be added or voided (D15). */
export function isOpenStatus(status: WorkOrderStatus): boolean {
  return (
    status !== "completed" &&
    status !== "ready_for_collection" &&
    status !== "collected" &&
    status !== "cancelled"
  );
}

/** Closed: collected or cancelled, final. */
export function isClosedStatus(status: WorkOrderStatus): boolean {
  return status === "collected" || status === "cancelled";
}

/**
 * D20: a job still open this many days (× 24 hours) after check-in is
 * overdue; in SQL, open and `now() - checked_in_at > interval '7 days'`.
 * Phase 5 (overdue exception, Today tile) and Phase 9 reporting import it.
 */
export const OVERDUE_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * D20: open (before completion) and checked in more than
 * OVERDUE_AFTER_DAYS × 24 hours before `now`.
 */
export function isOverdue(
  job: { status: WorkOrderStatus; checkedInAt: string | Date },
  now: Date = new Date(),
): boolean {
  if (!isOpenStatus(job.status)) return false;
  const checkedIn =
    job.checkedInAt instanceof Date ? job.checkedInAt.getTime() : Date.parse(job.checkedInAt);
  if (Number.isNaN(checkedIn)) return false;
  return now.getTime() - checkedIn > OVERDUE_AFTER_DAYS * DAY_MS;
}

/**
 * D269: what adding a line to a job does once it is no longer open. Null:
 * an open job (lines are added as usual) or a collected or cancelled one
 * (closed for good). "same_day": completed on today's shop day, so the
 * line is added and the job completed again. "follow_up": completed on an
 * earlier shop day, so the line goes on a follow-up job for the same bike.
 * The database decides (private.late_line_target); this only says
 * beforehand what it will do.
 */
export type AfterComplete = "same_day" | "follow_up";

export function afterCompleteMode(
  job: { status: WorkOrderStatus; completedAt: string | Date | null },
  now: Date = new Date(),
): AfterComplete | null {
  if (job.status !== "completed" && job.status !== "ready_for_collection") return null;
  if (!job.completedAt) return "follow_up";
  return shopDateKey(job.completedAt) === shopDateKey(now) ? "same_day" : "follow_up";
}

/** D269: what the Add sheets say beforehand, word for word. */
export const AFTER_COMPLETE_NOTES: Readonly<Record<AfterComplete, string>> = {
  same_day: "This job is completed: the line is added and the job completed again.",
  follow_up: "Completed on an earlier day: this goes on a new follow-up job for the same bike.",
};

/**
 * Why a bike owned by an archived customer cannot be checked in yet: it is
 * still theirs (D18), so it is not a shop bike, and archived customers get
 * no new jobs.
 */
export function archivedOwnerMessage(bike: { shortId: string }, owner: { label: string }): string {
  return `${bike.shortId} belongs to ${owner.label}, who is archived. Unarchive them, or transfer the bike to the right customer, before checking it in.`;
}

/** What staff call each status on screen (board, pills, timeline). */
export const STATUS_LABELS: Readonly<Record<WorkOrderStatus, string>> = {
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
};

/** The StatusPill tone for a status (DESIGN.md "Status"); the label always goes with it. */
export type StatusTone = "info" | "waiting" | "progress" | "done" | "danger" | "neutral";

const TONES: Readonly<Record<WorkOrderStatus, StatusTone>> = {
  received: "info",
  diagnosing: "info",
  ready_to_start: "info",
  awaiting_customer: "waiting",
  awaiting_parts: "waiting",
  paused: "waiting",
  in_progress: "progress",
  completed: "done",
  ready_for_collection: "done",
  collected: "neutral",
  cancelled: "danger",
};

export function statusTone(status: WorkOrderStatus): StatusTone {
  return TONES[status];
}

/**
 * The workshop board's columns (SPEC §7.2: Received, Waiting, Ready, In
 * Progress, Completed, Ready for Collection), each a set of statuses, plus
 * Closed. Every status is in exactly one group.
 */
export type BoardGroup = {
  id:
    | "received"
    | "waiting"
    | "ready"
    | "in_progress"
    | "completed"
    | "ready_for_collection"
    | "closed";
  label: string;
  statuses: readonly WorkOrderStatus[];
};

export const BOARD_GROUPS: readonly BoardGroup[] = [
  { id: "received", label: "Received", statuses: ["received", "diagnosing"] },
  { id: "waiting", label: "Waiting", statuses: ["awaiting_customer", "awaiting_parts", "paused"] },
  { id: "ready", label: "Ready", statuses: ["ready_to_start"] },
  { id: "in_progress", label: "In progress", statuses: ["in_progress"] },
  { id: "completed", label: "Completed", statuses: ["completed"] },
  {
    id: "ready_for_collection",
    label: "Ready for collection",
    statuses: ["ready_for_collection"],
  },
  { id: "closed", label: "Closed", statuses: ["collected", "cancelled"] },
];

/**
 * A move the job can make now: `forward` along the workflow, `reopen`
 * (completed or ready for collection back to in progress) or `cancel`.
 * Reopen and cancel need a reason (D15, D16).
 */
export type Transition = {
  to: WorkOrderStatus;
  needsReason: boolean;
  kind: "forward" | "reopen" | "cancel";
};

/** Every move transitionRule allows from `status`, in enum order. */
export function allowedTransitions(status: WorkOrderStatus): Transition[] {
  return nextStatuses(status).map((to) => ({
    to,
    needsReason: transitionRule(status, to) === "reason_required",
    kind:
      to === "cancelled"
        ? "cancel"
        : to === "in_progress" && !isOpenStatus(status)
          ? "reopen"
          : "forward",
  }));
}

/** A one-tap button on the job page: the usual next step from a status. */
export type PrimaryAction = { to: WorkOrderStatus; label: string };

const PRIMARY: Readonly<Record<WorkOrderStatus, readonly PrimaryAction[]>> = {
  received: [
    { to: "in_progress", label: "Start work" },
    { to: "diagnosing", label: "Diagnose" },
  ],
  diagnosing: [
    { to: "in_progress", label: "Start work" },
    { to: "awaiting_parts", label: "Waiting on parts" },
  ],
  awaiting_customer: [{ to: "in_progress", label: "Start work" }],
  awaiting_parts: [{ to: "in_progress", label: "Start work" }],
  ready_to_start: [{ to: "in_progress", label: "Start work" }],
  in_progress: [
    { to: "completed", label: "Complete" },
    { to: "paused", label: "Pause" },
  ],
  paused: [
    { to: "in_progress", label: "Resume" },
    { to: "completed", label: "Complete" },
  ],
  completed: [
    { to: "ready_for_collection", label: "Ready for collection" },
    { to: "collected", label: "Collected" },
  ],
  ready_for_collection: [{ to: "collected", label: "Collected" }],
  collected: [],
  cancelled: [],
};

/**
 * The usual next steps from `status`, as large one-tap buttons. Each is an
 * allowed move that needs no reason; anything else is under "Change status".
 */
export function primaryActions(status: WorkOrderStatus): PrimaryAction[] {
  return PRIMARY[status].filter((a) => transitionRule(status, a.to) === "allowed");
}

// ---------------------------------------------------------------------------
// The workshop board's filters (SPEC §7.2): all in the URL, parsed here so
// a shared or reloaded link shows the same board. Unknown values are
// dropped, never errors.
// ---------------------------------------------------------------------------

export type BoardGroupId = BoardGroup["id"];
/** All jobs, jobs I am on (lead or additional), or jobs with no lead. */
export type BoardView = "all" | "mine" | "unassigned";
/** Checked in today, in the last 7 or 30 days (shop time), or any time. */
export type CheckedInPreset = "today" | "7d" | "30d" | "any";
/** Any age, checked in more than 3 days ago, or overdue (D20). */
export type AgeFilter = "any" | "over3" | "overdue";

export const BOARD_VIEWS: readonly { value: BoardView; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "My jobs" },
  { value: "unassigned", label: "Unassigned" },
];

export const CHECKED_IN_PRESETS: readonly { value: CheckedInPreset; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export const AGE_FILTERS: readonly { value: AgeFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "over3", label: "Over 3 days" },
  { value: "overdue", label: "Overdue" },
];

/** The age filter "Over 3 days". */
export const OLD_AFTER_DAYS = 3;

/** Closed jobs shown per page, and the most "Show more" reaches. */
export const CLOSED_PAGE = 50;
export const CLOSED_MAX = 500;
/** Closed jobs are shown for this many days back unless a job number is asked for. */
export const CLOSED_WINDOW_DAYS = 30;

export type BoardFilters = {
  view: BoardView;
  /** One group only; null = every non-closed group as sections. */
  group: BoardGroupId | null;
  /** Individual statuses (repeated `status`), in enum order; empty = all. */
  statuses: WorkOrderStatus[];
  /** Jobs this staff member is actively assigned to (lead or additional). */
  mechanicId: string | null;
  customerId: string | null;
  bikeId: string | null;
  checkedIn: CheckedInPreset;
  age: AgeFilter;
  /** What was typed in the job-number box (trimmed). */
  q: string;
  /** `q` as a job number ("J-000123"), or null when it is not one. */
  jobNumber: string | null;
  /** Closed jobs to show (Show more adds CLOSED_PAGE). */
  closedLimit: number;
};

type ParamValue = string | string[] | undefined;
type Params = Record<string, ParamValue>;

const firstOf = (v: ParamValue): string => ((Array.isArray(v) ? v[0] : v) ?? "").trim();
const allOf = (v: ParamValue): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function oneOf<T extends string>(v: ParamValue, allowed: readonly T[], fallback: T): T {
  const s = firstOf(v).toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/**
 * A job number as staff type it: "J-000123", "j000123", "J 000123" or the
 * bare six digits "000123". Null for anything else.
 */
export function normalizeJobNumber(value: string): string | null {
  const m = /^(?:j\s*-?\s*)?(\d{6})$/i.exec(value.trim());
  return m ? `J-${m[1]}` : null;
}

/** The board's filters from the URL's search params. */
export function parseBoardFilters(params: Params): BoardFilters {
  const uuid = (v: ParamValue) => {
    const s = firstOf(v);
    return isUuid(s) ? s.toLowerCase() : null;
  };
  const wanted = new Set(
    allOf(params.status).flatMap((s) => s.split(",").map((x) => x.trim().toLowerCase())),
  );
  const q = firstOf(params.q).replace(/\s+/g, " ").slice(0, 40);
  const limit = Number.parseInt(firstOf(params.limit), 10);
  return {
    view: oneOf(
      params.view,
      BOARD_VIEWS.map((v) => v.value),
      "all",
    ),
    group: (BOARD_GROUPS.find((g) => g.id === firstOf(params.group).toLowerCase())?.id ??
      null) as BoardGroupId | null,
    statuses: WORK_ORDER_STATUSES.filter((s) => wanted.has(s)),
    mechanicId: uuid(params.mechanic),
    customerId: uuid(params.customer),
    bikeId: uuid(params.bike),
    checkedIn: oneOf(
      params.date,
      CHECKED_IN_PRESETS.map((p) => p.value),
      "any",
    ),
    age: oneOf(
      params.age,
      AGE_FILTERS.map((a) => a.value),
      "any",
    ),
    q,
    jobNumber: q ? normalizeJobNumber(q) : null,
    closedLimit:
      Number.isFinite(limit) && limit > CLOSED_PAGE
        ? Math.min(Math.ceil(limit / CLOSED_PAGE) * CLOSED_PAGE, CLOSED_MAX)
        : CLOSED_PAGE,
  };
}

export const DEFAULT_BOARD_FILTERS: BoardFilters = parseBoardFilters({});

/**
 * The board's query string for `filters` with `patch` applied ("?view=mine"
 * or "" for the default board). Defaults are left out, so a link is short
 * and every way of reaching a board reads the same.
 */
export function boardQuery(filters: BoardFilters, patch: Partial<BoardFilters> = {}): string {
  const f = { ...filters, ...patch };
  const params = new URLSearchParams();
  if (f.view !== "all") params.set("view", f.view);
  if (f.group) params.set("group", f.group);
  for (const s of WORK_ORDER_STATUSES.filter((s) => f.statuses.includes(s))) {
    params.append("status", s);
  }
  if (f.mechanicId) params.set("mechanic", f.mechanicId);
  if (f.customerId) params.set("customer", f.customerId);
  if (f.bikeId) params.set("bike", f.bikeId);
  if (f.checkedIn !== "any") params.set("date", f.checkedIn);
  if (f.age !== "any") params.set("age", f.age);
  if (f.q) params.set("q", f.q);
  if (f.closedLimit > CLOSED_PAGE) params.set("limit", String(f.closedLimit));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Whether anything narrows the board beyond the view and the group. */
export function hasBoardFilters(f: BoardFilters): boolean {
  return (
    f.statuses.length > 0 ||
    f.mechanicId !== null ||
    f.customerId !== null ||
    f.bikeId !== null ||
    f.checkedIn !== "any" ||
    f.age !== "any" ||
    f.q !== ""
  );
}

/**
 * The earliest check-in a preset allows, or null for any: shop-local
 * midnight today, 6 days back (the last 7 days, today included) or 29 days back.
 */
export function checkedInSince(preset: CheckedInPreset, now: Date): Date | null {
  switch (preset) {
    case "today":
      return shopDayStart(now);
    case "7d":
      return shopDayStart(now, 6);
    case "30d":
      return shopDayStart(now, 29);
    case "any":
      return null;
  }
}

/**
 * The latest check-in the age filter allows (more than 3 or 7 × 24 hours
 * before `now`), or null for any age. Overdue also needs an open status
 * (isOverdue), which the caller applies.
 */
export function checkedInBefore(age: AgeFilter, now: Date): Date | null {
  if (age === "any") return null;
  const days = age === "overdue" ? OVERDUE_AFTER_DAYS : OLD_AFTER_DAYS;
  return new Date(now.getTime() - days * DAY_MS);
}

/** The board group a status belongs to. */
export function boardGroupOf(status: WorkOrderStatus): BoardGroup {
  return BOARD_GROUPS.find((g) => g.statuses.includes(status))!;
}

export type BoardSection<T> = BoardGroup & { jobs: T[] };

/**
 * Jobs sorted into the board's groups, in BOARD_GROUPS order, each keeping
 * the order it was given. Every group is returned, empty or not.
 */
export function groupBoardJobs<T extends { status: WorkOrderStatus }>(
  jobs: readonly T[],
): BoardSection<T>[] {
  return BOARD_GROUPS.map((g) => ({
    ...g,
    jobs: jobs.filter((j) => boardGroupOf(j.status).id === g.id),
  }));
}

/**
 * The groups the board shows as sections: the chosen one; otherwise the
 * Closed group when the status filter asks only for closed statuses, every
 * group when a job number is asked for, and every non-closed group by
 * default.
 */
export function visibleGroups(
  f: Pick<BoardFilters, "group" | "statuses" | "jobNumber">,
): BoardGroupId[] {
  if (f.group) return [f.group];
  if (f.statuses.length > 0 && f.statuses.every(isClosedStatus)) return ["closed"];
  const all = BOARD_GROUPS.map((g) => g.id);
  return f.jobNumber ? all : all.filter((id) => id !== "closed");
}

/** A job's age on the board: "Today", "1 d", "12 d" (whole shop-local days). */
export function formatAge(days: number): string {
  return days <= 0 ? "Today" : `${days} d`;
}
