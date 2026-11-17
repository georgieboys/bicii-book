/**
 * Input schemas of the build package Server Actions (D246-D251). Pure, so
 * they are unit-tested directly; RLS and the RPCs check again.
 */
import { z } from "zod";

import { money, optionalMoney, reason } from "@/lib/inventory-forms";
import { parseMoney } from "@/lib/money";

/** A switch inside a form: "on" when on, absent when off. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

export const buildPackageSchema = z
  .object({
    id: z.guid({ error: "Open the form again." }),
    kind: z.enum(["full_build", "build_only"], { error: "Choose full build or build only." }),
    name: z
      .string({ error: "Name the package." })
      .trim()
      .min(1, { error: "Name the package." })
      .max(80, { error: "Keep the name to 80 characters." }),
    description: z
      .string()
      .trim()
      .max(4000, { error: "Keep the description under 4,000 characters." })
      .nullish()
      .transform((v) => v || null),
    price: money("price").refine((v) => parseMoney(v)!.greaterThan(0), {
      error: "Give the package a price above zero.",
    }),
    priceIsFrom: toggle,
    labourAmount: money("labour amount"),
    labourServiceId: z.guid({ error: "Choose the service the labour line uses." }),
    public: toggle,
    sortOrder: z.coerce
      .number({ error: "Enter a sort order from 0 to 10,000." })
      .int({ error: "Enter a whole number." })
      .min(0, { error: "Enter a sort order from 0 to 10,000." })
      .max(10000, { error: "Enter a sort order from 0 to 10,000." }),
  })
  .refine((v) => parseMoney(v.labourAmount)!.lte(parseMoney(v.price)!), {
    error: "The labour can't be more than the package price.",
    path: ["labourAmount"],
  });

export const packageArchiveSchema = z.object({
  id: z.guid({ error: "Unknown package." }),
  archived: z.boolean(),
});

export const jobBuildSchema = z.object({
  workOrderId: z.guid({ error: "Unknown job." }),
  packageId: z.guid({ error: "Choose a package." }),
  labourLineId: z.guid({ error: "Open the form again." }),
  price: optionalMoney("price"),
});

export const clearJobBuildSchema = z.object({
  workOrderId: z.guid({ error: "Unknown job." }),
  reason: reason("Say why the package is coming off."),
});

export const repriceLineSchema = z.object({
  lineId: z.guid({ error: "Unknown line." }),
  price: money("price"),
});

export const fitBuildSchema = z.object({
  workOrderId: z.guid({ error: "Unknown job." }),
});
