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
