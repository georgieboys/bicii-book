/**
 * The publication and unit-status state machines, mirrored from the
 * database (PLAN D25 SOLD-AT-COMPLETION, D26 PUBLICATION-MACHINE;
 * DATA-MODEL §6, §11). The database is authoritative:
 * private.publication_transition_allowed and
 * private.unit_status_transition_allowed decide in the products and
 * inventory_units triggers, and tests/db/inventory-catalog.test.ts compares
 * these tables with them pair by pair. The app uses this copy to offer only
 * the moves the database will accept. Pure.
 */
import { Constants, type Database } from "@/lib/database.types";

export type PublicationStatus = Database["public"]["Enums"]["publication_status"];
export type UnitStatus = Database["public"]["Enums"]["unit_status"];
export type TrackingType = Database["public"]["Enums"]["tracking_type"];

export const PUBLICATION_STATUSES: readonly PublicationStatus[] =
  Constants.public.Enums.publication_status;
export const UNIT_STATUSES: readonly UnitStatus[] = Constants.public.Enums.unit_status;

/**
 * Every allowed publication move (D26). `sold` is entered only by a sale
 * (job completion; Phases 6 and 10), never by hand, and only for unique
 * products; `sold → public` is the system restore when a sold unit returns
 * to stock.
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  draft: ["internal_only", "archived"],
  internal_only: ["public", "archived"],
  public: ["internal_only", "sold", "archived"],
  sold: ["public", "archived"],
  archived: ["internal_only"],
};

/**
 * Every allowed unit status move. `sold → held_for_customer` happens only
 * when the unit's job is reopened (D25).
 */
export const UNIT_STATUS_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  available: ["reserved", "held_for_customer", "sold", "returned_to_consignor", "written_off"],
  reserved: ["available", "held_for_customer", "sold"],
  held_for_customer: ["available", "sold"],
  sold: ["available", "held_for_customer"],
  written_off: ["available"],
  returned_to_consignor: [],
};

/** Whether a product may move from `from` to `to` (same status: false, a replay). */
export function canChangePublication(from: PublicationStatus, to: PublicationStatus): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

/** Whether a unit may move from `from` to `to` (same status: false, a replay). */
export function canChangeUnitStatus(from: UnitStatus, to: UnitStatus): boolean {
  return UNIT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The publication targets staff may choose by hand (Step 2's
 * set_publication_status): never `sold` (sales set it), from `sold` only
 * `archived` (the way back to public is a returned unit), and no `public`
 * for a unique product without an available unit.
 */
export function manualPublicationTargets(
  from: PublicationStatus,
  { trackingType, availableUnits }: { trackingType: TrackingType; availableUnits: number },
): PublicationStatus[] {
  if (from === "sold") return ["archived"];
  return PUBLICATION_TRANSITIONS[from].filter(
    (to) => to !== "sold" && !(to === "public" && trackingType === "unique" && availableUnits < 1),
  );
}

export type PublicationAction = { to: PublicationStatus; label: string };

/**
 * The publication card's buttons (D26): manualPublicationTargets named for
 * staff. "Publish" enters public, "Unpublish" leaves it for internal only,
 * "Make internal" takes a draft to internal only, "Restore" brings an
 * archived listing back to internal only and "Archive listing" archives
 * it. Never 'sold' (sales set it); a sold product offers only Archive
 * listing; a unique product with no available unit has no Publish.
 */
export function publicationActions(
  from: PublicationStatus,
  options: { trackingType: TrackingType; availableUnits: number },
): PublicationAction[] {
  return manualPublicationTargets(from, options).map((to) => ({
    to,
    label:
      to === "public"
        ? "Publish"
        : to === "archived"
          ? "Archive listing"
          : from === "public"
            ? "Unpublish"
            : from === "archived"
              ? "Restore"
              : "Make internal",
  }));
}

export type PublicationRequirements = {
  name: boolean;
  price: boolean;
  publicPhoto: boolean;
  /** Unique products only. */
  availableUnit?: boolean;
};

const REQUIREMENT_LABELS: Record<keyof PublicationRequirements, string> = {
  name: "A name",
  price: "A sale price",
  publicPhoto: "A public photo",
  availableUnit: "An available unit",
};

/**
 * The checklist of what publishing needs (private.publication_requirements_met,
 * D26), in order, with whether each is met. The database decides; this only
 * explains why Publish is disabled.
 */
export function publicationChecklist(
  requirements: PublicationRequirements,
): { key: keyof PublicationRequirements; label: string; met: boolean }[] {
  const keys: (keyof PublicationRequirements)[] = ["name", "price", "publicPhoto"];
  if (requirements.availableUnit !== undefined) keys.push("availableUnit");
  return keys.map((key) => ({
    key,
    label: REQUIREMENT_LABELS[key],
    met: requirements[key] === true,
  }));
}

/** "Still needed: A sale price, A public photo." or null when everything is met. */
export function missingRequirements(requirements: PublicationRequirements): string | null {
  const missing = publicationChecklist(requirements)
    .filter((r) => !r.met)
    .map((r) => r.label);
  return missing.length === 0 ? null : `Still needed: ${missing.join(", ")}.`;
}

/** What reporting.public_items.availability means to a shopper. */
export function publicAvailabilityLabel(availability: string | null): string {
  switch (availability) {
    case "available":
      return "Available";
    case "sold_out":
      return "Sold out";
    case "sold":
      return "Sold";
    default:
      return "Unavailable";
  }
}

// ---------------------------------------------------------------------------
// Display helpers for the stock screens (Phase 4 app). Pure; the database
// computes every figure, these only name and colour it.
// ---------------------------------------------------------------------------

export type MovementType = Database["public"]["Enums"]["movement_type"];

/** The status tones of DESIGN.md (StatusPill, Badge). */
export type StockTone = "done" | "waiting" | "danger" | "progress" | "info" | "neutral";

/**
 * How healthy a product's stock is: danger when there is none (or less
 * than none) or any location is below zero (D23 NEG-CONSUMPTION, "recount
 * needed"); waiting at or below the reorder point (reporting.low_stock's
 * rule); done otherwise.
 */
export function stockTone(
  onHand: number,
  reorderPoint: number | null,
  negativeLocations = 0,
): "danger" | "waiting" | "done" {
  if (onHand <= 0 || negativeLocations > 0) return "danger";
  if (reorderPoint != null && onHand <= reorderPoint) return "waiting";
  return "done";
}

/** A real minus sign (U+2212), so a negative count reads as one. */
const MINUS = "−";

const count = (n: number) =>
  n < 0 ? `${MINUS}${Math.abs(n).toLocaleString("en-SG")}` : n.toLocaleString("en-SG");

/** "34 in stock", "Out of stock", or "−2 (recount needed)" (D23). */
export function stockLabel(onHand: number): string {
  if (onHand < 0) return `${count(onHand)} (recount needed)`;
  if (onHand === 0) return "Out of stock";
  return `${count(onHand)} in stock`;
}

/** "+3", "−2" or "0": a ledger delta with a real minus sign. */
export function signedQuantity(delta: number): string {
  if (delta > 0) return `+${count(delta)}`;
  return count(delta);
}

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  held_for_customer: "On a job",
  sold: "Sold",
  written_off: "Written off",
  returned_to_consignor: "Returned to consignor",
};

const UNIT_STATUS_TONES: Record<UnitStatus, StockTone> = {
  available: "done",
  reserved: "info",
  held_for_customer: "waiting",
  sold: "progress",
  written_off: "danger",
  returned_to_consignor: "info",
};

/** The words staff_search uses for a unit's status too ("On a job" while held, D25). */
export function unitStatusLabel(status: UnitStatus): string {
  return UNIT_STATUS_LABELS[status];
}

export function unitStatusTone(status: UnitStatus): StockTone {
  return UNIT_STATUS_TONES[status];
}

export const PUBLICATION_LABELS: Record<PublicationStatus, string> = {
  draft: "Draft",
  internal_only: "Internal only",
  public: "Public",
  sold: "Sold",
  archived: "Archived",
};

const PUBLICATION_TONES: Record<PublicationStatus, StockTone> = {
  draft: "neutral",
  internal_only: "info",
  public: "done",
  sold: "progress",
  archived: "neutral",
};

export function publicationLabel(status: PublicationStatus): string {
  return PUBLICATION_LABELS[status];
}

export function publicationTone(status: PublicationStatus): StockTone {
  return PUBLICATION_TONES[status];
}

/**
 * What a ledger row was, in staff words. A transfer is two rows (out of
 * one location, into the other); a `reversal` written by voiding a part
 * line (it carries the job) is "Returned from job"; an `outside_purchase`
 * (D149a) is the receipt of an indent part bought outside BICII, always
 * followed by its "Used on job".
 */
export function movementLabel(
  type: MovementType,
  delta: number,
  { onJob = false }: { onJob?: boolean } = {},
): string {
  switch (type) {
    case "purchase_received":
      return "Received";
    case "outside_purchase":
      // D149a: an indent part bought outside BICII, fitted at once.
      return "Bought outside BICII";
    case "job_consumption":
      return "Used on job";
    case "retail_sale":
      return "Sold in shop";
    case "online_sale":
      return "Sold online";
    case "stock_adjustment":
      return "Adjustment";
    case "damaged":
      return "Damaged";
    case "return":
      return "Customer return";
    case "consignment_received":
      return "Consignment received";
    case "consignment_returned":
      return "Returned to consignor";
    case "transfer":
      return delta >= 0 ? "Transfer in" : "Transfer out";
    case "reversal":
      return onJob ? "Returned from job" : "Reversal";
  }
}

/** The movement filter chips on /inventory/movements. */
export const MOVEMENT_FILTERS = {
  all: { label: "All", types: null },
  jobs: { label: "Jobs", types: ["job_consumption", "reversal", "outside_purchase"] },
  adjustments: { label: "Adjustments", types: ["stock_adjustment", "damaged"] },
  transfers: { label: "Transfers", types: ["transfer"] },
} as const satisfies Record<string, { label: string; types: readonly MovementType[] | null }>;

export type MovementFilter = keyof typeof MOVEMENT_FILTERS;

export function isMovementFilter(value: unknown): value is MovementFilter {
  return typeof value === "string" && Object.hasOwn(MOVEMENT_FILTERS, value);
}

export type LocationLike = { id: string; name: string; active: boolean; sortOrder: number };

export type LocationKindValue = Database["public"]["Enums"]["location_kind"];

/**
 * Location kinds as staff read them. Plain data in a plain module: a
 * Server Component that imported it from a "use client" module would get a
 * client reference, not the object, and every label would read undefined.
 */
export const LOCATION_KIND_LABELS: Readonly<Record<LocationKindValue, string>> = {
  shop_floor: "Shop floor",
  workshop: "Workshop",
  storage: "Storage",
  offsite: "Off-site",
};

/**
 * Where stock goes when nobody says: the active location with the lowest
 * sort order, then name (the rule add_inventory_line applies in SQL), or
 * null when there is no active location (location_required).
 */
export function defaultLocation<L extends LocationLike>(locations: readonly L[]): L | null {
  const active = locations.filter((l) => l.active);
  active.sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return active[0] ?? null;
}

/**
 * The adjustment sheet's live preview: the count after adding `delta`
 * (negative to remove), and whether that would go below zero, which a
 * manual adjustment may never do (insufficient_stock; only a part used on
 * a job may, D23).
 */
export function adjustmentPreview(
  onHand: number,
  delta: number,
): { after: number; wouldGoNegative: boolean } {
  const after = onHand + delta;
  return { after, wouldGoNegative: after < 0 };
}

/** The NEG-CONSUMPTION warning (D23) for adding `quantity` where `onHand` are counted, or null. */
export function overdrawWarning(
  quantity: number,
  onHand: number,
  locationName: string,
): string | null {
  if (!(quantity > onHand)) return null;
  const have =
    onHand <= 0 ? `None counted at ${locationName}` : `Only ${count(onHand)} at ${locationName}`;
  return `${have}. Adding ${count(quantity)} takes the count below zero; ask whoever does stock counts to recount.`;
}

/** D25 SOLD-AT-COMPLETION: what a reopen does to the job's sold units. */
export function reopenUnitNote(units: readonly string[]): string {
  const names =
    units.length === 1
      ? units[0]
      : `${units.slice(0, -1).join(", ")} and ${units[units.length - 1]}`;
  return units.length === 1
    ? `${names} goes back on hold for this job. To return it to stock, void its line after reopening.`
    : `${names} go back on hold for this job. To return one to stock, void its line after reopening.`;
}
