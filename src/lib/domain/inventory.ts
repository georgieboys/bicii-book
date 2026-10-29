import "server-only";

import type { Logger } from "pino";

import { bikeTitle } from "@/lib/bikes";
import { DbError, constraintOf, mapDbError, unwrap } from "@/lib/db-errors";
import {
  defaultLocation,
  type MovementType,
  type PublicationRequirements,
  type PublicationStatus,
  type TrackingType,
  type UnitStatus,
} from "@/lib/inventory";
import { sumMoney, toMoneyString } from "@/lib/money";
import type { Database } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { WorkOrderStatus } from "@/lib/workshop";

import { listPhotos, type Photo } from "./attachments";
import { DomainError } from "./errors";
import type { ListPage } from "./list";
import { staffSearch } from "./search";
import { staffNames } from "@/lib/domain/staff-directory";

/**
 * Inventory (SPEC §11, §12, §21, §22, §23; DATA-MODEL §6, §7, §15, §16;
 * PLAN D23 NEG-CONSUMPTION, D24 PART-PRICE-COST, D25 SOLD-AT-COMPLETION,
 * D26 PUBLICATION-MACHINE, D27 SHOP-OWNED-ONLY).
 *
 * A DTO mapper over RLS reads and the Phase 4 RPCs. Stock is the sum of the
 * ledger (reporting.stock_levels / product_stock); it changes only through
 * adjust_stock, transfer_stock, create_unique_unit, write_off_unit and
 * add_inventory_line, each with a client request id so a retry never
 * records twice. Product and unit details are plain RLS writes
 * (manage_inventory), checked again by the tables' triggers.
 *
 * Cost visibility (SPEC §4.2): products, inventory_units and
 * inventory_movements have no column grant on their cost columns, so this
 * module never selects `*` from them; it lists its columns. Costs, expected
 * yield and Cult Commons come only from product_costs,
 * inventory_unit_costs and inventory_movement_costs, and only when the
 * caller has view_costs: without it those keys are absent from the DTO
 * (undefined, not null), so there is nothing for a screen to hide.
 *
 * Displayed selling prices come from public.selling_prices (the single
 * private.selling_price source), never re-derived here, so Phase 6's
 * consignment asking price flows through with no app change. Edit forms
 * still edit products.default_sale_price and inventory_units.sale_price.
 *
 * Money arrives from PostgREST as JSON numbers and leaves as fixed-point
 * strings; amounts go to the database as strings.
 */

type Money = string;

const money = (v: number | string | null | undefined): Money | null =>
  v === null || v === undefined ? null : toMoneyString(v);

const PRODUCT_NOT_FOUND = "That product no longer exists. Refresh and try again.";
const UNIT_NOT_FOUND = "That unit no longer exists. Refresh and try again.";

/** Database refusals that belong to one field: rethrown as a DomainError on it. */
function rethrowFields(err: unknown, fields: Record<string, string>): never {
  if (err instanceof DbError) {
    const mapped = mapDbError(err);
    const field = mapped.reason ? fields[mapped.reason] : undefined;
    if (field && mapped.kind !== "unknown" && mapped.kind !== "unavailable") {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
  }
  throw err;
}

const PRODUCT_FIELDS: Record<string, string> = {
  products_sku_key_unique: "sku",
  products_sku_check: "sku",
  products_name_check: "name",
  products_description_check: "description",
  products_brand_check: "brand",
  products_default_sale_price_check: "salePrice",
  products_default_direct_cost_check: "cost",
  products_reorder_point_check: "reorderPoint",
  category_kind_mismatch: "categoryId",
};

const UNIT_FIELDS: Record<string, string> = {
  inventory_units_serial_number_check: "serialNumber",
  inventory_units_condition_check: "condition",
  inventory_units_internal_notes_check: "internalNotes",
  inventory_units_sale_price_check: "unitSalePrice",
  inventory_units_direct_cost_check: "unitCost",
  location_inactive: "locationId",
  location_required: "locationId",
  bike_has_owner: "bikeId",
  bike_already_linked: "bikeId",
  bike_archived: "bikeId",
  inventory_units_bike_id_key: "bikeId",
  reason_too_long: "reason",
};

const STOCK_FIELDS: Record<string, string> = {
  insufficient_stock: "quantity",
  consignment_quantity_unavailable: "quantity",
  quantity_invalid: "quantity",
  reason_required: "reason",
  reason_too_long: "reason",
  location_inactive: "locationId",
  transfer_same_location: "toLocationId",
  unit_location_mismatch: "fromLocationId",
};

const PART_FIELDS: Record<string, string> = {
  part_price_missing: "unitSalePrice",
  quantity_invalid: "quantity",
  location_inactive: "locationId",
  location_required: "locationId",
  unit_location_mismatch: "locationId",
};

const actorOf = (names: ReadonlyMap<string, string>, id: string | null) =>
  id ? (names.get(id) ?? "A former colleague") : null;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type Location = {
  id: string;
  name: string;
  kind: LocationKind;
  active: boolean;
  sortOrder: number;
};

export type LocationList = {
  /** Active first (sort order, name), then inactive ones. */
  locations: Location[];
  /** The active location with the lowest (sort_order, name): add_inventory_line's default. */
  defaultLocationId: string | null;
};

/** Every location, active and inactive, with the default one (null: none active). */
export async function listLocations(supabase: ServerSupabase): Promise<LocationList> {
  const rows =
    unwrap(
      await supabase
        .from("locations")
        .select("id, name, kind, active, sort_order")
        .order("active", { ascending: false })
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
    ) ?? [];
  const locations = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    active: r.active,
    sortOrder: r.sort_order,
  }));
  return { locations, defaultLocationId: defaultLocation(locations)?.id ?? null };
}

export type LocationKind = Database["public"]["Enums"]["location_kind"];

export type LocationInput = {
  /** The form's id: the idempotency key of a new location. */
  id: string;
  name: string;
  kind: LocationKind;
  sortOrder: number;
};

const LOCATION_FIELDS: Record<string, string> = {
  locations_name_key: "name",
  locations_name_check: "name",
};

const LOCATION_NOT_FOUND = "That location no longer exists. Refresh and try again.";

/**
 * Adds a stock location (a plain insert under RLS: manage_inventory). The
 * form's id is the idempotency key, like createProduct: a locations_pkey
 * conflict is the location a lost response already created.
 */
export async function createLocation(
  supabase: ServerSupabase,
  input: LocationInput,
): Promise<{ id: string }> {
  const { error } = await supabase.from("locations").insert({
    id: input.id,
    name: input.name,
    kind: input.kind,
    sort_order: input.sortOrder,
  });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "locations_pkey") return { id: input.id };
    rethrowFields(new DbError(error), LOCATION_FIELDS);
  }
  return { id: input.id };
}

/** Renames a location or changes its kind and sort order (RLS: manage_inventory). */
export async function updateLocation(
  supabase: ServerSupabase,
  input: LocationInput,
): Promise<void> {
  const { data, error } = await supabase
    .from("locations")
    .update({ name: input.name, kind: input.kind, sort_order: input.sortOrder })
    .eq("id", input.id)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error), LOCATION_FIELDS);
  if (!data) throw new DomainError(LOCATION_NOT_FOUND);
}

/**
 * Activates or deactivates a location. The locations trigger refuses to
 * deactivate one still holding stock (location_has_stock); replaying the
 * current state changes nothing.
 */
export async function setLocationActive(
  supabase: ServerSupabase,
  id: string,
  active: boolean,
): Promise<void> {
  const row = unwrap(
    await supabase.from("locations").update({ active }).eq("id", id).select("id").maybeSingle(),
  );
  if (!row) throw new DomainError(LOCATION_NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Product list
// ---------------------------------------------------------------------------

export type ProductFilter = "all" | "low" | "archived";

export type ProductListItem = {
  id: string;
  shortId: string;
  name: string;
  sku: string | null;
  brand: string | null;
  trackingType: TrackingType;
  /** Ledger on-hand across every location (D23: may be below zero). */
  onHand: number;
  /** Unique products: units available to sell. */
  availableUnits: number;
  /** Locations whose ledger is below zero ("recount needed"). */
  negativeLocations: number;
  reorderPoint: number | null;
  /** At or below the reorder point, or below zero anywhere (reporting.low_stock's rule). */
  low: boolean;
  publicationStatus: PublicationStatus;
  /** public.selling_prices; null when none is set. */
  salePrice: Money | null;
  currency: string;
  active: boolean;
  archived: boolean;
};

const LIST_COLUMNS =
  "id, short_id, name, sku, brand, tracking_type, publication_status, currency, reorder_point, active, archived_at, updated_at";

type ListRow = {
  id: string;
  short_id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  tracking_type: TrackingType;
  publication_status: PublicationStatus;
  currency: string;
  reorder_point: number | null;
  active: boolean;
  archived_at: string | null;
};

/** Product rows (explicit columns), their stock and selling prices, in `ids` order. */
async function productItems(
  supabase: ServerSupabase,
  ids: readonly string[],
  preloaded?: readonly ListRow[],
): Promise<ProductListItem[]> {
  if (ids.length === 0) return [];
  const [rowsResult, stockResult, priceResult] = await Promise.all([
    preloaded
      ? Promise.resolve({ data: [...preloaded], error: null })
      : supabase.from("products").select(LIST_COLUMNS).in("id", ids),
    supabase
      .schema("reporting")
      .from("product_stock")
      .select("product_id, on_hand, available_units, negative_locations, below_reorder")
      .in("product_id", ids),
    supabase
      .from("selling_prices")
      .select("product_id, selling_price")
      .is("inventory_unit_id", null)
      .in("product_id", ids),
  ]);
  const rows = new Map((unwrap(rowsResult) ?? []).map((r) => [r.id, r as ListRow]));
  const stock = new Map((unwrap(stockResult) ?? []).map((s) => [s.product_id, s]));
  const prices = new Map((unwrap(priceResult) ?? []).map((p) => [p.product_id, p.selling_price]));
  return ids.flatMap((id) => {
    const r = rows.get(id);
    if (!r) return [];
    const s = stock.get(id);
    const onHand = s?.on_hand ?? 0;
    const negativeLocations = s?.negative_locations ?? 0;
    return [
      {
        id: r.id,
        shortId: r.short_id,
        name: r.name,
        sku: r.sku,
        brand: r.brand,
        trackingType: r.tracking_type,
        onHand,
        availableUnits: s?.available_units ?? 0,
        negativeLocations,
        reorderPoint: r.reorder_point,
        low:
          r.tracking_type === "quantity" &&
          (s?.below_reorder === true || onHand < 0 || negativeLocations > 0),
        publicationStatus: r.publication_status,
        salePrice: money(prices.get(id)),
        currency: r.currency,
        active: r.active,
        archived: r.archived_at !== null,
      },
    ];
  });
}

/**
 * The Inventory list. With `q`: staff_search over products (P- number and
 * SKU exact first; the Archived filter searches archived products the same
 * way), then their stock. Without: the most recently updated products
 * (archived ones only under Archived). Low stock reads reporting.low_stock
 * (largest shortfall first; with `q`, the matches that are low).
 */
export async function listProducts(
  supabase: ServerSupabase,
  { q, filter = "all", limit = 30 }: { q: string; filter?: ProductFilter; limit?: number },
): Promise<ListPage<ProductListItem>> {
  if (q) {
    const hits = await staffSearch(supabase, q, {
      kinds: ["product"],
      limit: filter === "low" ? 100 : limit,
      archived: filter === "archived",
    });
    let ids = hits.items.map((h) => h.id);
    if (filter === "low") {
      const low = new Set(
        (
          unwrap(
            await supabase
              .schema("reporting")
              .from("low_stock")
              .select("product_id")
              .in("product_id", ids),
          ) ?? []
        ).map((r) => r.product_id),
      );
      ids = ids.filter((id) => low.has(id));
      return { items: await productItems(supabase, ids.slice(0, limit)), more: ids.length > limit };
    }
    return { items: await productItems(supabase, ids), more: hits.more };
  }

  if (filter === "low") {
    const rows =
      unwrap(
        await supabase
          .schema("reporting")
          .from("low_stock")
          .select("product_id")
          .limit(limit + 1),
      ) ?? [];
    const ids = rows.map((r) => r.product_id).filter((v): v is string => !!v);
    return { items: await productItems(supabase, ids.slice(0, limit)), more: ids.length > limit };
  }

  let query = supabase.from("products").select(LIST_COLUMNS);
  query =
    filter === "archived" ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const rows =
    unwrap(
      await query
        .order(filter === "archived" ? "archived_at" : "updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(limit + 1),
    ) ?? [];
  const shown = rows.slice(0, limit);
  return {
    items: await productItems(
      supabase,
      shown.map((r) => r.id),
      shown,
    ),
    more: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export type Movement = {
  id: number;
  at: string;
  type: MovementType;
  /** Signed: + in, − out. */
  quantity: number;
  product: { id: string; shortId: string; name: string };
  unit: { id: string; shortId: string } | null;
  location: { id: string; name: string };
  /** Null when recorded outside the app (seed, SQL editor). */
  actorName: string | null;
  reason: string | null;
  job: { id: string; jobNumber: string } | null;
  /** This row reverses movement #id. */
  reversesId: number | null;
  /** Movement #id reverses this row. */
  reversedById: number | null;
  currency: string;
  /** The unit cost snapshot; only for view_costs holders (absent otherwise). */
  unitCost?: Money | null;
};

export type MovementQuery = {
  productId?: string;
  unitId?: string;
  locationId?: string;
  types?: readonly MovementType[] | null;
  /** Keyset: only movements with a smaller id ("Load more"). */
  before?: number;
  limit?: number;
};

export type MovementPage = {
  items: Movement[];
  /** Pass as `before` for the next page; null when there are no more. */
  nextBefore: number | null;
};

const MOVEMENT_COLUMNS =
  "id, created_at, movement_type, quantity_delta, reason, created_by, reversal_of_id, currency, work_order_id, product:products(id, short_id, name), unit:inventory_units(id, short_id), location:locations(id, name), job:work_orders(id, job_number)";

/** Newest first (id desc), keyset by id; each row with its actor, job and reversal links. */
export async function listMovements(
  supabase: ServerSupabase,
  { productId, unitId, locationId, types, before, limit = 50 }: MovementQuery,
  { viewCosts }: { viewCosts: boolean },
): Promise<MovementPage> {
  let query = supabase.from("inventory_movements").select(MOVEMENT_COLUMNS);
  if (productId) query = query.eq("product_id", productId);
  if (unitId) query = query.eq("inventory_unit_id", unitId);
  if (locationId) query = query.eq("location_id", locationId);
  if (types && types.length > 0) query = query.in("movement_type", [...types]);
  if (before !== undefined) query = query.lt("id", before);
  const [rowsResult, names] = await Promise.all([
    query.order("id", { ascending: false }).limit(limit + 1),
    staffNames(supabase),
  ]);
  const rows = (unwrap(rowsResult) ?? []).slice(0, limit);
  const more = (unwrap(rowsResult) ?? []).length > limit;
  const ids = rows.map((r) => r.id);
  const [reversalsResult, costsResult] = await Promise.all([
    ids.length > 0
      ? supabase.from("inventory_movements").select("id, reversal_of_id").in("reversal_of_id", ids)
      : Promise.resolve({
          data: [] as { id: number; reversal_of_id: number | null }[],
          error: null,
        }),
    viewCosts && ids.length > 0
      ? supabase
          .from("inventory_movement_costs")
          .select("movement_id, unit_cost_snapshot")
          .in("movement_id", ids)
      : Promise.resolve({
          data: [] as { movement_id: number | null; unit_cost_snapshot: number | null }[],
          error: null,
        }),
  ]);
  const reversedBy = new Map(
    (unwrap(reversalsResult) ?? []).map((r) => [r.reversal_of_id, r.id] as const),
  );
  const costs = new Map(
    (unwrap(costsResult) ?? []).map((c) => [c.movement_id, c.unit_cost_snapshot] as const),
  );
  return {
    items: rows.map((r) => {
      const m: Movement = {
        id: r.id,
        at: r.created_at,
        type: r.movement_type,
        quantity: r.quantity_delta,
        product: {
          id: r.product?.id ?? "",
          shortId: r.product?.short_id ?? "",
          name: r.product?.name ?? "",
        },
        unit: r.unit ? { id: r.unit.id, shortId: r.unit.short_id } : null,
        location: { id: r.location?.id ?? "", name: r.location?.name ?? "" },
        actorName: actorOf(names, r.created_by),
        reason: r.reason,
        job: r.job ? { id: r.job.id, jobNumber: r.job.job_number } : null,
        reversesId: r.reversal_of_id,
        reversedById: reversedBy.get(r.id) ?? null,
        currency: r.currency,
      };
      if (viewCosts) m.unitCost = money(costs.get(r.id));
      return m;
    }),
    nextBefore: more && rows.length > 0 ? rows[rows.length - 1].id : null,
  };
}

// ---------------------------------------------------------------------------
// Product detail
// ---------------------------------------------------------------------------

/**
 * What anonymous visitors see for one short ID: its reporting.public_items
 * row (the only anonymous inventory surface, D9/D26), or null when it is
 * not public. Read as staff through the same view, so the preview is the
 * row Phase 11's public /q page will render, not a re-derivation.
 */
export type PublicPreview = {
  kind: "product" | "unit";
  shortId: string;
  slug: string | null;
  name: string;
  salePrice: Money | null;
  currency: string;
  /** available, sold_out, sold or unavailable. */
  availability: string;
  /** Units only. */
  condition: string | null;
  photoCount: number;
};

async function publicPreview(
  supabase: ServerSupabase,
  kind: "product" | "unit",
  shortId: string,
): Promise<PublicPreview | null> {
  const row = unwrap(
    await supabase
      .schema("reporting")
      .from("public_items")
      .select("kind, short_id, slug, name, sale_price, currency, availability, condition, photos")
      .eq("kind", kind)
      .eq("short_id", shortId)
      .maybeSingle(),
  );
  if (!row) return null;
  return {
    kind,
    shortId: row.short_id ?? shortId,
    slug: row.slug,
    name: row.name ?? "",
    salePrice: money(row.sale_price),
    currency: row.currency ?? "SGD",
    availability: row.availability ?? "unavailable",
    condition: row.condition,
    photoCount: Array.isArray(row.photos) ? row.photos.length : 0,
  };
}

export type HistoryEntry = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  reason: string | null;
  actorName: string | null;
  at: string;
};

export type StockAtLocation = {
  locationId: string;
  name: string;
  active: boolean;
  onHand: number;
};

export type ProductUnit = {
  id: string;
  shortId: string;
  status: UnitStatus;
  location: { id: string; name: string };
  serialNumber: string | null;
  salePrice: Money | null;
  archived: boolean;
};

export type ProductDetail = {
  id: string;
  shortId: string;
  name: string;
  sku: string | null;
  brand: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  trackingType: TrackingType;
  ownershipType: string;
  publicationStatus: PublicationStatus;
  publicSlug: string | null;
  currency: string;
  /** The editable default (products.default_sale_price). */
  defaultSalePrice: Money | null;
  /** What it sells for (public.selling_prices). */
  salePrice: Money | null;
  reorderPoint: number | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Every active location (0 when none) plus inactive ones holding stock. */
  stock: StockAtLocation[];
  onHand: number;
  availableUnits: number;
  heldUnits: number;
  negativeLocations: number;
  low: boolean;
  /** Unique products only (empty otherwise), oldest first. */
  units: ProductUnit[];
  /** The latest 20. */
  movements: Movement[];
  moreMovements: boolean;
  /** Newest first. */
  history: HistoryEntry[];
  photos: Photo[];
  /** Its reporting.public_items row (kind 'product'); null while not public. */
  publicPreview: PublicPreview | null;
  /**
   * What publishing needs (D26), from the data loaded here; mirrors
   * private.publication_requirements_met, which stays the authority.
   */
  requirements: PublicationRequirements;
  /** view_costs only (absent otherwise). The product's own cost field. */
  cost?: Money | null;
  /**
   * view_costs only. What one sells at cost: shop stock, the product's
   * cost; consigned stock, the amount owed on the consignment that sells
   * next (D44), which Edit terms changes.
   */
  effectiveCost?: Money | null;
  expectedYield?: Money | null;
  expectedCultCommons?: Money | null;
};

const PRODUCT_COLUMNS =
  "id, short_id, sku, name, description, brand, tracking_type, ownership_type, publication_status, public_slug, default_sale_price, currency, reorder_point, active, archived_at, created_at, updated_at, category:categories(id, name)";

const asPayload = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** One product with its stock, units, recent movements, history and photos; null if unknown. */
export async function getProduct(
  supabase: ServerSupabase,
  id: string,
  { viewCosts }: { viewCosts: boolean },
): Promise<ProductDetail | null> {
  const row = unwrap(
    await supabase.from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!row) return null;
  const [
    locations,
    levelsResult,
    stockResult,
    priceResult,
    unitsResult,
    eventsResult,
    names,
    movements,
    photos,
    costsResult,
    preview,
  ] = await Promise.all([
    listLocations(supabase),
    supabase
      .schema("reporting")
      .from("stock_levels")
      .select("location_id, on_hand")
      .eq("product_id", id),
    supabase
      .schema("reporting")
      .from("product_stock")
      .select("on_hand, available_units, held_units, negative_locations, below_reorder")
      .eq("product_id", id)
      .maybeSingle(),
    supabase.from("selling_prices").select("inventory_unit_id, selling_price").eq("product_id", id),
    row.tracking_type === "unique"
      ? supabase
          .from("inventory_units")
          .select(
            "id, short_id, status, serial_number, archived_at, bike_id, location:locations(id, name)",
          )
          .eq("product_id", id)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("product_events")
      .select("id, event_type, payload, reason, actor_staff_id, created_at")
      .eq("product_id", id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(100),
    staffNames(supabase),
    listMovements(supabase, { productId: id, limit: 20 }, { viewCosts }),
    listPhotos(supabase, { entityType: "product", entityId: id }),
    viewCosts
      ? supabase
          .from("product_costs")
          .select("default_direct_cost, effective_cost, expected_yield, expected_cult_commons")
          .eq("product_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    publicPreview(supabase, "product", row.short_id),
  ]);
  const levels = new Map(
    (unwrap(levelsResult) ?? []).map((l) => [l.location_id, l.on_hand ?? 0] as const),
  );
  const stock = locations.locations
    .filter((l) => l.active || (levels.get(l.id) ?? 0) !== 0)
    .map((l) => ({
      locationId: l.id,
      name: l.name,
      active: l.active,
      onHand: levels.get(l.id) ?? 0,
    }));
  const totals = unwrap(stockResult);
  const prices = unwrap(priceResult) ?? [];
  const productPrice = prices.find((p) => p.inventory_unit_id === null)?.selling_price;
  const unitPrice = new Map(prices.map((p) => [p.inventory_unit_id, p.selling_price] as const));
  const onHand = totals?.on_hand ?? 0;
  const negativeLocations = totals?.negative_locations ?? 0;
  const unitRows = unwrap(unitsResult) ?? [];

  // The D26 requirements, as private.publication_requirements_met checks
  // them: a selling price (for a unique product, on every available unit),
  // a public photo on the product, one of its units or a linked bike, and
  // for a unique product an available unit. The name is always set (the
  // column is required).
  const available = unitRows.filter((u) => u.status === "available" && u.archived_at === null);
  const unique = row.tracking_type === "unique";
  let publicPhoto = photos.some((p) => p.visibility === "public");
  const others = unique
    ? [...unitRows.map((u) => u.id), ...unitRows.flatMap((u) => (u.bike_id ? [u.bike_id] : []))]
    : [];
  if (!publicPhoto && others.length > 0) {
    const { count, error } = await supabase
      .from("attachments")
      .select("id", { count: "exact", head: true })
      .eq("visibility", "public")
      .in("entity_type", ["inventory_unit", "bike"])
      .in("entity_id", others);
    if (error) throw new DbError(error);
    publicPhoto = (count ?? 0) > 0;
  }
  const requirements: PublicationRequirements = {
    name: row.name.trim() !== "",
    price: unique
      ? available.length > 0
        ? available.every((u) => unitPrice.get(u.id) != null)
        : productPrice != null
      : productPrice != null,
    publicPhoto,
    ...(unique ? { availableUnit: available.length > 0 } : {}),
  };

  const detail: ProductDetail = {
    id: row.id,
    shortId: row.short_id,
    name: row.name,
    sku: row.sku,
    brand: row.brand,
    description: row.description,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    trackingType: row.tracking_type,
    ownershipType: row.ownership_type,
    publicationStatus: row.publication_status,
    publicSlug: row.public_slug,
    currency: row.currency,
    defaultSalePrice: money(row.default_sale_price),
    salePrice: money(productPrice),
    reorderPoint: row.reorder_point,
    active: row.active,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stock,
    onHand,
    availableUnits: totals?.available_units ?? 0,
    heldUnits: totals?.held_units ?? 0,
    negativeLocations,
    low:
      row.tracking_type === "quantity" &&
      (totals?.below_reorder === true || onHand < 0 || negativeLocations > 0),
    units: unitRows.map((u) => ({
      id: u.id,
      shortId: u.short_id,
      status: u.status,
      location: { id: u.location?.id ?? "", name: u.location?.name ?? "" },
      serialNumber: u.serial_number,
      salePrice: money(unitPrice.get(u.id)),
      archived: u.archived_at !== null,
    })),
    movements: movements.items,
    moreMovements: movements.nextBefore !== null,
    history: (unwrap(eventsResult) ?? []).map((e) => ({
      id: e.id,
      type: e.event_type,
      payload: asPayload(e.payload),
      reason: e.reason,
      actorName: actorOf(names, e.actor_staff_id),
      at: e.created_at,
    })),
    photos,
    publicPreview: preview,
    requirements,
  };
  if (viewCosts) {
    const costs = unwrap(costsResult);
    detail.cost = money(costs?.default_direct_cost);
    detail.effectiveCost = money(costs?.effective_cost);
    detail.expectedYield = money(costs?.expected_yield);
    detail.expectedCultCommons = money(costs?.expected_cult_commons);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Unit detail
// ---------------------------------------------------------------------------

export type UnitDetail = {
  id: string;
  shortId: string;
  status: UnitStatus;
  ownershipType: string;
  serialNumber: string | null;
  condition: string | null;
  internalNotes: string | null;
  /** The editable override (inventory_units.sale_price). */
  ownSalePrice: Money | null;
  /** What it sells for (public.selling_prices: the unit's price, else the product's). */
  salePrice: Money | null;
  soldAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  product: {
    id: string;
    shortId: string;
    name: string;
    sku: string | null;
    currency: string;
    archived: boolean;
    /** A unit's public listing follows its product's publication. */
    publicationStatus: PublicationStatus;
  };
  location: { id: string; name: string; active: boolean };
  bike: { id: string; shortId: string; title: string } | null;
  /** The job its live line is on (held while open, sold once completed, D25). */
  job: { id: string; jobNumber: string; status: WorkOrderStatus } | null;
  movements: Movement[];
  history: HistoryEntry[];
  photos: Photo[];
  /** Its reporting.public_items row (kind 'unit'); null while its product is not public. */
  publicPreview: PublicPreview | null;
  /** view_costs only (absent otherwise). */
  cost?: Money | null;
  effectiveCost?: Money | null;
  expectedYield?: Money | null;
  expectedCultCommons?: Money | null;
};

const UNIT_COLUMNS =
  "id, short_id, status, ownership_type, serial_number, condition, internal_notes, sale_price, sold_at, archived_at, created_at, product:products(id, short_id, name, sku, currency, archived_at, publication_status), location:locations(id, name, active), bike:bikes!inventory_units_bike_id_fkey(id, short_id, brand, model, variant)";

/** One unit with its product, location, bike, job, movements, history and photos; null if unknown. */
export async function getUnit(
  supabase: ServerSupabase,
  id: string,
  { viewCosts }: { viewCosts: boolean },
): Promise<UnitDetail | null> {
  const row = unwrap(
    await supabase.from("inventory_units").select(UNIT_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!row || !row.product || !row.location) return null;
  const [priceResult, lineResult, eventsResult, names, movements, photos, costsResult, preview] =
    await Promise.all([
      supabase
        .from("selling_prices")
        .select("selling_price")
        .eq("inventory_unit_id", id)
        .maybeSingle(),
      supabase
        .from("work_order_line_items")
        .select("id, job:work_orders(id, job_number, status)")
        .eq("source_inventory_unit_id", id)
        .is("voided_at", null)
        .maybeSingle(),
      supabase
        .from("inventory_unit_events")
        .select("id, event_type, payload, reason, actor_staff_id, created_at")
        .eq("unit_id", id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(100),
      staffNames(supabase),
      listMovements(supabase, { unitId: id, limit: 50 }, { viewCosts }),
      listPhotos(supabase, { entityType: "inventory_unit", entityId: id }),
      viewCosts
        ? supabase
            .from("inventory_unit_costs")
            .select("direct_cost, effective_cost, expected_yield, expected_cult_commons")
            .eq("unit_id", id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      publicPreview(supabase, "unit", row.short_id),
    ]);
  const line = unwrap(lineResult);
  const detail: UnitDetail = {
    id: row.id,
    shortId: row.short_id,
    status: row.status,
    ownershipType: row.ownership_type,
    serialNumber: row.serial_number,
    condition: row.condition,
    internalNotes: row.internal_notes,
    ownSalePrice: money(row.sale_price),
    salePrice: money(unwrap(priceResult)?.selling_price),
    soldAt: row.sold_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    product: {
      id: row.product.id,
      shortId: row.product.short_id,
      name: row.product.name,
      sku: row.product.sku,
      currency: row.product.currency,
      archived: row.product.archived_at !== null,
      publicationStatus: row.product.publication_status,
    },
    location: { id: row.location.id, name: row.location.name, active: row.location.active },
    bike: row.bike
      ? { id: row.bike.id, shortId: row.bike.short_id, title: bikeTitle(row.bike) }
      : null,
    job: line?.job
      ? { id: line.job.id, jobNumber: line.job.job_number, status: line.job.status }
      : null,
    movements: movements.items,
    history: (unwrap(eventsResult) ?? []).map((e) => ({
      id: e.id,
      type: e.event_type,
      payload: asPayload(e.payload),
      reason: e.reason,
      actorName: actorOf(names, e.actor_staff_id),
      at: e.created_at,
    })),
    photos,
    publicPreview: preview,
  };
  if (viewCosts) {
    const costs = unwrap(costsResult);
    detail.cost = money(costs?.direct_cost);
    detail.effectiveCost = money(costs?.effective_cost);
    detail.expectedYield = money(costs?.expected_yield);
    detail.expectedCultCommons = money(costs?.expected_cult_commons);
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Product categories (kind 'product')
// ---------------------------------------------------------------------------

export type ProductCategory = { id: string; name: string };

/** Active product categories by their order, then name (fewer than 15: a Select). */
export async function listProductCategories(supabase: ServerSupabase): Promise<ProductCategory[]> {
  const rows =
    unwrap(
      await supabase
        .from("categories")
        .select("id, name")
        .eq("kind", "product")
        .is("archived_at", null)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
    ) ?? [];
  return rows;
}

// ---------------------------------------------------------------------------
// Writes: products and units
// ---------------------------------------------------------------------------

export type ProductInput = {
  name: string;
  sku: string | null;
  brand: string | null;
  categoryId: string | null;
  description: string | null;
  /** products.default_sale_price; null: no default. */
  salePrice: Money | null;
  /** products.default_direct_cost; view_costs only. On edit, null keeps the current cost. */
  cost: Money | null;
  /** Quantity products only. */
  reorderPoint: number | null;
  active: boolean;
};

const productRow = (input: ProductInput) => ({
  name: input.name,
  sku: input.sku,
  brand: input.brand,
  category_id: input.categoryId,
  description: input.description,
  default_sale_price: input.salePrice as unknown as number | null,
  reorder_point: input.reorderPoint,
  active: input.active,
});

/**
 * Creates a product (a plain insert under RLS: manage_inventory; the
 * database assigns its P- number and starts it as a draft, D26). The form's
 * id is the idempotency key, like createBike: a products_pkey conflict is
 * the product a lost response already created.
 */
export async function createProduct(
  supabase: ServerSupabase,
  id: string,
  input: ProductInput & { trackingType: TrackingType },
): Promise<{ id: string }> {
  const { error } = await supabase.from("products").insert({
    id,
    tracking_type: input.trackingType,
    ...productRow({
      ...input,
      reorderPoint: input.trackingType === "quantity" ? input.reorderPoint : null,
    }),
    ...(input.cost !== null ? { default_direct_cost: input.cost as unknown as number } : {}),
  });
  if (error) {
    if (error.code === "23505" && constraintOf(error) === "products_pkey") return { id };
    rethrowFields(new DbError(error), PRODUCT_FIELDS);
  }
  return { id };
}

/** Edits a product's details; its tracking type, P- number and publication never change here. */
export async function updateProduct(
  supabase: ServerSupabase,
  id: string,
  input: ProductInput,
): Promise<void> {
  const { data, error } = await supabase
    .from("products")
    .update({
      ...productRow(input),
      ...(input.cost !== null ? { default_direct_cost: input.cost as unknown as number } : {}),
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error), PRODUCT_FIELDS);
  if (!data) throw new DomainError(PRODUCT_NOT_FOUND);
}

/**
 * Archive or unarchive; replaying the current state changes nothing. The
 * products trigger refuses archiving a published product
 * (product_published) or one still holding stock (product_has_stock).
 */
export async function setProductArchived(
  supabase: ServerSupabase,
  id: string,
  archived: boolean,
): Promise<void> {
  const update = supabase
    .from("products")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id);
  const row = unwrap(
    await (archived ? update.is("archived_at", null) : update.not("archived_at", "is", null))
      .select("id")
      .maybeSingle(),
  );
  if (row) return;
  const exists = unwrap(await supabase.from("products").select("id").eq("id", id).maybeSingle());
  if (!exists) throw new DomainError(PRODUCT_NOT_FOUND);
}

export type UnitInput = {
  locationId: string;
  serialNumber: string | null;
  /** Shown publicly once the product is published. */
  condition: string | null;
  /** inventory_units.sale_price; null: the product's price. */
  salePrice: Money | null;
  /** inventory_units.direct_cost; view_costs only; null: the product's default cost. */
  cost: Money | null;
  /** A shop bike (no owner, not yet in stock) this unit is. */
  bikeId: string | null;
};

/**
 * Registers a shop-owned unit of a unique product (create_unique_unit, D27)
 * with its +1 movement; the unit id from the form is its idempotency key.
 */
export async function addUnit(
  supabase: ServerSupabase,
  input: UnitInput & { unitId: string; productId: string },
): Promise<{ id: string; shortId: string }> {
  try {
    const result = unwrap(
      await supabase.rpc("create_unique_unit", {
        unit_id: input.unitId,
        product_id: input.productId,
        location_id: input.locationId,
        serial_number: input.serialNumber ?? undefined,
        condition: input.condition ?? undefined,
        sale_price: input.salePrice ?? undefined,
        direct_cost: input.cost ?? undefined,
        bike_id: input.bikeId ?? undefined,
      }),
    );
    return { id: result?.unit_id ?? input.unitId, shortId: result?.short_id ?? "" };
  } catch (err) {
    rethrowFields(err, UNIT_FIELDS);
  }
}

/**
 * A unique item in one go: the product (its form id, idempotent), then its
 * first unit (create_unique_unit, idempotent by the unit id). If the second
 * step fails the product exists, and its page offers "Add unit"; the
 * returned `unitError` says why. The action still succeeds (the product was
 * saved), so the swallowed failure is logged here with its kind, code and
 * error, at error level for infrastructure failures (unknown, unavailable)
 * and warn for refusals, as staffAction would have logged it (ADR-001 A2).
 */
export async function createUniqueItem(
  supabase: ServerSupabase,
  input: { productId: string; unitId: string; product: ProductInput; unit: UnitInput },
  log: Pick<Logger, "warn" | "error">,
): Promise<{
  productId: string;
  unit: { id: string; shortId: string } | null;
  unitError: string | null;
}> {
  await createProduct(supabase, input.productId, { ...input.product, trackingType: "unique" });
  try {
    const unit = await addUnit(supabase, {
      ...input.unit,
      unitId: input.unitId,
      productId: input.productId,
    });
    return { productId: input.productId, unit, unitError: null };
  } catch (err) {
    if (err instanceof DomainError) {
      log.warn(
        { outcome: "unit_rejected", productId: input.productId, reason: err.message },
        "unique item saved without its unit",
      );
      return { productId: input.productId, unit: null, unitError: err.message };
    }
    const mapped = mapDbError(err);
    log[mapped.kind === "unknown" || mapped.kind === "unavailable" ? "error" : "warn"](
      {
        outcome: "unit_failed",
        productId: input.productId,
        kind: mapped.kind,
        code: mapped.code,
        reason: mapped.reason,
        err,
      },
      "unique item saved without its unit",
    );
    return { productId: input.productId, unit: null, unitError: mapped.message };
  }
}

export type UnitEdit = {
  serialNumber: string | null;
  condition: string | null;
  salePrice: Money | null;
  /** view_costs only; null keeps the current cost. */
  cost: Money | null;
  internalNotes: string | null;
};

/** Edits a unit's details under RLS (manage_inventory); status, location and bike change only through RPCs. */
export async function updateUnit(
  supabase: ServerSupabase,
  id: string,
  input: UnitEdit,
): Promise<void> {
  const { data, error } = await supabase
    .from("inventory_units")
    .update({
      serial_number: input.serialNumber,
      condition: input.condition,
      sale_price: input.salePrice as unknown as number | null,
      internal_notes: input.internalNotes,
      ...(input.cost !== null ? { direct_cost: input.cost as unknown as number } : {}),
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) rethrowFields(new DbError(error), UNIT_FIELDS);
  if (!data) throw new DomainError(UNIT_NOT_FOUND);
}

/**
 * Writes off an available or reserved unit with a reason (write_off_unit:
 * a `damaged` movement of −1); replay-safe by the request id made when the
 * confirmation opened.
 */
export async function writeOffUnit(
  supabase: ServerSupabase,
  requestId: string,
  unitId: string,
  reason: string,
): Promise<void> {
  const cleaned = reason.trim();
  if (!cleaned) {
    throw new DomainError("Say why the unit is being written off.", {
      reason: ["Say why the unit is being written off."],
    });
  }
  try {
    unwrap(
      await supabase.rpc("write_off_unit", {
        request_id: requestId,
        unit_id: unitId,
        reason: cleaned,
      }),
    );
  } catch (err) {
    rethrowFields(err, { reason_required: "reason", reason_too_long: "reason" });
  }
}

// ---------------------------------------------------------------------------
// Publication (D26) and splits (D28)
// ---------------------------------------------------------------------------

/**
 * Changes a product's publication by hand (set_publication_status,
 * manage_inventory). The database decides every move: 'sold' is never
 * chosen by hand and a sold product only archives (publication_sold_by_sale);
 * entering public needs a price, a public photo and, for a unique product,
 * an available unit (publication_requires_*). Their mapped messages reach
 * the card. The slug is assigned at first publish and never changes.
 */
export async function setPublicationStatus(
  supabase: ServerSupabase,
  productId: string,
  status: PublicationStatus,
  reason?: string | null,
): Promise<{ status: PublicationStatus; slug: string | null }> {
  const result = unwrap(
    await supabase.rpc("set_publication_status", {
      product_id: productId,
      status,
      reason: reason?.trim() || undefined,
    }),
  );
  return { status: result?.publication_status ?? status, slug: result?.public_slug ?? null };
}

export type SplitInput = {
  /** Both made with newId() when the sheet opens: the replay keys. */
  newProductId: string;
  unitId: string;
  sourceProductId: string;
  locationId: string;
  name: string;
  reason: string;
  serialNumber: string | null;
  condition: string | null;
  salePrice: Money | null;
};

const SPLIT_FIELDS: Record<string, string> = {
  reason_required: "reason",
  reason_too_long: "reason",
  insufficient_stock: "locationId",
  location_inactive: "locationId",
  products_name_check: "name",
  products_default_sale_price_check: "salePrice",
  inventory_units_serial_number_check: "serialNumber",
  inventory_units_condition_check: "condition",
};

/**
 * Takes one counted item out of stock as a new draft unique product and
 * unit at the same location (split_unit_from_stock, D28: adjust_stock and
 * manage_inventory; the unit carries the source's default cost). Replay
 * returns the same pair.
 */
export async function splitToUnique(
  supabase: ServerSupabase,
  input: SplitInput,
): Promise<{ productId: string; productShortId: string; unitId: string; unitShortId: string }> {
  try {
    const result = unwrap(
      await supabase.rpc("split_unit_from_stock", {
        new_product_id: input.newProductId,
        unit_id: input.unitId,
        source_product_id: input.sourceProductId,
        location_id: input.locationId,
        name: input.name,
        reason: input.reason,
        serial_number: input.serialNumber ?? undefined,
        condition: input.condition ?? undefined,
        sale_price: input.salePrice ?? undefined,
      }),
    );
    return {
      productId: result?.product_id ?? input.newProductId,
      productShortId: result?.product_short_id ?? "",
      unitId: result?.unit_id ?? input.unitId,
      unitShortId: result?.unit_short_id ?? "",
    };
  } catch (err) {
    rethrowFields(err, SPLIT_FIELDS);
  }
}

export type BikeStockUnit = { id: string; shortId: string; status: UnitStatus };

/** The unit a bike is in stock as (inventory_units.bike_id is unique), read through RLS; null if none. */
export async function getBikeStockUnit(
  supabase: ServerSupabase,
  bikeId: string,
): Promise<BikeStockUnit | null> {
  const row = unwrap(
    await supabase
      .from("inventory_units")
      .select("id, short_id, status")
      .eq("bike_id", bikeId)
      .maybeSingle(),
  );
  return row ? { id: row.id, shortId: row.short_id, status: row.status } : null;
}

// ---------------------------------------------------------------------------
// Writes: stock
// ---------------------------------------------------------------------------

export type AdjustmentInput = {
  requestId: string;
  productId: string;
  locationId: string;
  /** Non-zero; negative removes. */
  delta: number;
  type: "stock_adjustment" | "damaged";
  reason: string;
  /** Stock added only; view_costs only. */
  unitCost: Money | null;
};

/**
 * A manual stock change with a reason (adjust_stock). Never below zero at
 * the location (insufficient_stock: only a part used on a job may, D23).
 */
export async function adjustStock(
  supabase: ServerSupabase,
  input: AdjustmentInput,
): Promise<{ movementId: number; onHand: number }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new DomainError("Say why the stock is changing.", {
      reason: ["Say why the stock is changing."],
    });
  }
  try {
    const rows = unwrap(
      await supabase.rpc("adjust_stock", {
        request_id: input.requestId,
        product_id: input.productId,
        location_id: input.locationId,
        quantity_delta: input.delta,
        movement_type: input.type,
        reason,
        unit_cost: input.unitCost ?? undefined,
      }),
    );
    const row = rows?.[0];
    return { movementId: row?.movement_id ?? 0, onHand: row?.on_hand ?? 0 };
  } catch (err) {
    rethrowFields(err, STOCK_FIELDS);
  }
}

export type TransferInput = {
  requestId: string;
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  reason: string | null;
  /** A unique product's unit (quantity 1). */
  unitId: string | null;
};

/** Moves stock (or one unit) between active locations (transfer_stock: two linked rows). */
export async function transferStock(supabase: ServerSupabase, input: TransferInput): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("transfer_stock", {
        request_id: input.requestId,
        product_id: input.productId,
        from_location_id: input.fromLocationId,
        to_location_id: input.toLocationId,
        quantity: input.quantity,
        reason: input.reason ?? undefined,
        inventory_unit_id: input.unitId ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, STOCK_FIELDS);
  }
}

// ---------------------------------------------------------------------------
// Parts on jobs
// ---------------------------------------------------------------------------

export type PartLocation = { locationId: string; name: string; onHand: number };

export type PartOption = {
  kind: "product" | "unit";
  productId: string;
  unitId?: string;
  /** P- for a counted product, U- for a unit. */
  shortId: string;
  title: string;
  sku: string | null;
  serialNumber?: string | null;
  /** public.selling_prices; null: none set (part_price_missing unless overridden). */
  salePrice: Money | null;
  currency: string;
  /** On-hand at `locationId` if given, else at the default location. */
  onHandAtDefault: number;
  onHandTotal: number;
  /** Counted products: every active location; a unit: its own location (1). */
  byLocation: PartLocation[];
  /** Where the part would be taken from by default (a unit: its own location). */
  defaultLocationId: string | null;
  /** Direct cost for the preview; view_costs only (absent otherwise; null: none set). */
  cost?: Money | null;
  /**
   * Consigned stock (D44): whose it is and which consignment it comes
   * from. A unit's own item; for a quantity product the FIFO head (the
   * oldest active item with stock left, D45), which add_inventory_line
   * draws from when it covers the quantity. Absent for shop-owned stock.
   */
  consigned?: { consignorName: string; itemId: string; itemShortId: string };
};

/**
 * Parts for the job's Add part picker: products and units matching `q`
 * (staff_search), with their stock and selling price. Consigned stock is
 * offered too (D27 as changed by the owner, D44), marked with its
 * consignor and C- number; customer-owned stock never is. Left out:
 * archived or inactive products, units that are not available (on another
 * job, sold, written off), consigned units whose item is no longer active
 * and consigned quantity products with nothing left. A unique product
 * found by name is offered as its available units.
 *
 * For a view_costs holder, a consigned part's cost preview is what
 * add_inventory_line snapshots (D44): a unit's agreed amount plus its
 * shop-paid charges, a quantity product's FIFO-head agreed amount.
 */
export async function searchParts(
  supabase: ServerSupabase,
  q: string,
  { locationId, viewCosts }: { locationId?: string; viewCosts: boolean },
): Promise<PartOption[]> {
  const hits = await staffSearch(supabase, q, { kinds: ["product", "inventory_unit"], limit: 20 });
  if (hits.items.length === 0) return [];
  const hitProductIds = hits.items.filter((h) => h.kind === "product").map((h) => h.id);
  const hitUnitIds = hits.items.filter((h) => h.kind === "inventory_unit").map((h) => h.id);

  const unitColumns =
    "id, short_id, product_id, location_id, status, ownership_type, consignment_item_id, serial_number, archived_at";
  const [hitUnitsResult, productUnitsResult] = await Promise.all([
    hitUnitIds.length > 0
      ? supabase.from("inventory_units").select(unitColumns).in("id", hitUnitIds)
      : Promise.resolve({ data: [], error: null }),
    hitProductIds.length > 0
      ? supabase
          .from("inventory_units")
          .select(unitColumns)
          .in("product_id", hitProductIds)
          .eq("status", "available")
          .is("archived_at", null)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  type UnitRow = {
    id: string;
    short_id: string;
    product_id: string;
    location_id: string;
    status: UnitStatus;
    ownership_type: string;
    consignment_item_id: string | null;
    serial_number: string | null;
    archived_at: string | null;
  };
  const hitUnits = (unwrap(hitUnitsResult) ?? []) as UnitRow[];
  const productUnits = (unwrap(productUnitsResult) ?? []) as UnitRow[];
  const productIds = [...new Set([...hitProductIds, ...hitUnits.map((u) => u.product_id)])];
  const unitIds = [...new Set([...hitUnits, ...productUnits].map((u) => u.id))];

  const [productsResult, levelsResult, pricesResult, locations, productCosts, unitCosts] =
    await Promise.all([
      supabase
        .from("products")
        .select(
          "id, short_id, name, sku, tracking_type, ownership_type, active, archived_at, currency",
        )
        .in("id", productIds),
      supabase
        .schema("reporting")
        .from("stock_levels")
        .select("product_id, location_id, on_hand")
        .in("product_id", productIds),
      supabase
        .from("selling_prices")
        .select("product_id, inventory_unit_id, selling_price")
        .in("product_id", productIds),
      listLocations(supabase),
      viewCosts
        ? supabase
            .from("product_costs")
            .select("product_id, default_direct_cost")
            .in("product_id", productIds)
        : Promise.resolve({ data: [], error: null }),
      viewCosts && unitIds.length > 0
        ? supabase
            .from("inventory_unit_costs")
            .select("unit_id, effective_cost")
            .in("unit_id", unitIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
  const products = new Map((unwrap(productsResult) ?? []).map((p) => [p.id, p]));
  const levels = unwrap(levelsResult) ?? [];
  const prices = unwrap(pricesResult) ?? [];
  const productPrice = new Map(
    prices.filter((p) => p.inventory_unit_id === null).map((p) => [p.product_id, p.selling_price]),
  );
  const unitPrice = new Map(
    prices
      .filter((p) => p.inventory_unit_id !== null)
      .map((p) => [p.inventory_unit_id, p.selling_price]),
  );
  const productCost = new Map(
    (
      (unwrap(productCosts) ?? []) as {
        product_id: string | null;
        default_direct_cost: number | null;
      }[]
    ).map((c) => [c.product_id, c.default_direct_cost]),
  );
  const unitCost = new Map(
    ((unwrap(unitCosts) ?? []) as { unit_id: string | null; effective_cost: number | null }[]).map(
      (c) => [c.unit_id, c.effective_cost],
    ),
  );
  const active = locations.locations.filter((l) => l.active);
  const locationName = new Map(locations.locations.map((l) => [l.id, l.name]));
  const preferred =
    locationId && active.some((l) => l.id === locationId)
      ? locationId
      : locations.defaultLocationId;
  // D27 (changed) / D44: shop-owned and consigned stock; never customer-owned.
  const saleableOwnership = (o: string) => o === "shop_owned" || o === "consignment";
  const saleable = (
    p: { active: boolean; archived_at: string | null; ownership_type: string } | undefined,
  ) => !!p && p.active && p.archived_at === null && saleableOwnership(p.ownership_type);

  const options: PartOption[] = [];
  const seenUnits = new Set<string>();
  const unitOption = (u: UnitRow) => {
    const p = products.get(u.product_id);
    if (!saleable(p) || !p || seenUnits.has(u.id)) return;
    if (u.status !== "available" || u.archived_at !== null || !saleableOwnership(u.ownership_type))
      return;
    seenUnits.add(u.id);
    const option: PartOption = {
      kind: "unit",
      productId: p.id,
      unitId: u.id,
      shortId: u.short_id,
      title: p.name,
      sku: p.sku,
      serialNumber: u.serial_number,
      salePrice: money(unitPrice.get(u.id)),
      currency: p.currency,
      onHandAtDefault: 1,
      onHandTotal: 1,
      byLocation: [
        { locationId: u.location_id, name: locationName.get(u.location_id) ?? "", onHand: 1 },
      ],
      defaultLocationId: u.location_id,
    };
    if (viewCosts) option.cost = money(unitCost.get(u.id));
    if (u.consignment_item_id) option.consigned = consignedRef(u.consignment_item_id);
    options.push(option);
  };

  for (const hit of hits.items) {
    if (hit.kind === "inventory_unit") {
      const u = hitUnits.find((x) => x.id === hit.id);
      if (u) unitOption(u);
      continue;
    }
    const p = products.get(hit.id);
    if (!saleable(p) || !p) continue;
    if (p.tracking_type === "unique") {
      for (const u of productUnits.filter((x) => x.product_id === p.id)) unitOption(u);
      continue;
    }
    const at = new Map(
      levels.filter((l) => l.product_id === p.id).map((l) => [l.location_id, l.on_hand ?? 0]),
    );
    const option: PartOption = {
      kind: "product",
      productId: p.id,
      shortId: p.short_id,
      title: p.name,
      sku: p.sku,
      salePrice: money(productPrice.get(p.id)),
      currency: p.currency,
      onHandAtDefault: preferred ? (at.get(preferred) ?? 0) : 0,
      onHandTotal: [...at.values()].reduce((a, b) => a + b, 0),
      byLocation: active.map((l) => ({
        locationId: l.id,
        name: l.name,
        onHand: at.get(l.id) ?? 0,
      })),
      defaultLocationId: preferred,
    };
    if (viewCosts) option.cost = money(productCost.get(p.id));
    options.push(option);
  }
  return withConsignments(supabase, options, products, { viewCosts });
}

/** A consigned option's consignment, filled in by withConsignments. */
const consignedRef = (itemId: string) => ({ consignorName: "", itemId, itemShortId: "" });

/**
 * Fills in the consignor and C- number of consigned options, picks a
 * consigned quantity product's FIFO-head item (D45: the oldest active item
 * by received_at, then short_id, with stock left; none -> the product is
 * not offered) and, for view_costs, the cost add_inventory_line snapshots
 * (D44). Reads consignor_statement, so money stays gated by the database.
 */
async function withConsignments(
  supabase: ServerSupabase,
  options: PartOption[],
  products: ReadonlyMap<string, { ownership_type: string; tracking_type: string }>,
  { viewCosts }: { viewCosts: boolean },
): Promise<PartOption[]> {
  const quantityIds = options
    .filter(
      (o) => o.kind === "product" && products.get(o.productId)?.ownership_type === "consignment",
    )
    .map((o) => o.productId);
  const unitItemIds = options.flatMap((o) => (o.consigned ? [o.consigned.itemId] : []));
  if (quantityIds.length === 0 && unitItemIds.length === 0) return options;

  const filters = [
    quantityIds.length > 0 ? `product_id.in.(${quantityIds.join(",")})` : null,
    unitItemIds.length > 0 ? `id.in.(${unitItemIds.join(",")})` : null,
  ].filter(Boolean);
  const items =
    unwrap(
      await supabase
        .from("consignment_items")
        .select("id, short_id, product_id, consignor_id, status, received_at")
        .or(filters.join(","))
        .eq("status", "active")
        .order("received_at", { ascending: true })
        .order("short_id", { ascending: true }),
    ) ?? [];
  const consignorIds = [...new Set(items.map((i) => i.consignor_id))];
  const statements = await Promise.all(
    consignorIds.map(
      async (id) =>
        unwrap(await supabase.rpc("consignor_statement", { target_consignor_id: id })) ?? [],
    ),
  );
  const ledger = new Map(statements.flat().map((r) => [r.item_id, r]));

  const out: PartOption[] = [];
  for (const option of options) {
    const consignedProduct =
      option.kind === "product" && products.get(option.productId)?.ownership_type === "consignment";
    if (!consignedProduct && !option.consigned) {
      out.push(option);
      continue;
    }
    const item = consignedProduct
      ? items.find(
          (i) => i.product_id === option.productId && (ledger.get(i.id)?.remaining_qty ?? 0) > 0,
        )
      : items.find((i) => i.id === option.consigned?.itemId);
    // No active item with stock left (or the unit's item left the shop).
    if (!item) continue;
    const row = ledger.get(item.id);
    const next: PartOption = {
      ...option,
      consigned: {
        consignorName: row?.consignor_name ?? "",
        itemId: item.id,
        itemShortId: item.short_id,
      },
    };
    if (viewCosts) {
      const agreed = row?.agreed_amount_owed;
      // D44: a unit's line cost is its agreed amount plus its shop-paid
      // charges; a quantity line's is the item's agreed amount.
      next.cost =
        agreed === null || agreed === undefined
          ? null
          : option.kind === "unit"
            ? toMoneyString(sumMoney([agreed, row?.shop_charges ?? 0]))
            : toMoneyString(agreed);
    }
    out.push(next);
  }
  return out;
}

export type ShopBikeOption = {
  id: string;
  shortId: string;
  title: string;
  detail: string | null;
  brand: string | null;
  serialNumber: string | null;
};

/**
 * Shop bikes that can become a unique item: no owner (customer bikes must
 * be transferred to the shop first), not archived, not already a unit.
 */
export async function searchShopBikes(
  supabase: ServerSupabase,
  q: string,
): Promise<ShopBikeOption[]> {
  const hits = await staffSearch(supabase, q, { kinds: ["bike"], limit: 30 });
  if (hits.items.length === 0) return [];
  const rows =
    unwrap(
      await supabase
        .from("bikes")
        .select("id, short_id, brand, model, variant, colour, serial_number")
        .in(
          "id",
          hits.items.map((h) => h.id),
        )
        .is("customer_id", null)
        .is("inventory_unit_id", null)
        .is("archived_at", null),
    ) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.items.flatMap((h) => {
    const r = byId.get(h.id);
    if (!r) return [];
    const detail = [r.colour, r.serial_number ? `S/N ${r.serial_number}` : null]
      .filter(Boolean)
      .join(" · ");
    return [
      {
        id: r.id,
        shortId: r.short_id,
        title: bikeTitle(r),
        detail: detail || null,
        brand: r.brand,
        serialNumber: r.serial_number,
      },
    ];
  });
}

export type PartInput = {
  lineId: string;
  workOrderId: string;
  productId: string;
  unitId: string | null;
  quantity: number;
  locationId: string | null;
  /** Null: the selling price (private.selling_price). Any staff may override (D14, D24). */
  unitSalePrice: Money | null;
};

/**
 * Adds a part to an open job (add_inventory_line: the line with snapshotted
 * price, cost and rate, its job_consumption movement, and a unit held for
 * the job, D25). The line id is the idempotency key: a replay returns the
 * same line and movement. A counted part may take the location below zero
 * (D23: the UI warns); the cost is never entered here (D24).
 */
export async function addPartToJob(
  supabase: ServerSupabase,
  input: PartInput,
): Promise<{
  lineId: string;
  onHandAfter: number | null;
  locationName: string | null;
  replayed: boolean;
}> {
  let result;
  try {
    result = unwrap(
      await supabase.rpc("add_inventory_line", {
        line_id: input.lineId,
        work_order_id: input.workOrderId,
        product_id: input.productId,
        quantity: input.quantity,
        location_id: input.locationId ?? undefined,
        inventory_unit_id: input.unitId ?? undefined,
        unit_sale_price: input.unitSalePrice ?? undefined,
      }),
    );
  } catch (err) {
    rethrowFields(err, PART_FIELDS);
  }
  let locationName: string | null = null;
  if (result?.location_id) {
    const loc = unwrap(
      await supabase.from("locations").select("name").eq("id", result.location_id).maybeSingle(),
    );
    locationName = loc?.name ?? null;
  }
  return {
    lineId: result?.line_id ?? input.lineId,
    onHandAfter: result?.on_hand_after ?? null,
    locationName,
    replayed: result?.replayed === true,
  };
}

/** A product's name and P- number (the movements list's filter chip), or null. */
export async function productLabel(
  supabase: ServerSupabase,
  id: string,
): Promise<{ id: string; shortId: string; name: string } | null> {
  const row = unwrap(
    await supabase.from("products").select("id, short_id, name").eq("id", id).maybeSingle(),
  );
  return row ? { id: row.id, shortId: row.short_id, name: row.name } : null;
}
