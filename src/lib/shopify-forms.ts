/**
 * Input schemas of the Shopify Server Actions (src/app/(staff)/shopify/
 * actions.ts and the product actions in src/app/(staff)/inventory/
 * actions.ts). Pure, so they are unit-tested directly; the RPCs
 * (set_publish_online, request_product_sync, retry_integration_job,
 * dismiss_integration_job, link_shopify_variant, link_shopify_customer,
 * set_shopify_settings) check everything again.
 *
 *   - ids: uuids; Shopify ids: gids of the expected kind (the database
 *     also accepts bare numbers, the screens always send gids);
 *   - reasons: trimmed, 1..REASON_MAX_LENGTH, required to dismiss, to
 *     link a variant or a customer (D86), and to change whether test
 *     orders are recorded (D89);
 *   - the storefront URL: https or blank (blank = no Buy-online link, D84).
 */
import { z } from "zod";

import { optionalReason, reason } from "@/lib/inventory-forms";

const id = (error: string) => z.guid({ error });

const gid = (kind: string, error: string) =>
  z
    .string({ error })
    .trim()
    .regex(new RegExp(`^gid://shopify/${kind}/[0-9]{1,20}$`), { error });

export const publishOnlineSchema = z.object({
  productId: id("Unknown product."),
  publish: z.boolean({ error: "Choose on or off." }),
});

export const productIdSchema = z.object({ productId: id("Unknown product.") });

export const jobIdSchema = z.object({ jobId: id("Unknown queue item.") });

export const dismissJobSchema = z.object({
  jobId: id("Unknown queue item."),
  reason: reason("Say why you are dismissing it."),
});

export const linkVariantSchema = z.object({
  jobId: id("Unknown queue item."),
  productId: id("Choose the BICII product this Shopify line is."),
  shopifyProductGid: gid("Product", "This Shopify line has no product to link."),
  shopifyVariantGid: gid("ProductVariant", "This Shopify line has no variant to link."),
  reason: reason("Say why this is the same product."),
});

export const linkCustomerSchema = z.object({
  eventId: id("Unknown event."),
  customerId: id("Choose the BICII customer."),
  shopifyCustomerGid: gid("Customer", "This order has no Shopify customer."),
  reason: reason("Say how you know this is the same person."),
});

export const searchProductsSchema = z.object({ q: z.string().trim().max(200) });

/** A switch inside a form: "on" when on, absent when off; "true"/"false" from a hidden field. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

export const shopifySettingsSchema = z
  .object({
    onlineLocationId: id("Choose the online location."),
    storefrontUrl: z
      .string()
      .trim()
      .max(200, { error: "Keep the address under 200 characters." })
      .optional()
      .transform((v) => (v ? v.replace(/\/+$/, "") : null))
      .refine((v) => v === null || /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(v), {
        error: "Enter an https address, like https://shop.bicii.sg.",
      }),
    acceptTestOrders: toggle,
    /** What the form showed (a hidden field), so a change needs a reason. */
    wasAcceptingTestOrders: toggle,
    reason: optionalReason,
  })
  .superRefine((v, ctx) => {
    if (v.acceptTestOrders !== v.wasAcceptingTestOrders && !v.reason) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Say why you are changing whether test orders are recorded.",
      });
    }
  });

export type ShopifySettingsInput = z.output<typeof shopifySettingsSchema>;
