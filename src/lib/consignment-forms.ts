/**
 * Input schemas of the consignment Server Actions
 * (src/app/(staff)/consignment/actions.ts). Pure, so they are unit-tested
 * directly; the RPCs, RLS and triggers check everything again.
 *
 *   - ids (consignor, item, product, unit, charge, return, settlement,
 *     reversal): uuids made with newId() when the sheet or control opens,
 *     the idempotency keys;
 *   - money: what staff typed, parsed with parseMoney, sent on as a
 *     fixed-point string (never a float); an agreed amount of 0 is a known
 *     amount (D24), a charge or a payment is more than 0;
 *   - reasons: trimmed, 1..REASON_MAX_LENGTH where required.
 */
import { z } from "zod";

import { money, optionalMoney, reason } from "@/lib/inventory-forms";
import { parseMoney } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/** Optional text: trimmed, at most `max` characters, blank is null. */
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

/** A picker's hidden input: an id, or empty for none. */
const optionalId = (error: string) =>
  z
    .union([z.guid({ error }), z.literal(""), z.null()])
    .optional()
    .transform((v) => v || null);

// The same shape the consignors_email_check constraint accepts.
const EMAIL = /^[^@\s]+@[^@\s]+$/;

const email = text(320, "email").refine((v) => v === null || EMAIL.test(v), {
  error: "Enter a valid email address.",
});

/** An amount above 0 (a charge, a payment, an allocation). */
export const positiveMoney = (what: string) =>
  money(what).refine((v) => parseMoney(v)!.greaterThan(0), {
    error: `The ${what} must be more than 0.`,
  });

export const consignorSchema = z.object({
  /** New consignor: the form's idempotency key. Edit: the consignor. */
  id: z.guid({ error: "Unknown consignor." }),
  displayName: z
    .string({ error: "Enter the consignor's name." })
    .trim()
    .min(1, { error: "Enter the consignor's name." })
    .max(200, { error: "Keep the name under 200 characters." }),
  phone: text(40, "phone number"),
  email,
  customerId: optionalId("Choose a customer from the list."),
  internalNotes: text(10_000, "notes"),
  /** Blank on an edit keeps what is on file (it is never shown back). */
  payoutDetails: text(2_000, "payout details"),
});

export const newConsignorSchema = z.object({
  id: z.guid({ error: "Unknown consignor." }),
  displayName: z
    .string({ error: "Enter the consignor's name." })
    .trim()
    .min(1, { error: "Enter the consignor's name." })
    .max(200, { error: "Keep the name under 200 characters." }),
  phone: text(40, "phone number"),
  email,
  customerId: optionalId("Choose a customer from the list."),
});

const wholeNumber = (min: number, max: number, invalid: string, range: string) =>
  z
    .union([z.string(), z.number()], { error: invalid })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => /^\d+$/.test(v), { error: invalid, abort: true })
    .transform((v) => Number(v))
    .refine((v) => v >= min && v <= max, { error: range });

export const intakeSchema = z
  .object({
    itemId: z.guid({ error: "Start the intake again." }),
    consignorId: optionalId("Choose a consignor."),
    newConsignor: newConsignorSchema.nullish().transform((v) => v ?? null),
    locationId: z.guid({ error: "Choose where it is kept." }),
    agreedAmountOwed: money("amount owed to the consignor"),
    askingPrice: optionalMoney("asking price"),
    productName: z
      .string({ error: "Name the item." })
      .trim()
      .min(1, { error: "Name the item." })
      .max(200, { error: "Keep the name under 200 characters." }),
    brand: text(100, "brand"),
    description: text(5_000, "description"),
    categoryId: optionalId("Choose a category from the list."),
    trackingType: z.enum(["unique", "quantity"], { error: "Choose one item or several." }),
    quantity: wholeNumber(
      1,
      9_999,
      "Enter a whole number, like 1 or 6.",
      "Take in between 1 and 9,999.",
    ),
    serialNumber: text(100, "serial number"),
    condition: text(2_000, "condition"),
    receivedAt: z.iso
      .datetime({ offset: true, error: "Choose the date it came in." })
      .nullish()
      .transform((v) => v ?? null),
    agreementNotes: text(2_000, "agreement notes"),
    internalNotes: text(10_000, "notes"),
    newProductId: z.guid({ error: "Start the intake again." }),
    newUnitId: optionalId("Start the intake again."),
    bikeId: optionalId("Choose a bike from the list."),
  })
  .refine((v) => v.consignorId !== null || v.newConsignor !== null, {
    error: "Choose a consignor, or add a new one.",
    path: ["consignorId"],
  })
  .refine((v) => v.trackingType === "quantity" || v.quantity === 1, {
    error: "A single item is taken in one at a time.",
    path: ["quantity"],
  })
  .refine((v) => v.bikeId === null || v.trackingType === "unique", {
    error: "Only a single item can be a bike.",
    path: ["bikeId"],
  });

export const termsSchema = z.object({
  itemId: z.guid({ error: "Unknown item." }),
  agreedAmountOwed: money("amount owed to the consignor"),
  askingPrice: optionalMoney("asking price"),
  reason: z
    .string()
    .trim()
    .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` })
    .nullish()
    .transform((v) => v || null),
});

/**
 * Change owner (D162, admins only): a shop product's stock becomes one
 * consignor's, on the same product. The ledger reason is "Reclassified as
 * consigned stock: " plus this, within its 500 characters
 * (reclassify_as_consignment allows 460).
 */
export const RECLASSIFY_REASON_MAX = 460;

export const reclassifySchema = z.object({
  itemId: z.guid({ error: "Open Change owner again." }),
  productId: z.guid({ error: "Unknown product." }),
  consignorId: z.guid({ error: "Choose the consignor." }),
  agreedAmountOwed: money("amount owed to the consignor"),
  askingPrice: optionalMoney("asking price"),
  receivedAt: z.iso
    .datetime({ offset: true, error: "Choose the date it came in." })
    .nullish()
    .transform((v) => v ?? null),
  reason: z
    .string({ error: "Say why the owner is changing." })
    .trim()
    .min(1, { error: "Say why the owner is changing." })
    .max(RECLASSIFY_REASON_MAX, {
      error: `Keep the reason under ${RECLASSIFY_REASON_MAX} characters.`,
    }),
});

export const chargeSchema = z.object({
  chargeId: z.guid({ error: "Start the charge again." }),
  itemId: z.guid({ error: "Unknown item." }),
  description: z
    .string({ error: "Describe the charge." })
    .trim()
    .min(1, { error: "Describe the charge." })
    .max(200, { error: "Keep the description under 200 characters." }),
  amount: positiveMoney("amount"),
  // D4: no default; the sheet blocks submit until one is chosen.
  bearer: z.enum(["consignor", "shop"], { error: "Choose who pays: the consignor or the shop." }),
});

export const voidChargeSchema = z.object({
  chargeId: z.guid({ error: "Unknown charge." }),
  reason: reason("Say why the charge is voided."),
});

export const returnSchema = z.object({
  returnId: z.guid({ error: "Start the return again." }),
  itemId: z.guid({ error: "Unknown item." }),
  reason: reason("Say why it goes back to the consignor."),
  quantity: wholeNumber(1, 9_999, "Enter a whole number, like 1.", "Return between 1 and 9,999.")
    .nullish()
    .transform((v) => v ?? null),
  locationId: optionalId("Choose where it is returned from."),
});

export const settlementSchema = z.object({
  settlementId: z.guid({ error: "Start the payment again." }),
  consignorId: z.guid({ error: "Unknown consignor." }),
  amount: positiveMoney("amount paid"),
  allocations: z
    .array(
      z.object({
        itemId: z.guid({ error: "Unknown item." }),
        amount: positiveMoney("amount"),
        overrideReason: z
          .string()
          .trim()
          .max(REASON_MAX_LENGTH, {
            error: `Keep the reason under ${REASON_MAX_LENGTH} characters.`,
          })
          .nullish()
          .transform((v) => v || null),
      }),
    )
    .min(1, { error: "Allocate the payment to at least one item." }),
  paidAt: z.iso
    .datetime({ offset: true, error: "Choose the date it was paid." })
    .nullish()
    .transform((v) => v ?? null),
  reference: text(200, "reference"),
  notes: text(2_000, "notes"),
});

export const reverseSettlementSchema = z.object({
  reversalId: z.guid({ error: "Start the reversal again." }),
  settlementId: z.guid({ error: "Unknown payment." }),
  reason: reason("Say why the payment is reversed."),
});
