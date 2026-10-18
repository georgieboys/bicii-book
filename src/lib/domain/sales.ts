import "server-only";

import { DbError, mapDbError, unwrap } from "@/lib/db-errors";
import type { Database } from "@/lib/database.types";
import type { UnitStatus } from "@/lib/inventory";
import { DEFAULT_CURRENCY, sumMoney, toMoneyString } from "@/lib/money";
import { customerLabel } from "@/lib/people";
import type { SaleStatus } from "@/lib/sales";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import { currentCultCommonsRate } from "./services";
import { staffNames } from "@/lib/domain/staff-directory";

/**
 * In-store sales (SPEC §10, §13, §21, §23; DATA-MODEL §8, §15, §16; PLAN
 * D1, D7, D44–D49, D51, D53). A DTO mapper over the Phase 6 read RPCs and
 * the three sale writes:
 *
 *   record_retail_sale(sale_id, lines, customer_id, recognized_at, notes)
 *     any active staff (D48); keyed by the sheet's sale id, so a retry has
 *     one effect (a replay with the same request returns the same sale);
 *   restock_unit(unit_id, sale_line_id, location_id, reason)
 *     adjust_stock, plus manage_consignments for a consigned unit (D46);
 *     keyed by the sale line (a restocked line is a no-op);
 *   record_sale_refund(refund_id, sale_id, amount, reason)
 *     admins and managers (D94); financial only (D7).
 *
 * Money visibility (D48): sale headers, lines, quantities, prices, totals
 * and refunds reach every staff member; cost, yield, Cult Commons, rate
 * and the consignor payout come only from list_sales / sale_lines_detail,
 * which return them as NULL to staff without view_costs (the payout:
 * without manage_consignments or view_costs). The DTOs carry `null` for
 * hidden money and screens render nothing for it. sale_lines' cost
 * columns are not granted, so this module never selects them directly.
 *
 * Money arrives from PostgREST as JSON numbers and leaves as fixed-point
 * strings; amounts go to the database as strings.
 */

type Money = string;
type OwnershipType = Database["public"]["Enums"]["ownership_type"];

const money = (v: number | string | null | undefined): Money | null =>
  v === null || v === undefined ? null : toMoneyString(v);

const nameOf = (names: ReadonlyMap<string, string>, id: string | null) =>
  id ? (names.get(id) ?? "A former colleague") : null;

// ---------------------------------------------------------------------------
// The Sales list
// ---------------------------------------------------------------------------

export type SaleListItem = {
  id: string;
  saleNumber: string;
  status: SaleStatus;
  recognizedAt: string;
  customer: { id: string; label: string } | null;
  lineCount: number;
  firstDescription: string;
  hasConsignment: boolean;
  restockedLines: number;
  saleTotal: Money;
  refundedTotal: Money;
  /** view_costs only (D48); null otherwise. */
  costTotal: Money | null;
  yieldTotal: Money | null;
  cultCommons: Money | null;
};

/**
 * Sales recognised in [from, to) (either bound may be null), newest first,
 * matching `q` (S- number, customer or line words); list_sales.
 */
export async function listSales(
  supabase: ServerSupabase,
  {
    from,
    to,
    q,
    limit = 100,
  }: { from: string | null; to: string | null; q: string; limit?: number },
): Promise<{ items: SaleListItem[]; more: boolean }> {
  const rows =
    unwrap(
      await supabase.rpc("list_sales", {
        from_at: from ?? undefined,
        to_at: to ?? undefined,
        q: q || undefined,
        max_rows: limit + 1,
      }),
    ) ?? [];
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      saleNumber: r.sale_number,
      status: r.status,
      recognizedAt: r.recognized_at,
      customer: r.customer_id ? { id: r.customer_id, label: r.customer_label ?? "Customer" } : null,
      lineCount: r.line_count ?? 0,
      firstDescription: r.first_description ?? "",
      hasConsignment: r.has_consignment === true,
      restockedLines: r.restocked_lines ?? 0,
      saleTotal: toMoneyString(r.sale_total ?? 0),
      refundedTotal: toMoneyString(r.refunded_total ?? 0),
      costTotal: money(r.cost_total),
      yieldTotal: money(r.yield_total),
      cultCommons: money(r.cult_commons_share),
    })),
    more: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// One sale
// ---------------------------------------------------------------------------

export type SaleLine = {
  id: string;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
  restocked: { at: string; byName: string | null } | null;
  product: { id: string; shortId: string };
  unit: {
    id: string;
    shortId: string;
    status: UnitStatus;
    ownership: OwnershipType;
    /** The unit's live sale line (null once restocked, D46). */
    soldOnLineId: string | null;
    /** Where the unit is now (the restock's default location). */
    locationId: string | null;
  } | null;
  bike: { id: string; shortId: string } | null;
  consignment: {
    itemId: string;
    shortId: string;
    consignorId: string;
    consignorName: string;
  } | null;
  /** view_costs only (D48); null otherwise. */
  unitCost: Money | null;
  costTotal: Money | null;
  yieldTotal: Money | null;
  rate: string | null;
  cultCommons: Money | null;
  /** Per unit; manage_consignments or view_costs (D48); null otherwise or when not consigned. */
  payout: Money | null;
};

export type SaleRefund = {
  id: string;
  amount: Money;
  currency: string;
  reason: string;
  byName: string | null;
  at: string;
};

export type SaleDetail = {
  id: string;
  saleNumber: string;
  source: Database["public"]["Enums"]["sale_source"];
  status: SaleStatus;
  recognizedAt: string;
  createdAt: string;
  currency: string;
  notes: string | null;
  customer: { id: string; label: string } | null;
  /**
   * An online sale recorded before its Shopify customer was linked (D86):
   * the sale stays without a customer (sales are immutable), and the
   * customer now linked to its Shopify customer id is shown beside it.
   * `linked` null: that Shopify customer is not linked yet.
   */
  shopifyCustomer: { linked: { id: string; label: string } | null } | null;
  recordedByName: string | null;
  lines: SaleLine[];
  refunds: SaleRefund[];
  total: Money;
  refundedTotal: Money;
};

const SALE_COLUMNS =
  "id, sale_number, source, status, recognized_at, created_at, currency, notes, created_by, shopify_customer_id, customer:customers(id, first_name, last_name, display_name, email, phone)";

/** One sale with its lines (sale_lines_detail) and refunds; null if unknown. */
export async function getSale(supabase: ServerSupabase, id: string): Promise<SaleDetail | null> {
  const header = unwrap(
    await supabase.from("sales").select(SALE_COLUMNS).eq("id", id).maybeSingle(),
  );
  if (!header) return null;
  const [linesResult, refundsResult, names] = await Promise.all([
    supabase.rpc("sale_lines_detail", { sale_id: id }),
    supabase
      .from("sale_refunds")
      .select("id, amount, currency, reason, recorded_by, created_at")
      .eq("sale_id", id)
      .order("created_at", { ascending: true }),
    staffNames(supabase),
  ]);
  const rows = unwrap(linesResult) ?? [];
  const unitIds = rows.map((r) => r.inventory_unit_id).filter((v): v is string => !!v);
  const unitLocations = new Map<string, string>();
  if (unitIds.length > 0) {
    const units =
      unwrap(await supabase.from("inventory_units").select("id, location_id").in("id", unitIds)) ??
      [];
    for (const u of units) unitLocations.set(u.id, u.location_id);
  }
  const lines: SaleLine[] = rows.map((r) => ({
    id: r.id,
    lineNumber: r.line_number,
    description: r.description_snapshot,
    quantity: Number(r.quantity ?? 0),
    unitPrice: toMoneyString(r.unit_sale_price_snapshot ?? 0),
    total: toMoneyString(r.sale_total ?? 0),
    restocked: r.restocked_at ? { at: r.restocked_at, byName: r.restocked_by_name ?? null } : null,
    product: { id: r.product_id, shortId: r.product_short_id },
    unit: r.inventory_unit_id
      ? {
          id: r.inventory_unit_id,
          shortId: r.unit_short_id,
          status: r.unit_status,
          ownership: r.unit_ownership_type,
          soldOnLineId: r.unit_sold_sale_line_id ?? null,
          locationId: unitLocations.get(r.inventory_unit_id) ?? null,
        }
      : null,
    bike: r.bike_id ? { id: r.bike_id, shortId: r.bike_short_id } : null,
    consignment: r.consignment_item_id
      ? {
          itemId: r.consignment_item_id,
          shortId: r.consignment_short_id,
          consignorId: r.consignor_id,
          consignorName: r.consignor_name,
        }
      : null,
    unitCost: money(r.unit_direct_cost_snapshot),
    costTotal: money(r.cost_total),
    yieldTotal: money(r.yield_total),
    rate: r.cult_commons_rate_snapshot === null ? null : String(r.cult_commons_rate_snapshot),
    cultCommons: money(r.cult_commons_share),
    payout: money(r.consignor_payout_snapshot),
  }));
  const refunds: SaleRefund[] = (unwrap(refundsResult) ?? []).map((r) => ({
    id: r.id,
    amount: toMoneyString(r.amount),
    currency: r.currency,
    reason: r.reason,
    byName: nameOf(names, r.recorded_by),
    at: r.created_at,
  }));
  const c = header.customer;
  let shopifyCustomer: SaleDetail["shopifyCustomer"] = null;
  if (!c && header.shopify_customer_id) {
    const linked = unwrap(
      await supabase
        .from("customers")
        .select("id, first_name, last_name, display_name, email, phone")
        .eq("shopify_customer_id", header.shopify_customer_id)
        .maybeSingle(),
    );
    shopifyCustomer = {
      linked: linked
        ? {
            id: linked.id,
            label: customerLabel({
              firstName: linked.first_name,
              lastName: linked.last_name,
              displayName: linked.display_name,
              email: linked.email,
              phone: linked.phone,
            }),
          }
        : null,
    };
  }
  return {
    id: header.id,
    saleNumber: header.sale_number,
    source: header.source,
    status: header.status,
    recognizedAt: header.recognized_at,
    createdAt: header.created_at,
    currency: header.currency ?? DEFAULT_CURRENCY,
    notes: header.notes,
    customer: c
      ? {
          id: c.id,
          label: customerLabel({
            firstName: c.first_name,
            lastName: c.last_name,
            displayName: c.display_name,
            email: c.email,
            phone: c.phone,
          }),
        }
      : null,
    shopifyCustomer,
    recordedByName: nameOf(names, header.created_by),
    lines,
    refunds,
    total: toMoneyString(sumMoney(lines.map((l) => l.total))),
    refundedTotal: toMoneyString(sumMoney(refunds.map((r) => r.amount))),
  };
}

/**
 * The live sale of a unit (its sold_sale_line_id), for the unit page:
 * "Sold on S-…" and the Restock control. Null when no sale holds it (in
 * stock, on a job, or restocked).
 */
export async function saleForUnit(
  supabase: ServerSupabase,
  unitId: string,
): Promise<{ saleId: string; saleNumber: string; lineId: string } | null> {
  const unit = unwrap(
    await supabase
      .from("inventory_units")
      .select("id, sold_sale_line_id")
      .eq("id", unitId)
      .maybeSingle(),
  );
  if (!unit?.sold_sale_line_id) return null;
  const line = unwrap(
    await supabase
      .from("sale_lines")
      .select("id, sale_id, sale:sales(sale_number)")
      .eq("id", unit.sold_sale_line_id)
      .maybeSingle(),
  );
  if (!line) return null;
  return { saleId: line.sale_id, saleNumber: line.sale?.sale_number ?? "", lineId: line.id };
}

// ---------------------------------------------------------------------------
// The sale sheet's picker
// ---------------------------------------------------------------------------

export type SaleableRow = {
  /** Stable per row: a unit, or a product at a location (and consignment). */
  key: string;
  kind: "unit" | "product";
  productId: string;
  productShortId: string;
  unitId: string | null;
  unitShortId: string | null;
  title: string;
  subtitle: string;
  locationId: string;
  locationName: string;
  /** A unit: 1; a product: what this row can sell at this location. */
  onHand: number;
  /** The database selling price (D45: a consigned row's own asking price); null: none set. */
  unitPrice: Money | null;
  ownership: OwnershipType;
  consignment: { itemId: string; shortId: string; consignorName: string } | null;
  /**
   * What a sale would snapshot as the unit cost, for the "Below cost"
   * warning and the preview; view_costs only (absent otherwise; null: no
   * cost set). Consigned: the agreed amount, plus shop-paid charges on a
   * unit (D44, D45).
   */
  cost?: Money | null;
};

/**
 * What the sale sheet can sell for `q` (saleable_stock), with, for
 * view_costs holders, each row's cost and the Cult Commons rate in force
 * now (for the labelled preview; the sale snapshots the rate at its own
 * recognized_at).
 */
export async function searchSaleable(
  supabase: ServerSupabase,
  q: string,
  { viewCosts }: { viewCosts: boolean },
): Promise<{ rows: SaleableRow[]; rate: string | null }> {
  const found = unwrap(await supabase.rpc("saleable_stock", { q, max_results: 20 })) ?? [];
  const rows: SaleableRow[] = found.map((r) => ({
    key:
      r.kind === "unit"
        ? `unit:${r.inventory_unit_id}`
        : `product:${r.product_id}:${r.location_id}:${r.consignment_item_id ?? "shop"}`,
    kind: r.kind === "unit" ? "unit" : "product",
    productId: r.product_id,
    productShortId: r.product_short_id,
    unitId: r.inventory_unit_id ?? null,
    unitShortId: r.unit_short_id ?? null,
    title: r.title,
    subtitle: r.subtitle ?? "",
    locationId: r.location_id,
    locationName: r.location_name,
    onHand: r.on_hand ?? 0,
    unitPrice: money(r.unit_price),
    ownership: r.ownership_type,
    consignment: r.consignment_item_id
      ? {
          itemId: r.consignment_item_id,
          shortId: r.consignment_short_id,
          consignorName: r.consignor_name ?? "",
        }
      : null,
  }));
  if (!viewCosts || rows.length === 0) return { rows, rate: null };

  const shopUnits = rows.filter((r) => r.kind === "unit" && !r.consignment).map((r) => r.unitId!);
  const shopProducts = rows
    .filter((r) => r.kind === "product" && !r.consignment)
    .map((r) => r.productId);
  const itemIds = [...new Set(rows.flatMap((r) => (r.consignment ? [r.consignment.itemId] : [])))];
  const [unitCosts, productCosts, statements, rate] = await Promise.all([
    shopUnits.length > 0
      ? supabase
          .from("inventory_unit_costs")
          .select("unit_id, effective_cost")
          .in("unit_id", shopUnits)
      : Promise.resolve({ data: [], error: null }),
    shopProducts.length > 0
      ? supabase
          .from("product_costs")
          .select("product_id, default_direct_cost")
          .in("product_id", shopProducts)
      : Promise.resolve({ data: [], error: null }),
    Promise.all(
      itemIds.map(
        async (id) =>
          unwrap(await supabase.rpc("consignor_statement", { target_item_id: id })) ?? [],
      ),
    ),
    currentCultCommonsRate(supabase),
  ]);
  const unitCost = new Map(
    ((unwrap(unitCosts) ?? []) as { unit_id: string | null; effective_cost: number | null }[]).map(
      (c) => [c.unit_id, c.effective_cost],
    ),
  );
  const productCost = new Map(
    (
      (unwrap(productCosts) ?? []) as {
        product_id: string | null;
        default_direct_cost: number | null;
      }[]
    ).map((c) => [c.product_id, c.default_direct_cost]),
  );
  const ledger = new Map(statements.flat().map((s) => [s.item_id, s]));
  for (const row of rows) {
    if (row.consignment) {
      const s = ledger.get(row.consignment.itemId);
      const agreed = s?.agreed_amount_owed;
      row.cost =
        agreed === null || agreed === undefined
          ? null
          : row.kind === "unit"
            ? toMoneyString(sumMoney([agreed, s?.shop_charges ?? 0]))
            : toMoneyString(agreed);
    } else if (row.kind === "unit") {
      row.cost = money(unitCost.get(row.unitId));
    } else {
      row.cost = money(productCost.get(row.productId));
    }
  }
  return { rows, rate };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SaleLineInput =
  | { kind: "unit"; key: string; unitId: string; unitSalePrice: string | null }
  | {
      kind: "product";
      key: string;
      productId: string;
      locationId: string;
      quantity: number;
      consignmentItemId: string | null;
      unitSalePrice: string | null;
    };

export type RecordSaleInput = {
  saleId: string;
  lines: SaleLineInput[];
  customerId: string | null;
  /** Null: now (the database stamps it). */
  recognizedAt: string | null;
  notes: string | null;
};

/** The RPC's line JSON: ids, the quantity and the price as a decimal string; nothing else. */
export function toSaleLinesJson(lines: readonly SaleLineInput[]): Record<string, unknown>[] {
  return lines.map((l) => {
    const price = l.unitSalePrice !== null ? { unit_sale_price: l.unitSalePrice } : {};
    if (l.kind === "unit") return { inventory_unit_id: l.unitId, ...price };
    return {
      product_id: l.productId,
      location_id: l.locationId,
      quantity: l.quantity,
      ...(l.consignmentItemId ? { consignment_item_id: l.consignmentItemId } : {}),
      ...price,
    };
  });
}

/** Refusals that are about one unit: the sheet marks its line. */
const STALE_UNIT = new Set([
  "unit_already_sold",
  "unit_not_available",
  "sale_lines_unit_sells_once",
]);

/** Refusals about when the sale happened: the sheet marks Sold at (D55). */
const SALE_DATE = new Set(["sale_recognized_in_future", "sale_before_stock"]);

/**
 * Records an in-store sale (record_retail_sale). A replay of the same
 * request returns the sale it already recorded. When a unit has been sold
 * (or taken) since it was picked, the refusal names its line in
 * `fieldErrors["line:<key>"]`, so the sheet can mark it and keep the rest.
 */
export async function recordRetailSale(
  supabase: ServerSupabase,
  input: RecordSaleInput,
): Promise<{ saleId: string; saleNumber: string; replayed: boolean }> {
  const { data, error } = await supabase.rpc("record_retail_sale", {
    sale_id: input.saleId,
    lines: toSaleLinesJson(
      input.lines,
    ) as Database["public"]["Functions"]["record_retail_sale"]["Args"]["lines"],
    customer_id: input.customerId ?? undefined,
    recognized_at: input.recognizedAt ?? undefined,
    notes: input.notes ?? undefined,
  });
  if (error) {
    const mapped = mapDbError(error);
    if (mapped.reason && STALE_UNIT.has(mapped.reason)) {
      const unitIds = input.lines.flatMap((l) => (l.kind === "unit" ? [l.unitId] : []));
      const units =
        unitIds.length > 0
          ? (unwrap(
              await supabase.from("inventory_units").select("id, status").in("id", unitIds),
            ) ?? [])
          : [];
      const gone = new Set(units.filter((u) => u.status !== "available").map((u) => u.id));
      const fieldErrors: Record<string, string[]> = {};
      for (const l of input.lines) {
        if (l.kind === "unit" && gone.has(l.unitId)) {
          fieldErrors[`line:${l.key}`] = ["Already sold or taken. Remove this line."];
        }
      }
      throw new DomainError(mapped.message, fieldErrors);
    }
    if (mapped.reason && SALE_DATE.has(mapped.reason)) {
      throw new DomainError(mapped.message, { recognizedAt: [mapped.message] });
    }
    throw new DbError(error);
  }
  return {
    saleId: data.sale_id ?? input.saleId,
    saleNumber: data.sale_number ?? "",
    replayed: data.replayed === true,
  };
}

export type RestockInput = {
  unitId: string;
  saleLineId: string;
  /** Null: where the unit was sold. */
  locationId: string | null;
  reason: string;
};

/** Puts a sold unit back into stock with a reason (restock_unit; D7, D46). */
export async function restockUnit(supabase: ServerSupabase, input: RestockInput): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("restock_unit", {
        unit_id: input.unitId,
        sale_line_id: input.saleLineId,
        location_id: input.locationId ?? undefined,
        reason: input.reason,
      }),
    );
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped.reason === "reason_required" || mapped.reason === "reason_too_long") {
      throw new DomainError(mapped.message, { reason: [mapped.message] });
    }
    throw err;
  }
}

export type RefundInput = { refundId: string; saleId: string; amount: string; reason: string };

/** Records a refund (record_sale_refund; admins and managers, D94; money only, D7). */
export async function recordSaleRefund(
  supabase: ServerSupabase,
  input: RefundInput,
): Promise<void> {
  try {
    unwrap(
      await supabase.rpc("record_sale_refund", {
        refund_id: input.refundId,
        sale_id: input.saleId,
        amount: input.amount,
        reason: input.reason,
      }),
    );
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped.reason === "refund_exceeds_sale" || mapped.reason === "sale_refunds_amount_check") {
      throw new DomainError(mapped.message, { amount: [mapped.message] });
    }
    if (mapped.reason === "reason_required" || mapped.reason === "reason_too_long") {
      throw new DomainError(mapped.message, { reason: [mapped.message] });
    }
    throw err;
  }
}
