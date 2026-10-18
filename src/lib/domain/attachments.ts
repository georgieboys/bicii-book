import "server-only";

import { randomUUID } from "node:crypto";

import {
  INTERNAL_BUCKET,
  PUBLIC_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  attachmentPath,
  bucketFor,
  isUndecodedOriginal,
  otherBucket,
  type PhotoBucket,
  type PhotoEntity,
  type PhotoTarget,
  type Visibility,
} from "@/lib/attachments";
import { BUSINESS_ERRORS, DbError, unwrap } from "@/lib/db-errors";
import { getServerEnv } from "@/lib/env";
import type { PhotoMediaType } from "@/lib/images";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";

/**
 * Photos (SPEC §8; DATA-MODEL §2 "Attachment storage"; ADR-001 A7).
 *
 * Every Storage call here uses the signed-in staff member's RLS client:
 * the storage.objects policies (active staff only on media-internal) are
 * what allow minting an upload URL, signing a download URL, copying and
 * removing. Rows change only through the attachment RPCs.
 *
 * Upload: the server picks the attachment id and mints a signed upload URL
 * for exactly `{entity_type}/{entity_id}/{id}.{ext}` in media-internal; the
 * phone uploads to it directly; the server then calls record_attachment,
 * which checks the object really is there. New photos are internal.
 *
 * Storage and Postgres do not share a transaction, so the multi-step
 * changes below are ordered so that a failure at any step leaves the row
 * pointing at an object that exists, and are safe to repeat:
 *
 *   visibility to/from public = copy to the other bucket, then the RPC
 *   (which checks the copy exists), then remove the original. If the RPC
 *   fails the copy is removed again (a private photo must not linger in
 *   the public bucket). If removing the original fails, the change has
 *   still happened: the result says the cleanup is pending, and choosing
 *   the same setting again (the viewer's "Finish") removes it. An object
 *   is only removed after re-reading the row and seeing it names the
 *   other bucket (Storage's own policy refuses to delete an object a row
 *   points at, too).
 *
 *   delete = the RPC (reason required; the row is kept in
 *   attachment_events), then remove the object. A replay finds the path in
 *   the `deleted` event and removes whatever is left.
 *
 * Whatever a failed cleanup (or a crash between steps) leaves behind is
 * not left for staff to remember: listPhotos removes the record's stray
 * objects (attachment_stray_objects: nothing points at them, and they are
 * old enough not to belong to a change still running) every time the
 * record is shown, so media-public ends up holding only public photos.
 */

export type { PhotoTarget };

/** What the screens need to show and manage one photo. */
export type Photo = {
  id: string;
  entityType: PhotoEntity;
  entityId: string;
  /** Short-lived signed URL (internal/customer) or public URL; null if Storage could not sign it. */
  url: string | null;
  /**
   * What a grid shows: a 480 px rendition when Storage resizes images
   * (STORAGE_IMAGE_TRANSFORMS), else `url`. The viewer keeps the original.
   */
  thumbUrl: string | null;
  visibility: Visibility;
  caption: string | null;
  mediaType: string;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  createdAt: string;
};

/** Where the phone uploads one photo (ActionResult data of prepareUploads). */
export type UploadTarget = {
  attachmentId: string;
  bucket: PhotoBucket;
  path: string;
  token: string;
  mediaType: PhotoMediaType;
};

/** A Storage call failed; the cause is logged, never shown. */
export class StorageFailure extends Error {
  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`Storage ${operation} failed`);
    this.name = "StorageFailure";
  }
}

const COLUMNS =
  "id, entity_type, entity_id, storage_bucket, storage_path, visibility, caption, media_type, width, height, byte_size, created_at";

type Row = {
  id: string;
  entity_type: string;
  entity_id: string;
  storage_bucket: string;
  storage_path: string;
  visibility: Visibility;
  caption: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  created_at: string;
};

const asBucket = (b: string): PhotoBucket =>
  b === PUBLIC_BUCKET ? PUBLIC_BUCKET : INTERNAL_BUCKET;

function toPhoto(row: Row, urls: PhotoUrls | undefined): Photo {
  return {
    id: row.id,
    entityType: row.entity_type as PhotoEntity,
    entityId: row.entity_id,
    url: urls?.url ?? null,
    thumbUrl: urls?.thumbUrl ?? urls?.url ?? null,
    visibility: row.visibility,
    caption: row.caption,
    mediaType: row.media_type,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}

type PhotoUrls = { url: string | null; thumbUrl: string | null };

/**
 * The grid's rendition: 480 px square, cropped like the cell (object-cover),
 * enough for a 160 px cell at 3x. Photos are stored at up to 2048 px.
 */
const THUMBNAIL = { width: 480, height: 480, resize: "cover", quality: 70 } as const;

/** Whether Storage resizes images here (STORAGE_IMAGE_TRANSFORMS); off if the environment does not parse. */
function storageResizes(): boolean {
  try {
    return getServerEnv().STORAGE_IMAGE_TRANSFORMS === "true";
  } catch {
    return false;
  }
}

/**
 * URLs for rows: one batch of signed URLs for the private bucket, public
 * URLs for the rest. When Storage resizes images, also each photo's
 * thumbnail: a public rendition URL costs no request, a private one is a
 * signed request per photo (Storage signs renditions one at a time), sent
 * alongside the batch; a thumbnail that cannot be signed falls back to the
 * original.
 */
async function urlsFor(supabase: ServerSupabase, rows: Row[]): Promise<Map<string, PhotoUrls>> {
  const urls = new Map<string, PhotoUrls>();
  const resize = storageResizes();
  const privatePaths = rows
    .filter((r) => r.storage_bucket !== PUBLIC_BUCKET)
    .map((r) => r.storage_path);
  const internal = supabase.storage.from(INTERNAL_BUCKET);
  const [signed, thumbs] = await Promise.all([
    privatePaths.length > 0
      ? internal.createSignedUrls(privatePaths, SIGNED_URL_TTL_SECONDS)
      : Promise.resolve({ data: [] }),
    resize
      ? Promise.all(
          privatePaths.map((path) =>
            internal.createSignedUrl(path, SIGNED_URL_TTL_SECONDS, { transform: THUMBNAIL }),
          ),
        )
      : Promise.resolve([]),
  ]);
  const thumbOf = new Map<string, string>();
  thumbs.forEach((t, i) => {
    if (t.data?.signedUrl && !t.error) thumbOf.set(privatePaths[i], t.data.signedUrl);
  });
  for (const item of signed.data ?? []) {
    if (item.path && item.signedUrl && !item.error) {
      urls.set(item.path, { url: item.signedUrl, thumbUrl: thumbOf.get(item.path) ?? null });
    }
  }
  const publicBucket = supabase.storage.from(PUBLIC_BUCKET);
  for (const r of rows) {
    if (r.storage_bucket === PUBLIC_BUCKET) {
      urls.set(r.storage_path, {
        url: publicBucket.getPublicUrl(r.storage_path).data.publicUrl,
        thumbUrl: resize
          ? publicBucket.getPublicUrl(r.storage_path, { transform: THUMBNAIL }).data.publicUrl
          : null,
      });
    }
  }
  return urls;
}

/**
 * Removes the objects under a record that no attachment points at any more
 * and that are safe to remove (attachment_stray_objects): what a failed
 * Storage cleanup or an interrupted change left behind. Best effort: what
 * cannot be removed now is found again next time. Returns how many went.
 */
export async function sweepStrayPhotos(
  supabase: ServerSupabase,
  target: PhotoTarget,
): Promise<number> {
  const { data, error } = await supabase.rpc("attachment_stray_objects", {
    entity_type: target.entityType,
    entity_id: target.entityId,
  });
  if (error || !data || data.length === 0) return 0;
  let removed = 0;
  for (const bucket of [INTERNAL_BUCKET, PUBLIC_BUCKET] as const) {
    const paths = data.filter((o) => o.bucket === bucket).map((o) => o.path);
    if (paths.length === 0) continue;
    const { data: gone } = await supabase.storage.from(bucket).remove(paths);
    removed += gone?.length ?? 0;
  }
  return removed;
}

/**
 * A record's photos, oldest first, with URLs to show them. Also clears the
 * record's stray objects (sweepStrayPhotos), so a cleanup that failed
 * finishes the next time anyone looks at the record.
 */
export async function listPhotos(supabase: ServerSupabase, target: PhotoTarget): Promise<Photo[]> {
  const [result] = await Promise.all([
    supabase
      .from("attachments")
      .select(COLUMNS)
      .eq("entity_type", target.entityType)
      .eq("entity_id", target.entityId)
      .order("created_at", { ascending: true }),
    sweepStrayPhotos(supabase, target),
  ]);
  const rows = unwrap(result) as Row[];
  const urls = await urlsFor(supabase, rows);
  return rows.map((r) => toPhoto(r, urls.get(r.storage_path)));
}

/** The table holding each kind of record a photo can belong to. */
function tableFor(
  entityType: PhotoEntity,
): "bikes" | "customers" | "work_orders" | "products" | "inventory_units" | "consignment_items" {
  switch (entityType) {
    case "bike":
      return "bikes";
    case "customer":
      return "customers";
    case "work_order":
      return "work_orders";
    case "product":
      return "products";
    case "inventory_unit":
      return "inventory_units";
    case "consignment_item":
      return "consignment_items";
    default: {
      const unknown: never = entityType;
      throw new Error(`No table for photo entity ${String(unknown)}`);
    }
  }
}

async function requireEntity(supabase: ServerSupabase, target: PhotoTarget): Promise<void> {
  const table = tableFor(target.entityType);
  const row = unwrap(
    await supabase.from(table).select("id").eq("id", target.entityId).maybeSingle(),
  );
  if (!row) throw new DomainError("That record no longer exists. Refresh and try again.");
}

/**
 * One signed upload URL per photo, each for a new attachment id, minted
 * as the signed-in staff member (Storage checks they may insert into
 * media-internal). Valid for two hours.
 */
export async function prepareUploads(
  supabase: ServerSupabase,
  target: PhotoTarget,
  mediaTypes: PhotoMediaType[],
): Promise<UploadTarget[]> {
  await requireEntity(supabase, target);
  return Promise.all(
    mediaTypes.map(async (mediaType) => {
      const attachmentId = randomUUID();
      const path = attachmentPath(target.entityType, target.entityId, attachmentId, mediaType);
      const { data, error } = await supabase.storage
        .from(INTERNAL_BUCKET)
        .createSignedUploadUrl(path);
      if (error || !data) throw new StorageFailure("createSignedUploadUrl", error);
      return { attachmentId, bucket: INTERNAL_BUCKET, path, token: data.token, mediaType };
    }),
  );
}

export type RecordInput = PhotoTarget & {
  attachmentId: string;
  path: string;
  mediaType: PhotoMediaType;
  byteSize: number | null;
  width: number | null;
  height: number | null;
};

/**
 * Records an uploaded photo (RPC record_attachment: checks the object is in
 * Storage at the canonical path; replaying returns the same row).
 */
export async function recordPhoto(supabase: ServerSupabase, input: RecordInput): Promise<Photo> {
  const row = unwrap(
    await supabase.rpc("record_attachment", {
      attachment_id: input.attachmentId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      storage_bucket: INTERNAL_BUCKET,
      storage_path: input.path,
      media_type: input.mediaType,
      byte_size: input.byteSize ?? undefined,
      width: input.width ?? undefined,
      height: input.height ?? undefined,
      visibility: "internal",
    }),
  ) as Row;
  const urls = await urlsFor(supabase, [row]);
  return toPhoto(row, urls.get(row.storage_path));
}

async function readRow(supabase: ServerSupabase, id: string): Promise<Row | null> {
  return unwrap(
    await supabase.from("attachments").select(COLUMNS).eq("id", id).maybeSingle(),
  ) as Row | null;
}

/** Edit a caption (blank removes it). Recorded as `caption_changed` by trigger. */
export async function setPhotoCaption(
  supabase: ServerSupabase,
  id: string,
  caption: string | null,
): Promise<void> {
  const row = unwrap(
    await supabase.from("attachments").update({ caption }).eq("id", id).select("id").maybeSingle(),
  );
  if (!row) throw new DomainError("That photo no longer exists. Refresh and try again.");
}

const isAlreadyThere = (error: { message?: string; statusCode?: string; status?: number }) =>
  error.statusCode === "409" ||
  error.status === 409 ||
  /already exists|duplicate/i.test(error.message ?? "");

/**
 * Removes `path` from `bucket` unless the row (re-read now) names that
 * bucket, so an object the row points at is never removed. Returns the
 * Storage error, if any; a missing object is not an error.
 */
async function removeUnlessCurrent(
  supabase: ServerSupabase,
  attachmentId: string,
  bucket: PhotoBucket,
  path: string,
): Promise<unknown> {
  const now = await readRow(supabase, attachmentId);
  if (now && now.storage_bucket === bucket && now.storage_path === path) return null;
  const { error } = await supabase.storage.from(bucket).remove([path]);
  return error ?? null;
}

export type CleanupReport = (problem: string, details: Record<string, unknown>) => void;

/**
 * A change that has happened. `cleanupPending`: an old copy of the photo
 * could not be removed from Storage yet. Repeating the same change
 * finishes it; failing that, the next showing of the record does
 * (listPhotos).
 */
export type PhotoChange = { cleanupPending: boolean };

/**
 * Who may see a photo. internal <-> customer stays in media-internal (the
 * RPC alone); to or from public moves the object between buckets (see the
 * module comment for the order and what a failure leaves behind). PLAN D13:
 * a photo on a customer record is never public; D19: nor is a photo on a
 * job; nor is an original stored without re-encoding, which may carry its
 * GPS position.
 */
export async function setPhotoVisibility(
  supabase: ServerSupabase,
  id: string,
  visibility: Visibility,
  report: CleanupReport,
): Promise<PhotoChange> {
  const row = await readRow(supabase, id);
  if (!row) throw new DomainError("That photo no longer exists. Refresh and try again.");
  if (visibility === "public" && row.entity_type === "customer") {
    throw new DomainError(BUSINESS_ERRORS.attachment_customer_never_public);
  }
  // D19: refused before anything is copied to media-public (the database
  // trigger and CHECK are the backstop).
  if (visibility === "public" && row.entity_type === "work_order") {
    throw new DomainError(BUSINESS_ERRORS.attachment_work_order_never_public);
  }
  // D52: an agreement photo is never shared (the trigger and CHECK are the backstop).
  if (visibility !== "internal" && row.entity_type === "consignment_item") {
    throw new DomainError(BUSINESS_ERRORS.attachment_consignment_internal_only);
  }
  if (visibility === "public" && isUndecodedOriginal(row)) {
    throw new DomainError(BUSINESS_ERRORS.attachment_original_never_public);
  }
  const from = asBucket(row.storage_bucket);
  const to = bucketFor(visibility);
  const path = row.storage_path;

  if (from === to) {
    unwrap(await supabase.rpc("set_attachment_visibility", { attachment_id: id, visibility }));
    // Finish an earlier move that could not remove its old copy.
    const leftover = await removeUnlessCurrent(supabase, id, otherBucket(to), path);
    if (leftover) {
      report("stale_copy_not_removed", {
        attachmentId: id,
        bucket: otherBucket(to),
        path,
        error: leftover,
      });
      return { cleanupPending: true };
    }
    return { cleanupPending: false };
  }

  const { error: copyError } = await supabase.storage
    .from(from)
    .copy(path, path, { destinationBucket: to });
  // Already there: an earlier attempt copied it (the path is unique to this photo).
  if (copyError && !isAlreadyThere(copyError)) throw new StorageFailure("copy", copyError);

  const { error: rpcError } = await supabase.rpc("set_attachment_visibility", {
    attachment_id: id,
    visibility,
    new_bucket: to,
    new_path: path,
  });
  if (rpcError) {
    const now = await readRow(supabase, id);
    if (!now || now.storage_bucket !== to) {
      // The row still names the original, untouched: take the copy back out.
      const undo = await removeUnlessCurrent(supabase, id, to, path);
      if (undo) report("copy_not_removed", { attachmentId: id, bucket: to, path, error: undo });
      throw new DbError(rpcError);
    }
    // The change committed even though the response failed: carry on.
  }

  const removeError = await removeUnlessCurrent(supabase, id, from, path);
  if (removeError) {
    report("original_not_removed", { attachmentId: id, bucket: from, path, error: removeError });
    return { cleanupPending: true };
  }
  return { cleanupPending: false };
}

/**
 * Deletes a photo with a reason (RPC delete_attachment keeps who, when, why
 * and the row in attachment_events), then removes its object. Safe to
 * repeat: a replay reads the path from the `deleted` event. The photo is
 * deleted once this returns; `cleanupPending` means its file is still in
 * Storage (repeating finishes it, as does the next showing of the record).
 */
export async function deletePhoto(
  supabase: ServerSupabase,
  id: string,
  reason: string,
  report: CleanupReport,
): Promise<PhotoChange> {
  const cleaned = reason.trim();
  if (!cleaned) {
    throw new DomainError("Say why you are deleting this photo.", {
      reason: ["Say why you are deleting this photo."],
    });
  }
  // A set: the deleted row, or none on a replay.
  const deleted = (unwrap(
    await supabase.rpc("delete_attachment", { attachment_id: id, reason: cleaned }),
  ) ?? []) as Row[];

  let path: string | null = deleted[0]?.storage_path ?? null;
  if (!path) {
    const event = unwrap(
      await supabase
        .from("attachment_events")
        .select("payload")
        .eq("attachment_id", id)
        .eq("event_type", "deleted")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    const payload = event?.payload as { storage_path?: unknown } | null | undefined;
    path = typeof payload?.storage_path === "string" ? payload.storage_path : null;
  }
  if (!path) return { cleanupPending: false };

  // The row is gone and ids are never reused, so neither bucket's copy is
  // referenced any more.
  const failures: unknown[] = [];
  for (const bucket of [INTERNAL_BUCKET, PUBLIC_BUCKET] as const) {
    const { error } = await supabase.storage.from(bucket).remove([path]);
    if (error) failures.push(error);
  }
  if (failures.length > 0) {
    report("deleted_object_not_removed", { attachmentId: id, path, errors: failures });
    return { cleanupPending: true };
  }
  return { cleanupPending: false };
}
