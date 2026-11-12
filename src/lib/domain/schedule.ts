import "server-only";

import {
  appointmentWindows,
  scheduleWarning,
  unitsUsed,
  type ScheduleClosure,
  type ScheduleHours,
  type ScheduleSettings,
} from "@/lib/appointments/slots";
import { isActiveStatus, type AppointmentStatus } from "@/lib/appointments/status";
import { formatHHMM, localDay, parseHHMM, zonedInstant } from "@/lib/appointments/time";
import { shiftShopDay, shopToday } from "@/lib/dates";
import { mapDbError, unwrap } from "@/lib/db-errors";
import type {
  AppointmentTypeInput,
  ClosureInput,
  HoursInterval,
  BookingAlertsInput,
  ShopHoursInput,
  ShopSettingsInput,
} from "@/lib/schedule";
import { WEEKDAYS } from "@/lib/schedule";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";

/**
 * The shop's schedule configuration (SPEC §6; DATA-MODEL §3, §15; PLAN D2,
 * D35, D37, D38): settings, weekly hours, closures and appointment types.
 * Every active staff member reads them (RLS select); only admins change
 * them, and only through the admin RPCs (update_shop_settings,
 * set_shop_hours, save_closure_override, delete_closure_override,
 * save_appointment_type), which check the role and the rules again. A
 * change never moves, shrinks or cancels an existing appointment (D38:
 * appointments keep their own ends_at and units), so this module also
 * finds the upcoming ones a change left outside the hours, in a closure or
 * over capacity, for the screens to flag. No money.
 */

export type ShopSettings = ScheduleSettings & {
  currency: string;
  maxActiveBookings: number;
  cancelCutoffMinutes: number;
  /** Informational in Phase 2 (D9: Phase 8 decides the QR base). */
  publicSiteUrl: string | null;
  /** D163b: staff members who get booking alerts (active ones are sent to). */
  bookingAlertStaffIds: string[];
  /** D163b: other addresses that get booking alerts. */
  bookingAlertEmails: string[];
};

export type WeekdayHours = {
  weekday: number;
  name: string;
  /** Open that day (the stored rows' active flag). */
  active: boolean;
  /** "HH:MM", ordered; kept while the day is switched off. */
  intervals: HoursInterval[];
};

export type ClosureKind = "closed" | "custom_hours";

export type ClosureItem = {
  id: string;
  kind: ClosureKind;
  /** Shop-local days, "YYYY-MM-DD" (inclusive). */
  firstDay: string;
  lastDay: string;
  /** Closed part of a day, or a short day's hours; null for a whole closed day. */
  fromTime: string | null;
  toTime: string | null;
  reason: string;
  /** Booked, confirmed or arrived appointments it blocks (closed) or leaves outside its hours (short day). */
  affectedAppointments: number;
  /** The first day such an appointment is on, for the link to the day view. */
  firstAffectedDay: string | null;
};

export type ClosureList = {
  /** Current and upcoming, soonest first. */
  upcoming: ClosureItem[];
  /** Ended before `from`, latest first, at most PAST_CLOSURES. */
  past: ClosureItem[];
};

export type AppointmentTypeItem = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  capacityUnits: number;
  /** Customers can book it online (D37). */
  public: boolean;
  active: boolean;
  sortOrder: number;
};

export type AffectedAppointment = {
  id: string;
  startsAt: string;
  status: AppointmentStatus;
  problem: "outside_hours" | "closed" | "over_capacity";
};

export type AffectedSummary = {
  total: number;
  /** By shop day, soonest first. */
  days: { day: string; appointments: AffectedAppointment[] }[];
};

/** Past closures the settings screen keeps under "Past". */
export const PAST_CLOSURES = 10;

const hhmm = (t: string) => formatHHMM(parseHHMM(t));

const dayStartIso = (day: string, tz: string) => zonedInstant(day, 0, tz).toISOString();

// ---------------------------------------------------------------------------
// Reads (every active staff member)
// ---------------------------------------------------------------------------

export async function getShopSettings(supabase: ServerSupabase): Promise<ShopSettings> {
  const s = unwrap(
    await supabase
      .from("shop_settings")
      .select(
        "timezone, default_currency, intake_slot_minutes, intake_capacity_units, booking_min_notice_minutes, booking_horizon_days, customer_max_active_bookings, customer_cancel_cutoff_minutes, public_site_url, booking_alert_staff_ids, booking_alert_emails",
      )
      .eq("id", 1)
      .maybeSingle(),
  );
  if (!s) throw new DomainError("The shop's settings are missing. Ask an admin to check Settings.");
  return {
    timezone: s.timezone,
    currency: s.default_currency,
    slotMinutes: s.intake_slot_minutes,
    capacityUnits: s.intake_capacity_units,
    minNoticeMinutes: s.booking_min_notice_minutes,
    horizonDays: s.booking_horizon_days,
    maxActiveBookings: s.customer_max_active_bookings,
    cancelCutoffMinutes: s.customer_cancel_cutoff_minutes,
    publicSiteUrl: s.public_site_url,
    bookingAlertStaffIds: s.booking_alert_staff_ids ?? [],
    bookingAlertEmails: s.booking_alert_emails ?? [],
  };
}

async function hoursRows(supabase: ServerSupabase): Promise<ScheduleHours[]> {
  const rows =
    unwrap(
      await supabase
        .from("shop_hours")
        .select("weekday, opens_at, closes_at, active")
        .order("opens_at"),
    ) ?? [];
  return rows.map((h) => ({
    weekday: h.weekday,
    opens: h.opens_at,
    closes: h.closes_at,
    active: h.active,
  }));
}

/** The seven weekdays, Monday first, each with its intervals and whether the shop opens. */
export async function getWeeklyHours(supabase: ServerSupabase): Promise<WeekdayHours[]> {
  const rows = await hoursRows(supabase);
  return WEEKDAYS.map(({ weekday, name }) => {
    const mine = rows.filter((r) => r.weekday === weekday);
    return {
      weekday,
      name,
      active: mine.some((r) => r.active),
      intervals: mine.map((r) => ({ opens: hhmm(r.opens), closes: hhmm(r.closes) })),
    };
  });
}

type ClosureRow = {
  id: string;
  kind: ClosureKind;
  starts_at: string;
  ends_at: string;
  opens_at: string | null;
  closes_at: string | null;
  reason: string;
};

type HoldingRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  capacity_units: number;
  status: AppointmentStatus;
};

/** Appointments overlapping [from, to) that hold capacity (not cancelled, not no-show). */
async function holdingBetween(
  supabase: ServerSupabase,
  from: string,
  to: string | null,
): Promise<HoldingRow[]> {
  let query = supabase
    .from("appointments")
    .select("id, starts_at, ends_at, capacity_units, status")
    .gt("ends_at", from)
    .not("status", "in", "(cancelled,no_show)")
    .order("starts_at")
    .limit(5000);
  if (to) query = query.lt("starts_at", to);
  return unwrap(await query) ?? [];
}

/**
 * Whether an active appointment is hit by one closure: a closed range
 * overlapping it, or a short day's hours on its date that it does not fit
 * inside (custom hours replace the weekly hours on every date they cover,
 * D38).
 */
function hitByClosure(a: HoldingRow, c: ClosureRow, tz: string): boolean {
  const start = Date.parse(a.starts_at);
  const end = Date.parse(a.ends_at);
  const cStart = Date.parse(c.starts_at);
  const cEnd = Date.parse(c.ends_at);
  if (c.kind === "closed") return start < cEnd && cStart < end;
  if (!(cStart <= start && start < cEnd) || !c.opens_at || !c.closes_at) return false;
  const day = localDay(new Date(start), tz);
  const opens = zonedInstant(day, parseHHMM(c.opens_at), tz).getTime();
  const closes = zonedInstant(day, parseHHMM(c.closes_at), tz).getTime();
  return !(opens <= start && end <= closes);
}

function toClosureItem(
  c: ClosureRow,
  appointments: readonly HoldingRow[],
  tz: string,
): ClosureItem {
  const startsAt = new Date(c.starts_at);
  const endsAt = new Date(c.ends_at);
  const firstDay = localDay(startsAt, tz);
  const lastDay = localDay(new Date(endsAt.getTime() - 1), tz);
  const wholeDays =
    zonedInstant(firstDay, 0, tz).getTime() === startsAt.getTime() &&
    zonedInstant(shiftShopDay(lastDay, 1), 0, tz).getTime() === endsAt.getTime();
  const hit = appointments.filter((a) => isActiveStatus(a.status) && hitByClosure(a, c, tz));
  const local = (d: Date) => {
    const day = localDay(d, tz);
    return formatHHMM(Math.round((d.getTime() - zonedInstant(day, 0, tz).getTime()) / 60_000));
  };
  return {
    id: c.id,
    kind: c.kind,
    firstDay,
    lastDay,
    fromTime:
      c.kind === "custom_hours"
        ? c.opens_at && hhmm(c.opens_at)
        : wholeDays
          ? null
          : local(startsAt),
    toTime:
      c.kind === "custom_hours"
        ? c.closes_at && hhmm(c.closes_at)
        : wholeDays
          ? null
          : // A part-day closure ends on its own day; 24:00 when it runs to midnight.
            localDay(endsAt, tz) === firstDay
            ? local(endsAt)
            : "24:00",
    reason: c.reason,
    affectedAppointments: hit.length,
    firstAffectedDay: hit.length > 0 ? localDay(new Date(hit[0].starts_at), tz) : null,
  };
}

const CLOSURE_COLUMNS = "id, kind, starts_at, ends_at, opens_at, closes_at, reason";

/**
 * Closures for the settings screen: the current and upcoming ones (ending
 * after the start of `from`, the shop's today by default), soonest first,
 * each with the booked, confirmed or arrived appointments it affects; then
 * the last PAST_CLOSURES that ended before `from`, latest first.
 */
export async function listClosures(
  supabase: ServerSupabase,
  { from = shopToday() }: { from?: string } = {},
): Promise<ClosureList> {
  const settings = await getShopSettings(supabase);
  const tz = settings.timezone;
  const fromIso = dayStartIso(from, tz);
  const [upcomingResult, pastResult] = await Promise.all([
    supabase
      .from("closure_overrides")
      .select(CLOSURE_COLUMNS)
      .gt("ends_at", fromIso)
      .order("starts_at")
      .limit(200),
    supabase
      .from("closure_overrides")
      .select(CLOSURE_COLUMNS)
      .lte("ends_at", fromIso)
      .order("ends_at", { ascending: false })
      .limit(PAST_CLOSURES),
  ]);
  const upcoming = unwrap(upcomingResult) ?? [];
  const past = unwrap(pastResult) ?? [];
  const lastEnd = upcoming.reduce<string | null>(
    (max, c) => (max === null || c.ends_at > max ? c.ends_at : max),
    null,
  );
  const appointments = lastEnd ? await holdingBetween(supabase, fromIso, lastEnd) : [];
  return {
    upcoming: upcoming.map((c) => toClosureItem(c, appointments, tz)),
    past: past.map((c) => toClosureItem(c, [], tz)),
  };
}

/** One closure with the appointments it affects now; null when it does not exist (deleted). */
export async function getClosure(
  supabase: ServerSupabase,
  id: string,
): Promise<ClosureItem | null> {
  const [settings, rowResult] = await Promise.all([
    getShopSettings(supabase),
    supabase.from("closure_overrides").select(CLOSURE_COLUMNS).eq("id", id).maybeSingle(),
  ]);
  const row = unwrap(rowResult);
  if (!row) return null;
  const appointments = await holdingBetween(supabase, row.starts_at, row.ends_at);
  return toClosureItem(row, appointments, settings.timezone);
}

/** Every type (inactive ones last when included), by sort order, then name. */
export async function listAppointmentTypes(
  supabase: ServerSupabase,
  { includeInactive = false }: { includeInactive?: boolean } = {},
): Promise<AppointmentTypeItem[]> {
  let query = supabase
    .from("appointment_types")
    .select("id, name, description, duration_minutes, capacity_units, public, active, sort_order")
    .order("active", { ascending: false })
    .order("sort_order")
    .order("name");
  if (!includeInactive) query = query.eq("active", true);
  const rows = unwrap(await query) ?? [];
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    durationMinutes: t.duration_minutes,
    capacityUnits: t.capacity_units,
    public: t.public,
    active: t.active,
    sortOrder: t.sort_order,
  }));
}

/**
 * The upcoming (not yet ended) booked, confirmed or arrived appointments
 * the schedule no longer fits (D38: settings changes never move them):
 * outside the opening hours or in a closed range (the TypeScript mirror's
 * scheduleWarning: the closure first, the grid is no reason to warn), or
 * in an intake window whose held units now exceed its capacity (D2; every
 * appointment that holds units counts, checked-in ones too, as the
 * database counts them). Grouped by shop day, soonest first.
 */
export async function affectedBySchedule(supabase: ServerSupabase): Promise<AffectedSummary> {
  const now = new Date().toISOString();
  const [settings, hours, holding] = await Promise.all([
    getShopSettings(supabase),
    hoursRows(supabase),
    holdingBetween(supabase, now, null),
  ]);
  const active = holding.filter((a) => isActiveStatus(a.status));
  if (active.length === 0) return { total: 0, days: [] };
  const lastEnd = holding.reduce((max, a) => (a.ends_at > max ? a.ends_at : max), now);
  const closures: ScheduleClosure[] = (
    unwrap(
      await supabase
        .from("closure_overrides")
        .select(CLOSURE_COLUMNS)
        .lt("starts_at", lastEnd)
        .gt("ends_at", now)
        .limit(1000),
    ) ?? []
  ).map((c) => ({
    kind: c.kind,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    opens: c.opens_at,
    closes: c.closes_at,
  }));
  const ctx = { settings, hours, closures };
  const capacity = holding.map((a) => ({
    id: a.id,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    capacityUnits: a.capacity_units,
    status: a.status,
  }));
  const byDay = new Map<string, AffectedAppointment[]>();
  for (const a of active) {
    const warning = scheduleWarning({ startsAt: a.starts_at, endsAt: a.ends_at }, ctx);
    const over =
      !warning &&
      appointmentWindows(settings, Date.parse(a.starts_at), Date.parse(a.ends_at)).some(
        (w) => unitsUsed(capacity, w) > settings.capacityUnits,
      );
    if (!warning && !over) continue;
    const day = localDay(new Date(a.starts_at), settings.timezone);
    byDay.set(day, [
      ...(byDay.get(day) ?? []),
      { id: a.id, startsAt: a.starts_at, status: a.status, problem: warning ?? "over_capacity" },
    ]);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, appointments]) => ({ day, appointments }));
  return { total: days.reduce((n, d) => n + d.appointments.length, 0), days };
}

// ---------------------------------------------------------------------------
// Writes (admin RPCs)
// ---------------------------------------------------------------------------

/**
 * Rethrows a refusal as a DomainError on `fields[reason]` when the
 * database named one (business codes, named checks and unique keys);
 * anything else is rethrown as it is.
 */
function rethrowOn(err: unknown, fields: Record<string, string>): never {
  const mapped = mapDbError(err);
  const field = mapped.reason ? fields[mapped.reason] : undefined;
  if (
    field &&
    (mapped.kind === "business" || mapped.kind === "invalid" || mapped.kind === "duplicate")
  ) {
    throw new DomainError(mapped.message, { [field]: [mapped.message] });
  }
  throw err;
}

/** update_shop_settings: the booking settings (no time zone, currency or public site URL here). */
export async function updateShopSettings(
  supabase: ServerSupabase,
  input: ShopSettingsInput,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("update_shop_settings", {
        intake_slot_minutes: input.slotMinutes,
        intake_capacity_units: input.capacityUnits,
        booking_min_notice_minutes: input.minNoticeMinutes,
        booking_horizon_days: input.horizonDays,
        customer_max_active_bookings: input.maxActiveBookings,
        customer_cancel_cutoff_minutes: input.cancelCutoffMinutes,
      }),
    );
  } catch (err) {
    rethrowOn(err, {
      shop_capacity_below_type: "capacityUnits",
      shop_settings_slot_minutes_check: "slotMinutes",
      shop_settings_capacity_check: "capacityUnits",
      shop_settings_notice_check: "minNoticeMinutes",
      shop_settings_horizon_check: "horizonDays",
      shop_settings_customer_limit_check: "maxActiveBookings",
      shop_settings_cancel_cutoff_check: "cancelCutoffMinutes",
    });
  }
}

/** set_booking_alert_recipients (D163b, admin): who gets the shop's booking alerts. */
export async function setBookingAlertRecipients(
  supabase: ServerSupabase,
  input: BookingAlertsInput,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("set_booking_alert_recipients", {
        staff_ids: input.staffIds,
        emails: input.emails,
      }),
    );
  } catch (err) {
    rethrowOn(err, {
      booking_alert_staff_invalid: "staffIds",
      booking_alert_email_invalid: "emails",
      booking_alert_too_many: "emails",
    });
  }
}

/** set_shop_hours: replaces one weekday's intervals at once (a replay changes nothing). */
export async function setShopHours(supabase: ServerSupabase, input: ShopHoursInput): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("set_shop_hours", {
        weekday: input.weekday,
        intervals: input.intervals.map((i) => ({ opens_at: i.opens, closes_at: i.closes })),
        active: input.active,
      }),
    );
  } catch (err) {
    rethrowOn(err, {
      shop_hours_overlap: "intervals",
      shop_hours_interval_check: "intervals",
      shop_hours_weekday_opens_at_key: "intervals",
    });
  }
}

/**
 * save_closure_override by the sheet's id: isNew inserts (a replay of the
 * same values returns it; different values are closure_conflict, shown
 * with the sheet kept open), otherwise an edit. Returns the closure with
 * the appointments it affects.
 */
export async function saveClosure(
  supabase: ServerSupabase,
  input: ClosureInput,
): Promise<ClosureItem> {
  try {
    unwrap(
      await supabase.rpc("save_closure_override", {
        closure_id: input.id,
        is_new: input.isNew,
        kind: input.kind,
        first_day: input.firstDay,
        last_day: input.lastDay,
        reason: input.reason,
        from_time: input.fromTime ?? undefined,
        to_time: input.toTime ?? undefined,
      }),
    );
  } catch (err) {
    rethrowOn(err, {
      closure_custom_hours_overlap: "firstDay",
      closure_invalid_range: "lastDay",
      closure_overrides_reason_check: "reason",
      reason_required: "reason",
    });
  }
  const saved = await getClosure(supabase, input.id);
  if (!saved) throw new DomainError("That closure no longer exists. Refresh and try again.");
  return saved;
}

/** delete_closure_override with a reason; a replay (already gone) is success. */
export async function deleteClosure(
  supabase: ServerSupabase,
  input: { id: string; reason: string },
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("delete_closure_override", {
        closure_id: input.id,
        reason: input.reason,
      }),
    );
  } catch (err) {
    rethrowOn(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

/** save_appointment_type by the sheet's id (isNew inserts, else edits; never deleted). */
export async function saveAppointmentType(
  supabase: ServerSupabase,
  input: AppointmentTypeInput,
): Promise<AppointmentTypeItem> {
  try {
    const row = unwrap(
      await supabase.rpc("save_appointment_type", {
        appointment_type_id: input.id,
        is_new: input.isNew,
        name: input.name,
        description: input.description ?? "",
        duration_minutes: input.durationMinutes,
        capacity_units: input.capacityUnits,
        public: input.public,
        active: input.active,
        sort_order: input.sortOrder,
      }),
    );
    if (!row)
      throw new DomainError("That appointment type no longer exists. Refresh and try again.");
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      durationMinutes: row.duration_minutes,
      capacityUnits: row.capacity_units,
      public: row.public,
      active: row.active,
      sortOrder: row.sort_order,
    };
  } catch (err) {
    rethrowOn(err, {
      appointment_types_name_key: "name",
      appointment_types_name_check: "name",
      appointment_types_description_check: "description",
      appointment_types_duration_check: "durationMinutes",
      appointment_types_capacity_check: "capacityUnits",
      appointment_type_capacity_too_large: "capacityUnits",
    });
  }
}
