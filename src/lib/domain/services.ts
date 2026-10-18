import "server-only";

import { classifyRates, type RateState } from "@/lib/cult-commons";
import { constraintOf, DbError, unwrap } from "@/lib/db-errors";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * The workshop's services (SPEC §9; DATA-MODEL §5), read side: what intake
 * and "Add service" offer. Every staff member reads the sale side from
 * `services` (its column grant leaves out default_direct_cost); the default
 * cost comes from `services_staff`, which returns rows only to view_costs
 * holders, and is asked for only when the caller holds it. Services change
 * only through the service RPCs (create_service, update_service,
 * set_service_archived: manage_inventory, a cost also view_costs, D14);
 * categories are written through the RLS client (manage_inventory); Cult
 * Commons rates only through their admin RPCs (D21).
 */

import { DomainError } from "./errors";
import { rethrowOnField } from "./lines";
import { staffDirectory } from "@/lib/domain/staff-directory";

export type ServiceOption = {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  /** "Other" when the service has no category. */
  categoryName: string;
  /** Default unit sale price, fixed-point ("200.00"). */
  salePrice: string;
  currency: string;
  /** Default unit direct cost: only for view_costs holders, never otherwise. */
  cost?: string;
};

const UNCATEGORISED = "Other";

/**
 * Active, unarchived services for pickers, by category (category order,
 * uncategorised last) then the service's own order and name. With
 * `viewCosts`, each carries its default cost.
 */
export async function listActiveServices(
  supabase: ServerSupabase,
  { viewCosts }: { viewCosts: boolean },
): Promise<ServiceOption[]> {
  const [servicesResult, costsResult] = await Promise.all([
    supabase
      .from("services")
      .select(
        "id, name, description, default_sale_price, currency, sort_order, category:categories(id, name, sort_order)",
      )
      .eq("active", true)
      .is("archived_at", null),
    viewCosts
      ? supabase
          .from("services_staff")
          .select("id, default_direct_cost")
          .eq("active", true)
          .is("archived_at", null)
      : Promise.resolve(null),
  ]);
  const rows = unwrap(servicesResult) ?? [];
  const costs = new Map<string, string>();
  if (costsResult) {
    for (const c of unwrap(costsResult) ?? []) {
      if (c.id && c.default_direct_cost !== null) {
        costs.set(c.id, toMoneyString(c.default_direct_cost));
      }
    }
  }
  const order = (r: (typeof rows)[number]) => r.category?.sort_order ?? Number.MAX_SAFE_INTEGER;
  return [...rows]
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        (a.category?.name ?? "").localeCompare(b.category?.name ?? "") ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name),
    )
    .map((r) => {
      const option: ServiceOption = {
        id: r.id,
        name: r.name,
        description: r.description,
        categoryId: r.category?.id ?? null,
        categoryName: r.category?.name ?? UNCATEGORISED,
        salePrice: toMoneyString(r.default_sale_price),
        currency: r.currency,
      };
      if (viewCosts) option.cost = costs.get(r.id) ?? "0.00";
      return option;
    });
}

/**
 * Active services whose name or category contains every word of `q`
 * (case-insensitive), at most `limit`. The catalog is small, so it is
 * filtered here rather than with a pattern in the query.
 */
export async function searchServices(
  supabase: ServerSupabase,
  q: string,
  { viewCosts, limit = 12 }: { viewCosts: boolean; limit?: number },
): Promise<ServiceOption[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = await listActiveServices(supabase, { viewCosts });
  return all
    .filter((s) => {
      const haystack = `${s.name} ${s.categoryName}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .slice(0, limit);
}

/**
 * The Cult Commons rate in force now (fraction, "0.3000"), for previews
 * only: each line snapshots the rate when the database adds it. Only
 * view_costs holders can read rates; null for anyone else or when none is set.
 */
export async function currentCultCommonsRate(supabase: ServerSupabase): Promise<string | null> {
  const row = unwrap(
    await supabase
      .from("cult_commons_rates")
      .select("rate")
      .is("cancelled_at", null)
      .lte("effective_from", new Date().toISOString())
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return row ? String(row.rate) : null;
}

// ---------------------------------------------------------------------------
// Settings: services (SPEC §9)
// ---------------------------------------------------------------------------

export type SettingsService = {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  salePrice: string;
  currency: string;
  active: boolean;
  public: boolean;
  archived: boolean;
  /** Default unit direct cost: only for view_costs holders. */
  cost?: string;
};

export type ServiceGroup = {
  categoryId: string | null;
  categoryName: string;
  services: SettingsService[];
};

/**
 * Every service (active and inactive; archived ones only with `archived`)
 * grouped by category in category order, uncategorised last. Costs only
 * with `viewCosts`, read from services_staff.
 */
export async function listServicesForSettings(
  supabase: ServerSupabase,
  { viewCosts, archived }: { viewCosts: boolean; archived: boolean },
): Promise<ServiceGroup[]> {
  let services = supabase
    .from("services")
    .select(
      "id, name, description, category_id, default_sale_price, currency, active, public, archived_at, sort_order, category:categories(id, name, sort_order)",
    );
  services = archived ? services.not("archived_at", "is", null) : services.is("archived_at", null);
  const [servicesResult, costsResult] = await Promise.all([
    services,
    viewCosts ? supabase.from("services_staff").select("id, default_direct_cost") : null,
  ]);
  const rows = unwrap(servicesResult) ?? [];
  const costs = new Map<string, string>();
  for (const c of costsResult ? (unwrap(costsResult) ?? []) : []) {
    if (c.id && c.default_direct_cost !== null)
      costs.set(c.id, toMoneyString(c.default_direct_cost));
  }
  const order = (r: (typeof rows)[number]) => r.category?.sort_order ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...rows].sort(
    (a, b) =>
      order(a) - order(b) ||
      (a.category?.name ?? "\uffff").localeCompare(b.category?.name ?? "\uffff") ||
      a.sort_order - b.sort_order ||
      a.name.localeCompare(b.name),
  );
  const groups: ServiceGroup[] = [];
  for (const r of sorted) {
    const categoryId = r.category?.id ?? null;
    let group = groups.at(-1);
    if (!group || group.categoryId !== categoryId) {
      group = { categoryId, categoryName: r.category?.name ?? UNCATEGORISED, services: [] };
      groups.push(group);
    }
    const service: SettingsService = {
      id: r.id,
      name: r.name,
      description: r.description,
      categoryId,
      salePrice: toMoneyString(r.default_sale_price),
      currency: r.currency,
      active: r.active,
      public: r.public,
      archived: r.archived_at !== null,
    };
    if (viewCosts) service.cost = costs.get(r.id) ?? "0.00";
    group.services.push(service);
  }
  return groups;
}

export type ServiceInput = {
  id: string;
  name: string;
  /** Fixed-point string. */
  salePrice: string;
  description: string | null;
  categoryId: string | null;
  /** Null: none on create (0), unchanged on update. Needs view_costs (the RPC refuses otherwise). */
  cost: string | null;
  active: boolean;
  public: boolean;
};

const SERVICE_FIELDS = {
  services_active_name_key: "name",
  service_conflict: "name",
  category_kind_mismatch: "categoryId",
};

/** Creates a service (RPC create_service); the id is the idempotency key. */
export async function createService(
  supabase: ServerSupabase,
  input: ServiceInput,
): Promise<{ id: string }> {
  try {
    const id = unwrap(
      await supabase.rpc("create_service", {
        service_id: input.id,
        name: input.name,
        default_sale_price: input.salePrice,
        description: input.description ?? undefined,
        category_id: input.categoryId ?? undefined,
        default_direct_cost: input.cost ?? undefined,
        is_active: input.active,
        is_public: input.public,
      }),
    );
    return { id: id ?? input.id };
  } catch (err) {
    rethrowOnField(err, SERVICE_FIELDS);
  }
}

/**
 * Replaces a service's fields (RPC update_service). Existing job lines keep
 * their snapshot: a new price or cost applies to lines added from now on.
 */
export async function updateService(
  supabase: ServerSupabase,
  input: ServiceInput,
): Promise<{ id: string }> {
  try {
    unwrap(
      await supabase.rpc("update_service", {
        service_id: input.id,
        name: input.name,
        default_sale_price: input.salePrice,
        description: input.description ?? undefined,
        category_id: input.categoryId ?? undefined,
        is_active: input.active,
        is_public: input.public,
        default_direct_cost: input.cost ?? undefined,
      }),
    );
    return { id: input.id };
  } catch (err) {
    rethrowOnField(err, SERVICE_FIELDS);
  }
}

/** Archives (hidden from pickers; history keeps it) or unarchives a service. */
export async function setServiceArchived(
  supabase: ServerSupabase,
  input: { id: string; archived: boolean },
): Promise<null> {
  try {
    unwrap(
      await supabase.rpc("set_service_archived", {
        service_id: input.id,
        archived: input.archived,
      }),
    );
    return null;
  } catch (err) {
    rethrowOnField(err, {});
  }
}

// ---------------------------------------------------------------------------
// Settings: service and product categories (RLS: read by staff, written by
// manage_inventory). Each kind is its own list: names are unique per kind,
// and a service or product is filed only under a category of its own kind.
// ---------------------------------------------------------------------------

export type Category = { id: string; name: string; archived: boolean };

export type CategoryKind = "service" | "product";

const CATEGORY_NOT_FOUND = "That category no longer exists. Refresh and try again.";
const CATEGORY_FIELDS = { categories_active_name_key: "name", categories_name_check: "name" };

/** Categories of one kind by their order then name; archived ones only when asked for. */
export async function listCategories(
  supabase: ServerSupabase,
  {
    includeArchived = false,
    kind = "service",
  }: { includeArchived?: boolean; kind?: CategoryKind } = {},
): Promise<Category[]> {
  let query = supabase
    .from("categories")
    .select("id, name, archived_at")
    .eq("kind", kind)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!includeArchived) query = query.is("archived_at", null);
  const rows = unwrap(await query) ?? [];
  return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archived_at !== null }));
}

/** Adds a category of one kind; the id is the idempotency key. */
export async function createCategory(
  supabase: ServerSupabase,
  input: { id: string; name: string; kind: CategoryKind },
): Promise<{ id: string }> {
  const { error } = await supabase
    .from("categories")
    .insert({ id: input.id, kind: input.kind, name: input.name });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "categories_pkey")
      return { id: input.id };
    rethrowOnField(new DbError(error), CATEGORY_FIELDS);
  }
  return { id: input.id };
}

/** Renames a category. Services, products and job lines refer to it by id. */
export async function updateCategory(
  supabase: ServerSupabase,
  input: { id: string; name: string; kind: CategoryKind },
): Promise<null> {
  const { data, error } = await supabase
    .from("categories")
    .update({ name: input.name })
    .eq("id", input.id)
    .eq("kind", input.kind)
    .select("id")
    .maybeSingle();
  if (error) rethrowOnField(new DbError(error), CATEGORY_FIELDS);
  if (!data) throw new DomainError(CATEGORY_NOT_FOUND);
  return null;
}

/**
 * Archives a category (hidden from the service or product form; what is
 * filed under it keeps it) or brings it back. Categories are never deleted.
 */
export async function setCategoryArchived(
  supabase: ServerSupabase,
  input: { id: string; archived: boolean; kind: CategoryKind },
): Promise<null> {
  const { data, error } = await supabase
    .from("categories")
    .update({ archived_at: input.archived ? new Date().toISOString() : null })
    .eq("id", input.id)
    .eq("kind", input.kind)
    .select("id")
    .maybeSingle();
  if (error) rethrowOnField(new DbError(error), CATEGORY_FIELDS);
  if (!data) throw new DomainError(CATEGORY_NOT_FOUND);
  return null;
}

// ---------------------------------------------------------------------------
// Settings: Cult Commons rates (D21; readable by view_costs, changed by admins)
// ---------------------------------------------------------------------------

export type CultCommonsRate = {
  id: string;
  /** Fraction, "0.3000". */
  rate: string;
  effectiveFrom: string;
  createdAt: string;
  /** Null for the base rate that shipped with the database. */
  createdByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  state: RateState;
};

/** Every rate, newest effective date first, with its standing now (classifyRates). */
export async function listCultCommonsRates(
  supabase: ServerSupabase,
  now: Date = new Date(),
): Promise<CultCommonsRate[]> {
  const [ratesResult, staffResult] = await Promise.all([
    supabase
      .from("cult_commons_rates")
      .select("id, rate, effective_from, created_at, created_by, cancelled_at, cancelled_by")
      .order("effective_from", { ascending: false })
      .limit(200),
    staffDirectory(supabase),
  ]);
  const names = new Map((unwrap(staffResult) ?? []).map((s) => [s.id, s.display_name]));
  const name = (id: string | null) => (id ? (names.get(id) ?? "A former colleague") : null);
  const rows = (unwrap(ratesResult) ?? []).map((r) => ({
    id: r.id,
    rate: Number(r.rate).toFixed(4),
    effectiveFrom: r.effective_from,
    createdAt: r.created_at,
    createdByName: name(r.created_by),
    cancelledAt: r.cancelled_at,
    cancelledByName: name(r.cancelled_by),
  }));
  return classifyRates(rows, now);
}

/**
 * Schedules a Cult Commons rate (RPC schedule_cult_commons_rate, admin):
 * from now (null) or a later time, never backdated. Lines added from then
 * on snapshot it; existing lines never change (D21). `rateId` is the
 * sheet's idempotency key, so a retried "start now" adds no second rate.
 */
export async function scheduleCultCommonsRate(
  supabase: ServerSupabase,
  input: { rateId: string; rate: string; effectiveFrom: Date | null },
): Promise<{ id: string; effectiveFrom: string }> {
  try {
    const row = unwrap(
      await supabase.rpc("schedule_cult_commons_rate", {
        rate_id: input.rateId,
        rate: input.rate,
        effective_from: input.effectiveFrom?.toISOString(),
      }),
    );
    if (!row) throw new DomainError("The rate was not saved. Try again.");
    return { id: row.id, effectiveFrom: row.effective_from };
  } catch (err) {
    rethrowOnField(err, {
      rate_backdated: "effectiveFrom",
      cult_commons_rates_effective_from_key: "effectiveFrom",
      cult_commons_rates_rate_check: "percent",
    });
  }
}

/** Withdraws a rate that has not started yet (RPC cancel_cult_commons_rate, admin, D21). */
export async function cancelCultCommonsRate(
  supabase: ServerSupabase,
  input: { rateId: string },
): Promise<null> {
  unwrap(await supabase.rpc("cancel_cult_commons_rate", { rate_id: input.rateId }));
  return null;
}
