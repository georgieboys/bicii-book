import "server-only";

import { z } from "zod";

import type { Database } from "@/lib/database.types";
import { DbError, constraintOf, unwrap } from "@/lib/db-errors";
import { isValidQrBase, parseShortId } from "@/lib/ids";
import {
  LABEL_ENTITY_NOT_FOUND,
  labelUnavailable,
  type LabelUnavailableReason,
} from "@/lib/printing/availability";
import { maxLabelQuantity } from "@/lib/printing/job";
import {
  PUBLIC_SITE_URL_PROBLEM,
  labelContentSchema,
  labelLayoutSchema,
  printerConfigSchema,
  toDbConfig,
  toDbLayout,
  type LabelTemplateInput,
  type PrinterProfileInput,
} from "@/lib/printing/schemas";
import type {
  LabelContent,
  LabelKind,
  LabelTemplate,
  PrintJob,
  PrintStatus,
  PrinterAdapterId,
  PrinterProfile,
} from "@/lib/printing/types";
import type { ServerSupabase } from "@/lib/supabase/server";

import { DomainError } from "./errors";
import type { ListPage } from "./list";
import { staffNames } from "@/lib/domain/staff-directory";

/**
 * Labels and print jobs (SPEC §15, §16, §31; DATA-MODEL §12; PLAN D9,
 * D56–D59; ADR-017). Reads go through RLS (staff read templates, printers
 * and print jobs); writes go through the RPCs (create_print_job,
 * set_print_job_status, set_default_*) or, for an admin's template and
 * printer edits, the column grants. Every jsonb is parsed with the printing
 * schemas, so label text can only be what private.label_content wrote.
 * Nothing here builds a QR payload: the database computes it.
 */

type PrintJobRow = Database["public"]["Tables"]["print_jobs"]["Row"];

const templateSnapshotSchema = z.object({
  name: z.string(),
  kind: z.enum(["product", "unit", "bike"]),
  width_mm: z.number(),
  height_mm: z.number(),
  layout: labelLayoutSchema,
});

const profileSnapshotSchema = z.object({
  name: z.string(),
  adapter: z.enum(["browser", "pdf", "network_raw", "bluetooth"]),
  config: printerConfigSchema,
});

const ENTITY_COLUMN: Record<LabelKind, "product_id" | "inventory_unit_id" | "bike_id"> = {
  product: "product_id",
  unit: "inventory_unit_id",
  bike: "bike_id",
};

const nameOf = (names: Map<string, string>, id: string) => names.get(id) ?? "A former colleague";

// ---------------------------------------------------------------------------
// Print jobs
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  "id, label_kind, product_id, inventory_unit_id, bike_id, short_id, qr_payload, content, quantity, printer_profile_id, profile_snapshot, adapter, label_template_id, template_snapshot, status, rendered_at, completed_at, error, status_changed_by, reprint_of_id, requested_by, created_at";

type JobColumns = Pick<
  PrintJobRow,
  | "id"
  | "label_kind"
  | "product_id"
  | "inventory_unit_id"
  | "bike_id"
  | "short_id"
  | "qr_payload"
  | "content"
  | "quantity"
  | "printer_profile_id"
  | "profile_snapshot"
  | "adapter"
  | "label_template_id"
  | "template_snapshot"
  | "status"
  | "rendered_at"
  | "completed_at"
  | "error"
  | "status_changed_by"
  | "reprint_of_id"
  | "requested_by"
  | "created_at"
>;

function toPrintJob(
  row: JobColumns,
  names: Map<string, string>,
  entityArchived: boolean,
): PrintJob {
  const content = labelContentSchema.parse(row.content);
  const template = templateSnapshotSchema.parse(row.template_snapshot);
  const profile = profileSnapshotSchema.parse(row.profile_snapshot);
  if (content.qrPayload !== row.qr_payload || content.shortId !== row.short_id) {
    throw new Error(`print job ${row.id}: content does not match its QR payload`);
  }
  const entityId = row.product_id ?? row.inventory_unit_id ?? row.bike_id;
  if (!entityId) throw new Error(`print job ${row.id}: no record`);
  return {
    id: row.id,
    kind: row.label_kind,
    entityId,
    entityArchived,
    shortId: row.short_id,
    qrPayload: row.qr_payload,
    content,
    quantity: row.quantity,
    adapter: row.adapter,
    profile: { id: row.printer_profile_id, name: profile.name, config: profile.config },
    template: {
      id: row.label_template_id,
      name: template.name,
      widthMm: template.width_mm,
      heightMm: template.height_mm,
      layout: template.layout,
    },
    status: row.status,
    error: row.error,
    requestedBy: { id: row.requested_by, name: nameOf(names, row.requested_by) },
    statusChangedBy: row.status_changed_by
      ? { id: row.status_changed_by, name: nameOf(names, row.status_changed_by) }
      : null,
    createdAt: row.created_at,
    renderedAt: row.rendered_at,
    completedAt: row.completed_at,
    reprintOfId: row.reprint_of_id,
  };
}

/** Whether a job's record (or a unit's product) is archived: no new labels for it. */
async function entityArchived(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
): Promise<boolean> {
  if (kind === "product") {
    const row = unwrap(
      await supabase.from("products").select("archived_at").eq("id", entityId).maybeSingle(),
    );
    return row?.archived_at != null;
  }
  if (kind === "unit") {
    const row = unwrap(
      await supabase
        .from("inventory_units")
        .select("archived_at, product:products(archived_at)")
        .eq("id", entityId)
        .maybeSingle(),
    );
    return row?.archived_at != null || row?.product?.archived_at != null;
  }
  const row = unwrap(
    await supabase.from("bikes").select("archived_at").eq("id", entityId).maybeSingle(),
  );
  return row?.archived_at != null;
}

/** One print job with its snapshots, or null. */
export async function getPrintJob(supabase: ServerSupabase, id: string): Promise<PrintJob | null> {
  const [row, names] = await Promise.all([
    supabase.from("print_jobs").select(JOB_COLUMNS).eq("id", id).maybeSingle().then(unwrap),
    staffNames(supabase),
  ]);
  if (!row) return null;
  const entityId = row.product_id ?? row.inventory_unit_id ?? row.bike_id;
  const archived = entityId ? await entityArchived(supabase, row.label_kind, entityId) : false;
  return toPrintJob(row, names, archived);
}

/** A row of the print history (/labels) or a record's recent prints. */
export type PrintJobListItem = {
  id: string;
  kind: LabelKind;
  entityId: string;
  shortId: string;
  name: string;
  quantity: number;
  printerName: string;
  adapter: PrinterAdapterId;
  requestedBy: string;
  createdAt: string;
  status: PrintStatus;
  error: string | null;
  /** The label's price snapshot (D58), null when it printed no price. */
  price: string | null;
  currency: string;
};

const LIST_COLUMNS =
  "id, label_kind, product_id, inventory_unit_id, bike_id, short_id, content, quantity, profile_snapshot, adapter, status, error, requested_by, created_at";

type ListColumns = Pick<
  PrintJobRow,
  | "id"
  | "label_kind"
  | "product_id"
  | "inventory_unit_id"
  | "bike_id"
  | "short_id"
  | "content"
  | "quantity"
  | "profile_snapshot"
  | "adapter"
  | "status"
  | "error"
  | "requested_by"
  | "created_at"
>;

function toListItem(row: ListColumns, names: Map<string, string>): PrintJobListItem {
  const content: LabelContent = labelContentSchema.parse(row.content);
  const profile = profileSnapshotSchema.parse(row.profile_snapshot);
  return {
    id: row.id,
    kind: row.label_kind,
    entityId: (row.product_id ?? row.inventory_unit_id ?? row.bike_id) as string,
    shortId: row.short_id,
    name: content.name,
    quantity: row.quantity,
    printerName: profile.name,
    adapter: row.adapter,
    requestedBy: nameOf(names, row.requested_by),
    createdAt: row.created_at,
    status: row.status,
    error: row.error,
    price: content.price,
    currency: content.currency,
  };
}

export type PrintJobFilter = "all" | "open" | "failed";

/** The cursor of the next page: the last row's created_at and id. */
export type PrintJobCursor = { createdAt: string; id: string };

export function encodeCursor(c: PrintJobCursor): string {
  return `${c.createdAt}_${c.id}`;
}

export function decodeCursor(value: string | null | undefined): PrintJobCursor | null {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))_([0-9a-f-]{36})$/i.exec(
    value ?? "",
  );
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { createdAt: m[1], id: m[2].toLowerCase() };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The print history, newest first: all, open (queued or rendered: "To
 * confirm") or failed. `q` is a short ID matched exactly, or else part of
 * the label's name (case-insensitive). `before` continues after a page.
 */
export async function listPrintJobs(
  supabase: ServerSupabase,
  {
    filter,
    q,
    before = null,
    limit = 30,
  }: { filter: PrintJobFilter; q: string; before?: PrintJobCursor | null; limit?: number },
): Promise<ListPage<PrintJobListItem> & { next: PrintJobCursor | null }> {
  let query = supabase.from("print_jobs").select(LIST_COLUMNS);
  if (filter === "open") query = query.in("status", ["queued", "rendered"]);
  if (filter === "failed") query = query.eq("status", "failed");
  if (q) {
    const shortId = parseShortId(q);
    query = shortId
      ? query.eq("short_id", shortId.shortId)
      : query.ilike("content->>name", `%${escapeLike(q)}%`);
  }
  if (before) {
    const at = JSON.stringify(before.createdAt);
    query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${before.id})`);
  }
  const [rows, names] = await Promise.all([
    query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1)
      .then(unwrap),
    staffNames(supabase),
  ]);
  const page = (rows ?? []).slice(0, limit);
  const more = (rows ?? []).length > limit;
  const last = page.at(-1);
  return {
    items: page.map((r) => toListItem(r, names)),
    more,
    next: more && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/** A record's latest print jobs, newest first. */
export async function listJobsFor(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
  limit = 3,
): Promise<PrintJobListItem[]> {
  const [rows, names] = await Promise.all([
    supabase
      .from("print_jobs")
      .select(LIST_COLUMNS)
      .eq(ENTITY_COLUMN[kind], entityId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit)
      .then(unwrap),
    staffNames(supabase),
  ]);
  return (rows ?? []).map((r) => toListItem(r, names));
}

/** The newest printed job's price snapshot for a record (D58's "price changed" warning). */
async function lastPrintedPrice(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
): Promise<{ price: string | null } | null> {
  const row = unwrap(
    await supabase
      .from("print_jobs")
      .select("content")
      .eq(ENTITY_COLUMN[kind], entityId)
      .eq("status", "printed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return row ? { price: labelContentSchema.parse(row.content).price } : null;
}

// ---------------------------------------------------------------------------
// Templates and printers (read)
// ---------------------------------------------------------------------------

type TemplateRow = Database["public"]["Tables"]["label_templates"]["Row"];
type ProfileRow = Database["public"]["Tables"]["printer_profiles"]["Row"];

const toTemplate = (r: TemplateRow): LabelTemplate => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  widthMm: Number(r.width_mm),
  heightMm: Number(r.height_mm),
  layout: labelLayoutSchema.parse(r.layout),
  isDefault: r.is_default,
  active: r.active,
});

const toProfile = (r: ProfileRow): PrinterProfile => ({
  id: r.id,
  name: r.name,
  adapter: r.adapter,
  config: printerConfigSchema.parse(r.config),
  isDefault: r.is_default,
  active: r.active,
  sortOrder: r.sort_order,
});

/** Every label template (active and switched off): default first per kind, then by name. */
export async function listTemplates(
  supabase: ServerSupabase,
  { kind, activeOnly = false }: { kind?: LabelKind; activeOnly?: boolean } = {},
): Promise<LabelTemplate[]> {
  let query = supabase.from("label_templates").select("*");
  if (kind) query = query.eq("kind", kind);
  if (activeOnly) query = query.eq("active", true);
  const rows = unwrap(
    await query.order("kind").order("is_default", { ascending: false }).order("name"),
  );
  return (rows ?? []).map(toTemplate);
}

/** Every printer (active and switched off): default first, then sort order and name. */
export async function listProfiles(
  supabase: ServerSupabase,
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<PrinterProfile[]> {
  let query = supabase.from("printer_profiles").select("*");
  if (activeOnly) query = query.eq("active", true);
  const rows = unwrap(
    await query.order("is_default", { ascending: false }).order("sort_order").order("name"),
  );
  return (rows ?? []).map(toProfile);
}

// ---------------------------------------------------------------------------
// The record page's label context
// ---------------------------------------------------------------------------

export type LabelContext =
  | {
      ok: true;
      /** What a label printed now would carry (label_preview). */
      content: LabelContent;
      templates: LabelTemplate[];
      profiles: PrinterProfile[];
      defaultTemplateId: string | null;
      defaultProfileId: string | null;
      /** Products and units; null for bikes (a bike tag is never public). */
      publication: {
        status: Database["public"]["Enums"]["publication_status"];
        isPublic: boolean;
      } | null;
      recentJobs: PrintJobListItem[];
      /** The newest printed label's price (D58), or null when none printed yet. */
      lastPrintedPrice: { price: string | null } | null;
    }
  | {
      ok: false;
      reason: LabelUnavailableReason;
      message: string;
      recentJobs: PrintJobListItem[];
    };

async function labelPreview(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
): Promise<{ ok: true; content: LabelContent } | { ok: false; code: string }> {
  const { data, error } = await supabase.rpc("label_preview", { kind, entity_id: entityId });
  if (error) {
    // P0002: the record is gone (label_content's "… not found"), e.g.
    // deleted while the page rendered: unavailable, never a page error.
    if (error.code === "P0002") return { ok: false, code: LABEL_ENTITY_NOT_FOUND };
    const unavailable = error.code === "P0001" ? labelUnavailable(error.message) : null;
    if (unavailable) return { ok: false, code: error.message };
    throw new DbError(error);
  }
  return { ok: true, content: labelContentSchema.parse(data) };
}

async function publicationOf(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
  shortId: string,
): Promise<{
  status: Database["public"]["Enums"]["publication_status"];
  isPublic: boolean;
} | null> {
  if (kind === "bike") return null;
  const statusRow =
    kind === "product"
      ? unwrap(
          await supabase
            .from("products")
            .select("publication_status")
            .eq("id", entityId)
            .maybeSingle(),
        )
      : unwrap(
          await supabase
            .from("inventory_units")
            .select("product:products(publication_status)")
            .eq("id", entityId)
            .maybeSingle(),
        )?.product;
  if (!statusRow) return null;
  const publicRow = unwrap(
    await supabase
      .schema("reporting")
      .from("public_items")
      .select("short_id")
      .eq("short_id", shortId)
      .maybeSingle(),
  );
  return { status: statusRow.publication_status, isPublic: publicRow !== null };
}

/**
 * Everything a record page needs to offer labels. Never throws for a
 * "printing unavailable" condition (archived, a unique product, the QR
 * address not set, no template, the record gone): it returns { ok: false, reason, message }
 * so one misconfiguration cannot take down the product, unit or bike page.
 * Any other failure throws.
 */
export async function getLabelContext(
  supabase: ServerSupabase,
  { kind, entityId }: { kind: LabelKind; entityId: string },
): Promise<LabelContext> {
  const recent = listJobsFor(supabase, kind, entityId, 3);

  if (kind === "product") {
    const product = unwrap(
      await supabase.from("products").select("tracking_type").eq("id", entityId).maybeSingle(),
    );
    if (product?.tracking_type === "unique") {
      const u = labelUnavailable("label_unique_product_needs_unit")!;
      return { ok: false, ...u, recentJobs: await recent };
    }
  }

  const preview = await labelPreview(supabase, kind, entityId);
  if (!preview.ok) {
    const u = labelUnavailable(preview.code)!;
    return { ok: false, ...u, recentJobs: await recent };
  }

  const [templates, profiles, publication, recentJobs, lastPrinted] = await Promise.all([
    listTemplates(supabase, { kind, activeOnly: true }),
    listProfiles(supabase, { activeOnly: true }),
    publicationOf(supabase, kind, entityId, preview.content.shortId),
    recent,
    lastPrintedPrice(supabase, kind, entityId),
  ]);
  if (templates.length === 0) {
    const u = labelUnavailable("label_template_missing")!;
    return { ok: false, ...u, recentJobs };
  }
  return {
    ok: true,
    content: preview.content,
    templates,
    profiles,
    defaultTemplateId: templates.find((t) => t.isDefault)?.id ?? null,
    defaultProfileId: profiles.find((p) => p.isDefault)?.id ?? null,
    publication,
    recentJobs,
    lastPrintedPrice: lastPrinted,
  };
}

/**
 * "Print again" (D59): the settings of an earlier job of THIS record, for
 * a new job: its quantity (within today's cap), its printer and template
 * when still active (and the template still of this kind), the link, and
 * the price that job printed (D58: the sheet says when today's differs).
 * Null when the job is unknown or belongs to another record.
 */
export async function getReprintPreset(
  supabase: ServerSupabase,
  jobId: string,
  kind: LabelKind,
  entityId: string,
): Promise<{
  reprintOfId: string;
  quantity: number;
  profileId: string | null;
  templateId: string | null;
  price: string | null;
} | null> {
  const job = unwrap(
    await supabase
      .from("print_jobs")
      .select(
        "id, label_kind, product_id, inventory_unit_id, bike_id, quantity, printer_profile_id, label_template_id, content",
      )
      .eq("id", jobId)
      .maybeSingle(),
  );
  if (!job || job.label_kind !== kind) return null;
  if ((job.product_id ?? job.inventory_unit_id ?? job.bike_id) !== entityId) return null;
  const [profile, template] = await Promise.all([
    supabase
      .from("printer_profiles")
      .select("id, active")
      .eq("id", job.printer_profile_id)
      .maybeSingle()
      .then(unwrap),
    supabase
      .from("label_templates")
      .select("id, active, kind")
      .eq("id", job.label_template_id)
      .maybeSingle()
      .then(unwrap),
  ]);
  return {
    reprintOfId: job.id,
    quantity: Math.min(Math.max(job.quantity, 1), maxLabelQuantity(kind)),
    profileId: profile?.active ? profile.id : null,
    templateId: template?.active && template.kind === kind ? template.id : null,
    price: labelContentSchema.parse(job.content).price,
  };
}

/** What a record page's print sheet opens with (PrintLabelSheet's `preset`). */
export type PrintPreset = {
  /** The count asked for (D56: more than one job's cap leaves a remainder). */
  requestedQuantity: number;
  reprintOfId: string | null;
  profileId: string | null;
  templateId: string | null;
  /** The reprinted job's price snapshot (D58). */
  reprintPrice: string | null;
};

/**
 * A record page's deep link (`?print=1&qty=N&reprint={jobId}`, parsed by
 * parsePrintParams): the sheet's preset, or null when the page should not
 * open it. A reprint of an unknown job, or of another record's, opens the
 * sheet without the link (and its count).
 */
export async function resolvePrintPreset(
  supabase: ServerSupabase,
  kind: LabelKind,
  entityId: string,
  params: { open: boolean; requestedQuantity: number | null; reprintOfId: string | null },
): Promise<PrintPreset | null> {
  if (!params.open) return null;
  const reprint = params.reprintOfId
    ? await getReprintPreset(supabase, params.reprintOfId, kind, entityId)
    : null;
  return {
    requestedQuantity: params.requestedQuantity ?? reprint?.quantity ?? 1,
    reprintOfId: reprint?.reprintOfId ?? null,
    profileId: reprint?.profileId ?? null,
    templateId: reprint?.templateId ?? null,
    reprintPrice: reprint ? reprint.price : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * create_print_job: N identical labels of one record (D56), with the label,
 * template and printer snapshots. `id` is the client's key: a replay with
 * the same settings returns the same job.
 */
export async function createPrintJob(
  supabase: ServerSupabase,
  input: {
    id: string;
    kind: LabelKind;
    entityId: string;
    quantity: number;
    profileId?: string | null;
    templateId?: string | null;
    reprintOfId?: string | null;
  },
): Promise<{ jobId: string; adapter: PrinterAdapterId }> {
  const row = unwrap(
    await supabase.rpc("create_print_job", {
      job_id: input.id,
      kind: input.kind,
      entity_id: input.entityId,
      quantity: input.quantity,
      ...(input.profileId ? { printer_profile_id: input.profileId } : {}),
      ...(input.templateId ? { label_template_id: input.templateId } : {}),
      ...(input.reprintOfId ? { reprint_of_id: input.reprintOfId } : {}),
    }),
  );
  if (!row) throw new Error("create_print_job returned no row");
  return { jobId: row.id, adapter: row.adapter };
}

/** set_print_job_status (D59): rendered, printed, or failed with what went wrong. */
export async function setPrintJobStatus(
  supabase: ServerSupabase,
  input: { id: string; status: Exclude<PrintStatus, "queued">; error?: string | null },
): Promise<{ status: PrintStatus }> {
  const row = unwrap(
    await supabase.rpc("set_print_job_status", {
      job_id: input.id,
      status: input.status,
      ...(input.status === "failed" && input.error ? { error: input.error } : {}),
    }),
  );
  if (!row) throw new Error("set_print_job_status returned no row");
  return { status: row.status };
}

/**
 * Admin: create (with the form's id; a primary-key conflict means this
 * submit already saved it, as customers and bikes do) or update a
 * template. The database validates the layout again.
 */
export async function saveTemplate(
  supabase: ServerSupabase,
  id: string,
  input: LabelTemplateInput,
  mode: "create" | "update",
): Promise<{ id: string }> {
  const values = {
    name: input.name,
    width_mm: input.widthMm,
    height_mm: input.heightMm,
    layout: toDbLayout(
      input.layout,
    ) as Database["public"]["Tables"]["label_templates"]["Insert"]["layout"],
    active: input.active,
  };
  if (mode === "create") {
    const { error } = await supabase
      .from("label_templates")
      .insert({ id, kind: input.kind, ...values });
    if (error) {
      if (error.code === "23505" && constraintOf(error) === "label_templates_pkey") return { id };
      throw new DbError(error);
    }
    return { id };
  }
  const row = unwrap(
    await supabase.from("label_templates").update(values).eq("id", id).select("id").maybeSingle(),
  );
  if (!row) throw new DomainError("That template no longer exists.");
  return { id };
}

export async function setDefaultTemplate(supabase: ServerSupabase, id: string): Promise<void> {
  unwrap(await supabase.rpc("set_default_label_template", { template_id: id }));
}

/** Admin: create (form id as key) or update a printer. Its type never changes. */
export async function saveProfile(
  supabase: ServerSupabase,
  id: string,
  input: PrinterProfileInput,
  mode: "create" | "update",
): Promise<{ id: string }> {
  const values = {
    name: input.name,
    config: toDbConfig(input.config),
    active: input.active,
    sort_order: input.sortOrder,
  };
  if (mode === "create") {
    const { error } = await supabase
      .from("printer_profiles")
      .insert({ id, adapter: input.adapter, ...values });
    if (error) {
      if (error.code === "23505" && constraintOf(error) === "printer_profiles_pkey") return { id };
      throw new DbError(error);
    }
    return { id };
  }
  const row = unwrap(
    await supabase.from("printer_profiles").update(values).eq("id", id).select("id").maybeSingle(),
  );
  if (!row) throw new DomainError("That printer no longer exists.");
  return { id };
}

export async function setDefaultProfile(supabase: ServerSupabase, id: string): Promise<void> {
  unwrap(await supabase.rpc("set_default_printer_profile", { profile_id: id }));
}

/**
 * Admin: the shop's public website address, the QR base (D9). Validated
 * with the database's rule first; update_shop_settings checks again.
 */
export async function setPublicSiteUrl(supabase: ServerSupabase, url: string): Promise<string> {
  const value = url.trim();
  if (!isValidQrBase(value)) {
    throw new DomainError("Enter the public website's address, like https://bicii.sg.", {
      publicSiteUrl: [PUBLIC_SITE_URL_PROBLEM],
    });
  }
  unwrap(await supabase.rpc("update_shop_settings", { public_site_url: value }));
  return value.replace(/\/+$/, "");
}
