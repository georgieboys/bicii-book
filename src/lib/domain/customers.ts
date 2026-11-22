import "server-only";

import { bikeDetails, bikeTitle } from "@/lib/bikes";
import { DbError, constraintOf, unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError, staleEdit } from "./errors";
import type { ListPage } from "./list";

/**
 * Customers (SPEC §4.1, §21; DATA-MODEL §2). Staff read and write the
 * customers table directly under RLS (active staff only; the column grants
 * leave out the Auth and Shopify links). Search goes through staff_search,
 * which leaves archived customers out; the archived list filters the table.
 * Soft delete only: archiving hides a customer from search and pickers and
 * stops new bikes being registered to them (customer_archived), and keeps
 * every historical reference.
 */

/** One row of a customer list or search result. */
export type CustomerListItem = {
  id: string;
  label: string;
  /** "email · phone" */
  detail: string | null;
  archived: boolean;
};

/** A bike on a customer's page. */
export type CustomerBike = {
  id: string;
  shortId: string;
  title: string;
  detail: string | null;
  archived: boolean;
};

export type CustomerDetail = {
  id: string;
  label: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  /** Staff only; never in a customer projection. */
  internalNotes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Bikes this customer owns now, oldest first. */
  bikes: CustomerBike[];
};

export type CustomerInput = {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  internalNotes: string | null;
};

const LIST_COLUMNS = "id, first_name, last_name, display_name, email, phone, archived_at";

const contactLine = (email: string | null, phone: string | null) =>
  [email, phone].filter(Boolean).join(" · ") || null;

const NOT_FOUND = "That customer no longer exists. Refresh and try again.";

/**
 * Customers matching `q` (staff_search: name words in any order, email,
 * phone digits), or the most recently updated ones when `q` is empty.
 * `archived` lists archived customers instead, matched the same way. At
 * most `limit`; `more` says the list was cut off, so staff can narrow it.
 */
export async function listCustomers(
  supabase: ServerSupabase,
  { q, archived = false, limit = 30 }: { q: string; archived?: boolean; limit?: number },
): Promise<ListPage<CustomerListItem>> {
  if (q) {
    const hits =
      unwrap(
        await supabase.rpc("staff_search", {
          q,
          kinds: ["customer"],
          max_results: limit + 1,
          archived,
        }),
      ) ?? [];
    return {
      items: hits.slice(0, limit).map((h) => ({
        id: h.id,
        label: h.title,
        detail: h.subtitle,
        archived,
      })),
      more: hits.length > limit,
    };
  }

  let query = supabase.from("customers").select(LIST_COLUMNS);
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
      label: customerLabel({
        firstName: r.first_name,
        lastName: r.last_name,
        displayName: r.display_name,
        email: r.email,
        phone: r.phone,
      }),
      detail: contactLine(r.email, r.phone),
      archived: r.archived_at !== null,
    })),
    more: rows.length > limit,
  };
}

/** A customer with the bikes they own now, or null when there is no such customer. */
export async function getCustomer(
  supabase: ServerSupabase,
  id: string,
): Promise<CustomerDetail | null> {
  const row = unwrap(
    await supabase
      .from("customers")
      .select(
        "id, first_name, last_name, display_name, email, phone, internal_notes, archived_at, created_at, updated_at, bikes(id, short_id, brand, model, variant, colour, serial_number, archived_at, created_at)",
      )
      .eq("id", id)
      .order("archived_at", { referencedTable: "bikes", ascending: true, nullsFirst: true })
      .order("created_at", { referencedTable: "bikes", ascending: true })
      .maybeSingle(),
  );
  if (!row) return null;
  const label = customerLabel({
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
  });
  return {
    id: row.id,
    label,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    internalNotes: row.internal_notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bikes: (row.bikes ?? []).map((b) => ({
      id: b.id,
      shortId: b.short_id,
      title: bikeTitle(b),
      detail: bikeDetails({ colour: b.colour, serialNumber: b.serial_number }),
      archived: b.archived_at !== null,
    })),
  };
}

const toRow = (input: CustomerInput) => ({
  first_name: input.firstName,
  last_name: input.lastName,
  display_name: input.displayName,
  email: input.email,
  phone: input.phone,
  internal_notes: input.internalNotes,
});

/**
 * Creates a customer with the id the form chose (its idempotency key): a
 * repeated submit of the same form finds the row it already made instead
 * of creating a duplicate person.
 */
export async function createCustomer(
  supabase: ServerSupabase,
  id: string,
  input: CustomerInput,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("customers")
    .insert({ id, ...toRow(input) })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "customers_pkey") return { id };
    throw new DbError(error);
  }
  return { id: data.id };
}

/**
 * Saves every field of the edit sheet, but only while the customer's
 * updated_at is still the one the sheet opened with: a stale sheet is
 * refused (STALE_EDIT) instead of silently reverting newer contact details
 * (audit A-11).
 */
export async function updateCustomer(
  supabase: ServerSupabase,
  id: string,
  input: CustomerInput,
  expectedUpdatedAt: string,
): Promise<void> {
  const row = unwrap(
    await supabase
      .from("customers")
      .update(toRow(input))
      .eq("id", id)
      .eq("updated_at", expectedUpdatedAt)
      .select("id")
      .maybeSingle(),
  );
  if (row) return;
  const exists = unwrap(await supabase.from("customers").select("id").eq("id", id).maybeSingle());
  throw exists ? staleEdit() : new DomainError(NOT_FOUND);
}

/**
 * Archive (hidden from search and pickers; no new bikes) or unarchive.
 * Replaying the current state changes nothing, so an archived customer
 * keeps the date they were first archived. The database stamps the date
 * itself (the value sent here is ignored) and refuses archiving while the
 * customer still has open work: the DbError maps customer_has_open_work
 * to its message (A-22, customers_guard_archive).
 */
export async function setCustomerArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const update = supabase
    .from("customers")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id);
  const row = unwrap(
    await (archived ? update.is("archived_at", null) : update.not("archived_at", "is", null))
      .select("id")
      .maybeSingle(),
  );
  if (row) return;
  const exists = unwrap(await supabase.from("customers").select("id").eq("id", id).maybeSingle());
  if (!exists) throw new DomainError(NOT_FOUND);
}

/** Options for a customer picker: active customers matching `q` (staff_search). */
export async function searchCustomerOptions(
  supabase: ServerSupabase,
  q: string,
): Promise<{ id: string; label: string; description?: string }[]> {
  const hits = unwrap(
    await supabase.rpc("staff_search", { q, kinds: ["customer"], max_results: 8 }),
  );
  return (hits ?? []).map((h) => ({
    id: h.id,
    label: h.title,
    description: h.subtitle ?? undefined,
  }));
}
