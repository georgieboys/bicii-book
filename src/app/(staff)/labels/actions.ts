"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import { createPrintJob, setPrintJobStatus } from "@/lib/domain/labels";
import { maxLabelQuantity } from "@/lib/printing/job";
import { LABEL_KINDS } from "@/lib/printing/types";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

/**
 * Label print actions (SPEC §15, §16; PLAN D56, D59; src/lib/domain/labels.ts).
 * Any active staff member prints labels. The label text, the QR payload
 * and the snapshots are the database's (create_print_job); nothing here
 * carries label text.
 *
 *   createPrintJobAction     a job of N labels (1–500 of a product, 1–10 of
 *                            a unit or bike, D56); the id is the client's
 *                            key, so a retry makes one job
 *   setPrintJobStatusAction  rendered (sent to the printer), printed, or
 *                            failed with what went wrong (D59)
 */

const uuid = z.guid({ error: "Choose a record." });
const optionalUuid = z.preprocess((v) => (v === "" ? undefined : v), z.guid().optional());

const createSchema = z
  .object({
    id: z.guid(),
    kind: z.enum(LABEL_KINDS),
    entityId: uuid,
    quantity: z.coerce
      .number({ error: "Enter how many labels to print." })
      .int({ error: "Enter a whole number of labels." })
      .min(1, { error: "Print at least 1 label." })
      .max(500, { error: "Print at most 500 labels per job." }),
    profileId: optionalUuid,
    templateId: optionalUuid,
    reprintOfId: optionalUuid,
  })
  .superRefine((v, ctx) => {
    const max = maxLabelQuantity(v.kind);
    if (v.quantity > max) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message:
          v.kind === "product"
            ? `Print at most ${max} labels per job. Start another job for more.`
            : `Print at most ${max} labels per job for a unit or bike.`,
      });
    }
  });

export const createPrintJobAction = staffAction(
  createSchema,
  { name: "labels.create_print_job" },
  async (input, { supabase }) => {
    const result = await createPrintJob(supabase, input);
    // ADR-001 A6: the record page (Recent prints) is current when staff
    // come back to it from the print view.
    refresh();
    return result;
  },
);

const statusSchema = z
  .object({
    id: z.guid(),
    status: z.enum(["rendered", "printed", "failed"]),
    error: z
      .string()
      .trim()
      .max(REASON_MAX_LENGTH, { error: `Keep it under ${REASON_MAX_LENGTH} characters.` })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "failed" && !v.error) {
      ctx.addIssue({ code: "custom", path: ["error"], message: "Say what went wrong." });
    }
  });

export const setPrintJobStatusAction = staffAction(
  statusSchema,
  { name: "labels.set_status" },
  async (input, { supabase }) => {
    const result = await setPrintJobStatus(supabase, {
      id: input.id,
      status: input.status,
      error: input.status === "failed" ? input.error : null,
    });
    // ADR-001 A6: the screen re-renders with the new status.
    refresh();
    return result;
  },
);
