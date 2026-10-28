"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import { parseShopDay } from "@/lib/dates";
import {
  bookAppointment as book,
  cancel,
  checkIn,
  loadSchedule as load,
  markStatus,
  update,
} from "@/lib/domain/appointments";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/**
 * Appointment actions (SPEC §6; src/lib/domain/appointments.ts; PLAN
 * D36-D40). Thin: validate, call one domain function (an RPC that checks
 * authorization, the slot rules and the status machine again), refresh the
 * page after a write. Any active staff member may book, mark, cancel and
 * check in (D37, D40); errors come back as mapped messages with their code.
 */

const appointmentId = z.guid({ error: "Unknown appointment." });

/** Optional text: blank is null. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, { error: message })
    .optional()
    .nullable()
    .transform((v) => v || null);

/** Text whose absence keeps the stored value (undefined) and whose blank clears it (""). */
const editableText = (max: number, message: string) =>
  z.string().trim().max(max, { error: message }).optional();

/** Book an appointment for a customer; the id (made when the sheet opens) makes a retry one booking. */
export const bookAppointment = staffAction(
  z.object({
    id: z.guid({ error: "Open Book appointment again." }),
    customerId: z.guid({ error: "Choose the customer." }),
    appointmentTypeId: z.guid({ error: "Choose the type of appointment." }),
    startsAt: z.iso.datetime({ offset: true, error: "Choose a time." }),
    bikeId: z.guid({ error: "Choose one of the customer's bikes." }).nullable().optional(),
    customerNote: optionalText(1_000, "Keep the customer's note under 1,000 characters."),
    internalNote: optionalText(5_000, "Keep the internal note under 5,000 characters."),
  }),
  { name: "appointments.book" },
  async (input, { supabase }) => {
    const result = await book(supabase, { ...input, bikeId: input.bikeId ?? null });
    refresh();
    return result;
  },
);

/** Mark confirmed, arrived (also a no-show reinstated on its day, D39) or no-show. */
export const markAppointmentStatus = staffAction(
  z.object({
    appointmentId,
    status: z.enum(["confirmed", "arrived", "no_show"], { error: "Unknown status." }),
    reason: optionalText(500, "Keep the note under 500 characters."),
  }),
  { name: "appointments.mark_status" },
  async (input, { supabase }) => {
    const result = await markStatus(supabase, input);
    refresh();
    return result;
  },
);

/** Cancel with a reason (D37: staff may cancel at any time). */
export const cancelAppointment = staffAction(
  z.object({
    appointmentId,
    reason: z
      .string({ error: "Say why the appointment is cancelled." })
      .trim()
      .min(1, { error: "Say why the appointment is cancelled." })
      .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
  }),
  { name: "appointments.cancel" },
  async (input, { supabase }) => {
    const result = await cancel(supabase, input);
    refresh();
    return result;
  },
);

/** Change the bike (before check-in) and the notes; only the fields sent change. */
export const updateAppointment = staffAction(
  z.object({
    appointmentId,
    bikeId: z.guid({ error: "Choose one of the customer's bikes." }).nullable().optional(),
    clearBike: z.boolean().optional(),
    customerNote: editableText(1_000, "Keep the customer's note under 1,000 characters."),
    internalNote: editableText(5_000, "Keep the internal note under 5,000 characters."),
  }),
  { name: "appointments.update" },
  async (input, { supabase }) => {
    const result = await update(supabase, input);
    refresh();
    return result;
  },
);

/** Check in: open a new job (workOrderId is its idempotency key) or link an open one (D40). */
export const checkInAppointment = staffAction(
  z
    .object({
      appointmentId,
      bikeId: z.guid({ error: "Choose the bike they brought." }),
      workOrderId: z.guid({ error: "Choose the job." }),
      linkExisting: z.boolean(),
      requestedWork: optionalText(2_000, "Keep the requested work under 2,000 characters."),
      intakeNotes: optionalText(5_000, "Keep the condition notes under 5,000 characters."),
      leadMechanicId: z.guid({ error: "Choose the lead from the list." }).nullable().optional(),
    })
    .refine((v) => v.linkExisting || v.requestedWork !== null, {
      error: "Say what the customer wants done.",
      path: ["requestedWork"],
    }),
  { name: "appointments.check_in" },
  async (input, { supabase }) => {
    const result = await checkIn(supabase, {
      ...input,
      leadMechanicId: input.leadMechanicId ?? null,
    });
    refresh();
    return result;
  },
);

/** The booking sheet's read: everything the slot mirror needs for 1-14 days from `from`. */
export const loadSchedule = staffAction(
  z.object({
    from: z.string().refine((v) => parseShopDay(v) !== null, { error: "Choose a date." }),
    days: z.number().int().min(1).max(14),
  }),
  { name: "appointments.load_schedule" },
  async (input, { supabase }) => load(supabase, input),
);
