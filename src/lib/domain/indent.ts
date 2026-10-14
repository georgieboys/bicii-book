import "server-only";

import { unwrap } from "@/lib/db-errors";
import type { PartRequestKind, PartRequestStatus, QuoteChannel, QuoteState } from "@/lib/indent";
import { toMoneyString } from "@/lib/money";
import type { ServerSupabase } from "@/lib/supabase/server";

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
};

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

/** The job's indent requests (oldest first) and its latest quote. */
export async function getIndentPanel(
  supabase: ServerSupabase,
  workOrderId: string,
  { purchaseData }: { purchaseData: boolean },
): Promise<IndentPanel> {
  const [requests, quotes, arrivals] = await Promise.all([
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
  ]);
  const rows = unwrap(requests) ?? [];
  const arrivalRows = unwrap(arrivals) ?? [];
  const byRequest = new Map(arrivalRows.map((a) => [a.request_id, a]));

  let purchase = new Map<
    string,
    { expected_unit_cost: number | null; supplier_id: string | null; supplier_name: string | null }
  >();
  if (purchaseData && rows.length > 0) {
    const staffRows =
      unwrap(
        await supabase
          .from("job_part_requests_staff")
          .select("id, expected_unit_cost, supplier_id, supplier_name")
          .in(
            "id",
            rows.map((r) => r.id),
          ),
      ) ?? [];
    purchase = new Map(staffRows.map((r) => [r.id!, r]));
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
      };
    }),
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
};

/**
 * Products that can be ordered for a job (D62, D140): shop-owned, counted
 * by quantity, active and not archived, whatever their stock.
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
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .filter(
      (p) =>
        p.tracking_type === "quantity" &&
        p.ownership_type === "shop_owned" &&
        p.active &&
        p.archived_at === null,
    )
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((p) => ({
      id: p.id,
      name: p.name,
      shortId: p.short_id,
      sku: p.sku,
      salePrice: money(p.default_sale_price),
      currency: p.currency,
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

/** order_part_requests (D145, manage_purchasing): returns the purchase order id. */
export async function orderPartRequests(
  supabase: ServerSupabase,
  input: {
    requestIds: string[];
    supplierId: string;
    purchaseOrderId: string;
    moveToWaiting: boolean;
  },
): Promise<string> {
  return returned(
    unwrap(
      await supabase.rpc("order_part_requests", {
        request_ids: input.requestIds,
        supplier_id: input.supplierId,
        purchase_order_id: input.purchaseOrderId,
        move_to_waiting: input.moveToWaiting,
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
