/**
 * Input schemas of the inventory Server Actions (src/app/(staff)/inventory
 * /actions.ts, addPartToJob in jobs/actions.ts). Pure, so they are
 * unit-tested directly; the RPCs and triggers check everything again.
 *
 *   - quantities on a job or a transfer: whole numbers 1..999 (a transfer
 *     of counted stock up to 100,000);
 *   - adjustments: whole numbers −100,000..100,000, never 0;
 *   - money: what staff typed, parsed with parseMoney, 0 or more, sent on
 *     as a fixed-point string (never a float);
 *   - reasons: trimmed, at most REASON_MAX_LENGTH, required where the RPC
 *     requires one;
 *   - request, line and unit ids: uuids made with newId() when the sheet
 *     (or a write-off's confirmation) opens, the idempotency keys.
 */
import { z } from "zod";

import { Decimal, parseMoney, toMoneyString } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

const MAX_MONEY = new Decimal("9999999.99");

/** A required amount of 0 or more, to a fixed-point string. */
export const money = (what: string) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .refine((v) => parseMoney(v) !== null, {
      error: `Enter the ${what} as an amount of 0 or more, like 12.50.`,
      abort: true,
    })
    .refine((v) => parseMoney(v)!.lte(MAX_MONEY), {
      error: `The ${what} can be at most $9,999,999.99.`,
    })
    .transform((v) => toMoneyString(parseMoney(v)!));

/** An optional amount: blank (or missing) is null. */
export const optionalMoney = (what: string) =>
  z
    .preprocess(
      (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
      money(what).optional(),
    )
    .transform((v) => v ?? null);

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

/** A part's or a transfer's quantity: 1..999. */
export const partQuantity = wholeNumber(1, 999, {
  invalid: "Enter a whole number, like 1 or 2.",
  range: "Add between 1 and 999.",
});

/** A transfer of counted stock: 1..100,000. */
export const transferQuantity = wholeNumber(1, 100_000, {
  invalid: "Enter a whole number, like 1 or 2.",
  range: "Move between 1 and 100,000.",
});

/** How many an adjustment adds or removes (the direction is separate): 1..100,000. */
export const adjustmentQuantity = wholeNumber(1, 100_000, {
  invalid: "Enter a whole number, like 1 or 10.",
  range: "Enter between 1 and 100,000.",
});

export const reason = (what: string) =>
  z
    .string({ error: what })
    .trim()
    .min(1, { error: what })
    .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` });

export const optionalReason = z
  .string()
  .trim()
  .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` })
  .nullish()
  .transform((v) => v || null);

/** A picker's hidden input: an id, or empty for none. */
const optionalId = (error: string) =>
  z
    .union([z.guid({ error }), z.literal(""), z.null()])
    .optional()
    .transform((v) => v || null);

/** A switch inside a form: "on" when on, absent when off. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

const reorderPoint = z
  .preprocess(
    (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    wholeNumber(0, 1_000_000, {
      invalid: "Enter the reorder point as a whole number, like 5.",
      range: "The reorder point can't be negative.",
    }).optional(),
  )
  .transform((v) => (v === undefined ? null : v));

/** The product fields shared by New product and Edit details. */
export const productFields = {
  name: z
    .string({ error: "Name the product." })
    .trim()
    .min(1, { error: "Name the product." })
    .max(200, { error: "Keep the name under 200 characters." }),
  sku: text(64, "SKU"),
  brand: text(100, "brand"),
  categoryId: optionalId("Choose a category from the list."),
  description: text(5_000, "description"),
  salePrice: optionalMoney("sale price"),
  /** view_costs only; on edit, blank keeps the current cost. */
  cost: optionalMoney("cost"),
  reorderPoint,
  active: toggle,
};

/** The first unit's (or Add unit's) fields. */
export const unitFields = {
  locationId: z.guid({ error: "Choose where the item is." }),
  serialNumber: text(100, "serial number"),
  condition: text(500, "condition"),
  unitSalePrice: optionalMoney("unit sale price"),
  /** view_costs only. */
  unitCost: optionalMoney("unit cost"),
  bikeId: optionalId("Choose the bike from the list."),
};

export const createProductSchema = z.object({
  /** The form's idempotency key. */
  id: z.guid({ error: "Open New product again." }),
  trackingType: z.enum(["quantity", "unique"], { error: "Choose Quantity or Unique." }),
  ...productFields,
});

export const createUniqueItemSchema = z.object({
  id: z.guid({ error: "Open New product again." }),
  unitId: z.guid({ error: "Open New product again." }),
  ...productFields,
  ...unitFields,
});

export const updateProductSchema = z.object({
  id: z.guid({ error: "Unknown product." }),
  ...productFields,
});

export const addUnitSchema = z.object({
  unitId: z.guid({ error: "Open Add unit again." }),
  productId: z.guid({ error: "Unknown product." }),
  ...unitFields,
});

export const updateUnitSchema = z.object({
  id: z.guid({ error: "Unknown unit." }),
  serialNumber: text(100, "serial number"),
  condition: text(500, "condition"),
  unitSalePrice: optionalMoney("sale price"),
  unitCost: optionalMoney("cost"),
  internalNotes: text(10_000, "notes"),
});

export const adjustStockSchema = z
  .object({
    requestId: z.guid({ error: "Open Adjust stock again." }),
    productId: z.guid({ error: "Unknown product." }),
    locationId: z.guid({ error: "Choose a location." }),
    direction: z.enum(["add", "remove"], { error: "Choose Add or Remove." }),
    quantity: adjustmentQuantity,
    type: z
      .enum(["stock_adjustment", "damaged"], { error: "Choose Adjustment or Damaged." })
      .default("stock_adjustment"),
    reason: reason("Say why the stock is changing."),
    unitCost: optionalMoney("unit cost"),
  })
  .superRefine((v, ctx) => {
    if (v.type === "damaged" && v.direction === "add") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "Damaged stock is always removed.",
      });
    }
    if (v.unitCost !== null && v.direction === "remove") {
      ctx.addIssue({
        code: "custom",
        path: ["unitCost"],
        message: "A unit cost is recorded only for stock added.",
      });
    }
  })
  .transform(({ direction, quantity, ...v }) => ({
    ...v,
    delta: direction === "add" ? quantity : -quantity,
  }));

export const transferStockSchema = z
  .object({
    requestId: z.guid({ error: "Open Transfer again." }),
    productId: z.guid({ error: "Unknown product." }),
    fromLocationId: z.guid({ error: "Choose where it is now." }),
    toLocationId: z.guid({ error: "Choose where it goes." }),
    quantity: transferQuantity,
    reason: optionalReason,
    unitId: optionalId("Unknown unit."),
  })
  .superRefine((v, ctx) => {
    if (v.fromLocationId === v.toLocationId) {
      ctx.addIssue({
        code: "custom",
        path: ["toLocationId"],
        message: "Choose two different locations.",
      });
    }
    if (v.unitId && v.quantity !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "A unique item moves one at a time.",
      });
    }
  });

export const writeOffUnitSchema = z.object({
  requestId: z.guid({ error: "Open Write off again." }),
  unitId: z.guid({ error: "Unknown unit." }),
  reason: reason("Say why the unit is being written off."),
});

export const addPartSchema = z
  .object({
    lineId: z.guid({ error: "Open Add part again." }),
    workOrderId: z.guid({ error: "Unknown job." }),
    productId: z.guid({ error: "Choose a part from the list." }),
    unitId: optionalId("Choose a part from the list."),
    quantity: partQuantity,
    locationId: optionalId("Choose a location."),
    unitSalePrice: optionalMoney("price"),
  })
  .superRefine((v, ctx) => {
    if (v.unitId && v.quantity !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "A unique item is added one at a time.",
      });
    }
  });

export const searchSchema = z.object({
  q: z.string().trim().max(200),
  locationId: z.guid().optional(),
});

export const setPublicationSchema = z.object({
  productId: z.guid({ error: "Unknown product." }),
  status: z.enum(["draft", "internal_only", "public", "sold", "archived"], {
    error: "Choose what to do with the listing.",
  }),
  reason: optionalReason,
});

/** Split off as unique item (D28): the two ids are made when the sheet opens. */
export const splitToUniqueSchema = z.object({
  newProductId: z.guid({ error: "Open Split off again." }),
  unitId: z.guid({ error: "Open Split off again." }),
  sourceProductId: z.guid({ error: "Unknown product." }),
  locationId: z.guid({ error: "Choose where the item is." }),
  name: productFields.name,
  serialNumber: text(100, "serial number"),
  condition: text(500, "condition"),
  salePrice: optionalMoney("sale price"),
  // The split's ledger reason is "Split to U-######: " plus this, within
  // the ledger's 500 characters (split_unit_from_stock).
  reason: z
    .string({ error: "Say why it is being split off." })
    .trim()
    .min(1, { error: "Say why it is being split off." })
    .max(480, { error: "Keep the reason under 480 characters." }),
});

/** A location's fields (Settings → Locations); the id is the form's idempotency key. */
export const locationSchema = z.object({
  id: z.guid({ error: "Open the form again." }),
  name: z
    .string({ error: "Name the location." })
    .trim()
    .min(1, { error: "Name the location." })
    .max(80, { error: "Keep the name under 80 characters." }),
  kind: z.enum(["shop_floor", "workshop", "storage", "offsite"], {
    error: "Choose what kind of place it is.",
  }),
  sortOrder: wholeNumber(0, 100_000, {
    invalid: "Enter the sort order as a whole number, like 10.",
    range: "Enter a sort order from 0 to 100,000.",
  }),
});
