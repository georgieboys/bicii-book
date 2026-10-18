import "server-only";

import type { Database } from "@/lib/database.types";
import { DbError, mapDbError, unwrap } from "@/lib/db-errors";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";

/**
 * A job's lines and totals (SPEC §9, §10, §22; DATA-MODEL §5; PLAN D1, D14,
 * D15). Lines are immutable except voiding; their economics are the
 * database's generated columns, snapshotted when the line is added.
 *
 * Cost visibility: a staff member without view_costs reads lines from the
 * base table with an explicit cost-free column list (their column grant
 * refuses `select *`) and totals from `work_order_totals`; a view_costs
 * holder reads `work_order_line_items_staff` and `work_order_totals_staff`.
 * A DTO for someone without view_costs never has a `costs` key at all.
 *
 * Money arrives from PostgREST as JSON numbers and leaves here as
 * fixed-point strings ("70.00"); amounts go to the RPCs as strings too.
 */

export type LineType = Database["public"]["Enums"]["line_type"];

export type LineCosts = {
  unitDirectCost: string;
  costTotal: string;
  yieldTotal: string;
  /** The Cult Commons rate snapshotted on the line, as a fraction ("0.3000"). */
  ccRate: string;
  ccShare: string;
};

export type Line = {
  id: string;
  type: LineType;
  description: string;
  /** "2.00" */
  quantity: string;
  unitSalePrice: string;
  saleTotal: string;
  currency: string;
  createdAt: string;
  /** Null when added outside the app. */
  createdByName: string | null;
  voided: { at: string; byName: string | null; reason: string | null } | null;
  /**
   * A manual line added without a unit cost (D14): its cost 0 is a
   * placeholder, so its yield and Cult Commons count the whole sale until a
   * view_costs holder voids it and adds it again with the cost. Not a cost
   * figure: every staff member sees it.
   */
  costPending: boolean;
  /**
   * Inventory lines (Phase 4): the part's P- or U- record and the stock it
   * took. `onHandAtLocation` is the current ledger on-hand where the part
   * was taken from (reporting.stock_levels), for everyone; never a cost.
   */
  part?: LinePart;
  /** Only for view_costs holders. */
  costs?: LineCosts;
};

export type LinePart = {
  productId: string;
  /** Set for a unique unit. */
  unitId: string | null;
  /** P-###### or U-######. */
  shortId: string;
  /** Whole units (parts are counted in whole numbers). */
  quantity: number;
  /** Where its job_consumption movement took the stock from; null if none (an owner backfill). */
  locationId: string | null;
  locationName: string | null;
  /** Ledger on-hand at that location now; null when there is no location. */
  onHandAtLocation: number | null;
  /** A consigned part (D44): its consignment and consignor. Never a payout figure. */
  consigned?: { itemId: string; shortId: string; consignorName: string };
};

export type Totals = {
  currency: string;
  /** Live (not voided) lines. */
  lineCount: number;
  saleTotal: string;
  /** Only for view_costs holders. */
  costs?: {
    costTotal: string;
    yieldTotal: string;
    /** Sum of the lines' Cult Commons shares (D1). */
    ccShare: string;
    /** BICII yield after Cult Commons. */
    yieldAfterCc: string;
    /** Live lines with no cost entered (D14): while > 0 the figures above are provisional. */
    costPendingCount: number;
  };
};

/** The sale-side columns every staff member may read (the table's column grant). */
const SALE_COLUMNS =
  "id, line_type, source_product_id, source_inventory_unit_id, description_snapshot, quantity, unit_sale_price_snapshot, cost_pending, currency, sale_total, created_by, created_at, voided_at, voided_by, void_reason";
const COST_COLUMNS =
  "id, line_type, source_product_id, source_inventory_unit_id, description_snapshot, quantity, unit_sale_price_snapshot, cost_pending, currency, sale_total, created_by, created_at, voided_at, voided_by, void_reason, unit_direct_cost_snapshot, cost_total, yield_total, cult_commons_rate_snapshot, cult_commons_share";

type SaleRow = {
  id: string | null;
  line_type: LineType | null;
  source_product_id: string | null;
  source_inventory_unit_id: string | null;
  description_snapshot: string | null;
  quantity: number | null;
  unit_sale_price_snapshot: number | null;
  cost_pending: boolean | null;
  currency: string | null;
  sale_total: number | null;
  created_by: string | null;
  created_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

type CostRow = SaleRow & {
  unit_direct_cost_snapshot: number | null;
  cost_total: number | null;
  yield_total: number | null;
  cult_commons_rate_snapshot: number | null;
  cult_commons_share: number | null;
};

const money = (v: number | string | null | undefined) => toMoneyString(v ?? 0);

/**
 * A job's lines, voided ones included, oldest first. `names` maps staff ids
 * to display names (staff_directory); it may still be loading, so the job
 * page reads the lines alongside it rather than after it.
 */
export async function listLines(
  supabase: ServerSupabase,
  workOrderId: string,
  {
    viewCosts,
    names: namesInput,
  }: {
    viewCosts: boolean;
    names: ReadonlyMap<string, string> | PromiseLike<ReadonlyMap<string, string>>;
  },
): Promise<Line[]> {
  const rows: (SaleRow | CostRow)[] = viewCosts
    ? (unwrap(
        await supabase
          .from("work_order_line_items_staff")
          .select(COST_COLUMNS)
          .eq("work_order_id", workOrderId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      ) ?? [])
    : (unwrap(
        await supabase
          .from("work_order_line_items")
          .select(SALE_COLUMNS)
          .eq("work_order_id", workOrderId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
      ) ?? []);
  const [names, parts] = await Promise.all([namesInput, loadParts(supabase, rows)]);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "A former colleague") : null);

  return rows.map((r) => {
    const line: Line = {
      id: r.id ?? "",
      type: r.line_type ?? "manual",
      description: r.description_snapshot ?? "",
      quantity: money(r.quantity),
      unitSalePrice: money(r.unit_sale_price_snapshot),
      saleTotal: money(r.sale_total),
      currency: r.currency ?? "SGD",
      createdAt: r.created_at ?? "",
      createdByName: nameOf(r.created_by),
      voided: r.voided_at
        ? { at: r.voided_at, byName: nameOf(r.voided_by), reason: r.void_reason }
        : null,
      costPending: r.cost_pending === true,
    };
    const part = r.id ? parts.get(r.id) : undefined;
    if (part) line.part = part;
    if (viewCosts && "cost_total" in r) {
      line.costs = {
        unitDirectCost: money(r.unit_direct_cost_snapshot),
        costTotal: money(r.cost_total),
        yieldTotal: money(r.yield_total),
        ccRate: String(r.cult_commons_rate_snapshot ?? 0),
        ccShare: money(r.cult_commons_share),
      };
    }
    return line;
  });
}

/**
 * The part behind each inventory line: its P-/U- short ID, the location
 * its job_consumption movement took stock from, and the ledger on-hand
 * there now (reporting.stock_levels). Reads only cost-free columns.
 */
async function loadParts(
  supabase: ServerSupabase,
  rows: readonly SaleRow[],
): Promise<Map<string, LinePart>> {
  const parts = rows.filter((r) => r.line_type === "inventory" && r.id && r.source_product_id);
  if (parts.length === 0) return new Map();
  const lineIds = parts.map((r) => r.id!);
  const productIds = [...new Set(parts.map((r) => r.source_product_id!))];
  const unitIds = [
    ...new Set(parts.map((r) => r.source_inventory_unit_id).filter((v): v is string => !!v)),
  ];
  const [productsResult, unitsResult, movementsResult, levelsResult, consignedResult] =
    await Promise.all([
      supabase.from("products").select("id, short_id").in("id", productIds),
      unitIds.length > 0
        ? supabase.from("inventory_units").select("id, short_id").in("id", unitIds)
        : Promise.resolve({ data: [] as { id: string; short_id: string }[], error: null }),
      supabase
        .from("inventory_movements")
        .select("work_order_line_item_id, location_id, location:locations(name)")
        .in("work_order_line_item_id", lineIds)
        .eq("movement_type", "job_consumption"),
      supabase
        .schema("reporting")
        .from("stock_levels")
        .select("product_id, location_id, on_hand")
        .in("product_id", productIds),
      // D44: the consignment a part was drawn from (the column is readable by
      // all staff; its payout snapshot is not).
      supabase
        .from("work_order_line_items")
        .select(
          "id, consignment_item_id, item:consignment_items(id, short_id, consignor:consignors(display_name))",
        )
        .in("id", lineIds)
        .not("consignment_item_id", "is", null),
    ]);
  const consigned = new Map(
    (unwrap(consignedResult) ?? []).flatMap((r) =>
      r.id && r.item
        ? [
            [
              r.id,
              {
                itemId: r.item.id,
                shortId: r.item.short_id,
                consignorName: r.item.consignor?.display_name ?? "",
              },
            ] as const,
          ]
        : [],
    ),
  );
  const productShort = new Map((unwrap(productsResult) ?? []).map((p) => [p.id, p.short_id]));
  const unitShort = new Map((unwrap(unitsResult) ?? []).map((u) => [u.id, u.short_id]));
  const consumed = new Map(
    (unwrap(movementsResult) ?? []).map((m) => [
      m.work_order_line_item_id,
      { locationId: m.location_id, locationName: m.location?.name ?? null },
    ]),
  );
  const onHand = new Map(
    (unwrap(levelsResult) ?? []).map((l) => [`${l.product_id}|${l.location_id}`, l.on_hand ?? 0]),
  );
  const result = new Map<string, LinePart>();
  for (const r of parts) {
    const productId = r.source_product_id!;
    const unitId = r.source_inventory_unit_id;
    const where = consumed.get(r.id!);
    const consignment = consigned.get(r.id!);
    result.set(r.id!, {
      ...(consignment ? { consigned: consignment } : {}),
      productId,
      unitId,
      shortId: (unitId ? unitShort.get(unitId) : productShort.get(productId)) ?? "",
      quantity: Number(r.quantity ?? 0),
      locationId: where?.locationId ?? null,
      locationName: where?.locationName ?? null,
      onHandAtLocation: where ? (onHand.get(`${productId}|${where.locationId}`) ?? 0) : null,
    });
  }
  return result;
}

/**
 * A job's running totals over its live lines (the database's views).
 * `currency` (the job's) is the fallback for a job with no lines; it may
 * still be loading, so the job page reads the totals alongside the job.
 */
export async function getTotals(
  supabase: ServerSupabase,
  workOrderId: string,
  {
    viewCosts,
    currency: currencyInput,
  }: { viewCosts: boolean; currency: string | PromiseLike<string> },
): Promise<Totals> {
  if (viewCosts) {
    const row = unwrap(
      await supabase
        .from("work_order_totals_staff")
        .select(
          "currency, line_count, sale_total, cost_total, yield_total, cult_commons_share, bicii_yield_after_cc, cost_pending_count",
        )
        .eq("work_order_id", workOrderId)
        .maybeSingle(),
    );
    return {
      currency: row?.currency ?? (await currencyInput),
      lineCount: row?.line_count ?? 0,
      saleTotal: money(row?.sale_total),
      costs: {
        costTotal: money(row?.cost_total),
        yieldTotal: money(row?.yield_total),
        ccShare: money(row?.cult_commons_share),
        yieldAfterCc: money(row?.bicii_yield_after_cc),
        costPendingCount: row?.cost_pending_count ?? 0,
      },
    };
  }
  const row = unwrap(
    await supabase
      .from("work_order_totals")
      .select("currency, line_count, sale_total")
      .eq("work_order_id", workOrderId)
      .maybeSingle(),
  );
  return {
    currency: row?.currency ?? (await currencyInput),
    lineCount: row?.line_count ?? 0,
    saleTotal: money(row?.sale_total),
  };
}

/**
 * Business refusals that belong to one field of a form: rethrown as a
 * DomainError on that field (the message is the mapped, safe one).
 */
export function rethrowOnField(err: unknown, fields: Record<string, string>): never {
  if (err instanceof DbError) {
    const mapped = mapDbError(err);
    const field = mapped.reason ? fields[mapped.reason] : undefined;
    if (mapped.kind === "business" && field) {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
  }
  throw err;
}

const LINE_FIELDS = {
  service_unavailable: "serviceId",
  reason_required: "reason",
  reason_too_long: "reason",
};

export type ServiceLineInput = {
  lineId: string;
  workOrderId: string;
  serviceId: string;
  /** Fixed-point strings. */
  quantity: string;
  /** Null: the service's default. */
  unitSalePrice: string | null;
  /** Null: the service's default. Requires view_costs (the RPC refuses otherwise). */
  unitDirectCost: string | null;
  /** Null: the service's name. */
  description: string | null;
};

/**
 * Adds a service to an open job (RPC add_service_line: snapshots price,
 * cost and rate). The line id is the idempotency key: a replay returns
 * the line it already added.
 */
export async function addServiceLine(
  supabase: ServerSupabase,
  input: ServiceLineInput,
): Promise<{ id: string }> {
  try {
    const id = unwrap(
      await supabase.rpc("add_service_line", {
        line_id: input.lineId,
        work_order_id: input.workOrderId,
        service_id: input.serviceId,
        quantity: input.quantity,
        unit_sale_price: input.unitSalePrice ?? undefined,
        unit_direct_cost: input.unitDirectCost ?? undefined,
        description: input.description ?? undefined,
      }),
    );
    return { id: id ?? input.lineId };
  } catch (err) {
    rethrowOnField(err, LINE_FIELDS);
  }
}

export type ManualLineInput = {
  lineId: string;
  workOrderId: string;
  description: string;
  quantity: string;
  unitSalePrice: string;
  /** Null: no direct cost. Requires view_costs. */
  unitDirectCost: string | null;
};

/** Adds a free-text line (labour, a sundry) to an open job; replay-safe by line id. */
export async function addManualLine(
  supabase: ServerSupabase,
  input: ManualLineInput,
): Promise<{ id: string }> {
  try {
    const id = unwrap(
      await supabase.rpc("add_manual_line", {
        line_id: input.lineId,
        work_order_id: input.workOrderId,
        description: input.description,
        unit_sale_price: input.unitSalePrice,
        quantity: input.quantity,
        unit_direct_cost: input.unitDirectCost ?? undefined,
      }),
    );
    return { id: id ?? input.lineId };
  } catch (err) {
    rethrowOnField(err, LINE_FIELDS);
  }
}

/**
 * Voids a line with a reason (RPC void_line; only while the job is open,
 * D15). The line stays, struck through, with who, when and why; voiding
 * again changes nothing.
 */
export async function voidLine(
  supabase: ServerSupabase,
  input: { lineId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new DomainError("Say why the line is being voided.", {
      reason: ["Say why the line is being voided."],
    });
  }
  try {
    unwrap(await supabase.rpc("void_line", { line_id: input.lineId, reason }));
  } catch (err) {
    rethrowOnField(err, LINE_FIELDS);
  }
}
