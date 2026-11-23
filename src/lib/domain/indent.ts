import "server-only";

import { DbError, mapDbError, unwrap } from "@/lib/db-errors";
import type { PartRequestKind, PartRequestStatus, QuoteChannel, QuoteState } from "@/lib/indent";
import { logger } from "@/lib/logger";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import { staffSearch } from "./search";

/**
 * Indent parts and quotes on a job (Phase 13; PLAN D140-D147, ADR-024;
 * DATA-MODEL §5 "Indent parts and quotes"). Reads come from the staff
 * tables (no expected cost or supplier: those come from
 * job_part_requests_staff for view_costs or manage_purchasing holders,
 * D60, D147); every write is an RPC that checks again. Money leaves here as
 * fixed-point strings.
 */

export type PartRequest = {
  id: string;
  kind: PartRequestKind;
  status: PartRequestStatus;
  description: string;
  /** "2.00" */
  quantity: string;
  unitSalePrice: string;
  lineTotal: string;
  currency: string;
  productId: string | null;
  serviceId: string | null;
  cancelReason: string | null;
  /** The job line it became, once fitted. */
  lineId: string | null;
  /** Ordered parts: their purchase order and whether receipts cover them (D146). */
  order: {
    purchaseOrderId: string;
    poNumber: string;
    arrived: boolean;
    locationId: string | null;
  } | null;
  /** Present only for view_costs or manage_purchasing holders (D60, D147). */
  purchase?: {
    expectedUnitCost: string | null;
    supplierId: string | null;
    supplierName: string | null;
  };
  /**
   * View costs holders only (D24, D30): the part's product has no cost, so
   * Fit would be refused (part_cost_missing). Absent for everyone else and
   * for services.
   */
  costMissing?: boolean;
  /**
   * Parts on consigned products (D44, D265): fitted from the consigned stock
   * (the consignor is owed the agreed amount on completion), never ordered
   * or bought outside BICII. `onHand` is the stock at `locationId`, the
   * location holding the most of it, which Fit takes it from. Absent
   * otherwise.
   */
  consigned?: StockAt;
  /**
   * A shop-owned part never ordered in BICII that is in stock already (a
   * one-off taken in when proposed, D264/D265, or stock on the shelf): Fit
   * takes it from `locationId` and does not steer to Bought outside BICII.
   */
  inStock?: StockAt;
  /**
   * D160: an approved or ordered item that was fitted and whose line was
   * voided since (its latest part_request_unfitted entry), and whether it
   * had been bought outside BICII (the part is then back in stock). Absent
   * otherwise.
   */
  unfitted?: { boughtOutside: boolean };
};

/** Stock of one product at the location that holds the most of it. */
export type StockAt = { onHand: number; locationId: string | null; locationName: string | null };

export type JobQuote = {
  id: string;
  state: QuoteState;
  channel: QuoteChannel;
  total: string;
  currency: string;
  sentAt: string;
  expiresAt: string;
  answeredAt: string | null;
  answeredName: string | null;
};

export type IndentPanel = {
  requests: PartRequest[];
  /** The job's latest quote, if any. */
  quote: JobQuote | null;
};

const money = (v: number | string | null) => (v === null ? null : toMoneyString(v));

/** An RPC's return value, which these RPCs always give (null would be a database bug). */
function returned<T>(value: T | null, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} returned nothing`);
  return value;
}

/**
 * The job's indent requests (oldest first) and its latest quote. With
 * `viewCosts`, each part says whether its product has a cost (Fit needs
 * one, D24), read from public.product_costs (view_costs only). An approved
 * or ordered item whose fitted line was voided says so (D160, from the
 * job's part_request_unfitted entries, which any staff member reads).
 */
export async function getIndentPanel(
  supabase: ServerSupabase,
  workOrderId: string,
  { purchaseData, viewCosts = false }: { purchaseData: boolean; viewCosts?: boolean },
): Promise<IndentPanel> {
  const [requests, quotes, arrivals, unfits] = await Promise.all([
    supabase
      .from("job_part_requests")
      .select(
        "id, kind, status, description, quantity, unit_sale_price, line_total, currency, product_id, service_id, cancel_reason, work_order_line_item_id, created_at",
      )
      .eq("work_order_id", workOrderId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("quotes")
      .select(
        "id, status, channel, total, currency, sent_at, expires_at, answered_at, answered_name",
      )
      .eq("work_order_id", workOrderId)
      .order("sent_at", { ascending: false })
      .limit(1),
    supabase.rpc("part_request_arrivals", { work_order_id: workOrderId }),
    // D160: items whose fitted line was voided (the job's timeline entries).
    supabase
      .from("work_order_events")
      .select("payload")
      .eq("work_order_id", workOrderId)
      .eq("event_type", "part_request_unfitted")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  const rows = unwrap(requests) ?? [];
  const arrivalRows = unwrap(arrivals) ?? [];
  const byRequest = new Map(arrivalRows.map((a) => [a.request_id, a]));
  // The latest entry per request wins (it may have been fitted and voided again).
  const unfitted = new Map<string, { boughtOutside: boolean }>();
  for (const { payload } of unwrap(unfits) ?? []) {
    const p =
      typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
    if (typeof p.request_id === "string") {
      unfitted.set(p.request_id, { boughtOutside: p.bought_outside === true });
    }
  }

  // The purchase data and the cost check depend only on the requests, not
  // on each other: one more phase, not two.
  const productIds = [
    ...new Set(rows.flatMap((r) => (r.kind === "part" && r.product_id ? [r.product_id] : []))),
  ];
  const [staffResult, costResult, productResult, levelResult, locationResult] = await Promise.all([
    purchaseData && rows.length > 0
      ? supabase
          .from("job_part_requests_staff")
          .select("id, expected_unit_cost, supplier_id, supplier_name")
          .in(
            "id",
            rows.map((r) => r.id),
          )
      : null,
    viewCosts && productIds.length > 0
      ? supabase
          .from("product_costs")
          .select("product_id, default_direct_cost")
          .in("product_id", productIds)
      : null,
    productIds.length > 0
      ? supabase.from("products").select("id, ownership_type").in("id", productIds)
      : null,
    productIds.length > 0
      ? supabase
          .schema("reporting")
          .from("stock_levels")
          .select("product_id, location_id, on_hand")
          .in("product_id", productIds)
      : null,
    productIds.length > 0 ? supabase.from("locations").select("id, name") : null,
  ]);
  const consignedIds = new Set(
    (productResult ? (unwrap(productResult) ?? []) : [])
      .filter((p) => p.ownership_type === "consignment")
      .map((p) => p.id),
  );
  // Fit takes a never-ordered part from one location (add_inventory_line):
  // the one holding the most of it, so the sheet counts what Fit can take.
  const locationNames = new Map(
    (locationResult ? (unwrap(locationResult) ?? []) : []).map((l) => [l.id, l.name]),
  );
  const stockAt = new Map<string, StockAt>();
  for (const l of levelResult ? (unwrap(levelResult) ?? []) : []) {
    if (!l.product_id) continue;
    const onHand = l.on_hand ?? 0;
    const best = stockAt.get(l.product_id);
    if (!best || onHand > best.onHand) {
      stockAt.set(l.product_id, {
        onHand,
        locationId: l.location_id,
        locationName: l.location_id ? (locationNames.get(l.location_id) ?? null) : null,
      });
    }
  }
  const noStock: StockAt = { onHand: 0, locationId: null, locationName: null };
  const purchase = new Map<
    string,
    { expected_unit_cost: number | null; supplier_id: string | null; supplier_name: string | null }
  >(staffResult ? (unwrap(staffResult) ?? []).map((r) => [r.id!, r]) : []);
  let withoutCost: Set<string> | null = null;
  if (costResult) {
    const costRows = unwrap(costResult) ?? [];
    const known = new Set(
      costRows.filter((c) => c.default_direct_cost !== null).map((c) => c.product_id),
    );
    withoutCost = new Set(productIds.filter((id) => !known.has(id)));
  }

  const q = (unwrap(quotes) ?? [])[0];
  const quote: JobQuote | null = q
    ? {
        id: q.id,
        state: q.status === "open" && Date.parse(q.expires_at) <= Date.now() ? "expired" : q.status,
        channel: q.channel,
        total: toMoneyString(q.total),
        currency: q.currency,
        sentAt: q.sent_at,
        expiresAt: q.expires_at,
        answeredAt: q.answered_at,
        answeredName: q.answered_name,
      }
    : null;

  return {
    quote,
    requests: rows.map((r) => {
      const arrival = byRequest.get(r.id);
      const p = purchase.get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        description: r.description,
        quantity: toMoneyString(r.quantity),
        unitSalePrice: toMoneyString(r.unit_sale_price),
        lineTotal: toMoneyString(r.line_total ?? 0),
        currency: r.currency,
        productId: r.product_id,
        serviceId: r.service_id,
        cancelReason: r.cancel_reason,
        lineId: r.work_order_line_item_id,
        order:
          arrival && arrival.purchase_order_id && arrival.po_number
            ? {
                purchaseOrderId: arrival.purchase_order_id,
                poNumber: arrival.po_number,
                arrived: arrival.arrived === true,
                locationId: arrival.location_id,
              }
            : null,
        ...(purchaseData
          ? {
              purchase: {
                expectedUnitCost: money(p?.expected_unit_cost ?? null),
                supplierId: p?.supplier_id ?? null,
                supplierName: p?.supplier_name ?? null,
              },
            }
          : {}),
        // A consigned part's cost is what its consignor is owed, not the
        // product's default cost.
        ...(withoutCost && r.kind === "part" && r.product_id && !consignedIds.has(r.product_id)
          ? { costMissing: withoutCost.has(r.product_id) }
          : {}),
        ...(r.kind === "part" && r.product_id && consignedIds.has(r.product_id)
          ? { consigned: stockAt.get(r.product_id) ?? noStock }
          : {}),
        ...(r.kind === "part" &&
        r.product_id &&
        !consignedIds.has(r.product_id) &&
        !(arrival && arrival.purchase_order_id) &&
        (stockAt.get(r.product_id)?.onHand ?? 0) > 0
          ? { inStock: stockAt.get(r.product_id)! }
          : {}),
        ...((r.status === "approved" || r.status === "ordered") && unfitted.has(r.id)
          ? { unfitted: unfitted.get(r.id)! }
          : {}),
      };
    }),
  };
}

/** The job's approved items not on the bill yet (R-082), as Postgres counted and totalled them. */
export type UnfittedSummary = { itemCount: number; quotedTotal: string; currency: string };

/**
 * public.work_order_unfitted_requests for one job (any active staff
 * member; no cost): how many approved or ordered items are not on the bill
 * and their quoted total, summed in Postgres (D140: a memo, never part of
 * the total). Null when there are none; a read error is logged and gives
 * null, so the job page never breaks over a memo.
 */
export async function getUnfittedSummary(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<UnfittedSummary | null> {
  const { data, error } = await supabase
    .from("work_order_unfitted_requests")
    .select("item_count, quoted_total, currency")
    .eq("work_order_id", workOrderId);
  if (error) {
    logger.error({ workOrderId, code: error.code }, "unfitted indent read failed");
    return null;
  }
  // One row per currency; a job's requests are in its own currency.
  const row = (data ?? []).find((r) => (r.item_count ?? 0) > 0);
  if (!row || row.quoted_total === null) return null;
  return {
    itemCount: row.item_count ?? 0,
    quotedTotal: toMoneyString(row.quoted_total),
    currency: row.currency ?? "SGD",
  };
}

export type IndentReservation = { workOrderId: string; jobNumber: string; quantity: number };

/**
 * Arrived, unfitted indent quantities of a product by job (D146): shown on
 * the product page as reserved for those jobs, though nothing holds them.
 */
export async function getIndentReservations(
  supabase: ServerSupabase,
  productId: string,
): Promise<IndentReservation[]> {
  const rows = unwrap(await supabase.rpc("indent_reservations", { product_id: productId }));
  return (rows ?? []).map((r) => ({
    workOrderId: r.work_order_id,
    jobNumber: r.job_number,
    quantity: r.quantity,
  }));
}

export type IndentProductOption = {
  id: string;
  name: string;
  shortId: string;
  sku: string | null;
  salePrice: string | null;
  currency: string;
  /** False for a match that is already in the shop and is added with Add part instead. */
  orderable: boolean;
  /** Units on hand, for a match that is not orderable. */
  onHand: number;
  consigned: boolean;
};

/**
 * Products that can be ordered for a job (D62, D140): shop-owned, counted
 * by quantity, active and not archived, whatever their stock. Matches that
 * cannot be ordered but are in the shop now (consigned stock, a unique
 * item) come back too, not orderable, so the sheet can point to Add part.
 */
export async function searchIndentProducts(
  supabase: ServerSupabase,
  q: string,
): Promise<IndentProductOption[]> {
  const hits = await staffSearch(supabase, q, { kinds: ["product"], limit: 20 });
  const ids = hits.items.map((h) => h.id);
  if (ids.length === 0) return [];
  const rows =
    unwrap(
      await supabase
        .from("products")
        .select(
          "id, name, short_id, sku, default_sale_price, currency, tracking_type, ownership_type, active, archived_at",
        )
        .in("id", ids),
    ) ?? [];
  const levels =
    unwrap(
      await supabase
        .schema("reporting")
        .from("stock_levels")
        .select("product_id, on_hand")
        .in("product_id", ids),
    ) ?? [];
  const onHand = new Map<string, number>();
  for (const l of levels) {
    if (l.product_id) onHand.set(l.product_id, (onHand.get(l.product_id) ?? 0) + (l.on_hand ?? 0));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .filter((p) => p.active && p.archived_at === null && p.ownership_type !== "customer_owned")
    .map((p) => ({
      p,
      // D265: consigned stock counted by quantity is proposed too (quoted,
      // then fitted from stock; never ordered).
      // A consigned product with no stock could be quoted but never fitted.
      orderable:
        p.tracking_type === "quantity" &&
        (p.ownership_type === "shop_owned" ||
          (p.ownership_type === "consignment" && (onHand.get(p.id) ?? 0) > 0)),
      stock: onHand.get(p.id) ?? 0,
    }))
    .filter(({ orderable, stock }) => orderable || stock > 0)
    .sort((a, b) => (order.get(a.p.id) ?? 0) - (order.get(b.p.id) ?? 0))
    .map(({ p, orderable, stock }) => ({
      id: p.id,
      name: p.name,
      shortId: p.short_id,
      sku: p.sku,
      salePrice: money(p.default_sale_price),
      currency: p.currency,
      orderable,
      onHand: stock,
      consigned: p.ownership_type === "consignment",
    }));
}

/** propose_part (D140): returns the request id (replay-safe on it). */
export async function proposePart(
  supabase: ServerSupabase,
  input: {
    requestId: string;
    workOrderId: string;
    productId: string;
    quantity: number;
    unitSalePrice: string | null;
    expectedUnitCost: string | null;
    supplierId: string | null;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("propose_part", {
        request_id: input.requestId,
        work_order_id: input.workOrderId,
        product_id: input.productId,
        quantity: input.quantity,
        ...(input.unitSalePrice !== null
          ? { unit_sale_price: input.unitSalePrice as unknown as number }
          : {}),
        ...(input.expectedUnitCost !== null
          ? { expected_unit_cost: input.expectedUnitCost as unknown as number }
          : {}),
        ...(input.supplierId !== null ? { supplier_id: input.supplierId } : {}),
      }),
    ),
    "RPC",
  );
}

const ONE_OFF_PROPOSE_FIELDS: Record<string, string> = {
  one_off_name_required: "name",
  quantity_invalid: "quantity",
  part_price_missing: "unitSalePrice",
  one_off_cost_required: "unitCost",
  one_off_consignor_required: "consignorId",
  location_inactive: "locationId",
  location_required: "locationId",
};

/** D265: a new one-off item made and proposed on the quote; returns the request id. */
export async function proposeOneOffPart(
  supabase: ServerSupabase,
  input: {
    requestId: string;
    workOrderId: string;
    name: string;
    quantity: number;
    unitSalePrice: string;
    consigned: boolean;
    consignorId: string | null;
    agreedAmountOwed: string | null;
    unitCost: string | null;
    locationId: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase.rpc("propose_one_off_part", {
    request_id: input.requestId,
    work_order_id: input.workOrderId,
    name: input.name,
    quantity: input.quantity,
    unit_sale_price: input.unitSalePrice,
    consigned: input.consigned,
    consignor_id: input.consigned ? (input.consignorId ?? undefined) : undefined,
    agreed_amount_owed: input.consigned ? (input.agreedAmountOwed ?? undefined) : undefined,
    unit_direct_cost: input.consigned ? undefined : (input.unitCost ?? undefined),
    location_id: input.locationId ?? undefined,
  });
  if (error) {
    const err = new DbError(error);
    const mapped = mapDbError(err);
    const field = mapped.reason ? ONE_OFF_PROPOSE_FIELDS[mapped.reason] : undefined;
    if (field && mapped.kind !== "unknown" && mapped.kind !== "unavailable") {
      throw new DomainError(mapped.message, { [field]: [mapped.message] });
    }
    throw err;
  }
  return returned(data, "RPC");
}

/** propose_service (D140): returns the request id. */
export async function proposeService(
  supabase: ServerSupabase,
  input: {
    requestId: string;
    workOrderId: string;
    serviceId: string;
    quantity: string;
    unitSalePrice: string | null;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("propose_service", {
        request_id: input.requestId,
        work_order_id: input.workOrderId,
        service_id: input.serviceId,
        quantity: input.quantity as unknown as number,
        ...(input.unitSalePrice !== null
          ? { unit_sale_price: input.unitSalePrice as unknown as number }
          : {}),
      }),
    ),
    "RPC",
  );
}

/** cancel_part_request with a reason. */
export async function cancelPartRequest(
  supabase: ServerSupabase,
  requestId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("cancel_part_request", { request_id: requestId, reason }));
}

/** Who a quote email goes to (D144): the job's customer, read through staff RLS. */
export async function getQuoteRecipient(
  supabase: ServerSupabase,
  workOrderId: string,
): Promise<{ jobNumber: string; firstName: string | null; email: string | null } | null> {
  const row = unwrap(
    await supabase
      .from("work_orders")
      .select("job_number, customer:customers(first_name, email)")
      .eq("id", workOrderId)
      .maybeSingle(),
  );
  if (!row) return null;
  return {
    jobNumber: row.job_number,
    firstName: row.customer?.first_name ?? null,
    email: row.customer?.email ?? null,
  };
}

/** send_quote (D141): returns the link token, which is never readable again. */
export async function sendQuote(
  supabase: ServerSupabase,
  input: {
    quoteId: string;
    workOrderId: string;
    requestIds: string[];
    channel: QuoteChannel;
    validDays: number;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("send_quote", {
        quote_id: input.quoteId,
        work_order_id: input.workOrderId,
        request_ids: input.requestIds,
        channel: input.channel,
        valid_days: input.validDays,
      }),
    ),
    "RPC",
  );
}

/** withdraw_quote: the link stops working; its items go back to proposed. */
export async function withdrawQuote(supabase: ServerSupabase, quoteId: string): Promise<void> {
  unwrap(await supabase.rpc("withdraw_quote", { quote_id: quoteId }));
}

/**
 * order_part_requests (D145, manage_purchasing): returns the purchase order
 * id. A part whose quote's deposit is not paid (D152) needs an active admin
 * or manager and `overrideReason`, recorded on the job's timeline; without
 * one the database refuses with deposit_unpaid.
 */
export async function orderPartRequests(
  supabase: ServerSupabase,
  input: {
    requestIds: string[];
    supplierId: string;
    purchaseOrderId: string;
    moveToWaiting: boolean;
    overrideReason?: string | null;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("order_part_requests", {
        request_ids: input.requestIds,
        supplier_id: input.supplierId,
        purchase_order_id: input.purchaseOrderId,
        move_to_waiting: input.moveToWaiting,
        ...(input.overrideReason ? { override_reason: input.overrideReason } : {}),
      }),
    ),
    "RPC",
  );
}

/** fit_part_request (D140, D146): returns the new line's id. */
export async function fitPartRequest(
  supabase: ServerSupabase,
  input: { requestId: string; lineId: string; locationId: string | null },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("fit_part_request", {
        request_id: input.requestId,
        line_id: input.lineId,
        ...(input.locationId !== null ? { location_id: input.locationId } : {}),
      }),
    ),
    "RPC",
  );
}

/**
 * fit_part_bought_outside (D149a; View costs or Manage purchasing): records
 * an approved part never ordered in BICII as bought outside at `unitCost`
 * (what the shop paid for one) and fits it in the same transaction, at
 * `locationId` or the default location. Returns the new line's id
 * (replay-safe on it). The cost is passed as a fixed-point string.
 */
export async function fitPartBoughtOutside(
  supabase: ServerSupabase,
  input: {
    requestId: string;
    lineId: string;
    unitCost: string;
    locationId: string | null;
    reference: string | null;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("fit_part_bought_outside", {
        request_id: input.requestId,
        line_id: input.lineId,
        unit_cost: input.unitCost as unknown as number,
        ...(input.locationId !== null ? { location_id: input.locationId } : {}),
        ...(input.reference !== null ? { reference: input.reference } : {}),
      }),
    ),
    "RPC",
  );
}
