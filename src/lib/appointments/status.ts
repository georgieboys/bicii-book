/**
 * Appointment statuses on screen (SPEC §6 statuses; PLAN D36, D37, D39,
 * D40): labels, tones and the actions staff are offered, mirroring the
 * database's status machine (private.appointment_transition_allowed,
 * mark_appointment_status, cancel_appointment, check_in_appointment)
 * exactly; tests/unit/appointment-status.test.ts checks it against
 * tests/fixtures/appointment-transitions.ts. The database stays the
 * authority. Pure.
 */
import type { Database } from "@/lib/database.types";
import { SHOP_TIME_ZONE } from "@/lib/dates";

import { localDay } from "./time";

export type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
export type AppointmentSource = Database["public"]["Enums"]["appointment_source"];

/** The status tokens (DESIGN.md): the same set as Badge and StatusPill tones. */
export type AppointmentTone = "info" | "waiting" | "progress" | "done" | "danger" | "neutral";

export const APPOINTMENT_STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  booked: "Booked",
  confirmed: "Confirmed",
  arrived: "Arrived",
  checked_in: "Checked in",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const APPOINTMENT_SOURCE_LABELS: Readonly<Record<AppointmentSource, string>> = {
  customer: "Booked online",
  staff: "Booked by staff",
};

/**
 * The hint under "Why is the appointment cancelled?". Cancelling an online
 * booking queues the customer's cancellation email whoever cancels it
 * (private.appointments_queue_notices), and the email leaves out the staff
 * reason; a booking staff made sends nothing.
 */
export function cancelHint(source: AppointmentSource): string {
  return source === "customer"
    ? "Kept in the appointment's history. The customer is emailed that it's cancelled when booking emails are on; your reason isn't in it."
    : "Kept in the appointment's history. The customer is not told automatically.";
}

const TONES: Readonly<Record<AppointmentStatus, AppointmentTone>> = {
  booked: "info",
  confirmed: "progress",
  arrived: "waiting",
  checked_in: "done",
  completed: "done",
  cancelled: "neutral",
  no_show: "danger",
};

export function appointmentTone(status: AppointmentStatus): AppointmentTone {
  return TONES[status];
}

/** Still expected or in the shop and not yet checked in: they hold a place and can still change. */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ["booked", "confirmed", "arrived"];

export function isActiveStatus(status: AppointmentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** A booked or confirmed appointment this many minutes past its start without an arrival is late. */
export const LATE_AFTER_MINUTES = 15;

/** Booked or confirmed and more than LATE_AFTER_MINUTES past its start. */
export function isLate(
  appt: { status: AppointmentStatus; startsAt: string | Date },
  now: Date,
): boolean {
  if (appt.status !== "booked" && appt.status !== "confirmed") return false;
  const start = appt.startsAt instanceof Date ? appt.startsAt.getTime() : Date.parse(appt.startsAt);
  return now.getTime() > start + LATE_AFTER_MINUTES * 60_000;
}

export type AppointmentActions = {
  /** booked -> confirmed. */
  confirm: boolean;
  /** booked or confirmed -> arrived. */
  arrive: boolean;
  /** booked, confirmed or arrived -> checked_in, with a job (D40). */
  checkIn: boolean;
  /** booked or confirmed -> no_show, only once it has started (D39). */
  noShow: boolean;
  /** booked, confirmed or arrived -> cancelled, at any time, with a reason (D37). */
  cancel: boolean;
  /** no_show -> arrived, only on the appointment's own shop-local date (D39). */
  reinstate: boolean;
};

/**
 * What staff may do next, as the database decides it: completed only
 * through the job (D36), never offered; cancelled and completed are final.
 * The reinstatement's capacity re-check happens in the database.
 */
export function availableActions(
  status: AppointmentStatus,
  startsAt: string | Date,
  now: Date,
  { timeZone = SHOP_TIME_ZONE }: { timeZone?: string } = {},
): AppointmentActions {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  const expected = status === "booked" || status === "confirmed";
  return {
    confirm: status === "booked",
    arrive: expected,
    checkIn: expected || status === "arrived",
    noShow: expected && now.getTime() >= start.getTime(),
    cancel: expected || status === "arrived",
    reinstate: status === "no_show" && localDay(now, timeZone) === localDay(start, timeZone),
  };
}

export type PrimaryAction = "arrive" | "checkIn" | "reinstate";

/**
 * The step the detail page puts first: Arrived for an expected customer,
 * Check in once they are here, "Reinstate as arrived" for a no-show on its
 * own day; null when nothing comes next.
 */
export function primaryAction(
  status: AppointmentStatus,
  actions: AppointmentActions,
): PrimaryAction | null {
  if (actions.arrive) return "arrive";
  if (status === "arrived" && actions.checkIn) return "checkIn";
  if (actions.reinstate) return "reinstate";
  return null;
}

/** How the week strip and week view count a day's appointments. */
export type StatusBucket = "expected" | "here" | "done" | "missed" | "cancelled";

export function statusBucket(status: AppointmentStatus): StatusBucket {
  switch (status) {
    case "booked":
    case "confirmed":
      return "expected";
    case "arrived":
      return "here";
    case "checked_in":
    case "completed":
      return "done";
    case "no_show":
      return "missed";
    case "cancelled":
      return "cancelled";
  }
}

export type ScheduleWarning = "outside_hours" | "closed";

export const SCHEDULE_WARNING_LABELS: Readonly<Record<ScheduleWarning, string>> = {
  outside_hours: "Outside opening hours",
  closed: "Shop closed",
};
