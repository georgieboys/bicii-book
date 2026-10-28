"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { ActionError, staffAction } from "@/lib/actions";
import { hasPermission } from "@/lib/auth/permissions";
import { Constants } from "@/lib/database.types";
import {
  addManualLine as addManual,
  addServiceLine as addService,
  voidLine as voidOne,
} from "@/lib/domain/lines";
import { addPartToJob as addPart } from "@/lib/domain/inventory";
import { searchServices } from "@/lib/domain/services";
import {
  addWorkOrderNote as addNote,
  assignStaff as assign,
  createWorkOrder as create,
  customerBikesForIntake,
  searchIntakeOptions as searchIntake,
  setApprovalFlag as setApproval,
  setWorkOrderStatus as setStatus,
  unassignStaff as unassign,
  updateWorkOrderDetails as updateDetails,
} from "@/lib/domain/workshop";
import { addPartSchema } from "@/lib/inventory-forms";
import { Decimal, parseMoney, toMoneyString } from "@/lib/money";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/**
 * Workshop actions (SPEC §7, §9, §22; src/lib/domain/workshop.ts and
 * lines.ts). Every write is an RPC that checks again; these validate the
 * input, keep cost entry to view_costs holders (D14) and refresh the page.
 */

const MAX_MONEY = new Decimal("9999999.99");
const MAX_QUANTITY = new Decimal("9999");

/** A money field typed by staff: 0 or more, at most 2 decimals, to a fixed-point string. */
const money = (what: string) =>
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

/** An optional money field: blank is null. */
const optionalMoney = (what: string) =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      money(what).optional(),
    )
    .transform((v) => v ?? null);

/** A quantity: more than 0, at most 9,999, at most 2 decimals, to a fixed-point string. */
const quantity = z
  .string({ error: "Enter the quantity." })
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, { error: "Enter a quantity like 1 or 1.5.", abort: true })
  .refine((v) => new Decimal(v).gt(0), { error: "The quantity must be more than 0." })
  .refine((v) => new Decimal(v).lte(MAX_QUANTITY), { error: "The quantity can be at most 9,999." })
  .transform((v) => toMoneyString(v));

const reason = (what: string) =>
  z
    .string({ error: what })
    .trim()
    .min(1, { error: what })
    .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` });

const workOrderId = z.guid({ error: "Unknown job." });

/** D14: only view_costs holders enter a direct cost (the RPC refuses anyone else too). */
function requireCostPermission(
  staff: Parameters<typeof hasPermission>[0],
  cost: string | null,
): void {
  if (cost !== null && !hasPermission(staff, "view_costs")) {
    throw new ActionError("You can't set a cost.", {
      unitDirectCost: ["Only staff who can view costs can enter one."],
    });
  }
}

/** Check a bike in as a new job (intake). Replaying the same id returns the same job. */
export const createWorkOrder = staffAction(
  z.object({
    id: z.guid({ error: "Start the intake again." }),
    customerId: z.guid({ error: "Choose the customer." }),
    bikeId: z.guid({ error: "Choose the bike." }),
    requestedWork: z
      .string({ error: "Say what the customer wants done." })
      .trim()
      .min(1, { error: "Say what the customer wants done." })
      .max(2_000, { error: "Keep the requested work under 2,000 characters." }),
    intakeNotes: z
      .string()
      .trim()
      .max(5_000, { error: "Keep the condition notes under 5,000 characters." })
      .optional()
      .transform((v) => v || null),
    leadId: z.guid({ error: "Choose the lead from the list." }).nullable(),
    additionalIds: z.array(z.guid()).max(10, { error: "At most 10 additional staff." }),
    services: z
      .array(z.object({ lineId: z.guid(), serviceId: z.guid(), quantity }))
      .max(20, { error: "At most 20 services at check-in. Add more on the job." }),
  }),
  { name: "jobs.create" },
  async (input, { supabase }) => create(supabase, input),
);

/** Move a job to another status; cancelling and reopening need a reason (D15, D16). */
export const setWorkOrderStatus = staffAction(
  z.object({
    workOrderId,
    status: z.enum(Constants.public.Enums.work_order_status),
    note: z
      .string()
      .trim()
      .max(REASON_MAX_LENGTH, { error: `Keep the note under ${REASON_MAX_LENGTH} characters.` })
      .optional()
      .transform((v) => v || null),
  }),
  { name: "jobs.set_status" },
  async (input, { supabase }) => {
    const result = await setStatus(supabase, input);
    refresh();
    return result;
  },
);

/** Add a service to an open job; the price may be changed, the cost only with view_costs (D14). */
export const addServiceLine = staffAction(
  z.object({
    lineId: z.guid({ error: "Open Add service again." }),
    workOrderId,
    serviceId: z.guid({ error: "Choose a service from the list." }),
    quantity,
    unitSalePrice: optionalMoney("price"),
    unitDirectCost: optionalMoney("cost"),
    description: z
      .string()
      .trim()
      .max(300, { error: "Keep the description under 300 characters." })
      .optional()
      .transform((v) => v || null),
  }),
  { name: "jobs.add_service_line" },
  async (input, { supabase, staff }) => {
    requireCostPermission(staff, input.unitDirectCost);
    const result = await addService(supabase, input);
    refresh();
    return result;
  },
);

/** Add a free-text line (labour, a sundry) to an open job. */
export const addManualLine = staffAction(
  z.object({
    lineId: z.guid({ error: "Open Add manual line again." }),
    workOrderId,
    description: z
      .string({ error: "Describe the line." })
      .trim()
      .min(1, { error: "Describe the line." })
      .max(300, { error: "Keep the description under 300 characters." }),
    quantity,
    unitSalePrice: money("price"),
    unitDirectCost: optionalMoney("cost"),
  }),
  { name: "jobs.add_manual_line" },
  async (input, { supabase, staff }) => {
    requireCostPermission(staff, input.unitDirectCost);
    const result = await addManual(supabase, input);
    refresh();
    return result;
  },
);

/**
 * Add a part from stock to an open job (any staff, D15). The price may be
 * changed by anyone (D14); the cost is the part's own and never entered
 * here (D24 PART-PRICE-COST). A counted part may take its location below
 * zero (D23 NEG-CONSUMPTION: the sheet warns first); a unique unit is held
 * for the job until it is completed (D25). Replay-safe by line id.
 */
export const addPartToJob = staffAction(
  addPartSchema,
  { name: "jobs.add_part" },
  async (input, { supabase }) => {
    const result = await addPart(supabase, input);
    refresh();
    return result;
  },
);

/** Void a line with a reason; it stays on the job, struck through (D15: open jobs only). */
export const voidLine = staffAction(
  z.object({
    lineId: z.guid({ error: "Unknown line." }),
    reason: reason("Say why the line is being voided."),
  }),
  { name: "jobs.void_line" },
  async (input, { supabase }) => {
    await voidOne(supabase, input);
    refresh();
    return null;
  },
);

/** Intake step 1: customers and bikes matching a query. */
export const searchIntakeOptions = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "jobs.search_intake" },
  async ({ q }, { supabase }) => (q ? searchIntake(supabase, q) : []),
);

/**
 * The customer's active bikes, with any job each is already in for: intake
 * step 2, the booking sheet and an appointment's Change bike share it.
 */
export const listIntakeBikes = staffAction(
  z.object({ customerId: z.guid({ error: "Unknown customer." }) }),
  { name: "jobs.intake_bikes" },
  async ({ customerId }, { supabase }) => customerBikesForIntake(supabase, customerId),
);

/** Active services matching a query, for Add service (costs only for view_costs). */
export const searchServiceOptions = staffAction(
  z.object({ q: z.string().trim().max(200) }),
  { name: "jobs.search_services" },
  async ({ q }, { supabase, staff }) =>
    searchServices(supabase, q, { viewCosts: hasPermission(staff, "view_costs") }),
);

/**
 * Put someone on a job as lead or additional staff (D22: any active staff,
 * on a job not collected or cancelled). A new lead replaces the old one,
 * who leaves the job.
 */
export const assignStaff = staffAction(
  z.object({
    workOrderId,
    staffId: z.guid({ error: "Choose who to assign." }),
    role: z.enum(Constants.public.Enums.assignment_role, { error: "Choose lead or additional." }),
  }),
  { name: "jobs.assign_staff" },
  async (input, { supabase }) => {
    const result = await assign(supabase, input);
    refresh();
    return result;
  },
);

/** Take someone off a job (D22); replaying it changes nothing. */
export const unassignStaff = staffAction(
  z.object({ workOrderId, staffId: z.guid({ error: "Unknown staff member." }) }),
  { name: "jobs.unassign_staff" },
  async (input, { supabase }) => {
    const result = await unassign(supabase, input);
    refresh();
    return result;
  },
);

/** The internal "customer approved extra work" flag and its note (SPEC §7.1). */
export const setApprovalFlag = staffAction(
  z.object({
    workOrderId,
    flagged: z.boolean(),
    // Null or missing keeps the stored note (the switch); "" clears it.
    note: z
      .string()
      .trim()
      .max(500, { error: "Keep the approval note under 500 characters." })
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  }),
  { name: "jobs.set_approval" },
  async (input, { supabase }) => {
    const result = await setApproval(supabase, input);
    refresh();
    return result;
  },
);

/** Add a note or a diagnosis to the job's timeline; any status. Replay-safe by note id. */
export const addWorkOrderNote = staffAction(
  z.object({
    noteId: z.guid({ error: "Open the note again." }),
    workOrderId,
    kind: z.enum(Constants.public.Enums.work_order_note_kind),
    body: z
      .string({ error: "Write the note first." })
      .trim()
      .min(1, { error: "Write the note first." })
      .max(5_000, { error: "Keep the note under 5,000 characters." }),
  }),
  { name: "jobs.add_note" },
  async (input, { supabase }) => {
    const result = await addNote(supabase, input);
    refresh();
    return result;
  },
);

/** A field the form left out is null (keep what is stored); "" clears it. */
const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-SG")} characters.` })
    .optional()
    .transform((v) => v ?? null);

/**
 * Edit the requested work and the notes. The sheet sends only the fields
 * its user changed, so a field someone else saved meanwhile is kept, not
 * overwritten with the stale value; an emptied note is cleared.
 */
export const updateWorkOrderDetails = staffAction(
  z.object({
    workOrderId,
    requestedWork: z
      .string({ error: "Say what the customer wants done." })
      .trim()
      .min(1, { error: "Say what the customer wants done." })
      .max(2_000, { error: "Keep the requested work under 2,000 characters." })
      .optional()
      .transform((v) => v ?? null),
    intakeNotes: optionalText(5_000, "condition notes"),
    internalNotes: optionalText(10_000, "internal notes"),
    completionNotes: optionalText(5_000, "completion notes"),
  }),
  { name: "jobs.update_details" },
  async (input, { supabase }) => {
    const result = await updateDetails(supabase, input);
    refresh();
    return result;
  },
);
