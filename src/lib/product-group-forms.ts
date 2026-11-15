/**
 * Input schemas of the product group Server Actions (D241, D242). Pure, so
 * they are unit-tested directly; RLS and the triggers check again.
 */
import { z } from "zod";

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

export const OPTION_NAME_MAX = 40;
export const OPTION_VALUE_MAX = 60;

export const productGroupSchema = z.object({
  id: z.guid({ error: "Unknown group." }),
  name: z
    .string({ error: "Name the group." })
    .trim()
    .min(1, { error: "Name the group." })
    .max(200, { error: "Keep the name to 200 characters." }),
  description: text(10000, "description"),
  brand: text(200, "brand"),
  optionName: z
    .string({ error: "Name the option, such as Colour or Size." })
    .trim()
    .min(1, { error: "Name the option, such as Colour or Size." })
    .max(OPTION_NAME_MAX, { error: `Keep the option name to ${OPTION_NAME_MAX} characters.` }),
});

export const groupArchiveSchema = z.object({
  id: z.guid({ error: "Unknown group." }),
  archived: z.boolean(),
});

/** A product into a group (with its option value), a new option value, or out (groupId null). */
export const productMembershipSchema = z
  .object({
    productId: z.guid({ error: "Unknown product." }),
    groupId: z.guid({ error: "Choose a group." }).nullable(),
    optionValue: z
      .string()
      .trim()
      .max(OPTION_VALUE_MAX, { error: `Keep the option value to ${OPTION_VALUE_MAX} characters.` })
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.groupId === null || v.optionValue !== null, {
    error: "Give this product's option value, such as Black or M.",
    path: ["optionValue"],
  });
