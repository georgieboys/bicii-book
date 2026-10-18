import "server-only";

import { bikeTitle } from "@/lib/bikes";
import { BUSINESS_ERRORS, unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";
import {
  allowedTransitions,
  archivedOwnerMessage,
  checkedInBefore,
  checkedInSince,
  CLOSED_WINDOW_DAYS,
  groupBoardJobs,
  isClosedStatus,
  isOpenStatus,
  transitionRule,
  visibleGroups,
  WORK_ORDER_STATUSES,
  type BoardFilters,
  type BoardGroupId,
  type Transition,
  type WorkOrderStatus,
} from "@/lib/workshop";
import {
  describeEvent,
  type EventDescription,
  type WorkOrderEventType,
} from "@/lib/workshop-timeline";

import { DomainError } from "./errors";
import { getTotals, listLines, rethrowOnField, type Line, type Totals } from "./lines";
import type { ListPage } from "./list";
import { staffDirectory, staffNames } from "@/lib/domain/staff-directory";

/**
 * Workshop jobs (SPEC §7, §21; DATA-MODEL §4; PLAN D15–D22). Jobs are
 * written only through RPCs, which check authorization, the status machine
 * and the ownership rule again and write the timeline themselves; staff
 * read the tables under RLS. Cost figures reach a DTO only for a view_costs
 * holder (src/lib/domain/lines.ts).
 */

export type AssignmentRole = "lead" | "additional";

export type TimelineEntry = EventDescription & {
  id: number;
  type: WorkOrderEventType;
  at: string;
  /** Null when the change was made outside the app (seed, SQL editor). */
  actorName: string | null;
};

export type WorkOrderDetail = {
  id: string;
  jobNumber: string;
  status: WorkOrderStatus;
  currency: string;
  customer: {
    id: string;
    label: string;
    /** For greeting the customer in a quote message (Phase 13). */
    firstName: string | null;
    phone: string | null;
    email: string | null;
    archived: boolean;
  };
  bike: { id: string; shortId: string; title: string; colour: string | null; archived: boolean };
  requestedWork: string;
  intakeNotes: string | null;
  internalNotes: string | null;
  completionNotes: string | null;
  approval: { flagged: boolean; note: string | null };
  stamps: {
    checkedInAt: string;
    statusChangedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    readyForCollectionAt: string | null;
    collectedAt: string | null;
    cancelledAt: string | null;
    cancellationReason: string | null;
  };
  /** Active assignments: the lead first, then additional staff by when they joined. */
  assignments: { staffId: string; name: string; role: AssignmentRole; assignedAt: string }[];
  lines: Line[];
  totals: Totals;
  /** Newest first: at most the `timelineRows` asked for. */
  timeline: TimelineEntry[];
  /** Older events exist beyond `timeline` (the check-in among them). */
  timelineTruncated: boolean;
  allowedTransitions: Transition[];
  /** The appointment the job was checked in from (D40; Phase 2), or null. */
  appointment: { id: string; startsAt: string; typeName: string } | null;
};

const NOT_FOUND = "That job no longer exists. Refresh and try again.";

type NameColumns = {
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
};

const labelOf = (c: NameColumns) =>
  customerLabel({
    firstName: c.first_name,
    lastName: c.last_name,
    displayName: c.display_name,
    email: c.email,
    phone: c.phone,
  });

const CLOSED = "(collected,cancelled)";

/** Timeline events the job page shows at first, and with "Show earlier events". */
export const TIMELINE_ROWS = 200;
export const TIMELINE_ALL_ROWS = 1000;

/**
 * Everything the job page shows except photos (listPhotos with target
 * work_order), or null when there is no such job. With `viewCosts` false
 * the lines and totals carry no cost, yield or Cult Commons figure.
 */
export async function getWorkOrder(
  supabase: ServerSupabase,
  id: string,
  { viewCosts, timelineRows = TIMELINE_ROWS }: { viewCosts: boolean; timelineRows?: number },
): Promise<WorkOrderDetail | null> {
  // One phase for the job, its people, timeline, lines and totals: the
  // lines need only the staff names and the totals only the job's
  // currency, as a fallback, so neither waits for the job row.
  const jobQuery = Promise.resolve(
    supabase
      .from("work_orders")
      .select(
        "id, job_number, status, currency, requested_work, intake_notes, internal_notes, completion_notes, approval_flag, approval_note, checked_in_at, status_changed_at, started_at, completed_at, ready_for_collection_at, collected_at, cancelled_at, cancellation_reason, customer:customers(id, first_name, last_name, display_name, email, phone, archived_at), bike:bikes(id, short_id, brand, model, variant, colour, archived_at), appointment:appointments(id, starts_at, type:appointment_types(name))",
      )
      .eq("id", id)
      .maybeSingle(),
  );
  const namesQuery = staffNames(supabase);
  const [jobResult, assignmentsResult, timelineResult, names, lines, totals] = await Promise.all([
    jobQuery,
    supabase
      .from("work_order_assignments")
      .select("staff_id, role, assigned_at")
      .eq("work_order_id", id)
      .is("unassigned_at", null)
      .order("assigned_at", { ascending: true }),
    // One more than shown, to know whether older events were left out.
    supabase.rpc("work_order_timeline", { work_order_id: id, max_rows: timelineRows + 1 }),
    namesQuery,
    listLines(supabase, id, { viewCosts, names: namesQuery }),
    getTotals(supabase, id, {
      viewCosts,
      currency: jobQuery.then((r) => r.data?.currency ?? "SGD"),
    }),
  ]);
  const row = unwrap(jobResult);
  if (!row || !row.customer || !row.bike) return null;
  const assignments = (unwrap(assignmentsResult) ?? [])
    .map((a) => ({
      staffId: a.staff_id,
      name: names.get(a.staff_id) ?? "A former colleague",
      role: a.role,
      assignedAt: a.assigned_at,
    }))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "lead" ? -1 : 1));
  const events = unwrap(timelineResult) ?? [];
  const lineDescriptions = new Map(lines.map((l) => [l.id, l.description]));
  const lineOf = (payload: unknown): string | null => {
    const id =
      typeof payload === "object" && payload !== null && "line_id" in payload
        ? (payload as { line_id: unknown }).line_id
        : null;
    return typeof id === "string" ? (lineDescriptions.get(id) ?? null) : null;
  };
  const timelineTruncated = events.length > timelineRows;
  const timeline = events.slice(0, timelineRows).map((e) => ({
    id: e.id,
    type: e.event_type,
    at: e.created_at,
    actorName: e.actor_staff_id ? (e.actor_display_name ?? "A former colleague") : null,
    ...describeEvent(
      {
        type: e.event_type,
        payload: e.payload,
        subjectName: e.subject_display_name,
        lineDescription: lineOf(e.payload),
      },
      { currency: row.currency },
    ),
  }));

  return {
    id: row.id,
    jobNumber: row.job_number,
    status: row.status,
    currency: row.currency,
    customer: {
      id: row.customer.id,
      label: labelOf(row.customer),
      firstName: row.customer.first_name,
      phone: row.customer.phone,
      email: row.customer.email,
      archived: row.customer.archived_at !== null,
    },
    bike: {
      id: row.bike.id,
      shortId: row.bike.short_id,
      title: bikeTitle(row.bike),
      colour: row.bike.colour,
      archived: row.bike.archived_at !== null,
    },
    requestedWork: row.requested_work,
    intakeNotes: row.intake_notes,
    internalNotes: row.internal_notes,
    completionNotes: row.completion_notes,
    approval: { flagged: row.approval_flag, note: row.approval_note },
    stamps: {
      checkedInAt: row.checked_in_at,
      statusChangedAt: row.status_changed_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      readyForCollectionAt: row.ready_for_collection_at,
      collectedAt: row.collected_at,
      cancelledAt: row.cancelled_at,
      cancellationReason: row.cancellation_reason,
    },
    assignments,
    lines,
    totals,
    timeline,
    timelineTruncated,
    allowedTransitions: allowedTransitions(row.status),
    appointment:
      row.appointment && row.appointment.type
        ? {
            id: row.appointment.id,
            startsAt: row.appointment.starts_at,
            typeName: row.appointment.type.name,
          }
        : null,
  };
}

export type CreateWorkOrderInput = {
  /** The intake's idempotency key. */
  id: string;
  customerId: string;
  bikeId: string;
  requestedWork: string;
  intakeNotes: string | null;
  leadId: string | null;
  additionalIds: string[];
  /** Known services; quantities as fixed-point strings. */
  services: { lineId: string; serviceId: string; quantity: string }[];
};

const CREATE_FIELDS = {
  requested_work_required: "requestedWork",
  work_order_customer_archived: "customerId",
  work_order_bike_archived: "bikeId",
  bike_owner_mismatch: "bikeId",
  staff_inactive: "leadId",
  service_unavailable: "services",
};

/**
 * Checks a bike in as a new job (RPC create_work_order: J- number, lead
 * and additional staff, known services, the timeline's first events). The
 * id is the idempotency key: a replay (a double tap, a retry after a lost
 * response) returns the job it already made.
 */
export async function createWorkOrder(
  supabase: ServerSupabase,
  input: CreateWorkOrderInput,
): Promise<{ id: string; jobNumber: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("create_work_order", {
        work_order_id: input.id,
        customer_id: input.customerId,
        bike_id: input.bikeId,
        requested_work: input.requestedWork,
        intake_notes: input.intakeNotes ?? undefined,
        lead_mechanic_id: input.leadId ?? undefined,
        additional_staff_ids: input.additionalIds,
        // A JSON number: the RPC checks the type. Quantities have at most
        // two decimals, which a number carries exactly as decimal text.
        services: input.services.map((s) => ({
          line_id: s.lineId,
          service_id: s.serviceId,
          quantity: Number(s.quantity),
        })),
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { id: row.id, jobNumber: row.job_number };
  } catch (err) {
    rethrowOnField(err, CREATE_FIELDS);
  }
}

/**
 * Moves a job along the status machine (RPC set_work_order_status, D15,
 * D16). Checks the move first for a precise message; the RPC checks again
 * under a lock. The same status is a replay and changes nothing.
 */
export async function setWorkOrderStatus(
  supabase: ServerSupabase,
  input: { workOrderId: string; status: WorkOrderStatus; note: string | null },
): Promise<{ status: WorkOrderStatus }> {
  const current = unwrap(
    await supabase.from("work_orders").select("status").eq("id", input.workOrderId).maybeSingle(),
  );
  if (!current) throw new DomainError(NOT_FOUND);
  if (current.status === input.status) return { status: current.status };
  const rule = transitionRule(current.status, input.status);
  if (rule === null) throw new DomainError(BUSINESS_ERRORS.work_order_transition_invalid);
  const note = input.note?.trim() || null;
  if (rule === "reason_required" && !note) {
    const message =
      input.status === "cancelled"
        ? "Say why the job is being cancelled."
        : "Say why the job is being reopened.";
    throw new DomainError(message, { note: [message] });
  }
  try {
    const row = unwrap(
      await supabase.rpc("set_work_order_status", {
        work_order_id: input.workOrderId,
        status: input.status,
        note: note ?? undefined,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { status: row.status };
  } catch (err) {
    rethrowOnField(err, { reason_required: "note", reason_too_long: "note" });
  }
}

/** A bike as intake shows it. */
export type IntakeBikeRef = { id: string; shortId: string; title: string };

export type IntakeBike = IntakeBikeRef & {
  colour: string | null;
  /** A job for this bike that is not collected or cancelled yet. */
  openJob: { id: string; jobNumber: string } | null;
};

/** One result of intake's first step: a customer, or a bike (with its owner). */
export type IntakeOption = {
  id: string;
  kind: "customer" | "bike";
  label: string;
  description?: string;
  meta?: string;
  /** The customer this choice selects; null for a bike nobody owns (a shop bike). */
  customer: { id: string; label: string } | null;
  bike: IntakeBikeRef | null;
  /**
   * The bike's owner when they are archived: the bike is still theirs (D18),
   * so it is neither a shop bike nor theirs to check in until they are
   * unarchived or the bike is transferred.
   */
  archivedOwner: { id: string; label: string } | null;
};

/**
 * Customers and bikes matching `q` (staff_search; archived ones left out).
 * Choosing a bike selects its owner too, so each bike hit carries it.
 */
export async function searchIntakeOptions(
  supabase: ServerSupabase,
  q: string,
): Promise<IntakeOption[]> {
  const hits =
    unwrap(
      await supabase.rpc("staff_search", { q, kinds: ["customer", "bike"], max_results: 10 }),
    ) ?? [];
  const bikeIds = hits.filter((h) => h.kind === "bike").map((h) => h.id);
  const bikes = new Map<
    string,
    {
      short_id: string;
      brand: string;
      model: string;
      variant: string | null;
      owner: { id: string; label: string } | null;
      archivedOwner: { id: string; label: string } | null;
    }
  >();
  if (bikeIds.length > 0) {
    const rows =
      unwrap(
        await supabase
          .from("bikes")
          .select(
            "id, short_id, brand, model, variant, customer:customers(id, first_name, last_name, display_name, email, phone, archived_at)",
          )
          .in("id", bikeIds),
      ) ?? [];
    for (const r of rows) {
      const owner = r.customer ? { id: r.customer.id, label: labelOf(r.customer) } : null;
      const archived = r.customer?.archived_at != null;
      bikes.set(r.id, {
        ...r,
        owner: archived ? null : owner,
        archivedOwner: archived ? owner : null,
      });
    }
  }
  return hits.flatMap((h): IntakeOption[] => {
    if (h.kind === "customer") {
      return [
        {
          id: h.id,
          kind: "customer",
          label: h.title,
          description: h.subtitle ?? undefined,
          meta: "Customer",
          customer: { id: h.id, label: h.title },
          bike: null,
          archivedOwner: null,
        },
      ];
    }
    const bike = bikes.get(h.id);
    if (h.kind !== "bike" || !bike) return [];
    return [
      {
        id: h.id,
        kind: "bike",
        label: h.title,
        description: bike.owner
          ? `Owned by ${bike.owner.label}`
          : bike.archivedOwner
            ? `Owned by ${bike.archivedOwner.label} (archived)`
            : "Shop bike · no customer",
        meta: bike.short_id,
        customer: bike.owner,
        bike: { id: h.id, shortId: bike.short_id, title: bikeTitle(bike) },
        archivedOwner: bike.archivedOwner,
      },
    ];
  });
}

/** Open jobs (not collected or cancelled) for these bikes, by bike id. */
async function openJobsFor(
  supabase: ServerSupabase,
  bikeIds: string[],
): Promise<Map<string, { id: string; jobNumber: string }>> {
  const jobs = new Map<string, { id: string; jobNumber: string }>();
  if (bikeIds.length === 0) return jobs;
  const rows =
    unwrap(
      await supabase
        .from("work_orders")
        .select("id, job_number, bike_id, checked_in_at")
        .in("bike_id", bikeIds)
        .not("status", "in", CLOSED)
        .order("checked_in_at", { ascending: false }),
    ) ?? [];
  for (const r of rows) {
    if (!jobs.has(r.bike_id)) jobs.set(r.bike_id, { id: r.id, jobNumber: r.job_number });
  }
  return jobs;
}

/**
 * The customer's active bikes for intake's second step, oldest first, each
 * with the job it is already in the shop for, if any.
 */
export async function customerBikesForIntake(
  supabase: ServerSupabase,
  customerId: string,
): Promise<IntakeBike[]> {
  const rows =
    unwrap(
      await supabase
        .from("bikes")
        .select("id, short_id, brand, model, variant, colour")
        .eq("customer_id", customerId)
        .is("archived_at", null)
        .order("created_at", { ascending: true }),
    ) ?? [];
  const jobs = await openJobsFor(
    supabase,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    shortId: r.short_id,
    title: bikeTitle(r),
    colour: r.colour,
    openJob: jobs.get(r.id) ?? null,
  }));
}

/**
 * Intake presets from the URL (?customer=, ?bike=), resolved to what the
 * wizard shows. A bike's owner wins over a customer that does not own it;
 * archived records are ignored. A bike whose owner is archived is not
 * offered as a shop bike: it is left out, with `notice` saying why.
 */
export async function intakePreset(
  supabase: ServerSupabase,
  { customerId, bikeId }: { customerId: string | null; bikeId: string | null },
): Promise<{
  customer: { id: string; label: string } | null;
  bike: IntakeBike | null;
  notice: string | null;
}> {
  let customer: { id: string; label: string } | null = null;
  let bike: IntakeBike | null = null;
  let notice: string | null = null;
  if (bikeId) {
    const row = unwrap(
      await supabase
        .from("bikes")
        .select(
          "id, short_id, brand, model, variant, colour, archived_at, customer:customers(id, first_name, last_name, display_name, email, phone, archived_at)",
        )
        .eq("id", bikeId)
        .maybeSingle(),
    );
    if (row && row.archived_at === null && row.customer && row.customer.archived_at !== null) {
      notice = archivedOwnerMessage({ shortId: row.short_id }, { label: labelOf(row.customer) });
    } else if (row && row.archived_at === null) {
      const jobs = await openJobsFor(supabase, [row.id]);
      bike = {
        id: row.id,
        shortId: row.short_id,
        title: bikeTitle(row),
        colour: row.colour,
        openJob: jobs.get(row.id) ?? null,
      };
      if (row.customer) customer = { id: row.customer.id, label: labelOf(row.customer) };
    }
  }
  if (!customer && customerId) {
    const row = unwrap(
      await supabase
        .from("customers")
        .select("id, first_name, last_name, display_name, email, phone, archived_at")
        .eq("id", customerId)
        .maybeSingle(),
    );
    if (row && row.archived_at === null) customer = { id: row.id, label: labelOf(row) };
  }
  return { customer, bike, notice };
}

/** Active staff, by name: who can be assigned to a job (D22). */
export async function listActiveStaff(
  supabase: ServerSupabase,
): Promise<{ id: string; name: string }[]> {
  const rows = unwrap(await staffDirectory(supabase)) ?? [];
  return rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.display_name }));
}

// ---------------------------------------------------------------------------
// The workshop board (SPEC §7.2)
// ---------------------------------------------------------------------------

/** One job on the board: no money (SPEC §7.2; costs never reach the board). */
export type BoardJob = {
  id: string;
  jobNumber: string;
  status: WorkOrderStatus;
  checkedInAt: string;
  /** When the job last changed status; for a closed job, when it closed. */
  statusChangedAt: string;
  customerLabel: string;
  bikeTitle: string;
  bikeShortId: string;
  /** Null when the job has no lead. */
  leadName: string | null;
};

export type Board = {
  /** Jobs per group after every filter except the group itself. */
  counts: Record<BoardGroupId, number>;
  /** The groups shown, in board order, each with its jobs (open ones oldest check-in first). */
  sections: { id: BoardGroupId; label: string; jobs: BoardJob[] }[];
  /** More open jobs match than BOARD_OPEN_CAP: the open counts are partial. */
  truncated: boolean;
  /** More closed jobs match than filters.closedLimit. */
  closedMore: boolean;
  /** `q` was typed but is not a job number, so nothing was searched. */
  invalidQuery: boolean;
};

/** The most open jobs the board reads in one go (newest check-ins win). */
export const BOARD_OPEN_CAP = 300;

const BOARD_COLUMNS =
  "id, job_number, status, checked_in_at, status_changed_at, lead_mechanic_id, customer:customers(first_name, last_name, display_name, email, phone), bike:bikes(short_id, brand, model, variant)";

const OPEN_STATUSES = WORK_ORDER_STATUSES.filter((s) => !isClosedStatus(s));
const CLOSED_STATUSES = WORK_ORDER_STATUSES.filter(isClosedStatus);

/**
 * Work orders matching the board's filters (RLS client, explicit columns).
 * "My jobs" and the mechanic filter join the active assignments with
 * `!inner`, so a job is kept when that person is on it as lead or
 * additional staff.
 */
function selectBoardJobs(
  supabase: ServerSupabase,
  f: BoardFilters,
  staffId: string,
  now: Date,
  options: { count?: boolean; head?: boolean } = {},
) {
  const people = [f.view === "mine" ? staffId : null, f.mechanicId].filter(
    (p): p is string => p !== null,
  );
  const select = options.count ? { count: "exact" as const, head: options.head ?? false } : {};
  const query =
    people.length === 0
      ? supabase.from("work_orders").select(BOARD_COLUMNS, select)
      : people.length === 1 || people[0] === people[1]
        ? supabase
            .from("work_orders")
            .select(
              `${BOARD_COLUMNS}, a1:work_order_assignments!inner(staff_id, unassigned_at)`,
              select,
            )
            .eq("a1.staff_id", people[0])
            .is("a1.unassigned_at", null)
        : supabase
            .from("work_orders")
            .select(
              `${BOARD_COLUMNS}, a1:work_order_assignments!inner(staff_id, unassigned_at), a2:work_order_assignments!inner(staff_id, unassigned_at)`,
              select,
            )
            .eq("a1.staff_id", people[0])
            .is("a1.unassigned_at", null)
            .eq("a2.staff_id", people[1])
            .is("a2.unassigned_at", null);

  let q = query;
  if (f.view === "unassigned") q = q.is("lead_mechanic_id", null);
  if (f.statuses.length > 0) q = q.in("status", f.statuses);
  if (f.customerId) q = q.eq("customer_id", f.customerId);
  if (f.bikeId) q = q.eq("bike_id", f.bikeId);
  if (f.jobNumber) q = q.eq("job_number", f.jobNumber);
  const since = checkedInSince(f.checkedIn, now);
  if (since) q = q.gte("checked_in_at", since.toISOString());
  const before = checkedInBefore(f.age, now);
  if (before) q = q.lt("checked_in_at", before.toISOString());
  // D20: overdue only while open, before completion.
  if (f.age === "overdue") q = q.in("status", WORK_ORDER_STATUSES.filter(isOpenStatus));
  return q;
}

type BoardRow = {
  id: string;
  job_number: string;
  status: WorkOrderStatus;
  checked_in_at: string;
  status_changed_at: string;
  lead_mechanic_id: string | null;
  customer: NameColumns | null;
  bike: { short_id: string; brand: string; model: string; variant: string | null } | null;
};

function toBoardJob(r: BoardRow, names: Map<string, string>): BoardJob {
  return {
    id: r.id,
    jobNumber: r.job_number,
    status: r.status,
    checkedInAt: r.checked_in_at,
    statusChangedAt: r.status_changed_at,
    customerLabel: r.customer ? labelOf(r.customer) : "Customer",
    bikeTitle: r.bike ? bikeTitle(r.bike) : "Bike",
    bikeShortId: r.bike?.short_id ?? "",
    leadName: r.lead_mechanic_id ? (names.get(r.lead_mechanic_id) ?? "A former colleague") : null,
  };
}

/**
 * The workshop board for `filters` (SPEC §7.2): one query over open jobs
 * (newest BOARD_OPEN_CAP check-ins; grouped and counted here) and one over
 * closed jobs (closed in the last 30 days unless a job number is asked
 * for, newest first, `closedLimit` at a time, counted by the database).
 * No money: the board never shows a figure.
 */
export async function listWorkOrders(
  supabase: ServerSupabase,
  filters: BoardFilters,
  { staffId, now = new Date() }: { staffId: string; now?: Date },
): Promise<Board> {
  const counts = Object.fromEntries(groupBoardJobs([]).map((g) => [g.id, 0])) as Record<
    BoardGroupId,
    number
  >;
  const shown = visibleGroups(filters);
  const empty = (invalidQuery: boolean): Board => ({
    counts,
    sections: [],
    truncated: false,
    closedMore: false,
    invalidQuery,
  });
  if (filters.q && !filters.jobNumber) return empty(true);

  const wantsOpen =
    filters.statuses.length === 0 || filters.statuses.some((s) => OPEN_STATUSES.includes(s));
  const wantsClosed =
    filters.age !== "overdue" &&
    (filters.statuses.length === 0 || filters.statuses.some((s) => CLOSED_STATUSES.includes(s)));
  const showClosed = shown.includes("closed");

  const openQuery = wantsOpen
    ? selectBoardJobs(supabase, filters, staffId, now)
        .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
        .order("checked_in_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(BOARD_OPEN_CAP + 1)
    : null;
  let closedQuery = wantsClosed
    ? selectBoardJobs(supabase, filters, staffId, now, { count: true, head: !showClosed }).in(
        "status",
        CLOSED_STATUSES,
      )
    : null;
  if (closedQuery && !filters.jobNumber) {
    closedQuery = closedQuery.gte(
      "status_changed_at",
      new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString(),
    );
  }
  const [openResult, closedResult, names] = await Promise.all([
    openQuery,
    closedQuery
      ? closedQuery
          .order("status_changed_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(filters.closedLimit + 1)
      : null,
    staffNames(supabase),
  ]);

  const openRows = (openResult ? (unwrap(openResult) ?? []) : []) as BoardRow[];
  const truncated = openRows.length > BOARD_OPEN_CAP;
  // The workshop works oldest first: the longest-waiting bike tops its group.
  const open = openRows
    .slice(0, BOARD_OPEN_CAP)
    .reverse()
    .map((r) => toBoardJob(r, names));
  for (const section of groupBoardJobs(open)) counts[section.id] = section.jobs.length;

  const closedRows = (closedResult ? (unwrap(closedResult) ?? []) : []) as BoardRow[];
  counts.closed = closedResult?.count ?? 0;
  const closed = closedRows.slice(0, filters.closedLimit).map((r) => toBoardJob(r, names));

  const sections = groupBoardJobs([...open, ...closed])
    .filter((g) => shown.includes(g.id))
    .map((g) => ({ id: g.id, label: g.label, jobs: g.jobs }));
  return {
    counts,
    sections,
    truncated,
    closedMore: showClosed && closedRows.length > filters.closedLimit,
    invalidQuery: false,
  };
}

/** Names for the board's active filter chips (the customer, bike and mechanic chosen). */
export async function boardFilterLabels(
  supabase: ServerSupabase,
  f: Pick<BoardFilters, "customerId" | "bikeId" | "mechanicId">,
): Promise<{ customer: string | null; bike: string | null; mechanic: string | null }> {
  const [customer, bike, names] = await Promise.all([
    f.customerId
      ? supabase
          .from("customers")
          .select("first_name, last_name, display_name, email, phone")
          .eq("id", f.customerId)
          .maybeSingle()
      : null,
    f.bikeId
      ? supabase
          .from("bikes")
          .select("short_id, brand, model, variant")
          .eq("id", f.bikeId)
          .maybeSingle()
      : null,
    f.mechanicId ? staffNames(supabase) : null,
  ]);
  const c = customer ? unwrap(customer) : null;
  const b = bike ? unwrap(bike) : null;
  return {
    customer: c ? labelOf(c) : f.customerId ? "Unknown customer" : null,
    bike: b ? `${bikeTitle(b)} · ${b.short_id}` : f.bikeId ? "Unknown bike" : null,
    mechanic: f.mechanicId ? (names?.get(f.mechanicId) ?? "Unknown staff member") : null,
  };
}

// ---------------------------------------------------------------------------
// Service history (bike and customer pages)
// ---------------------------------------------------------------------------

/** One job in a bike's or customer's service history. */
export type HistoryJob = {
  id: string;
  jobNumber: string;
  status: WorkOrderStatus;
  checkedInAt: string;
  completedAt: string | null;
  collectedAt: string | null;
  /** The first line of the requested work. */
  summary: string;
  bikeTitle: string;
  bikeShortId: string;
  leadName: string | null;
};

const HISTORY_COLUMNS =
  "id, job_number, status, checked_in_at, completed_at, collected_at, requested_work, lead_mechanic_id, bike:bikes(short_id, brand, model, variant)";

async function listHistory(
  supabase: ServerSupabase,
  column: "bike_id" | "customer_id",
  id: string,
  limit: number,
): Promise<ListPage<HistoryJob>> {
  const [result, names] = await Promise.all([
    supabase
      .from("work_orders")
      .select(HISTORY_COLUMNS)
      .eq(column, id)
      .order("checked_in_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1),
    staffNames(supabase),
  ]);
  const rows = unwrap(result) ?? [];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      jobNumber: r.job_number,
      status: r.status,
      checkedInAt: r.checked_in_at,
      completedAt: r.completed_at,
      collectedAt: r.collected_at,
      summary: r.requested_work.split("\n")[0].trim(),
      bikeTitle: r.bike ? bikeTitle(r.bike) : "Bike",
      bikeShortId: r.bike?.short_id ?? "",
      leadName: r.lead_mechanic_id ? (names.get(r.lead_mechanic_id) ?? "A former colleague") : null,
    })),
    more: rows.length > limit,
  };
}

/** A bike's work orders, newest check-in first (whoever the customer was). */
export function listWorkOrdersForBike(
  supabase: ServerSupabase,
  bikeId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<ListPage<HistoryJob>> {
  return listHistory(supabase, "bike_id", bikeId, limit);
}

/** A customer's work orders (they are the job's customer), newest check-in first. */
export function listWorkOrdersForCustomer(
  supabase: ServerSupabase,
  customerId: string,
  { limit = 20 }: { limit?: number } = {},
): Promise<ListPage<HistoryJob>> {
  return listHistory(supabase, "customer_id", customerId, limit);
}

// ---------------------------------------------------------------------------
// People, approval, notes and details on a job (D22; SPEC §7.1, §7.2)
// ---------------------------------------------------------------------------

/**
 * Assigns a staff member as lead or additional (RPC assign_staff, D22). A
 * new lead replaces the previous one, who leaves the job. Replaying the
 * same assignment changes nothing.
 */
export async function assignStaff(
  supabase: ServerSupabase,
  input: { workOrderId: string; staffId: string; role: AssignmentRole },
): Promise<{ role: AssignmentRole }> {
  try {
    const row = unwrap(
      await supabase.rpc("assign_staff", {
        work_order_id: input.workOrderId,
        staff_id: input.staffId,
        role: input.role,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { role: row.role };
  } catch (err) {
    rethrowOnField(err, { staff_inactive: "staffId" });
  }
}

/** Takes someone off a job (RPC unassign_staff). False when they were not on it. */
export async function unassignStaff(
  supabase: ServerSupabase,
  input: { workOrderId: string; staffId: string },
): Promise<{ removed: boolean }> {
  const row = unwrap(
    await supabase.rpc("unassign_staff", {
      work_order_id: input.workOrderId,
      staff_id: input.staffId,
    }),
  );
  return { removed: Boolean(row?.id) };
}

/**
 * The internal "customer approved extra work" flag and its note (RPC
 * set_approval_flag; SPEC §7.1: no customer approval workflow). Not on a
 * collected or cancelled job.
 */
export async function setApprovalFlag(
  supabase: ServerSupabase,
  input: { workOrderId: string; flagged: boolean; note: string | null },
): Promise<{ flagged: boolean; note: string | null }> {
  try {
    const row = unwrap(
      await supabase.rpc("set_approval_flag", {
        work_order_id: input.workOrderId,
        flagged: input.flagged,
        // Null keeps the stored note; "" clears it.
        note: input.note ?? undefined,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { flagged: row.approval_flag, note: row.approval_note };
  } catch (err) {
    rethrowOnField(err, {});
  }
}

/**
 * Adds a note or a diagnosis to the job's timeline (RPC
 * add_work_order_note); any status. `noteId` is the sheet's idempotency
 * key: a retry after a lost response finds the note it already added
 * instead of writing a second, permanent one.
 */
export async function addWorkOrderNote(
  supabase: ServerSupabase,
  input: { noteId: string; workOrderId: string; kind: "note" | "diagnosis"; body: string },
): Promise<{ id: number }> {
  try {
    const row = unwrap(
      await supabase.rpc("add_work_order_note", {
        note_id: input.noteId,
        work_order_id: input.workOrderId,
        kind: input.kind,
        body: input.body,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { id: row.id };
  } catch (err) {
    rethrowOnField(err, { note_required: "body", note_too_long: "body" });
  }
}

export type WorkOrderDetailsInput = {
  workOrderId: string;
  /** Null keeps it; otherwise trimmed and not empty. */
  requestedWork: string | null;
  /** Null keeps a note, "" clears it. */
  intakeNotes: string | null;
  internalNotes: string | null;
  completionNotes: string | null;
};

/**
 * Changes the requested work and the three notes (RPC update_work_order:
 * null keeps a field, "" clears a note, the requested work cannot be
 * cleared). Callers pass only what their user changed, so a colleague's
 * newer text in another field survives. One details_changed event names
 * what changed; saving with no change records nothing.
 */
export async function updateWorkOrderDetails(
  supabase: ServerSupabase,
  input: WorkOrderDetailsInput,
): Promise<null> {
  try {
    const row = unwrap(
      await supabase.rpc("update_work_order", {
        work_order_id: input.workOrderId,
        requested_work: input.requestedWork ?? undefined,
        intake_notes: input.intakeNotes ?? undefined,
        internal_notes: input.internalNotes ?? undefined,
        completion_notes: input.completionNotes ?? undefined,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return null;
  } catch (err) {
    rethrowOnField(err, { requested_work_required: "requestedWork" });
  }
}
