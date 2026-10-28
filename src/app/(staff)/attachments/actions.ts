"use server";

import { after } from "next/server";
import { refresh } from "next/cache";
import { z } from "zod";

import { staffAction } from "@/lib/actions";
import { PHOTO_ENTITIES } from "@/lib/attachments";
import { Constants } from "@/lib/database.types";
import {
  deletePhoto as remove,
  prepareUploads as prepare,
  recordPhoto as record,
  setPhotoCaption as caption,
  setPhotoVisibility as visibility,
  type CleanupReport,
  type Photo,
  type PhotoChange,
  type UploadTarget,
} from "@/lib/domain/attachments";
import { MAX_PHOTO_BYTES, PHOTO_MEDIA_TYPES } from "@/lib/images";
import { REASON_MAX_LENGTH } from "@/lib/reasons";

import type { Logger } from "pino";

export type { Photo, PhotoChange, UploadTarget };

/**
 * Photo actions (src/lib/domain/attachments.ts). Uploads go from the phone
 * straight to Storage: prepareUploads mints the signed URLs, the browser
 * uploads, recordPhoto records each one. recordPhoto does not refresh the
 * page: a batch of photos would re-render it (and re-sign every photo on
 * it) once per photo, so the upload queue refreshes once when it drains.
 */

const target = {
  entityType: z.enum(PHOTO_ENTITIES),
  entityId: z.guid({ error: "Unknown record." }),
};
const attachmentId = z.guid({ error: "Unknown photo." });
const dimension = z.number().int().min(1).max(100_000).nullable();

/** Logs storage cleanup that failed after the database change (never shown to staff). */
const reporter =
  (log: Logger): CleanupReport =>
  (problem, details) =>
    after(() => log.error({ problem, ...details }, "photo storage cleanup failed"));

export const prepareUploads = staffAction(
  z.object({
    ...target,
    mediaTypes: z.array(z.enum(PHOTO_MEDIA_TYPES)).min(1).max(20),
  }),
  { name: "attachments.prepare_uploads" },
  async ({ mediaTypes, ...t }, { supabase }) => prepare(supabase, t, mediaTypes),
);

export const recordPhoto = staffAction(
  z.object({
    ...target,
    attachmentId,
    path: z.string().min(1).max(300),
    mediaType: z.enum(PHOTO_MEDIA_TYPES),
    byteSize: z.number().int().min(1).max(MAX_PHOTO_BYTES).nullable(),
    width: dimension,
    height: dimension,
  }),
  { name: "attachments.record" },
  async (input, { supabase }) => record(supabase, input),
);

export const setPhotoCaption = staffAction(
  z.object({
    attachmentId,
    caption: z
      .string()
      .trim()
      .max(500, { error: "Keep the caption under 500 characters." })
      .optional()
      .transform((v) => (v ? v : null)),
  }),
  { name: "attachments.set_caption" },
  async (input, { supabase }) => {
    await caption(supabase, input.attachmentId, input.caption);
    refresh();
    return null;
  },
);

export const setPhotoVisibility = staffAction(
  z.object({ attachmentId, visibility: z.enum(Constants.public.Enums.attachment_visibility) }),
  { name: "attachments.set_visibility" },
  async (input, { supabase, log }): Promise<PhotoChange> => {
    try {
      return await visibility(supabase, input.attachmentId, input.visibility, reporter(log));
    } finally {
      // Even a move that failed part-way may have changed the row.
      refresh();
    }
  },
);

export const deletePhoto = staffAction(
  z.object({
    attachmentId,
    reason: z
      .string()
      .trim()
      .min(1, { error: "Say why you are deleting this photo." })
      .max(REASON_MAX_LENGTH, { error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` }),
  }),
  { name: "attachments.delete" },
  async (input, { supabase, log }): Promise<PhotoChange> => {
    try {
      return await remove(supabase, input.attachmentId, input.reason, reporter(log));
    } finally {
      refresh();
    }
  },
);
