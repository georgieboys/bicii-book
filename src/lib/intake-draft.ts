/**
 * The intake draft (SPEC §22: autosave where losing work would hurt). One
 * draft per device in localStorage: the ids and labels picked and the text
 * typed, nothing else (no prices, no costs). It names the staff member who
 * started it and is offered back only to them, and only within
 * DRAFT_MAX_AGE_MS of starting; signing out and the login page remove it
 * (src/lib/device-data.ts), so a shared device never hands one person's
 * intake to the next. Every access is wrapped, as in
 * src/lib/recent-searches.ts: storage can be missing, full, or throw
 * (Safari private mode, blocked site data). The draft keeps the job's and
 * the service lines' idempotency keys, so finishing a restored intake can
 * never make a second job. Pure apart from the storage it is handed.
 */
import { isUuid } from "@/lib/uuid";

export const INTAKE_DRAFT_KEY = "bicii.intake-draft.v2";
/** The version-1 key (no staff id), removed whenever the draft is read or cleared. */
export const LEGACY_INTAKE_DRAFT_KEYS = ["bicii.intake-draft.v1"] as const;
/** A draft older than this is not offered back: 24 hours. */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type IntakeDraftService = { lineId: string; serviceId: string; quantity: string };

export type IntakeDraft = {
  v: 2;
  /** The staff member who started it (staff.id); only they are offered it back. */
  staffId: string;
  /** When the intake began (ISO), for "Continue the intake you started at 10:42?". */
  startedAt: string;
  /** The job's idempotency key. */
  workOrderId: string;
  /** 0 Customer · 1 Bike · 2 Work · 3 People · 4 Services · 5 Review */
  step: number;
  customer: { id: string; label: string } | null;
  bike: { id: string; shortId: string; title: string } | null;
  requestedWork: string;
  intakeNotes: string;
  leadId: string | null;
  additionalIds: string[];
  services: IntakeDraftService[];
};

export const LAST_STEP = 5;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the draft holds anything worth offering back. */
export function draftHasContent(d: IntakeDraft): boolean {
  return (
    d.customer !== null ||
    d.bike !== null ||
    d.requestedWork.trim() !== "" ||
    d.intakeNotes.trim() !== "" ||
    d.services.length > 0
  );
}

export function serializeDraft(draft: IntakeDraft): string {
  return JSON.stringify(draft);
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

/** The draft from its stored JSON; null for anything missing, malformed or from another version. */
export function parseDraft(raw: string | null | undefined): IntakeDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const d = obj(parsed);
  if (!d || d.v !== 2) return null;
  if (!isUuid(d.staffId)) return null;
  const startedAt = str(d.startedAt, 40);
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) return null;
  if (!isUuid(d.workOrderId)) return null;
  const step =
    typeof d.step === "number" && Number.isInteger(d.step) && d.step >= 0 && d.step <= LAST_STEP
      ? d.step
      : 0;

  const c = obj(d.customer);
  const customer =
    c && isUuid(c.id) && str(c.label, 400) !== null ? { id: c.id, label: c.label as string } : null;
  const b = obj(d.bike);
  const bike =
    b && isUuid(b.id) && str(b.shortId, 40) !== null && str(b.title, 400) !== null
      ? { id: b.id, shortId: b.shortId as string, title: b.title as string }
      : null;
  const services = Array.isArray(d.services)
    ? d.services.flatMap((s): IntakeDraftService[] => {
        const o = obj(s);
        return o &&
          isUuid(o.lineId) &&
          isUuid(o.serviceId) &&
          typeof o.quantity === "string" &&
          /^\d{1,4}(\.\d{1,2})?$/.test(o.quantity)
          ? [{ lineId: o.lineId, serviceId: o.serviceId, quantity: o.quantity }]
          : [];
      })
    : [];
  return {
    v: 2,
    staffId: d.staffId,
    startedAt,
    workOrderId: d.workOrderId,
    step,
    customer,
    bike,
    requestedWork: str(d.requestedWork, 5_000) ?? "",
    intakeNotes: str(d.intakeNotes, 10_000) ?? "",
    leadId: isUuid(d.leadId) ? d.leadId : null,
    additionalIds: Array.isArray(d.additionalIds) ? d.additionalIds.filter(isUuid) : [],
    services,
  };
}

/**
 * The draft `staffId` may continue, or null. A draft that is unreadable,
 * another staff member's, or started more than DRAFT_MAX_AGE_MS before
 * `now` is removed, and so is any version-1 draft.
 */
export function readDraft(
  staffId: string,
  storage: StorageLike | null = defaultStorage(),
  now: number = Date.now(),
): IntakeDraft | null {
  try {
    for (const key of LEGACY_INTAKE_DRAFT_KEYS) storage?.removeItem(key);
    const raw = storage?.getItem(INTAKE_DRAFT_KEY);
    if (!raw) return null;
    const draft = parseDraft(raw);
    if (
      draft &&
      draft.staffId === staffId &&
      now - Date.parse(draft.startedAt) <= DRAFT_MAX_AGE_MS
    ) {
      return draft;
    }
    storage?.removeItem(INTAKE_DRAFT_KEY);
    return null;
  } catch {
    return null;
  }
}

/** Saves the draft, or removes it when there is nothing in it yet. */
export function saveDraft(
  draft: IntakeDraft,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    if (draftHasContent(draft)) storage?.setItem(INTAKE_DRAFT_KEY, serializeDraft(draft));
    else storage?.removeItem(INTAKE_DRAFT_KEY);
  } catch {
    // Full or blocked: the intake just isn't kept.
  }
}

export function clearDraft(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(INTAKE_DRAFT_KEY);
    for (const key of LEGACY_INTAKE_DRAFT_KEYS) storage?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

export type DraftPruning = {
  draft: IntakeDraft;
  /** Services on the draft that are no longer offered (archived or inactive since). */
  removedServices: number;
  /** The lead or helpers on the draft who are no longer active staff. */
  removedStaff: number;
};

/**
 * A restored draft checked against what can be chosen now: services
 * archived or deactivated since it was saved, and a lead or helpers who are
 * no longer active, are dropped (the screens only show what can be chosen,
 * so these could neither be seen nor removed, and creating the job would be
 * refused every time). The counts are for telling the user what changed.
 */
export function pruneDraft(
  draft: IntakeDraft,
  available: { serviceIds: ReadonlySet<string>; staffIds: ReadonlySet<string> },
): DraftPruning {
  const services = draft.services.filter((s) => available.serviceIds.has(s.serviceId));
  const leadId = draft.leadId && available.staffIds.has(draft.leadId) ? draft.leadId : null;
  const additionalIds = draft.additionalIds.filter((id) => available.staffIds.has(id));
  return {
    draft: { ...draft, services, leadId, additionalIds },
    removedServices: draft.services.length - services.length,
    removedStaff:
      (draft.leadId !== leadId ? 1 : 0) + (draft.additionalIds.length - additionalIds.length),
  };
}

/** What pruneDraft removed, in a sentence; null when nothing was. */
export function prunedMessage({ removedServices, removedStaff }: DraftPruning): string | null {
  const parts: string[] = [];
  if (removedServices > 0) {
    parts.push(
      removedServices === 1
        ? "1 service is no longer offered"
        : `${removedServices} services are no longer offered`,
    );
  }
  if (removedStaff > 0) {
    parts.push(
      removedStaff === 1
        ? "1 person is no longer active staff"
        : `${removedStaff} people are no longer active staff`,
    );
  }
  return parts.length > 0 ? `Removed from the draft: ${parts.join(", and ")}.` : null;
}
