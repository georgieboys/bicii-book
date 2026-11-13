/**
 * Input schemas of the adventure Server Actions (src/app/(staff)/adventures
 * /actions.ts). Pure, so they are unit-tested directly; the RPCs check
 * everything again (DATA-MODEL §20).
 *
 *   - distance: kilometres with at most one decimal, 0.1..10,000;
 *   - nominal days and supported days: whole numbers 1..60;
 *   - times: whole hours 1..1,440, sent on as minutes;
 *   - prices: what staff typed, parsed with parseMoney, more than 0, sent
 *     on as a fixed-point string (never a float);
 *   - checkpoints: a JSON list the editor builds, at most 100.
 */
import { z } from "zod";

import { PARTICIPATIONS } from "@/lib/adventures";
import { money, optionalMoney } from "@/lib/inventory-forms";
import { parseMoney } from "@/lib/money";

/** Optional text: trimmed, at most `max` characters; blank is "". */
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .nullish()
    .transform((v) => v ?? "");

const required = (max: number, what: string) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` });

/** A whole number typed as text within bounds; blank is null when optional. */
const whole = (min: number, max: number, invalid: string, range: string) =>
  z
    .union([z.string(), z.number()], { error: invalid })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => /^\d+$/.test(v), { error: invalid, abort: true })
    .transform((v) => Number(v))
    .refine((v) => v >= min && v <= max, { error: range });

const optionalWhole = (min: number, max: number, invalid: string, range: string) =>
  z
    .preprocess(
      (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
      whole(min, max, invalid, range).optional(),
    )
    .transform((v) => v ?? null);

export const distanceKm = z
  .union([z.string(), z.number()], { error: "Enter the distance in kilometres, like 125." })
  .transform((v) => (typeof v === "number" ? String(v) : v.trim().replace(/,/g, "")))
  .refine((v) => /^\d+(\.\d)?$/.test(v), {
    error: "Enter the distance in kilometres, like 125 or 12.5.",
    abort: true,
  })
  .transform((v) => Number(v))
  .refine((v) => v > 0 && v <= 10_000, { error: "Enter a distance from 0.1 to 10,000 km." });

const slug = z
  .string({ error: "Enter the web address." })
  .trim()
  .toLowerCase()
  .refine((v) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) && v.length >= 2 && v.length <= 60, {
    error: "Use 2 to 60 lowercase letters, digits and single hyphens, like bicii-125.",
  });

/** A switch inside a form: "on" when on, absent when off. */
const toggle = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

const hoursToMinutes = (what: string) =>
  optionalWhole(
    1,
    1440,
    `Enter the ${what} as a whole number of hours, like 24.`,
    `Enter a ${what} from 1 to 1,440 hours.`,
  ).transform((v) => (v === null ? null : v * 60));

export const createAdventureSchema = z.object({
  slug,
  name: required(80, "name"),
  distanceKm,
});

export const adventureDraftSchema = z
  .object({
    revisionId: z.guid({ error: "Open the draft again." }),
    expectedVersion: whole(1, 2_147_483_647, "Open the draft again.", "Open the draft again."),
    name: required(80, "name"),
    summary: text(400, "summary"),
    description: text(5000, "description"),
    note: text(1000, "note"),
    region: text(80, "region"),
    terrain: text(80, "terrain"),
    whenToStart: text(120, "start time advice"),
    startFinish: text(300, "start and finish"),
    distanceKm,
    nominalDays: optionalWhole(
      1,
      60,
      "Enter the days as a whole number, like 1.",
      "Enter from 1 to 60 days.",
    ),
    timeZone: z
      .string()
      .trim()
      .min(1, { error: "Enter a time zone, like Asia/Singapore." })
      .max(64, { error: "Enter a time zone, like Asia/Singapore." }),
    minElapsedMinutes: hoursToMinutes("minimum time"),
    maxElapsedMinutes: hoursToMinutes("maximum time"),
    checkpointOrder: z.enum(["any", "sequence"], { error: "Choose how checkpoints are ridden." }),
    routeUrl: z
      .string()
      .trim()
      .max(500, { error: "Keep the link under 500 characters." })
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || /^https:\/\/\S+$/.test(v), {
        error: "Enter the full link, starting with https://",
      }),
    rules: text(5000, "rules"),
    equipment: text(2000, "equipment"),
    riderInstructions: text(5000, "rider instructions"),
    emergencyProcedure: text(2000, "emergency procedure"),
    staffNotes: text(2000, "staff notes"),
    isPlanned: toggle,
  })
  .refine(
    (v) =>
      v.minElapsedMinutes === null ||
      v.maxElapsedMinutes === null ||
      v.minElapsedMinutes <= v.maxElapsedMinutes,
    { error: "The minimum time cannot be longer than the maximum.", path: ["minElapsedMinutes"] },
  );

const coordinate = (min: number, max: number, what: string) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || v === "" ? null : Number(v)))
    .refine((v) => v === null || (Number.isFinite(v) && v >= min && v <= max), {
      error: `Enter the ${what} in decimal degrees.`,
    });

export const checkpointSchema = z
  .object({
    label: required(80, "checkpoint name"),
    instructions: text(1000, "instructions"),
    latitude: coordinate(-90, 90, "latitude"),
    longitude: coordinate(-180, 180, "longitude"),
    mandatory: z.boolean().default(true),
    photoRequired: z.boolean().default(true),
  })
  .refine((c) => (c.latitude === null) === (c.longitude === null), {
    error: "Enter both latitude and longitude, or neither.",
    path: ["latitude"],
  });

export type CheckpointInput = z.output<typeof checkpointSchema>;

export const adventureCheckpointsSchema = z.object({
  revisionId: z.guid({ error: "Open the draft again." }),
  checkpoints: z
    .string({ error: "Open the draft again." })
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Open the draft again." });
        return z.NEVER;
      }
    })
    .pipe(z.array(checkpointSchema).max(100, { error: "A route can have up to 100 checkpoints." })),
});

export const adventureOfferSchema = z
  .object({
    revisionId: z.guid({ error: "Open the draft again." }),
    kind: z.enum(PARTICIPATIONS as [string, ...string[]], { error: "Choose the kind of offer." }),
    price: money("price").refine((v) => parseMoney(v)!.gt(0), {
      error: "Enter a price above 0.",
    }),
    trackerHirePrice: optionalMoney("tracker hire price"),
    supportedDays: optionalWhole(
      1,
      60,
      "Enter the days as a whole number, like 1.",
      "Enter from 1 to 60 days.",
    ),
    inclusions: text(2000, "inclusions"),
  })
  .refine((v) => v.kind !== "supported" || v.supportedDays !== null, {
    error: "Enter how many days the supported package lasts.",
    path: ["supportedDays"],
  })
  .refine((v) => v.trackerHirePrice === null || parseMoney(v.trackerHirePrice)!.gt(0), {
    error: "Enter a tracker hire price above 0, or leave it blank.",
    path: ["trackerHirePrice"],
  })
  .transform((v) => ({
    ...v,
    trackerHirePrice: v.kind === "supported" ? null : v.trackerHirePrice,
    supportedDays: v.kind === "supported" ? v.supportedDays : null,
  }));

export const removeAdventureOfferSchema = z.object({
  revisionId: z.guid({ error: "Open the draft again." }),
  kind: z.enum(PARTICIPATIONS as [string, ...string[]], { error: "Choose the kind of offer." }),
});

export const adventureIdSchema = z.object({
  adventureId: z.guid({ error: "Unknown adventure." }),
});

export const publishAdventureSchema = z.object({
  revisionId: z.guid({ error: "Open the draft again." }),
  changeSummary: text(500, "summary of changes"),
});

export const archiveAdventureSchema = z.object({
  adventureId: z.guid({ error: "Unknown adventure." }),
  reason: required(500, "reason"),
});

export const adventureOrderSchema = z.object({
  adventureId: z.guid({ error: "Unknown adventure." }),
  sortOrder: z
    .union([z.string(), z.number()], { error: "Enter a whole number, like 40." })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => /^-?\d+$/.test(v), { error: "Enter a whole number, like 40.", abort: true })
    .transform((v) => Number(v))
    .refine((v) => v >= -10_000 && v <= 10_000, { error: "Enter from -10,000 to 10,000." }),
});

// ------------------------------------------- bookings, review, packs ----
// Phase B (D178-D182).

const DECISIONS = ["approved", "changes_requested", "rejected"] as const;
const PACK_STATUSES = ["awaiting_pack", "ready", "fulfilled", "on_hold"] as const;

/** A checkbox: "on", "true" or true is ticked; anything else is not. */
const ticked = z
  .union([z.string(), z.boolean()])
  .nullish()
  .transform((v) => v === true || v === "on" || v === "true");

/** A shop day, YYYY-MM-DD; blank is null. */
const optionalDay = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    error: "Enter the date as a day, like 2026-11-15.",
  });

/** A distance in kilometres with up to three decimals, as text; blank is null. */
const optionalAcceptedKm = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? "" : String(v).trim().replace(/,/g, "")))
  .refine(
    (v) => v === "" || (/^\d+(\.\d{1,3})?$/.test(v) && Number(v) > 0 && Number(v) <= 10_000),
    {
      error: "Enter the accepted distance in kilometres, like 128.4.",
    },
  )
  .transform((v) => (v === "" ? null : v));

export const submissionIdSchema = z.object({
  submissionId: z.guid({ error: "Unknown submission." }),
});

export const decideReviewSchema = z
  .object({
    submissionId: z.guid({ error: "Unknown submission." }),
    decision: z.enum(DECISIONS, { error: "Choose a decision." }),
    identity: ticked,
    coverage: ticked,
    checkpoints: ticked,
    chronology: ticked,
    time_window: ticked,
    distance: ticked,
    acceptedDistanceKm: optionalAcceptedKm,
    completedOn: optionalDay,
    messageToRider: text(2000, "message to the rider"),
    internalNote: text(2000, "internal note"),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "approved") {
      if (v.acceptedDistanceKm === null)
        ctx.addIssue({
          code: "custom",
          path: ["acceptedDistanceKm"],
          message: "Enter the accepted distance.",
        });
      if (v.completedOn === null)
        ctx.addIssue({
          code: "custom",
          path: ["completedOn"],
          message: "Enter the day the ride was completed.",
        });
    } else if (v.messageToRider === "") {
      ctx.addIssue({
        code: "custom",
        path: ["messageToRider"],
        message: "Tell the rider what to change or why.",
      });
    }
  });

export const revokeCertificateSchema = z.object({
  certificateId: z.guid({ error: "Unknown certificate." }),
  reason: required(500, "reason"),
});

export const clearAttentionSchema = z.object({
  bookingId: z.guid({ error: "Unknown booking." }),
  note: required(500, "note"),
});

export const packStatusSchema = z.object({
  fulfilmentId: z.guid({ error: "Unknown pack." }),
  status: z.enum(PACK_STATUSES, { error: "Choose a status." }),
  note: text(500, "note"),
});

export const adventureSalesSchema = z
  .object({
    salesEnabled: ticked,
    termsVersion: text(40, "terms version"),
  })
  .superRefine((v, ctx) => {
    if (v.salesEnabled && v.termsVersion === "")
      ctx.addIssue({
        code: "custom",
        path: ["termsVersion"],
        message: "Give the version of the published terms riders accept.",
      });
  });
