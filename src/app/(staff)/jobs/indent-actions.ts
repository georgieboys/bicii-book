"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { hasPermission } from "@/lib/auth/permissions";
import {
  cancelPartRequest,
  fitPartRequest,
  getQuoteRecipient,
  orderPartRequests,
  proposePart,
  proposeService,
  searchIndentProducts,
  sendQuote,
  withdrawQuote,
} from "@/lib/domain/indent";
import { createProduct } from "@/lib/domain/inventory";
import { listSuppliers } from "@/lib/domain/suppliers";
import { QUOTE_DAYS, quotePath } from "@/lib/indent";
import { quoteEmailEnabled, sendQuoteEmail } from "@/lib/integrations/email/quote";
import { Decimal, parseMoney, toMoneyString } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/**
 * Indent parts and quotes on a job (Phase 13; PLAN D140-D147, ADR-024).
 * Every write is an RPC that checks again: any staff member proposes,
 * quotes, cancels and fits on an open job; ordering needs Manage purchasing;
 * a cost or supplier needs View costs or Manage purchasing (D60, D147);
 * creating a new product needs Manage inventory.
 */

const MAX_MONEY = new Decimal("9999999.99");

const money = (what: string) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .refine((v) => parseMoney(v) !== null, {
      error: `Enter the ${what} as an amount of 0 or more, like 12.50.`,
      abort: true,
    })
    .refine((v) => parseMoney(v)!.lte(MAX_MONEY), { error: `The ${what} is too large.` })
    .transform((v) => toMoneyString(parseMoney(v)!));

const optionalMoney = (what: string) =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      money(what).optional(),
    )
    .transform((v) => v ?? null);

const optionalId = (what: string) =>
  z
    .preprocess((v) => (v === "" ? undefined : v), z.uuid({ error: what }).optional())
    .transform((v) => v ?? null);

const workOrderId = z.uuid({ error: "Unknown job." });

/** Products that can be ordered for a job (shop-owned, counted, active). */
export const searchIndentProductOptions = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "indent.search_products" },
  async ({ q }, { supabase }) => (q ? searchIndentProducts(supabase, q) : []),
);

/** Active suppliers for the order sheet and a proposal's expected supplier. */
export const supplierOptions = staffAction(
  z.object({ q: z.string().trim().max(200).default("") }),
  { name: "indent.supplier_options" },
  async ({ q }, { supabase, staff }) => {
    if (!hasPermission(staff, "view_costs") && !hasPermission(staff, "manage_purchasing"))
      return [];
    const { items } = await listSuppliers(supabase, { q, limit: 50 });
    return items.map((s) => ({ id: s.id, name: s.name }));
  },
);

const proposePartSchema = z
  .object({
    requestId: z.uuid({ error: "Open the form again." }),
    workOrderId,
    productId: optionalId("Choose a part."),
    // A new product (Manage inventory): its name and price, and its cost.
    newProductId: optionalId("Open the form again."),
    newName: z.string().trim().max(200).default(""),
    newPrice: optionalMoney("selling price"),
    quantity: z.coerce
      .number({ error: "Enter the quantity." })
      .int({ error: "Parts are counted in whole numbers." })
      .min(1, { error: "Add at least 1." })
      .max(999, { error: "Add at most 999." }),
    unitSalePrice: optionalMoney("price"),
    expectedUnitCost: optionalMoney("expected cost"),
    supplierId: optionalId("Choose a supplier."),
  })
  .superRefine((v, ctx) => {
    if (v.productId === null && v.newName === "") {
      ctx.addIssue({
        code: "custom",
        path: ["productId"],
        message: "Choose a part or name a new one.",
      });
    }
    if (v.productId === null && v.newName !== "" && v.newPrice === null) {
      ctx.addIssue({ code: "custom", path: ["newPrice"], message: "Enter the selling price." });
    }
  });

/**
 * Propose an indent part (D140): an existing product, or a new one created
 * here first (Manage inventory: internal, counted by quantity, with its
 * price and, for cost holders, the expected cost as its cost).
 */
export const proposePartAction = staffAction(
  proposePartSchema,
  { name: "indent.propose_part" },
  async (input, { supabase, staff }) => {
    const purchaseData =
      hasPermission(staff, "view_costs") || hasPermission(staff, "manage_purchasing");
    let productId = input.productId;
    if (productId === null) {
      if (!hasPermission(staff, "manage_inventory")) {
        throw new ActionError(
          "Only staff who manage inventory can add a new product. Choose an existing one.",
          {
            productId: ["Choose an existing part."],
          },
        );
      }
      if (input.newProductId === null) throw new ActionError("Open the form again.");
      ({ id: productId } = await createProduct(supabase, input.newProductId, {
        trackingType: "quantity",
        name: input.newName,
        sku: null,
        brand: null,
        categoryId: null,
        description: null,
        salePrice: input.newPrice,
        cost: hasPermission(staff, "view_costs") ? input.expectedUnitCost : null,
        reorderPoint: null,
        active: true,
      }));
    }
    const id = await proposePart(supabase, {
      requestId: input.requestId,
      workOrderId: input.workOrderId,
      productId,
      quantity: input.quantity,
      unitSalePrice: input.unitSalePrice,
      expectedUnitCost: purchaseData ? input.expectedUnitCost : null,
      supplierId: purchaseData ? input.supplierId : null,
    });
    refresh();
    return { id };
  },
);

/** Propose a catalogue service, such as fitting labour (D140). */
export const proposeServiceAction = staffAction(
  z.object({
    requestId: z.uuid({ error: "Open the form again." }),
    workOrderId,
    serviceId: z.uuid({ error: "Choose a service." }),
    quantity: z
      .string({ error: "Enter the quantity." })
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, { error: "Enter a quantity like 1 or 1.5." })
      .refine((v) => new Decimal(v).gt(0) && new Decimal(v).lte(999), {
        error: "Enter a quantity from 0.01 to 999.",
      }),
    unitSalePrice: optionalMoney("price"),
  }),
  { name: "indent.propose_service" },
  async (input, { supabase }) => {
    const id = await proposeService(supabase, input);
    refresh();
    return { id };
  },
);

/** Cancel a request that is not on an open quote and not fitted, with a reason. */
export const cancelPartRequestAction = staffAction(
  z.object({
    requestId: z.uuid({ error: "Unknown item." }),
    reason: z
      .string({ error: "Say why it is cancelled." })
      .trim()
      .min(1, { error: "Say why it is cancelled." })
      .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
  }),
  { name: "indent.cancel" },
  async ({ requestId, reason }, { supabase }) => {
    await cancelPartRequest(supabase, requestId, reason);
    refresh();
    return null;
  },
);

/** This request's own origin, so a link works on whichever Admin address staff use. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Send proposed items as a quote (D141, D144). Returns the link, shown to
 * staff this once (only its hash is stored): the sheet then opens WhatsApp
 * or copies it. By email (when RESEND_API_KEY and EMAIL_FROM are set and
 * the customer has an address) the Admin also emails it; a failed email
 * keeps the quote, and staff copy the link instead.
 */
export const sendQuoteAction = staffAction(
  z.object({
    quoteId: z.uuid({ error: "Open the form again." }),
    workOrderId,
    requestIds: z
      .array(z.uuid({ error: "Unknown item." }))
      .min(1, { error: "Choose at least one item." })
      .max(50, { error: "Send at most 50 items at once." }),
    channel: z.enum(["whatsapp", "email", "link"], { error: "Choose how to send it." }),
    validDays: z.coerce
      .number()
      .int()
      .min(QUOTE_DAYS.min, { error: `At least ${QUOTE_DAYS.min} day.` })
      .max(QUOTE_DAYS.max, { error: `At most ${QUOTE_DAYS.max} days.` }),
  }),
  { name: "indent.send_quote" },
  async (input, { supabase }) => {
    const recipient =
      input.channel === "email" ? await getQuoteRecipient(supabase, input.workOrderId) : null;
    if (input.channel === "email") {
      if (!quoteEmailEnabled()) {
        throw new ActionError("Email isn't set up yet. Send by WhatsApp or copy the link.");
      }
      if (!recipient?.email) {
        throw new ActionError(
          "The customer has no email address. Add one, or send by WhatsApp or copy the link.",
        );
      }
    }
    const token = await sendQuote(supabase, input);
    const link = `${await origin()}${quotePath(token)}`;
    let emailedTo: string | null = null;
    let emailFailed = false;
    if (recipient?.email) {
      const sent = await sendQuoteEmail({
        quoteId: input.quoteId,
        to: recipient.email,
        firstName: recipient.firstName,
        jobNumber: recipient.jobNumber,
        link,
        days: input.validDays,
      });
      if (sent.ok) emailedTo = recipient.email;
      else emailFailed = true;
    }
    refresh();
    return { link, validDays: input.validDays, emailedTo, emailFailed };
  },
);

/** Withdraw the open quote: its link stops working, its items go back to proposed. */
export const withdrawQuoteAction = staffAction(
  z.object({ quoteId: z.uuid({ error: "Unknown quote." }) }),
  { name: "indent.withdraw_quote" },
  async ({ quoteId }, { supabase }) => {
    await withdrawQuote(supabase, quoteId);
    refresh();
    return null;
  },
);

/** Order approved parts from one supplier (D145, Manage purchasing). */
export const orderPartRequestsAction = staffAction(
  z.object({
    requestIds: z
      .array(z.uuid({ error: "Unknown item." }))
      .min(1, { error: "Choose at least one part." })
      .max(50, { error: "Order at most 50 parts at once." }),
    supplierId: z.uuid({ error: "Choose a supplier." }),
    purchaseOrderId: z.uuid({ error: "Open the form again." }),
    moveToWaiting: z.boolean(),
  }),
  { name: "indent.order", permission: "manage_purchasing" },
  async (input, { supabase }) => {
    const purchaseOrderId = await orderPartRequests(supabase, input);
    refresh();
    return { purchaseOrderId };
  },
);

/** Put an approved or ordered request on the job as an ordinary line (D146). */
export const fitPartRequestAction = staffAction(
  z.object({
    requestId: z.uuid({ error: "Unknown item." }),
    lineId: z.uuid({ error: "Open the form again." }),
    locationId: optionalId("Unknown location."),
  }),
  { name: "indent.fit" },
  async (input, { supabase }) => {
    const lineId = await fitPartRequest(supabase, input);
    refresh();
    return { lineId };
  },
);
