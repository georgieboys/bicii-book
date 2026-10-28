/**
 * Input schemas of the sales Server Actions (src/app/(staff)/sales/actions.ts).
 * Pure, so they are unit-tested directly; record_retail_sale, restock_unit
 * and record_sale_refund check everything again.
 *
 *   - ids (sale, refund, lines' units, products, locations, consignment
 *     items, customer): uuids; the sale and refund ids are made when the
 *     sheet or confirmation opens, the idempotency keys;
 *   - prices: what staff typed, parsed with parseMoney, sent on as a
 *     fixed-point string; 0 is a known price (D24, D53), blank is "the
 *     database selling price";
 *   - recognized_at: null while "Sold earlier?" is closed (the database
 *     stamps now()), else an instant that is not in the future;
 *   - reasons: trimmed, 1..REASON_MAX_LENGTH.
 */
import { z } from "zod";

import { optionalMoney, reason } from "@/lib/inventory-forms";
import { parseMoney } from "@/lib/money";
import { positiveMoney } from "@/lib/consignment-forms";

const unitLine = z.object({
  kind: z.literal("unit"),
  key: z.string().min(1).max(200),
  unitId: z.guid({ error: "Unknown item." }),
  unitSalePrice: optionalMoney("price"),
});

const productLine = z.object({
  kind: z.literal("product"),
  key: z.string().min(1).max(200),
  productId: z.guid({ error: "Unknown item." }),
  locationId: z.guid({ error: "Choose where it is sold from." }),
  quantity: z
    .number({ error: "Enter a whole number, like 1." })
    .int({ error: "Enter a whole number, like 1." })
    .min(1, { error: "Sell between 1 and 999." })
    .max(999, { error: "Sell between 1 and 999." }),
  consignmentItemId: z
    .guid({ error: "Unknown consignment." })
    .nullish()
    .transform((v) => v ?? null),
  unitSalePrice: optionalMoney("price"),
});

export const saleSchema = z.object({
  saleId: z.guid({ error: "Start the sale again." }),
  lines: z
    .array(z.discriminatedUnion("kind", [unitLine, productLine]))
    .min(1, { error: "Add at least one item to the sale." })
    .max(50, { error: "A sale holds at most 50 lines. Record the rest as another sale." }),
  customerId: z
    .guid({ error: "Choose a customer from the list." })
    .nullish()
    .transform((v) => v ?? null),
  recognizedAt: z.iso
    .datetime({ offset: true, error: "Enter when it was sold." })
    .nullish()
    .transform((v) => v ?? null)
    .refine((v) => v === null || Date.parse(v) <= Date.now() + 5 * 60_000, {
      error: "A sale can't be dated in the future.",
    }),
  notes: z
    .string()
    .trim()
    .max(2000, { error: "Keep the notes under 2,000 characters." })
    .nullish()
    .transform((v) => v || null),
});

export const restockSchema = z.object({
  unitId: z.guid({ error: "Unknown item." }),
  saleLineId: z.guid({ error: "Unknown sale line." }),
  locationId: z
    .guid({ error: "Choose where it goes back." })
    .nullish()
    .transform((v) => v ?? null),
  reason: reason("Say why the item is going back into stock."),
});

export const refundSchema = z.object({
  refundId: z.guid({ error: "Start the refund again." }),
  saleId: z.guid({ error: "Unknown sale." }),
  amount: positiveMoney("refund"),
  reason: reason("Say why the sale is being refunded."),
});

/** A typed price as the decimal string the RPC takes; null when blank or not an amount. */
export function priceInput(value: string): string | null {
  const parsed = parseMoney(value);
  return parsed === null ? null : parsed.toFixed(2);
}
