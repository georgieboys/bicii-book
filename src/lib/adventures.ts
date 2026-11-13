/**
 * Adventures (docs/ADVENTURES.md, D164-D171): labels and small helpers the
 * staff screens share. Pure and client-safe; the database decides every
 * rule again (DATA-MODEL §20).
 */
import type { PermissionKey } from "@/lib/auth/permissions";
import type { Database } from "@/lib/database.types";
import { Decimal } from "@/lib/money";

export type AdventureStatus = Database["public"]["Enums"]["adventure_status"];
export type AdventureParticipation = Database["public"]["Enums"]["adventure_participation"];
export type AdventureCheckpointOrder = Database["public"]["Enums"]["adventure_checkpoint_order"];
export type AdventureEventKind = Database["public"]["Enums"]["adventure_event_kind"];

/** Certification starts here (D164). */
export const CERTIFICATION_MIN_KM = 125;

/** In the order the screens list them. */
export const PARTICIPATIONS: readonly AdventureParticipation[] = [
  "self_supported",
  "self_supported_group",
  "supported",
];

export const PARTICIPATION_LABELS: Record<AdventureParticipation, string> = {
  self_supported: "Self-supported",
  self_supported_group: "Self-supported group",
  supported: "Supported",
};

export const PARTICIPATION_DESCRIPTIONS: Record<AdventureParticipation, string> = {
  self_supported: "The rider rides when they choose and carries what they need.",
  self_supported_group: "The same certification, riding with a group on a date BICII publishes.",
  supported: "A fixed departure with BICII facilitators. The tracker is included.",
};

export const STATUS_LABELS: Record<AdventureStatus, string> = {
  draft: "Not published",
  published: "Published",
  archived: "Archived",
};

export const EVENT_LABELS: Record<AdventureEventKind, string> = {
  created: "Created",
  draft_started: "New draft started",
  published: "Published",
  archived: "Archived",
  unarchived: "Unarchived",
  order_changed: "Order changed",
};

/** Whether this staff member may change the catalogue (D169). */
export function canManageAdventures(staff: { permissions: readonly PermissionKey[] }): boolean {
  return staff.permissions.includes("manage_adventures");
}

/** Whether a distance qualifies for certification offers (D164). */
export function isCertifiableDistance(km: number | string): boolean {
  const value = new Decimal(km);
  return value.isFinite() && value.gte(CERTIFICATION_MIN_KM);
}

/**
 * D165, the owner's formulas, as the editor's suggestion (mirrors
 * private.adventure_suggested_price; a database test checks the same
 * figures): self-supported 49 + 10 x (days - 1); supported 49 + 100 x days.
 */
export function suggestedPrice(
  kind: AdventureParticipation,
  nominalDays: number | null,
  supportedDays: number | null,
): string | null {
  if (kind === "supported") {
    if (supportedDays === null || supportedDays < 1) return null;
    return new Decimal(49).plus(new Decimal(100).times(supportedDays)).toFixed(2);
  }
  if (nominalDays === null || nominalDays < 1) return null;
  return new Decimal(49).plus(new Decimal(10).times(nominalDays - 1)).toFixed(2);
}

/** "125 km", "1,000 km", "12.5 km". */
export function formatDistance(km: number | string): string {
  const value = new Decimal(km);
  const text = value.isInteger() ? value.toFixed(0) : value.toFixed(1);
  const [whole, fraction] = text.split(".");
  const grouped = Number(whole).toLocaleString("en-SG");
  return `${fraction ? `${grouped}.${fraction}` : grouped} km`;
}

/** Minutes as "24 h", "36 h 30 min". */
export function formatElapsed(minutes: number | null): string | null {
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// ------------------------------------------------- bookings and review ----
// Phase B (D172-D182): labels for the bookings, review and pack screens.

export type AdventureBookingStatus = Database["public"]["Enums"]["adventure_booking_status"];
export type AdventureBookingEventKind = Database["public"]["Enums"]["adventure_booking_event_kind"];
export type AdventureSubmissionState = Database["public"]["Enums"]["adventure_submission_state"];
export type AdventureFileState = Database["public"]["Enums"]["adventure_file_state"];
export type AdventureReviewDecision = Database["public"]["Enums"]["adventure_review_decision"];
export type AdventurePackStatus = Database["public"]["Enums"]["adventure_pack_status"];
export type AdventureFinisherName = Database["public"]["Enums"]["adventure_finisher_name"];

export const BOOKING_STATUS_LABELS: Record<AdventureBookingStatus, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Paid",
  cancelled: "Cancelled",
  expired: "Checkout expired",
};

export const BOOKING_EVENT_LABELS: Record<AdventureBookingEventKind, string> = {
  created: "Booking started",
  payment_started: "Checkout opened",
  confirmed: "Paid",
  expired: "Checkout expired",
  payment_failed: "Payment failed",
  payment_processing: "Payment processing",
  payment_attention: "Payment needs attention",
  refund_recorded: "Refund recorded",
  evidence_started: "Evidence started",
  evidence_submitted: "Certification requested",
  review_started: "Review started",
  changes_requested: "Changes requested",
  certified: "Certified",
  not_certified: "Not certified",
  certificate_revoked: "Certificate revoked",
  pack_updated: "Finisher pack updated",
  attention_cleared: "Payment flag cleared",
  tracker_issued: "Tracker given out",
  tracker_replaced: "Tracker replaced",
  tracker_returned: "Tracker returned",
  tracker_hire_cancelled: "Tracker hire cancelled",
  ride_started: "Ride started",
  ride_finished: "Ride finished",
  capture_corrected: "Ride window corrected",
  departure_joined: "Joined a group date",
  departure_left: "Left a group date",
  departure_cancelled: "Group date cancelled",
};

export const DEPARTURE_KIND_LABELS: Record<"self_supported_group" | "supported", string> = {
  self_supported_group: "Group ride",
  supported: "Supported ride",
};

export const SUBMISSION_STATE_LABELS: Record<AdventureSubmissionState, string> = {
  draft: "Rider is adding evidence",
  submitted: "Waiting for review",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Not certified",
};

export const FILE_STATE_LABELS: Record<AdventureFileState, string> = {
  awaiting_upload: "Not uploaded",
  uploaded: "Waiting to be read",
  parsing: "Being read",
  parsed: "Read",
  failed: "Could not be read",
  removed: "Removed",
};

export const DECISION_LABELS: Record<AdventureReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Not certified",
};

export const PACK_STATUS_LABELS: Record<AdventurePackStatus, string> = {
  awaiting_pack: "To pack",
  ready: "Ready to collect",
  fulfilled: "Collected",
  on_hold: "On hold",
};

export const FINISHER_NAME_LABELS: Record<AdventureFinisherName, string> = {
  first_name_initial: "First name and initial",
  full_name: "Full name",
  hidden: "Hidden (A BICII rider)",
};

/** The review checklist, in the order the workspace asks it (D178). */
export const REVIEW_CHECKS = [
  { key: "identity", label: "The recording is the rider's own ride" },
  { key: "coverage", label: "The track covers the whole route" },
  { key: "checkpoints", label: "Every mandatory checkpoint is passed, with its photo" },
  { key: "chronology", label: "Times run forward with no impossible jumps" },
  { key: "time_window", label: "The ride is inside the route's time limit" },
  { key: "distance", label: "The distance is at least the route's" },
] as const;

export type ReviewCheckKey = (typeof REVIEW_CHECKS)[number]["key"];

/** Whether this staff member may review rides (D178). */
export function canVerifyAdventures(staff: { permissions: readonly PermissionKey[] }): boolean {
  return staff.permissions.includes("verify_adventures");
}

/** Minutes between two instants, or null. */
export function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
}

/** "1.2 km", "350 m". */
export function formatMetres(m: number | string | null): string | null {
  if (m === null) return null;
  const value = Number(m);
  if (!Number.isFinite(value)) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

// ------------------------------------------------------- tracker hire ----
// Phase C (D185-D188): labels for the Trackers and Handovers screens.

export const TRACKER_STATE_LABELS: Record<
  "in_service" | "maintenance" | "lost" | "retired",
  string
> = {
  in_service: "In service",
  maintenance: "Maintenance",
  lost: "Lost",
  retired: "Retired",
};

export const TRACKER_CONDITION_LABELS: Record<
  "good" | "needs_service" | "faulty" | "lost",
  string
> = {
  good: "Good: back in service",
  needs_service: "Needs charging or a check",
  faulty: "Faulty",
  lost: "Lost",
};

export const HIRE_STATUS_LABELS: Record<"held" | "confirmed" | "completed" | "cancelled", string> =
  {
    held: "Waiting for payment",
    confirmed: "Paid",
    completed: "Returned",
    cancelled: "Cancelled",
  };
