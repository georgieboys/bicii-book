import "server-only";

import type {
  AdventureCheckpointOrder,
  AdventureEventKind,
  AdventureParticipation,
  AdventureStatus,
} from "@/lib/adventures";
import type { CheckpointInput } from "@/lib/adventure-forms";
import { unwrap } from "@/lib/db-errors";

import { DomainError } from "./errors";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * The adventure catalogue for staff (DATA-MODEL §20, D164-D166). Reads go
 * through RLS (any active staff member); every change is an RPC that
 * requires manage_adventures and checks its own rules.
 */

type Money = string;

const GONE = "That adventure no longer exists. Refresh and try again.";

/**
 * Generated RPC argument types are not nullable even where SQL accepts
 * null; this keeps the cast in one place. Money crosses as a fixed-point
 * string (PostgREST passes it to numeric), never as a float.
 */
function arg<T>(value: unknown): T {
  return value as T;
}

/** A list read: its rows, or none. */
function rows<T>(result: { data: T[] | null; error: Parameters<typeof unwrap>[0]["error"] }): T[] {
  return unwrap(result) ?? [];
}

export type AdventureListItem = {
  id: string;
  slug: string;
  status: AdventureStatus;
  sortOrder: number;
  name: string;
  distanceKm: string;
  isPlanned: boolean;
  offerCount: number;
  hasDraft: boolean;
};

export type AdventureCheckpoint = {
  position: number;
  label: string;
  instructions: string;
  latitude: string | null;
  longitude: string | null;
  reviewRadiusM: number | null;
  mandatory: boolean;
  photoRequired: boolean;
};

export type AdventureOffer = {
  kind: AdventureParticipation;
  price: Money;
  trackerHirePrice: Money | null;
  supportedDays: number | null;
  inclusions: string;
};

export type AdventureRevision = {
  id: string;
  revisionNumber: number;
  version: number;
  sealedAt: string | null;
  changeSummary: string | null;
  name: string;
  summary: string;
  description: string;
  note: string;
  region: string;
  terrain: string;
  whenToStart: string;
  startFinish: string;
  distanceKm: string;
  nominalDays: number | null;
  timeZone: string;
  minElapsedMinutes: number | null;
  maxElapsedMinutes: number | null;
  checkpointOrder: AdventureCheckpointOrder;
  routeUrl: string | null;
  rules: string;
  equipment: string;
  riderInstructions: string;
  emergencyProcedure: string;
  staffNotes: string;
  isPlanned: boolean;
  checkpoints: AdventureCheckpoint[];
  offers: AdventureOffer[];
};

export type AdventureEvent = {
  id: string;
  kind: AdventureEventKind;
  revisionNumber: number | null;
  staffName: string | null;
  reason: string | null;
  createdAt: string;
};

export type AdventureDetail = {
  id: string;
  slug: string;
  status: AdventureStatus;
  sortOrder: number;
  /** What the public sees (null until the first publish). */
  current: AdventureRevision | null;
  /** The draft being edited, if any. */
  draft: AdventureRevision | null;
  events: AdventureEvent[];
};

const REVISION_COLUMNS =
  "id, adventure_id, revision_number, version, sealed_at, change_summary, name, summary, description, note, region, terrain, when_to_start, start_finish, distance_km, nominal_days, time_zone, min_elapsed_minutes, max_elapsed_minutes, checkpoint_order, route_url, rules, equipment, rider_instructions, emergency_procedure, staff_notes, is_planned";

/** Every adventure, in public order, with what the list shows. */
export async function listAdventures(supabase: ServerSupabase): Promise<AdventureListItem[]> {
  const adventures = rows(
    await supabase
      .from("adventures")
      .select("id, slug, status, sort_order, current_revision_id")
      .order("sort_order")
      .order("slug"),
  );
  if (adventures.length === 0) return [];
  const revisions = rows(
    await supabase
      .from("adventure_revisions")
      .select("id, adventure_id, revision_number, name, distance_km, is_planned, sealed_at")
      .in(
        "adventure_id",
        adventures.map((a) => a.id),
      ),
  );
  const offers = rows(
    await supabase
      .from("adventure_offers")
      .select("revision_id")
      .in(
        "revision_id",
        revisions.map((r) => r.id),
      ),
  );
  const offersByRevision = new Map<string, number>();
  for (const o of offers)
    offersByRevision.set(o.revision_id, (offersByRevision.get(o.revision_id) ?? 0) + 1);

  return adventures.map((a) => {
    const own = revisions.filter((r) => r.adventure_id === a.id);
    const draft = own.find((r) => r.sealed_at === null) ?? null;
    const current = own.find((r) => r.id === a.current_revision_id) ?? null;
    const shown = current ?? draft ?? own.sort((x, y) => y.revision_number - x.revision_number)[0];
    return {
      id: a.id,
      slug: a.slug,
      status: a.status,
      sortOrder: a.sort_order,
      name: shown?.name ?? a.slug,
      distanceKm: String(shown?.distance_km ?? ""),
      isPlanned: shown?.is_planned ?? false,
      offerCount: current ? (offersByRevision.get(current.id) ?? 0) : 0,
      hasDraft: draft !== null,
    };
  });
}

type RevisionRow = {
  id: string;
  adventure_id: string;
  revision_number: number;
  version: number;
  sealed_at: string | null;
  change_summary: string | null;
  name: string;
  summary: string;
  description: string;
  note: string;
  region: string;
  terrain: string;
  when_to_start: string;
  start_finish: string;
  distance_km: number;
  nominal_days: number | null;
  time_zone: string;
  min_elapsed_minutes: number | null;
  max_elapsed_minutes: number | null;
  checkpoint_order: AdventureCheckpointOrder;
  route_url: string | null;
  rules: string;
  equipment: string;
  rider_instructions: string;
  emergency_procedure: string;
  staff_notes: string;
  is_planned: boolean;
};

async function loadRevision(
  supabase: ServerSupabase,
  row: RevisionRow,
): Promise<AdventureRevision> {
  const [checkpoints, offers] = await Promise.all([
    supabase
      .from("adventure_checkpoints")
      .select(
        "position, label, instructions, latitude, longitude, review_radius_m, mandatory, photo_required",
      )
      .eq("revision_id", row.id)
      .order("position"),
    supabase
      .from("adventure_offers")
      .select("kind, price, tracker_hire_price, supported_days, inclusions")
      .eq("revision_id", row.id)
      .order("kind"),
  ]);
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    version: row.version,
    sealedAt: row.sealed_at,
    changeSummary: row.change_summary,
    name: row.name,
    summary: row.summary,
    description: row.description,
    note: row.note,
    region: row.region,
    terrain: row.terrain,
    whenToStart: row.when_to_start,
    startFinish: row.start_finish,
    distanceKm: String(row.distance_km),
    nominalDays: row.nominal_days,
    timeZone: row.time_zone,
    minElapsedMinutes: row.min_elapsed_minutes,
    maxElapsedMinutes: row.max_elapsed_minutes,
    checkpointOrder: row.checkpoint_order,
    routeUrl: row.route_url,
    rules: row.rules,
    equipment: row.equipment,
    riderInstructions: row.rider_instructions,
    emergencyProcedure: row.emergency_procedure,
    staffNotes: row.staff_notes,
    isPlanned: row.is_planned,
    checkpoints: rows(checkpoints).map((c) => ({
      position: c.position,
      label: c.label,
      instructions: c.instructions,
      latitude: c.latitude === null ? null : String(c.latitude),
      longitude: c.longitude === null ? null : String(c.longitude),
      reviewRadiusM: c.review_radius_m,
      mandatory: c.mandatory,
      photoRequired: c.photo_required,
    })),
    offers: rows(offers).map((o) => ({
      kind: o.kind,
      price: Number(o.price).toFixed(2),
      trackerHirePrice:
        o.tracker_hire_price === null ? null : Number(o.tracker_hire_price).toFixed(2),
      supportedDays: o.supported_days,
      inclusions: o.inclusions,
    })),
  };
}

/** One adventure with its published and draft revisions and history; null if unknown. */
export async function getAdventure(
  supabase: ServerSupabase,
  id: string,
): Promise<AdventureDetail | null> {
  const adventure = unwrap(
    await supabase
      .from("adventures")
      .select("id, slug, status, sort_order, current_revision_id")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!adventure) return null;

  const revisions = rows(
    await supabase
      .from("adventure_revisions")
      .select(REVISION_COLUMNS)
      .eq("adventure_id", id)
      .order("revision_number"),
  ) as RevisionRow[];
  const currentRow = revisions.find((r) => r.id === adventure.current_revision_id) ?? null;
  const draftRow = revisions.find((r) => r.sealed_at === null) ?? null;

  const events = rows(
    await supabase
      .from("adventure_events")
      .select("id, kind, revision_id, reason, created_at, staff:staff_id (display_name)")
      .eq("adventure_id", id)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
  );
  const numberOf = new Map(revisions.map((r) => [r.id, r.revision_number]));

  return {
    id: adventure.id,
    slug: adventure.slug,
    status: adventure.status,
    sortOrder: adventure.sort_order,
    current: currentRow ? await loadRevision(supabase, currentRow) : null,
    draft: draftRow ? await loadRevision(supabase, draftRow) : null,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      revisionNumber: e.revision_id ? (numberOf.get(e.revision_id) ?? null) : null,
      staffName: (e.staff as { display_name: string } | null)?.display_name ?? null,
      reason: e.reason,
      createdAt: e.created_at,
    })),
  };
}

export async function createAdventure(
  supabase: ServerSupabase,
  input: { slug: string; name: string; distanceKm: number },
): Promise<{ id: string }> {
  const revision = unwrap(
    await supabase.rpc("create_adventure", {
      slug: input.slug,
      name: input.name,
      distance_km: input.distanceKm,
    }),
  );
  if (!revision) throw new DomainError(GONE);
  return { id: revision.adventure_id };
}

export type DraftInput = {
  revisionId: string;
  expectedVersion: number;
  name: string;
  summary: string;
  description: string;
  note: string;
  region: string;
  terrain: string;
  whenToStart: string;
  startFinish: string;
  distanceKm: number;
  nominalDays: number | null;
  timeZone: string;
  minElapsedMinutes: number | null;
  maxElapsedMinutes: number | null;
  checkpointOrder: AdventureCheckpointOrder;
  routeUrl: string | null;
  rules: string;
  equipment: string;
  riderInstructions: string;
  emergencyProcedure: string;
  staffNotes: string;
  isPlanned: boolean;
};

/** Saves every field of the draft; refused when it changed since it was opened. */
export async function saveAdventureDraft(
  supabase: ServerSupabase,
  input: DraftInput,
): Promise<{ version: number }> {
  const revision = unwrap(
    await supabase.rpc("update_adventure_draft", {
      revision_id: input.revisionId,
      expected_version: input.expectedVersion,
      name: input.name,
      summary: input.summary,
      description: input.description,
      note: input.note,
      region: input.region,
      terrain: input.terrain,
      when_to_start: input.whenToStart,
      start_finish: input.startFinish,
      distance_km: input.distanceKm,
      nominal_days: arg<number>(input.nominalDays),
      time_zone: input.timeZone,
      min_elapsed_minutes: arg<number>(input.minElapsedMinutes),
      max_elapsed_minutes: arg<number>(input.maxElapsedMinutes),
      checkpoint_order: input.checkpointOrder,
      route_url: arg<string>(input.routeUrl),
      rules: input.rules,
      equipment: input.equipment,
      rider_instructions: input.riderInstructions,
      emergency_procedure: input.emergencyProcedure,
      staff_notes: input.staffNotes,
      is_planned: input.isPlanned,
    }),
  );
  if (!revision) throw new DomainError(GONE);
  return { version: revision.version };
}

export async function setAdventureCheckpoints(
  supabase: ServerSupabase,
  revisionId: string,
  checkpoints: CheckpointInput[],
): Promise<void> {
  unwrap(
    await supabase.rpc("set_adventure_checkpoints", {
      revision_id: revisionId,
      checkpoints: checkpoints.map((c) => ({
        label: c.label,
        instructions: c.instructions,
        latitude: c.latitude,
        longitude: c.longitude,
        mandatory: c.mandatory,
        photo_required: c.photoRequired,
      })),
    }),
  );
}

export async function setAdventureOffer(
  supabase: ServerSupabase,
  input: {
    revisionId: string;
    kind: AdventureParticipation;
    price: Money;
    trackerHirePrice: Money | null;
    supportedDays: number | null;
    inclusions: string;
  },
): Promise<void> {
  unwrap(
    await supabase.rpc("set_adventure_offer", {
      revision_id: input.revisionId,
      kind: input.kind,
      price: arg<number>(input.price),
      tracker_hire_price: arg<number>(input.trackerHirePrice),
      supported_days: arg<number>(input.supportedDays),
      inclusions: input.inclusions,
    }),
  );
}

export async function removeAdventureOffer(
  supabase: ServerSupabase,
  revisionId: string,
  kind: AdventureParticipation,
): Promise<void> {
  unwrap(await supabase.rpc("remove_adventure_offer", { revision_id: revisionId, kind }));
}

/** The draft (started from the published revision if there is none). */
export async function startAdventureDraft(
  supabase: ServerSupabase,
  adventureId: string,
): Promise<{ revisionId: string }> {
  const revision = unwrap(
    await supabase.rpc("start_adventure_draft", { adventure_id: adventureId }),
  );
  if (!revision) throw new DomainError(GONE);
  return { revisionId: revision.id };
}

export async function publishAdventureRevision(
  supabase: ServerSupabase,
  revisionId: string,
  changeSummary: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("publish_adventure_revision", {
      revision_id: revisionId,
      change_summary: changeSummary,
    }),
  );
}

export async function archiveAdventure(
  supabase: ServerSupabase,
  adventureId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("archive_adventure", { adventure_id: adventureId, reason }));
}

export async function unarchiveAdventure(
  supabase: ServerSupabase,
  adventureId: string,
): Promise<void> {
  unwrap(await supabase.rpc("unarchive_adventure", { adventure_id: adventureId }));
}

export async function setAdventureOrder(
  supabase: ServerSupabase,
  adventureId: string,
  sortOrder: number,
): Promise<void> {
  unwrap(
    await supabase.rpc("set_adventure_order", { adventure_id: adventureId, sort_order: sortOrder }),
  );
}
