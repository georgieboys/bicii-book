import "server-only";

import { bikeSubtitle, bikeTitle } from "@/lib/bikes";
import type { Database } from "@/lib/database.types";
import { DbError, constraintOf, unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import type { ListPage } from "./list";
import { staffDirectory } from "@/lib/domain/staff-directory";

/**
 * Bikes (SPEC §5; DATA-MODEL §2). A bike is permanent: its B- short ID is
 * assigned by the database and printed on its label, and it keeps it for
 * life. bikes.customer_id is the current owner; every owner change goes
 * through transfer_bike_ownership with a reason and leaves an ownership
 * event (a trigger writes it), so history is never rewritten. Staff edit
 * the descriptive fields directly under RLS; the column grants keep the
 * short ID, the owner and the inventory link out of plain updates.
 */

export type BikeListItem = {
  id: string;
  shortId: string;
  title: string;
  /** "Owner · colour · S/N …" */
  detail: string | null;
  archived: boolean;
};

export type BikeOwner = {
  id: string;
  label: string;
  phone: string | null;
  email: string | null;
  archived: boolean;
};

export type OwnershipEventType = Database["public"]["Enums"]["bike_ownership_event_type"];

/** One step of a bike's ownership history. `null` party = the shop. */
export type OwnershipEvent = {
  id: string;
  type: OwnershipEventType;
  from: { id: string; label: string } | null;
  to: { id: string; label: string } | null;
  reason: string | null;
  /** Null when the change was made outside the app (seed, SQL editor). */
  actorName: string | null;
  at: string;
};

export type BikeDetail = {
  id: string;
  shortId: string;
  title: string;
  brand: string;
  model: string;
  variant: string | null;
  frameSize: string | null;
  colour: string | null;
  serialNumber: string | null;
  description: string | null;
  /** Staff only; never in a customer projection. */
  internalNotes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  owner: BikeOwner | null;
  /** Newest first. */
  history: OwnershipEvent[];
};

export type BikeInput = {
  brand: string;
  model: string;
  variant: string | null;
  frameSize: string | null;
  colour: string | null;
  serialNumber: string | null;
  description: string | null;
  internalNotes: string | null;
};

const NOT_FOUND = "That bike no longer exists. Refresh and try again.";

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

/**
 * Bikes matching `q` (staff_search: short ID or serial number ignoring
 * case, spaces and dashes; brand, model, variant and colour words with the
 * owner's name), or the most recently updated ones when `q` is empty.
 * `archived` lists archived bikes instead, matched the same way. At most
 * `limit`; `more` says the list was cut off, so staff can narrow it.
 */
export async function listBikes(
  supabase: ServerSupabase,
  { q, archived = false, limit = 30 }: { q: string; archived?: boolean; limit?: number },
): Promise<ListPage<BikeListItem>> {
  if (q) {
    const hits =
      unwrap(
        await supabase.rpc("staff_search", {
          q,
          kinds: ["bike"],
          max_results: limit + 1,
          archived,
        }),
      ) ?? [];
    return {
      items: hits.slice(0, limit).map((h) => ({
        id: h.id,
        shortId: h.short_id,
        title: h.title,
        detail: h.subtitle,
        archived,
      })),
      more: hits.length > limit,
    };
  }

  let query = supabase
    .from("bikes")
    .select(
      "id, short_id, brand, model, variant, colour, serial_number, archived_at, owner:customers(first_name, last_name, display_name, email, phone)",
    );
  query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const rows =
    unwrap(
      await query
        .order(archived ? "archived_at" : "updated_at", { ascending: false })
        .limit(limit + 1),
    ) ?? [];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      shortId: r.short_id,
      title: bikeTitle(r),
      detail: bikeSubtitle({
        ownerLabel: r.owner ? labelOf(r.owner) : null,
        colour: r.colour,
        serialNumber: r.serial_number,
      }),
      archived: r.archived_at !== null,
    })),
    more: rows.length > limit,
  };
}

/** A bike with its current owner and ownership history, or null. */
export async function getBike(supabase: ServerSupabase, id: string): Promise<BikeDetail | null> {
  const [bikeResult, historyResult, directoryResult] = await Promise.all([
    supabase
      .from("bikes")
      .select(
        "id, short_id, brand, model, variant, frame_size, colour, serial_number, description, internal_notes, archived_at, created_at, updated_at, owner:customers(id, first_name, last_name, display_name, email, phone, archived_at)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("bike_ownership_events")
      .select(
        "id, event_type, reason, created_at, actor_staff_id, from:customers!bike_ownership_events_from_customer_id_fkey(id, first_name, last_name, display_name, email, phone), to:customers!bike_ownership_events_to_customer_id_fkey(id, first_name, last_name, display_name, email, phone)",
      )
      .eq("bike_id", id)
      .order("created_at", { ascending: false }),
    staffDirectory(supabase),
  ]);
  const row = unwrap(bikeResult);
  if (!row) return null;
  const events = unwrap(historyResult) ?? [];
  const names = new Map((unwrap(directoryResult) ?? []).map((s) => [s.id, s.display_name]));
  const party = (c: (NameColumns & { id: string }) | null) =>
    c ? { id: c.id, label: labelOf(c) } : null;

  return {
    id: row.id,
    shortId: row.short_id,
    title: bikeTitle(row),
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    frameSize: row.frame_size,
    colour: row.colour,
    serialNumber: row.serial_number,
    description: row.description,
    internalNotes: row.internal_notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: row.owner
      ? {
          id: row.owner.id,
          label: labelOf(row.owner),
          phone: row.owner.phone,
          email: row.owner.email,
          archived: row.owner.archived_at !== null,
        }
      : null,
    history: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      from: party(e.from),
      to: party(e.to),
      reason: e.reason,
      actorName: e.actor_staff_id ? (names.get(e.actor_staff_id) ?? "A former colleague") : null,
      at: e.created_at,
    })),
  };
}

const toRow = (input: BikeInput) => ({
  brand: input.brand,
  model: input.model,
  variant: input.variant,
  frame_size: input.frameSize,
  colour: input.colour,
  serial_number: input.serialNumber,
  description: input.description,
  internal_notes: input.internalNotes,
});

/**
 * Registers a bike, to a customer or to nobody (a shop or consigned bike).
 * The database assigns its short ID and, with an owner, writes the
 * `registered` ownership event. Uses the form's id as idempotency key, like
 * createCustomer.
 */
export async function createBike(
  supabase: ServerSupabase,
  id: string,
  input: BikeInput & { customerId: string | null },
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("bikes")
    .insert({ id, customer_id: input.customerId, ...toRow(input) })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "bikes_pkey") return { id };
    if (error.code === "23503") {
      throw new DomainError("That customer no longer exists. Choose another owner.", {
        customerId: ["That customer no longer exists."],
      });
    }
    throw new DbError(error);
  }
  return { id: data.id };
}

export async function updateBike(
  supabase: ServerSupabase,
  id: string,
  input: BikeInput,
): Promise<void> {
  const row = unwrap(
    await supabase.from("bikes").update(toRow(input)).eq("id", id).select("id").maybeSingle(),
  );
  if (!row) throw new DomainError(NOT_FOUND);
}

/** Archive or unarchive; replaying the current state changes nothing. */
export async function setBikeArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const update = supabase
    .from("bikes")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id);
  const row = unwrap(
    await (archived ? update.is("archived_at", null) : update.not("archived_at", "is", null))
      .select("id")
      .maybeSingle(),
  );
  if (row) return;
  const exists = unwrap(await supabase.from("bikes").select("id").eq("id", id).maybeSingle());
  if (!exists) throw new DomainError(NOT_FOUND);
}

/**
 * Moves a bike to another customer, or to the shop (`toCustomerId` null),
 * with a mandatory reason (RPC transfer_bike_ownership: one `transferred`
 * event with the actor and the reason; replaying the current owner is a
 * no-op; archived bikes and archived customers are refused).
 */
export async function transferBike(
  supabase: ServerSupabase,
  input: { bikeId: string; toCustomerId: string | null; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new DomainError("Say why the bike is changing owner.", {
      reason: ["Say why the bike is changing owner."],
    });
  }
  unwrap(
    await supabase.rpc("transfer_bike_ownership", {
      bike_id: input.bikeId,
      // null = the shop; the generated type does not know the SQL accepts it.
      to_customer_id: input.toCustomerId as string,
      reason,
    }),
  );
}
