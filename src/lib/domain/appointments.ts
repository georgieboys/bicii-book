import "server-only";

import {
  describeAppointmentEvent,
  type AppointmentEventDescription,
  type AppointmentEventType,
} from "@/lib/appointments/history";
import {
  openStretches,
  scheduleWarning,
  shopHoursRanges,
  windowUsage,
  type ScheduleClosure,
  type ScheduleHours,
  type ScheduleSettings,
  type WindowUsage,
} from "@/lib/appointments/slots";
import {
  isActiveStatus,
  isLate,
  statusBucket,
  type AppointmentSource,
  type AppointmentStatus,
  type ScheduleWarning,
  type StatusBucket,
} from "@/lib/appointments/status";
import { daysFrom, formatHHMM, parseHHMM, weekStart } from "@/lib/appointments/time";
import { bikeTitle } from "@/lib/bikes";
import type { Database } from "@/lib/database.types";
import { shiftShopDay, shopDayStart, shopDayToDate, shopToday } from "@/lib/dates";
import { unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import { weekdayName } from "@/lib/schedule";
import type { ServerSupabase } from "@/lib/supabase/server";
import { isOpenStatus, WORK_ORDER_STATUSES, type WorkOrderStatus } from "@/lib/workshop";

import { DomainError } from "./errors";
import { rethrowOnField } from "./lines";
import { staffDirectory } from "@/lib/domain/staff-directory";

/**
 * Appointments for staff (SPEC §6, §21; DATA-MODEL §3, §16; PLAN D2,
 * D36-D42). Staff read the tables under RLS (active staff only) and write
 * only through the Phase 2 RPCs, which check authorization, the slot rules
 * under their locks and the status machine again. The day and week views
 * and the booking sheet compute the grid with the TypeScript mirror
 * (src/lib/appointments/slots.ts) from one load of the schedule. DTOs
 * carry no money.
 */

type AppointmentEnum = Database["public"]["Enums"];

export type ScheduleTypeOption = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  capacityUnits: number;
  /** Customers may book it online (D37); staff book every active type. */
  public: boolean;
  active: boolean;
};

/** One appointment in a list (day and week views). */
export type AppointmentListItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  capacityUnits: number;
  customer: { id: string; label: string; phone: string | null };
  bike: { id: string; shortId: string; title: string } | null;
  type: { id: string; name: string };
  hasCustomerNote: boolean;
  hasInternalNote: boolean;
  /** The job it was checked in to (D40). */
  job: { id: string; jobNumber: string; status: WorkOrderStatus } | null;
  /** D38: an active booking a settings change left outside the hours or in a closure. */
  scheduleWarning: ScheduleWarning | null;
};

/** Different hours on a date (a custom_hours closure, D38). */
export type CustomHours = {
  opens: string;
  closes: string;
  reason: string;
  /** "Short day" when shorter than the usual hours, else "Different hours". */
  label: string;
};

/** How a date is open. */
export type DayHours = {
  day: string;
  /** No open time left (weekly closed, or closures cover every open hour). */
  closedAllDay: boolean;
  /** Why, for staff: a closure's reason, or "Not open on Mondays". */
  closedReason: string | null;
  customHours: CustomHours | null;
  /** The open stretches, "HH:MM"-"HH:MM" (closures taken out). */
  stretches: { opens: string; closes: string }[];
};

export type DaySchedule = DayHours & {
  settings: ScheduleSettings;
  /** Every appointment starting that shop day, in time order (cancelled ones too). */
  appointments: AppointmentListItem[];
  /** The grid windows of the open hours (or holding units) with used/capacity. */
  windows: WindowUsage[];
  /** The first open day after this one within 14 days, for a closed day's link. */
  nextOpenDay: string | null;
};

export type WeekDay = DayHours & {
  appointments: AppointmentListItem[];
  /** D41: non-cancelled appointments starting that day. */
  scheduled: number;
  counts: Record<StatusBucket, number>;
};

export type WeekSchedule = { from: string; days: WeekDay[] };

/** The raw inputs of the TypeScript slot mirror over a range of days (the booking sheet). */
export type ScheduleData = {
  from: string;
  days: number;
  /** The server's clock when loaded (ISO). */
  asOf: string;
  settings: ScheduleSettings;
  hours: ScheduleHours[];
  closures: (ScheduleClosure & { id: string; reason: string })[];
  appointments: {
    id: string;
    startsAt: string;
    endsAt: string;
    capacityUnits: number;
    status: AppointmentStatus;
  }[];
  /** Active types, staff-only ones included (staff may book them, D37). */
  types: ScheduleTypeOption[];
};

export type AppointmentHistoryEntry = AppointmentEventDescription & {
  id: number;
  type: AppointmentEventType;
  at: string;
};

export type AppointmentDetail = AppointmentListItem & {
  customer: AppointmentListItem["customer"] & { email: string | null; archived: boolean };
  customerNote: string | null;
  internalNote: string | null;
  cancellationReason: string | null;
  cancelledVia: AppointmentSource | null;
  stamps: {
    createdAt: string;
    confirmedAt: string | null;
    arrivedAt: string | null;
    checkedInAt: string | null;
    completedAt: string | null;
    noShowAt: string | null;
    cancelledAt: string | null;
  };
  /** Newest first. */
  history: AppointmentHistoryEntry[];
};

const NOT_FOUND = "That appointment no longer exists. Refresh and try again.";

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

/** The instant a shop day starts (Singapore midnight; D35). */
const dayStart = (day: string): Date => shopDayStart(shopDayToDate(day));

// ---------------------------------------------------------------------------
// Schedule configuration (every active staff member reads it)
// ---------------------------------------------------------------------------

type ScheduleConfig = {
  settings: ScheduleSettings;
  hours: ScheduleHours[];
  closures: (ScheduleClosure & { id: string; reason: string })[];
};

async function loadConfig(supabase: ServerSupabase, from: Date, to: Date): Promise<ScheduleConfig> {
  const [settingsResult, hoursResult, closuresResult] = await Promise.all([
    supabase
      .from("shop_settings")
      .select(
        "timezone, intake_slot_minutes, intake_capacity_units, booking_min_notice_minutes, booking_horizon_days",
      )
      .eq("id", 1)
      .maybeSingle(),
    supabase.from("shop_hours").select("weekday, opens_at, closes_at, active").order("opens_at"),
    supabase
      .from("closure_overrides")
      .select("id, kind, starts_at, ends_at, opens_at, closes_at, reason")
      .lt("starts_at", to.toISOString())
      .gt("ends_at", from.toISOString())
      .order("starts_at"),
  ]);
  const s = unwrap(settingsResult);
  if (!s) throw new DomainError("The shop's settings are missing. Ask an admin to check Settings.");
  return {
    settings: {
      timezone: s.timezone,
      slotMinutes: s.intake_slot_minutes,
      capacityUnits: s.intake_capacity_units,
      minNoticeMinutes: s.booking_min_notice_minutes,
      horizonDays: s.booking_horizon_days,
    },
    hours: (unwrap(hoursResult) ?? []).map((h) => ({
      weekday: h.weekday,
      opens: h.opens_at,
      closes: h.closes_at,
      active: h.active,
    })),
    closures: (unwrap(closuresResult) ?? []).map((c) => ({
      id: c.id,
      kind: c.kind,
      startsAt: c.starts_at,
      endsAt: c.ends_at,
      opens: c.opens_at,
      closes: c.closes_at,
      reason: c.reason,
    })),
  };
}

const hhmm = (t: string) => formatHHMM(parseHHMM(t));

const wall = (instantMs: number, day: string): string => {
  const start = dayStart(day).getTime();
  return formatHHMM(Math.round((instantMs - start) / 60_000));
};

function dayHours(day: string, config: ScheduleConfig): DayHours {
  const stretches = openStretches(day, config);
  const dayStartMs = dayStart(day).getTime();
  const custom = config.closures
    .filter(
      (c) =>
        c.kind === "custom_hours" &&
        Date.parse(String(c.startsAt)) <= dayStartMs &&
        dayStartMs < Date.parse(String(c.endsAt)),
    )
    .sort((a, b) => Date.parse(String(a.startsAt)) - Date.parse(String(b.startsAt)))[0];
  let customHours: CustomHours | null = null;
  if (custom?.opens && custom.closes) {
    const weekly = shopHoursRanges(day, { hours: config.hours, closures: [] });
    const usual = weekly.reduce((n, r) => n + (r.end - r.start), 0);
    const special = (parseHHMM(custom.closes) - parseHHMM(custom.opens)) * 60_000;
    customHours = {
      opens: hhmm(custom.opens),
      closes: hhmm(custom.closes),
      reason: custom.reason,
      label: usual > 0 && special < usual ? "Short day" : "Different hours",
    };
  }
  const closedAllDay = stretches.length === 0;
  let closedReason: string | null = null;
  if (closedAllDay) {
    const dayEnd = dayStart(shiftShopDay(day, 1)).getTime();
    const closure = config.closures.find(
      (c) =>
        c.kind === "closed" &&
        Date.parse(String(c.startsAt)) < dayEnd &&
        dayStartMs < Date.parse(String(c.endsAt)),
    );
    const open = shopHoursRanges(day, config);
    closedReason =
      open.length > 0 && closure
        ? closure.reason
        : customHours
          ? customHours.reason
          : `Not open on ${weekdayName(shopDayToDate(day).getUTCDay())}s`;
  }
  return {
    day,
    closedAllDay,
    closedReason,
    customHours,
    stretches: stretches.map((s) => ({
      opens: wall(s.start, day),
      closes: wall(s.end, day),
    })),
  };
}

// ---------------------------------------------------------------------------
// Appointment lists
// ---------------------------------------------------------------------------

const LIST_COLUMNS =
  "id, starts_at, ends_at, status, source, capacity_units, customer_note, internal_note, customer:customers(id, first_name, last_name, display_name, email, phone), bike:bikes(id, short_id, brand, model, variant), type:appointment_types(id, name), work_orders(id, job_number, status)";

type ListRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  capacity_units: number;
  customer_note: string | null;
  internal_note: string | null;
  customer: (NameColumns & { id: string }) | null;
  bike: {
    id: string;
    short_id: string;
    brand: string;
    model: string;
    variant: string | null;
  } | null;
  type: { id: string; name: string } | null;
  work_orders: { id: string; job_number: string; status: WorkOrderStatus }[];
};

/**
 * One list row as a DTO; `config` (the schedule around it) adds the D38
 * warning, null leaves it out (the customer page lists without one).
 */
function toListItem(r: ListRow, config: ScheduleConfig | null): AppointmentListItem | null {
  if (!r.customer || !r.type) return null;
  const job = r.work_orders[0] ?? null;
  return {
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    source: r.source,
    capacityUnits: r.capacity_units,
    customer: { id: r.customer.id, label: labelOf(r.customer), phone: r.customer.phone },
    bike: r.bike ? { id: r.bike.id, shortId: r.bike.short_id, title: bikeTitle(r.bike) } : null,
    type: { id: r.type.id, name: r.type.name },
    hasCustomerNote: Boolean(r.customer_note),
    hasInternalNote: Boolean(r.internal_note),
    job: job ? { id: job.id, jobNumber: job.job_number, status: job.status } : null,
    scheduleWarning:
      config && isActiveStatus(r.status)
        ? scheduleWarning({ startsAt: r.starts_at, endsAt: r.ends_at }, config)
        : null,
  };
}

async function listBetween(
  supabase: ServerSupabase,
  from: Date,
  to: Date,
  config: ScheduleConfig,
): Promise<AppointmentListItem[]> {
  const rows =
    unwrap(
      await supabase
        .from("appointments")
        .select(LIST_COLUMNS)
        .gte("starts_at", from.toISOString())
        .lt("starts_at", to.toISOString())
        .order("starts_at")
        .order("created_at")
        .limit(1000),
    ) ?? [];
  return rows.flatMap((r) => toListItem(r, config) ?? []);
}

/**
 * One shop day for the day view: its hours (closed, custom hours, open
 * stretches), every appointment starting that day in time order with its
 * D38 warning, the capacity windows and, for a closed day, the next open
 * day within 14 days.
 */
export async function listDay(
  supabase: ServerSupabase,
  day: string = shopToday(),
): Promise<DaySchedule> {
  const from = dayStart(day);
  const to = dayStart(shiftShopDay(day, 1));
  // Closures far enough ahead to find the next open day.
  const config = await loadConfig(supabase, from, dayStart(shiftShopDay(day, 15)));
  const appointments = await listBetween(supabase, from, to, config);
  const hours = dayHours(day, config);
  let nextOpenDay: string | null = null;
  if (hours.closedAllDay) {
    nextOpenDay =
      daysFrom(shiftShopDay(day, 1), 14).find((d) => openStretches(d, config).length > 0) ?? null;
  }
  return {
    ...hours,
    settings: config.settings,
    appointments,
    windows: windowUsage(day, { ...config, appointments }),
    nextOpenDay,
  };
}

/**
 * The Monday-to-Sunday week around `day` for the week strip and the week
 * view: each day's hours, appointments and counts by status bucket.
 */
export async function listWeek(
  supabase: ServerSupabase,
  day: string = shopToday(),
): Promise<WeekSchedule> {
  const first = weekStart(day);
  const from = dayStart(first);
  const to = dayStart(shiftShopDay(first, 7));
  const config = await loadConfig(supabase, from, to);
  const appointments = await listBetween(supabase, from, to, config);
  const byDay = new Map<string, AppointmentListItem[]>();
  for (const a of appointments) {
    const key = shopToday(a.startsAt);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }
  return {
    from: first,
    days: daysFrom(first, 7).map((d) => {
      const list = byDay.get(d) ?? [];
      const counts: Record<StatusBucket, number> = {
        expected: 0,
        here: 0,
        done: 0,
        missed: 0,
        cancelled: 0,
      };
      for (const a of list) counts[statusBucket(a.status)] += 1;
      return {
        ...dayHours(d, config),
        appointments: list,
        scheduled: list.length - counts.cancelled,
        counts,
      };
    }),
  };
}

/** One expected arrival on Today's list. */
export type ExpectedArrival = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: Extract<AppointmentStatus, "booked" | "confirmed">;
  customerLabel: string;
  typeName: string;
  /** More than LATE_AFTER_MINUTES past its start, not arrived yet. */
  late: boolean;
};

export type TodayAppointmentSummary = {
  day: string;
  /** D41: not cancelled. */
  booked: number;
  /** Still booked or confirmed: not arrived yet. */
  expected: number;
  /** Arrived, checked in or completed. */
  arrived: number;
  noShows: number;
  /** Up to TODAY_ARRIVALS_ROWS expected arrivals: late ones first, then by start. */
  arrivals: ExpectedArrival[];
};

/** Expected arrivals Today lists; the rest are one tap away on the day view. */
export const TODAY_ARRIVALS_ROWS = 5;

/**
 * Today's appointment figures for `day`, the shop day today_dashboard
 * returned (never the app's own clock; D35): the counts from
 * public.appointment_daily (D41: by scheduled day and current status;
 * operational, every active staff member, D30) and the first
 * TODAY_ARRIVALS_ROWS still-expected (booked or confirmed) arrivals that
 * day, late ones first, then by start time.
 */
export async function todaySummary(
  supabase: ServerSupabase,
  day: string,
): Promise<TodayAppointmentSummary> {
  const [countsResult, rowsResult] = await Promise.all([
    supabase.rpc("appointment_daily", { from_day: day, to_day: day }),
    supabase
      .from("appointments")
      .select(
        "id, starts_at, ends_at, status, customer:customers(first_name, last_name, display_name, email, phone), type:appointment_types(name)",
      )
      .gte("starts_at", dayStart(day).toISOString())
      .lt("starts_at", dayStart(shiftShopDay(day, 1)).toISOString())
      .in("status", ["booked", "confirmed"])
      .order("starts_at")
      .order("created_at")
      .limit(TODAY_ARRIVALS_ROWS),
  ]);
  const counts = (unwrap(countsResult) ?? [])[0];
  const now = new Date();
  const arrivals = (unwrap(rowsResult) ?? [])
    .flatMap((r): ExpectedArrival[] =>
      r.customer && r.type && (r.status === "booked" || r.status === "confirmed")
        ? [
            {
              id: r.id,
              startsAt: r.starts_at,
              endsAt: r.ends_at,
              status: r.status,
              customerLabel: labelOf(r.customer),
              typeName: r.type.name,
              late: isLate({ status: r.status, startsAt: r.starts_at }, now),
            },
          ]
        : [],
    )
    // Late first, then by start (already the query's order; stable sort).
    .sort((a, b) => Number(b.late) - Number(a.late));
  return {
    day,
    booked: counts?.booked ?? 0,
    expected: counts?.expected ?? 0,
    arrived: counts?.arrived ?? 0,
    noShows: counts?.no_shows ?? 0,
    arrivals,
  };
}

/** How many past appointments the customer page lists under the upcoming ones. */
export const CUSTOMER_PAST_APPOINTMENTS = 5;

export type CustomerAppointments = {
  /** From today's shop day on, soonest first (cancelled ones too, labelled). */
  upcoming: AppointmentListItem[];
  /** Before today, newest first, at most CUSTOMER_PAST_APPOINTMENTS. */
  past: AppointmentListItem[];
};

/**
 * A customer's appointments for their page: today's and later ones first
 * (soonest first), then the last CUSTOMER_PAST_APPOINTMENTS before today.
 */
export async function customerAppointments(
  supabase: ServerSupabase,
  customerId: string,
): Promise<CustomerAppointments> {
  const todayStart = dayStart(shopToday()).toISOString();
  const [upcomingResult, pastResult] = await Promise.all([
    supabase
      .from("appointments")
      .select(LIST_COLUMNS)
      .eq("customer_id", customerId)
      .gte("starts_at", todayStart)
      .order("starts_at")
      .order("created_at")
      .limit(50),
    supabase
      .from("appointments")
      .select(LIST_COLUMNS)
      .eq("customer_id", customerId)
      .lt("starts_at", todayStart)
      .order("starts_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(CUSTOMER_PAST_APPOINTMENTS),
  ]);
  return {
    upcoming: (unwrap(upcomingResult) ?? []).flatMap((r) => toListItem(r, null) ?? []),
    past: (unwrap(pastResult) ?? []).flatMap((r) => toListItem(r, null) ?? []),
  };
}

/**
 * Everything the TypeScript slot mirror needs over `days` days from
 * `from` (1..14), in one set of queries: settings, weekly hours, the
 * closures overlapping the range, the range's appointments that hold
 * capacity, and the active types (staff view: staff-only types too).
 */
export async function loadSchedule(
  supabase: ServerSupabase,
  { from, days }: { from: string; days: number },
): Promise<ScheduleData> {
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    throw new DomainError("Load between 1 and 14 days at a time.");
  }
  const start = dayStart(from);
  const end = dayStart(shiftShopDay(from, days));
  const [config, appointmentsResult, typesResult] = await Promise.all([
    loadConfig(supabase, start, end),
    supabase
      .from("appointments")
      .select("id, starts_at, ends_at, capacity_units, status")
      .lt("starts_at", end.toISOString())
      .gt("ends_at", start.toISOString())
      .not("status", "in", "(cancelled,no_show)")
      .limit(5000),
    supabase
      .from("appointment_types")
      .select("id, name, description, duration_minutes, capacity_units, public, active, sort_order")
      .eq("active", true)
      .order("sort_order")
      .order("name"),
  ]);
  return {
    from,
    days,
    asOf: new Date().toISOString(),
    ...config,
    appointments: (unwrap(appointmentsResult) ?? []).map((a) => ({
      id: a.id,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      capacityUnits: a.capacity_units,
      status: a.status,
    })),
    types: (unwrap(typesResult) ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      durationMinutes: t.duration_minutes,
      capacityUnits: t.capacity_units,
      public: t.public,
      active: t.active,
    })),
  };
}

// ---------------------------------------------------------------------------
// One appointment
// ---------------------------------------------------------------------------

/** One appointment with its history (newest first, actors named) and its job; null when unknown. */
export async function getAppointment(
  supabase: ServerSupabase,
  id: string,
): Promise<AppointmentDetail | null> {
  const [rowResult, eventsResult, staffResult] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, starts_at, ends_at, status, source, capacity_units, customer_note, internal_note, cancellation_reason, cancelled_via, created_at, confirmed_at, arrived_at, checked_in_at, completed_at, no_show_at, cancelled_at, customer:customers(id, first_name, last_name, display_name, email, phone, archived_at), bike:bikes(id, short_id, brand, model, variant), type:appointment_types(id, name), work_orders(id, job_number, status)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("appointment_events")
      .select("id, event_type, from_status, reason, payload, actor_staff_id, created_at")
      .eq("appointment_id", id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(200),
    staffDirectory(supabase),
  ]);
  const r = unwrap(rowResult);
  if (!r || !r.customer || !r.type) return null;
  const names = new Map((unwrap(staffResult) ?? []).map((s) => [s.id, s.display_name]));
  const startsDay = shopToday(r.starts_at);
  const config = await loadConfig(
    supabase,
    dayStart(startsDay),
    dayStart(shiftShopDay(startsDay, 1)),
  );
  const job = r.work_orders[0] ?? null;
  return {
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    source: r.source,
    capacityUnits: r.capacity_units,
    customer: {
      id: r.customer.id,
      label: labelOf(r.customer),
      phone: r.customer.phone,
      email: r.customer.email,
      archived: r.customer.archived_at !== null,
    },
    bike: r.bike ? { id: r.bike.id, shortId: r.bike.short_id, title: bikeTitle(r.bike) } : null,
    type: { id: r.type.id, name: r.type.name },
    hasCustomerNote: Boolean(r.customer_note),
    hasInternalNote: Boolean(r.internal_note),
    job: job ? { id: job.id, jobNumber: job.job_number, status: job.status } : null,
    scheduleWarning: isActiveStatus(r.status)
      ? scheduleWarning({ startsAt: r.starts_at, endsAt: r.ends_at }, config)
      : null,
    customerNote: r.customer_note,
    internalNote: r.internal_note,
    cancellationReason: r.cancellation_reason,
    cancelledVia: r.cancelled_via,
    stamps: {
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
      arrivedAt: r.arrived_at,
      checkedInAt: r.checked_in_at,
      completedAt: r.completed_at,
      noShowAt: r.no_show_at,
      cancelledAt: r.cancelled_at,
    },
    history: (unwrap(eventsResult) ?? []).map((e) => ({
      id: e.id,
      type: e.event_type,
      at: e.created_at,
      ...describeAppointmentEvent(
        {
          type: e.event_type,
          fromStatus: e.from_status,
          payload: e.payload,
          actorName: e.actor_staff_id
            ? (names.get(e.actor_staff_id) ?? "a former colleague")
            : null,
        },
        e.reason,
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes (RPCs)
// ---------------------------------------------------------------------------

export type BookAppointmentInput = {
  /** Made when the sheet opens: the booking's idempotency key. */
  id: string;
  customerId: string;
  appointmentTypeId: string;
  startsAt: string;
  bikeId: string | null;
  customerNote: string | null;
  internalNote: string | null;
};

const BOOK_FIELDS = {
  customer_archived: "customerId",
  appointment_type_unavailable: "appointmentTypeId",
  appointment_bike_not_owned: "bikeId",
  appointment_bike_archived: "bikeId",
  appointments_customer_note_check: "customerNote",
  appointments_internal_note_check: "internalNote",
};

/**
 * Books for a customer (RPC book_appointment; D37: staff are exempt from
 * notice, horizon, the online limit and the public flag, never from hours,
 * closures or capacity). The id is the idempotency key: a replay returns
 * the booking already made, which counts as success. Slot refusals
 * (appointment_capacity_exceeded and the others) keep their code, so the
 * sheet can reload the times.
 */
export async function bookAppointment(
  supabase: ServerSupabase,
  input: BookAppointmentInput,
): Promise<{ id: string; startsAt: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("book_appointment", {
        appointment_id: input.id,
        customer_id: input.customerId,
        appointment_type_id: input.appointmentTypeId,
        starts_at: input.startsAt,
        bike_id: input.bikeId ?? undefined,
        customer_note: input.customerNote ?? undefined,
        internal_note: input.internalNote ?? undefined,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { id: row.id, startsAt: row.starts_at };
  } catch (err) {
    rethrowOnField(err, BOOK_FIELDS);
  }
}

/** Marks confirmed, arrived (a no-show reinstated on its own day, D39) or no-show. */
export async function markStatus(
  supabase: ServerSupabase,
  input: {
    appointmentId: string;
    status: Extract<AppointmentEnum["appointment_status"], "confirmed" | "arrived" | "no_show">;
    reason: string | null;
  },
): Promise<{ status: AppointmentStatus }> {
  const row = unwrap(
    await supabase.rpc("mark_appointment_status", {
      appointment_id: input.appointmentId,
      status: input.status,
      reason: input.reason ?? undefined,
    }),
  );
  if (!row) throw new DomainError(NOT_FOUND);
  return { status: row.status };
}

/** Cancels with a reason, at any time (D37: no cutoff for staff; cancelled_via staff). */
export async function cancel(
  supabase: ServerSupabase,
  input: { appointmentId: string; reason: string },
): Promise<{ status: AppointmentStatus }> {
  try {
    const row = unwrap(
      await supabase.rpc("cancel_appointment", {
        appointment_id: input.appointmentId,
        reason: input.reason,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { status: row.status };
  } catch (err) {
    rethrowOnField(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

/**
 * Changes the bike (before check-in) and notes. Only what is given is
 * sent: null keeps, "" clears a note, clearBike removes the bike.
 */
export async function update(
  supabase: ServerSupabase,
  input: {
    appointmentId: string;
    bikeId?: string | null;
    clearBike?: boolean;
    customerNote?: string | null;
    internalNote?: string | null;
  },
): Promise<{ id: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("update_appointment", {
        appointment_id: input.appointmentId,
        bike_id: input.bikeId ?? undefined,
        clear_bike: input.clearBike ?? false,
        customer_note: input.customerNote ?? undefined,
        internal_note: input.internalNote ?? undefined,
      }),
    );
    if (!row) throw new DomainError(NOT_FOUND);
    return { id: row.id };
  } catch (err) {
    rethrowOnField(err, {
      appointment_bike_not_owned: "bikeId",
      appointment_bike_archived: "bikeId",
      appointments_customer_note_check: "customerNote",
      appointments_internal_note_check: "internalNote",
    });
  }
}

export type CheckInInput = {
  appointmentId: string;
  bikeId: string;
  /** The idempotency key of the new job, or the existing job to link. */
  workOrderId: string;
  linkExisting: boolean;
  requestedWork: string | null;
  intakeNotes: string | null;
  leadMechanicId: string | null;
};

export type CheckInResult = {
  appointmentId: string;
  status: AppointmentStatus;
  workOrderId: string;
  jobNumber: string;
  /** This call opened the job (false: linked an existing one, or a replay). */
  created: boolean;
};

/**
 * Checks the appointment in with the customer's own bike (RPC
 * check_in_appointment, D40): a new job through Phase 3's path, or a link
 * to one open, unlinked job of the same customer and bike. A replay returns
 * the existing link.
 */
export async function checkIn(
  supabase: ServerSupabase,
  input: CheckInInput,
): Promise<CheckInResult> {
  try {
    const row = unwrap(
      await supabase.rpc("check_in_appointment", {
        appointment_id: input.appointmentId,
        bike_id: input.bikeId,
        work_order_id: input.workOrderId,
        link_existing: input.linkExisting,
        requested_work: input.requestedWork ?? undefined,
        intake_notes: input.intakeNotes ?? undefined,
        lead_mechanic_id: input.leadMechanicId ?? undefined,
      }),
    );
    if (!row || !row.work_order_id || !row.job_number || !row.appointment_status) {
      throw new DomainError(NOT_FOUND);
    }
    return {
      appointmentId: row.appointment_id ?? input.appointmentId,
      status: row.appointment_status,
      workOrderId: row.work_order_id,
      jobNumber: row.job_number,
      created: Boolean(row.created),
    };
  } catch (err) {
    rethrowOnField(err, {
      appointment_bike_not_owned: "bikeId",
      appointment_bike_archived: "bikeId",
      bike_owner_mismatch: "bikeId",
      requested_work_required: "requestedWork",
      staff_inactive: "leadMechanicId",
      appointment_work_order_mismatch: "workOrderId",
    });
  }
}

export type LinkableJob = {
  id: string;
  jobNumber: string;
  bikeId: string;
  status: WorkOrderStatus;
  checkedInAt: string;
  requestedWork: string;
};

const OPEN_JOB_STATUSES = WORK_ORDER_STATUSES.filter(isOpenStatus);

/**
 * Work orders check-in may link (D40): open (before completed), of this
 * customer (and bike, when given), with no appointment yet. Newest first.
 */
export async function openUnlinkedJobs(
  supabase: ServerSupabase,
  customerId: string,
  bikeId?: string | null,
): Promise<LinkableJob[]> {
  let query = supabase
    .from("work_orders")
    .select("id, job_number, bike_id, status, checked_in_at, requested_work")
    .eq("customer_id", customerId)
    .is("appointment_id", null)
    // D40: "open" is exactly P3's open (src/lib/workshop.ts isOpenStatus).
    .in("status", OPEN_JOB_STATUSES)
    .order("checked_in_at", { ascending: false })
    .limit(50);
  if (bikeId) query = query.eq("bike_id", bikeId);
  const rows = unwrap(await query) ?? [];
  return rows.map((r) => ({
    id: r.id,
    jobNumber: r.job_number,
    bikeId: r.bike_id,
    status: r.status,
    checkedInAt: r.checked_in_at,
    requestedWork: r.requested_work,
  }));
}
