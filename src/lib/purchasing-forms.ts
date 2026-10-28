/**
 * Input schemas of the purchasing Server Actions (src/app/(staff)/purchasing
 * /actions.ts and supplier-actions.ts; step 4's receiving reuses
 * purchaseUnitCostSchema). Pure, so they are unit-tested directly; the RPCs,
 * column checks and triggers check everything again (DATA-MODEL §10).
 *
 *   - unit costs: what staff typed, parsed with parseMoney, 0..99,999.99
 *     with at most 2 decimals (purchase_order_lines_unit_cost_check), sent
 *     on as a fixed-point string, never a float. 0 is a KNOWN cost (D24 as
 *     amended by the owner, 2026-10-05): only a missing value is missing;
 *   - quantities: whole numbers 1..100,000;
 *   - dates: a shop day "YYYY-MM-DD" from a native date input, or blank;
 *   - reasons: trimmed, at most 500 characters.
 */
import { z } from "zod";

import { parseShopDay } from "@/lib/dates";
import { Decimal, formatMoney, parseMoney, toMoneyString } from "@/lib/money";
import { MAX_PURCHASE_QUANTITY, MAX_PURCHASE_UNIT_COST, normaliseWebsite } from "@/lib/purchasing";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

export { MAX_PURCHASE_QUANTITY, MAX_PURCHASE_UNIT_COST };

const MAX_COST = new Decimal(MAX_PURCHASE_UNIT_COST);

/**
 * A purchase unit cost: 0..99,999.99, at most 2 decimals; to a fixed-point
 * string ("12.00"). 0 is valid (free goods are a known cost, D24 amended).
 */
export const purchaseUnitCostSchema = z
  .union([z.string(), z.number()], { error: "Enter the unit cost." })
  .transform((v) => (typeof v === "number" ? String(v) : v).trim())
  .refine((v) => v !== "", { error: "Enter the unit cost.", abort: true })
  .refine((v) => !/\.\d{3,}$/.test(v), {
    error: "Use at most 2 decimals, like 12.50.",
    abort: true,
  })
  .refine((v) => parseMoney(v) !== null, {
    error: "Enter the unit cost as an amount of 0 or more, like 12.50.",
    abort: true,
  })
  .refine((v) => parseMoney(v)!.lte(MAX_COST), {
    error: `The unit cost can be at most ${formatMoney(MAX_PURCHASE_UNIT_COST)}.`,
  })
  .transform((v) => toMoneyString(parseMoney(v)!));

/** Optional text: trimmed, at most `max` characters, blank is null. */
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

/** A whole number typed as text (or sent as a number) within bounds. */
const wholeNumber = (min: number, max: number, messages: { invalid: string; range: string }) =>
  z
    .union([z.string(), z.number()], { error: messages.invalid })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => /^-?\d+$/.test(v), { error: messages.invalid, abort: true })
    .transform((v) => Number(v))
    .refine((v) => v >= min && v <= max, { error: messages.range });

/** A blank-or-shop-day date input ("2026-10-12"); blank is null. */
const optionalDay = (what: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || parseShopDay(v) !== null, {
      error: `Enter the ${what} as a date.`,
    });

const optionalReason = z
  .string()
  .trim()
  .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` })
  .nullish()
  .transform((v) => v || null);

/** A whole quantity ordered on a line: 1..100,000. */
export const purchaseQuantitySchema = wholeNumber(1, MAX_PURCHASE_QUANTITY, {
  invalid: "Enter a whole number, like 1 or 20.",
  range: "Order between 1 and 100,000.",
});

// The same shape suppliers_email_check accepts.
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const WEBSITE = /^https?:\/\/\S+$/i;

/** The supplier fields shared by New supplier and Edit. */
export const supplierFields = {
  name: z
    .string({ error: "Name the supplier." })
    .trim()
    .min(1, { error: "Name the supplier." })
    .max(200, { error: "Keep the name under 200 characters." }),
  contactName: text(200, "contact name"),
  email: text(320, "email").refine((v) => v === null || EMAIL.test(v), {
    error: "Enter a valid email address.",
  }),
  phone: text(40, "phone number"),
  website: z
    .string()
    .trim()
    .max(300, { error: "Keep the website under 300 characters." })
    .nullish()
    .transform((v) => normaliseWebsite(v))
    .refine((v) => v === null || (WEBSITE.test(v) && v.length <= 300), {
      error: "Enter a website like veloparts.test or https://veloparts.test.",
    }),
  accountReference: text(100, "account reference"),
  notes: text(10_000, "notes"),
};

export const supplierSchema = z.object({
  /** New supplier: the form's idempotency key. Edit: the supplier. */
  id: z.guid({ error: "Open the form again." }),
  ...supplierFields,
});

export const setSupplierArchivedSchema = z.object({
  supplierId: z.guid({ error: "Unknown supplier." }),
  archived: z.boolean(),
});

/** A switch inside a form: "on" when on, absent when off. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

const optionalLeadDays = z
  .preprocess(
    (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    wholeNumber(0, 365, {
      invalid: "Enter the lead time as a whole number of days, like 7.",
      range: "Enter a lead time from 0 to 365 days.",
    }).optional(),
  )
  .transform((v) => (v === undefined ? null : v));

export const supplierProductSchema = z.object({
  supplierId: z.guid({ error: "Choose a supplier from the list." }),
  productId: z.guid({ error: "Choose a product from the list." }),
  supplierSku: text(100, "supplier SKU"),
  leadDays: optionalLeadDays,
  preferred: toggle,
});

export const removeSupplierProductSchema = z.object({
  supplierId: z.guid({ error: "Unknown supplier." }),
  productId: z.guid({ error: "Unknown product." }),
});

/** The PO header fields shared by New order and Edit details. */
export const purchaseOrderFields = {
  supplierId: z.guid({ error: "Choose a supplier from the list." }),
  expectedAt: optionalDay("expected date"),
  supplierReference: text(100, "supplier reference"),
  notes: text(2_000, "notes"),
};

export const createPurchaseOrderSchema = z.object({
  /** The form's idempotency key (made when the sheet opens). */
  id: z.guid({ error: "Open New order again." }),
  ...purchaseOrderFields,
});

export const updatePurchaseOrderSchema = z.object({
  purchaseOrderId: z.guid({ error: "Unknown order." }),
  ...purchaseOrderFields,
});

export const purchaseOrderLineSchema = z.object({
  /** Add: the sheet's idempotency key. Edit: the line. */
  id: z.guid({ error: "Open the line again." }),
  purchaseOrderId: z.guid({ error: "Unknown order." }),
  productId: z.guid({ error: "Choose a product from the list." }),
  quantityOrdered: purchaseQuantitySchema,
  unitCost: purchaseUnitCostSchema,
  expectedAt: optionalDay("expected date"),
  notes: text(500, "notes"),
  reason: optionalReason,
});

export const removePurchaseOrderLineSchema = z.object({
  lineId: z.guid({ error: "Unknown line." }),
  reason: optionalReason,
});

export const purchaseOrderIdSchema = z.object({
  purchaseOrderId: z.guid({ error: "Unknown order." }),
});

export const cancelPurchaseOrderSchema = z.object({
  purchaseOrderId: z.guid({ error: "Unknown order." }),
  reason: z
    .string({ error: "Say why the order is being cancelled." })
    .trim()
    .min(1, { error: "Say why the order is being cancelled." })
    .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
});

export const purchaseCostDefaultsSchema = z.object({
  supplierId: z.guid({ error: "Unknown supplier." }),
  productIds: z.array(z.guid()).min(1).max(200),
});

export const purchasingSearchSchema = z.object({ q: z.string().trim().max(200) });

// ---------------------------------------------------------------------------
// Receiving and reorder (Phase 7 step 4)
// ---------------------------------------------------------------------------

/** One received line: a whole quantity 1..100,000, the actual cost (0 valid), a location. */
export const receiptLineSchema = z.object({
  purchaseOrderLineId: z.guid({ error: "Refresh the order and try again." }),
  quantityReceived: z
    .number({ error: "Enter a whole number of units received." })
    .int({ error: "Enter a whole number of units received." })
    .min(1, { error: "Receive at least 1 unit on a line." })
    .max(MAX_PURCHASE_QUANTITY, { error: "Receive at most 100,000 units on a line." }),
  unitCostActual: purchaseUnitCostSchema,
  locationId: z.guid({ error: "Choose where the units go." }),
});

/**
 * Receive a delivery (receive_purchase). The idempotency key is the form's
 * (made when it first mounts, kept across retries); receivedAt is sent only
 * when staff changed it (an ISO instant), else the server uses now() (D64).
 */
export const receivePurchaseSchema = z.object({
  purchaseOrderId: z.guid({ error: "Unknown order." }),
  idempotencyKey: z.guid({ error: "Reload the page and try again." }),
  reference: text(100, "delivery note reference"),
  receivedAt: z.iso
    .datetime({ offset: true, error: "Enter the delivery date and time." })
    .nullish()
    .transform((v) => v ?? null),
  notes: text(2_000, "notes"),
  lines: z
    .array(receiptLineSchema)
    .min(1, { error: "Receive at least one line." })
    .max(200, { error: "Receive at most 200 lines at once." }),
});

export const lookupReceiptSchema = z.object({
  idempotencyKey: z.guid({ error: "Unknown delivery." }),
});

/** A draft order from the low-stock list (D66); the id is the page's idempotency key. */
export const createPurchaseOrderFromLowStockSchema = z.object({
  id: z.guid({ error: "Reload the page and try again." }),
  supplierId: z.guid({ error: "Choose a supplier from the list." }),
  productIds: z
    .array(z.guid())
    .min(1, { error: "Choose at least one product." })
    .max(100, { error: "Choose at most 100 products." }),
});
