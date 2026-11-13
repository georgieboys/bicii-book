import "server-only";

import type {
  AdventureBookingEventKind,
  AdventureBookingStatus,
  AdventureFileState,
  AdventureFinisherName,
  AdventurePackStatus,
  AdventureParticipation,
  AdventureReviewDecision,
  AdventureSubmissionState,
  ReviewCheckKey,
} from "@/lib/adventures";
import { unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Adventure bookings, review and packs for staff (DATA-MODEL §20,
 * D172-D182). Reads go through RLS: bookings, payments, certificates and
 * packs for any staff member; evidence, tracks and reviews only for staff
 * who verify or manage adventures (they read as empty for anyone else).
 * Every change is an RPC that checks its own permission and rules.
 */

type Money = string;
type Rows<T> = { data: T[] | null; error: Parameters<typeof unwrap>[0]["error"] };

function rows<T>(result: Rows<T>): T[] {
  return unwrap(result) ?? [];
}

/** An embedded to-one relation, which supabase-js types loosely. */
function one<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return (value as T) ?? null;
}

/** An embedded customer's name as staff see it everywhere (display name, else first and last, else email). */
function riderLabel(value: unknown): string {
  const c = one<{
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(value);
  return c
    ? customerLabel({
        displayName: c.display_name,
        firstName: c.first_name,
        lastName: c.last_name,
        email: c.email,
      })
    : "Unknown rider";
}

type Named = { display_name: string } | null;

// ------------------------------------------------------------ bookings ----

export type AdventureBookingListItem = {
  id: string;
  reference: string;
  status: AdventureBookingStatus;
  kind: AdventureParticipation;
  customerName: string;
  routeName: string;
  total: Money;
  needsAttention: boolean;
  createdAt: string;
  confirmedAt: string | null;
};

const LIST_COLUMNS =
  "id, reference, status, kind, total, needs_attention, created_at, confirmed_at, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name)";

type ListRow = {
  id: string;
  reference: string;
  status: AdventureBookingStatus;
  kind: AdventureParticipation;
  total: Money;
  needs_attention: boolean;
  created_at: string;
  confirmed_at: string | null;
  customer: unknown;
  revision: unknown;
};

function listItem(r: ListRow): AdventureBookingListItem {
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    kind: r.kind,
    customerName: riderLabel(r.customer),
    routeName: one<{ name: string }>(r.revision)?.name ?? "Unknown route",
    total: String(r.total),
    needsAttention: r.needs_attention,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
  };
}

export type BookingFilter = "all" | "paid" | "attention" | "unpaid";

/** The newest bookings first, filtered; at most 200. */
export async function listAdventureBookings(
  supabase: ServerSupabase,
  filter: BookingFilter,
): Promise<AdventureBookingListItem[]> {
  let query = supabase.from("adventure_bookings").select(LIST_COLUMNS);
  if (filter === "paid") query = query.eq("status", "confirmed");
  if (filter === "attention") query = query.eq("needs_attention", true);
  if (filter === "unpaid") query = query.in("status", ["pending_payment", "expired", "cancelled"]);
  const data = rows(
    (await query
      .order("created_at", { ascending: false })
      .order("id")
      .limit(200)) as unknown as Rows<ListRow>,
  );
  return data.map(listItem);
}

export type AdventureBookingDetail = AdventureBookingListItem & {
  customerId: string;
  adventureId: string;
  revisionNumber: number;
  distanceKm: string;
  tshirtSize: string | null;
  finisherName: AdventureFinisherName;
  termsVersion: string;
  attentionReason: string | null;
  lines: Array<{ id: string; description: string; quantity: number; total: Money }>;
  payments: Array<{
    id: string;
    amount: Money;
    status: string;
    refundedAmount: Money;
    paidAt: string | null;
    createdAt: string;
    livemode: boolean | null;
  }>;
  submissions: Array<{
    id: string;
    attemptNumber: number;
    version: number;
    state: AdventureSubmissionState;
    submittedAt: string | null;
  }>;
  certificate: {
    id: string;
    reference: string;
    status: "active" | "revoked";
    completedOn: string;
    acceptedDistanceKm: string;
    issuedAt: string;
    revokeReason: string | null;
  } | null;
  pack: AdventurePack | null;
  events: Array<{
    id: string;
    kind: AdventureBookingEventKind;
    staffName: string | null;
    note: string | null;
    createdAt: string;
  }>;
};

/** What an event's detail says, in a line, when it says something a person wrote or chose. */
function eventNote(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const parts = [
    d.note,
    d.reason,
    d.certificate,
    d.status,
    d.version ? `version ${d.version}` : null,
  ]
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String)
    .filter((v) => v.trim() !== "");
  return parts.length ? parts.join(" · ") : null;
}

export async function getAdventureBooking(
  supabase: ServerSupabase,
  id: string,
): Promise<AdventureBookingDetail | null> {
  const booking = unwrap(
    (await supabase
      .from("adventure_bookings")
      .select(
        `${LIST_COLUMNS}, customer_id, adventure_id, tshirt_size, finisher_name, terms_version, attention_reason, revision_full:revision_id (revision_number, distance_km)`,
      )
      .eq("id", id)
      .maybeSingle()) as unknown as {
      data:
        | (ListRow & {
            customer_id: string;
            adventure_id: string;
            tshirt_size: string | null;
            finisher_name: AdventureFinisherName;
            terms_version: string;
            attention_reason: string | null;
            revision_full: unknown;
          })
        | null;
      error: Parameters<typeof unwrap>[0]["error"];
    },
  );
  if (!booking) return null;
  const revision = one<{ revision_number: number; distance_km: string | number }>(
    booking.revision_full,
  );

  const [lines, payments, attempts, certificates, events] = await Promise.all([
    supabase
      .from("adventure_booking_lines")
      .select("id, description, quantity, total")
      .eq("booking_id", id)
      .order("position"),
    supabase
      .from("adventure_payments")
      .select("id, amount, status, refunded_amount, paid_at, created_at, livemode")
      .eq("booking_id", id)
      .order("created_at"),
    supabase
      .from("adventure_attempts")
      .select(
        "id, attempt_number, submissions:adventure_submissions (id, version, state, submitted_at)",
      )
      .eq("booking_id", id)
      .order("attempt_number"),
    supabase
      .from("adventure_certificates")
      .select("id, reference, status, completed_on, accepted_distance_km, issued_at, revoke_reason")
      .eq("booking_id", id),
    supabase
      .from("adventure_booking_events")
      .select("id, kind, detail, created_at, staff:staff_id (display_name)")
      .eq("booking_id", id)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(100),
  ]);
  const cert = rows(certificates)[0] ?? null;
  const packs = await listAdventurePacks(supabase, { bookingId: id });

  return {
    ...listItem(booking),
    customerId: booking.customer_id,
    adventureId: booking.adventure_id,
    revisionNumber: revision?.revision_number ?? 0,
    distanceKm: String(revision?.distance_km ?? "0"),
    tshirtSize: booking.tshirt_size,
    finisherName: booking.finisher_name,
    termsVersion: booking.terms_version,
    attentionReason: booking.attention_reason,
    lines: rows(lines).map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity,
      total: String(l.total),
    })),
    payments: rows(payments).map((p) => ({
      id: p.id,
      amount: String(p.amount),
      status: p.status,
      refundedAmount: String(p.refunded_amount),
      paidAt: p.paid_at,
      createdAt: p.created_at,
      livemode: p.livemode,
    })),
    submissions: rows(attempts).flatMap((a) =>
      (
        (a.submissions ?? []) as Array<{
          id: string;
          version: number;
          state: AdventureSubmissionState;
          submitted_at: string | null;
        }>
      )
        .sort((x, y) => y.version - x.version)
        .map((s) => ({
          id: s.id,
          attemptNumber: a.attempt_number,
          version: s.version,
          state: s.state,
          submittedAt: s.submitted_at,
        })),
    ),
    certificate: cert
      ? {
          id: cert.id,
          reference: cert.reference,
          status: cert.status,
          completedOn: cert.completed_on,
          acceptedDistanceKm: String(cert.accepted_distance_km),
          issuedAt: cert.issued_at,
          revokeReason: cert.revoke_reason,
        }
      : null,
    pack: packs[0] ?? null,
    events: rows(events).map((e) => ({
      id: e.id,
      kind: e.kind,
      staffName: one<{ display_name: string }>(e.staff)?.display_name ?? null,
      note: eventNote(e.detail),
      createdAt: e.created_at,
    })),
  };
}

export async function clearAdventureBookingAttention(
  supabase: ServerSupabase,
  bookingId: string,
  note: string,
): Promise<void> {
  unwrap(await supabase.rpc("clear_adventure_booking_attention", { booking_id: bookingId, note }));
}

// -------------------------------------------------------------- review ----

export type ReviewQueueItem = {
  submissionId: string;
  bookingId: string;
  reference: string;
  customerName: string;
  routeName: string;
  version: number;
  state: AdventureSubmissionState;
  submittedAt: string | null;
  claimedBy: string | null;
  needsAttention: boolean;
};

type QueueRow = {
  id: string;
  version: number;
  state: AdventureSubmissionState;
  submitted_at: string | null;
  claimer: unknown;
  attempt: unknown;
};

/** Versions waiting for a decision, oldest request first. */
export async function listReviewQueue(supabase: ServerSupabase): Promise<ReviewQueueItem[]> {
  const data = rows(
    (await supabase
      .from("adventure_submissions")
      .select(
        "id, version, state, submitted_at, claimer:review_claimed_by (display_name), attempt:attempt_id (booking:booking_id (id, reference, needs_attention, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name)))",
      )
      .in("state", ["submitted", "in_review"])
      .order("submitted_at")
      .limit(200)) as unknown as Rows<QueueRow>,
  );
  return data.map((s) => {
    const booking = one<{
      id: string;
      reference: string;
      needs_attention: boolean;
      customer: unknown;
      revision: unknown;
    }>(one<{ booking: unknown }>(s.attempt)?.booking);
    return {
      submissionId: s.id,
      bookingId: booking?.id ?? "",
      reference: booking?.reference ?? "",
      customerName: riderLabel(booking?.customer),
      routeName: one<{ name: string }>(booking?.revision)?.name ?? "Unknown route",
      version: s.version,
      state: s.state,
      submittedAt: s.submitted_at,
      claimedBy: one<{ display_name: string }>(s.claimer)?.display_name ?? null,
      needsAttention: booking?.needs_attention ?? false,
    };
  });
}

export type TrackSummary = {
  id: string;
  pointCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  distanceKm: string;
  hasTimes: boolean;
  format: string;
  outline: Array<{ lat: number; lon: number }>;
};

export type EvidenceFile = {
  id: string;
  kind: "activity" | "checkpoint_photo";
  checkpointPosition: number | null;
  originalName: string;
  sizeBytes: number | null;
  state: AdventureFileState;
  parseError: string | null;
  track: TrackSummary | null;
  /** A short-lived link for viewing a photo (staff who read evidence). */
  photoUrl: string | null;
};

export type CheckpointPass = {
  position: number;
  label: string;
  latitude: number | null;
  longitude: number | null;
  reviewRadiusM: number | null;
  mandatory: boolean;
  photoRequired: boolean;
  nearestM: number | null;
  nearestAt: string | null;
};

export type PastReview = {
  version: number;
  decision: AdventureReviewDecision;
  reviewerName: string | null;
  messageToRider: string;
  internalNote: string;
  decidedAt: string;
};

export type ReviewWorkspace = {
  submissionId: string;
  version: number;
  state: AdventureSubmissionState;
  submittedAt: string | null;
  riderStatement: string;
  claimedBy: string | null;
  booking: {
    id: string;
    reference: string;
    customerName: string;
    needsAttention: boolean;
    attentionReason: string | null;
  };
  route: {
    name: string;
    revisionNumber: number;
    distanceKm: string;
    minElapsedMinutes: number | null;
    maxElapsedMinutes: number | null;
    checkpointOrder: string;
    rules: string;
  };
  files: EvidenceFile[];
  checkpoints: CheckpointPass[];
  history: PastReview[];
  /** The hired tracker's track on this attempt (D191), when it has points or a window. */
  tracker: {
    attemptId: string;
    points: number;
    firstAt: string | null;
    lastAt: string | null;
    distanceKm: string;
    captureStartedAt: string | null;
    captureFinishedAt: string | null;
    outline: Array<{ lat: number; lon: number }>;
  } | null;
};

const EVIDENCE_BUCKET = "adventure-evidence";
const OUTLINE_POINTS = 800;

export async function getReviewWorkspace(
  supabase: ServerSupabase,
  submissionId: string,
): Promise<ReviewWorkspace | null> {
  const sub = unwrap(
    (await supabase
      .from("adventure_submissions")
      .select(
        "id, attempt_id, version, state, submitted_at, rider_statement, claimer:review_claimed_by (display_name), attempt:attempt_id (booking:booking_id (id, reference, needs_attention, attention_reason, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name, revision_number, distance_km, min_elapsed_minutes, max_elapsed_minutes, checkpoint_order, rules)))",
      )
      .eq("id", submissionId)
      .maybeSingle()) as unknown as {
      data: (QueueRow & { attempt_id: string; rider_statement: string }) | null;
      error: Parameters<typeof unwrap>[0]["error"];
    },
  );
  if (!sub) return null;
  const booking = one<{
    id: string;
    reference: string;
    needs_attention: boolean;
    attention_reason: string | null;
    customer: unknown;
    revision: unknown;
  }>(one<{ booking: unknown }>(sub.attempt)?.booking);
  const revision = one<{
    name: string;
    revision_number: number;
    distance_km: string | number;
    min_elapsed_minutes: number | null;
    max_elapsed_minutes: number | null;
    checkpoint_order: string;
    rules: string;
  }>(booking?.revision);
  if (!booking || !revision) return null;

  const [files, passes, versions, trackerSummary, trackerOutline] = await Promise.all([
    supabase
      .from("adventure_evidence_files")
      .select(
        "id, kind, checkpoint_position, storage_path, original_name, size_bytes, state, parse_error, track:adventure_tracks (id, point_count, started_at, finished_at, distance_km, has_times, source_format)",
      )
      .eq("submission_id", submissionId)
      .neq("state", "removed")
      .order("kind")
      .order("checkpoint_position", { nullsFirst: true })
      .order("created_at"),
    supabase.rpc("adventure_checkpoint_passes", { submission_id: submissionId }),
    supabase
      .from("adventure_submissions")
      .select(
        "version, reviews:adventure_reviews (decision, message_to_rider, internal_note, decided_at, reviewer:reviewer_id (display_name))",
      )
      .eq("attempt_id", sub.attempt_id)
      .order("version", { ascending: false }),
    supabase.rpc("adventure_tracker_summary", { submission_id: submissionId }),
    supabase.rpc("adventure_tracker_outline", {
      submission_id: submissionId,
      max_points: OUTLINE_POINTS,
    }),
  ]);
  const ts = rows(trackerSummary)[0] ?? null;

  const evidence: EvidenceFile[] = await Promise.all(
    rows(files).map(async (f) => {
      const t = one<{
        id: string;
        point_count: number;
        started_at: string | null;
        finished_at: string | null;
        distance_km: string | number;
        has_times: boolean;
        source_format: string;
      }>(f.track);
      let outline: TrackSummary["outline"] = [];
      if (t) {
        const points = rows(
          await supabase.rpc("adventure_track_outline", {
            track_id: t.id,
            max_points: OUTLINE_POINTS,
          }),
        );
        outline = points.map((p) => ({ lat: Number(p.latitude), lon: Number(p.longitude) }));
      }
      let photoUrl: string | null = null;
      if (f.kind === "checkpoint_photo" && f.state === "uploaded") {
        const signed = await supabase.storage
          .from(EVIDENCE_BUCKET)
          .createSignedUrl(f.storage_path, 600);
        photoUrl = signed.data?.signedUrl ?? null;
      }
      return {
        id: f.id,
        kind: f.kind,
        checkpointPosition: f.checkpoint_position,
        originalName: f.original_name,
        sizeBytes: f.size_bytes,
        state: f.state,
        parseError: f.parse_error,
        photoUrl,
        track: t
          ? {
              id: t.id,
              pointCount: t.point_count,
              startedAt: t.started_at,
              finishedAt: t.finished_at,
              distanceKm: String(t.distance_km),
              hasTimes: t.has_times,
              format: t.source_format,
              outline,
            }
          : null,
      };
    }),
  );

  return {
    submissionId: sub.id,
    version: sub.version,
    state: sub.state,
    submittedAt: sub.submitted_at,
    riderStatement: sub.rider_statement,
    claimedBy: one<{ display_name: string }>(sub.claimer)?.display_name ?? null,
    booking: {
      id: booking.id,
      reference: booking.reference,
      customerName: riderLabel(booking.customer),
      needsAttention: booking.needs_attention,
      attentionReason: booking.attention_reason,
    },
    route: {
      name: revision.name,
      revisionNumber: revision.revision_number,
      distanceKm: String(revision.distance_km),
      minElapsedMinutes: revision.min_elapsed_minutes,
      maxElapsedMinutes: revision.max_elapsed_minutes,
      checkpointOrder: revision.checkpoint_order,
      rules: revision.rules,
    },
    files: evidence,
    checkpoints: rows(passes).map((c) => ({
      position: c.checkpoint_position,
      label: c.label,
      latitude: c.latitude === null ? null : Number(c.latitude),
      longitude: c.longitude === null ? null : Number(c.longitude),
      reviewRadiusM: c.review_radius_m,
      mandatory: c.mandatory,
      photoRequired: c.photo_required,
      nearestM: c.nearest_m === null ? null : Number(c.nearest_m),
      nearestAt: c.nearest_at,
    })),
    tracker:
      ts && (ts.points > 0 || ts.capture_started_at)
        ? {
            attemptId: ts.attempt_id,
            points: ts.points,
            firstAt: ts.first_at,
            lastAt: ts.last_at,
            distanceKm: String(ts.distance_km ?? 0),
            captureStartedAt: ts.capture_started_at,
            captureFinishedAt: ts.capture_finished_at,
            outline: rows(trackerOutline).map((p) => ({
              lat: Number(p.latitude),
              lon: Number(p.longitude),
            })),
          }
        : null,
    history: rows(versions).flatMap((v) =>
      (v.reviews ? [v.reviews].flat() : []).map((raw: unknown) => {
        const r = raw as {
          decision: AdventureReviewDecision;
          message_to_rider: string;
          internal_note: string;
          decided_at: string;
          reviewer: unknown;
        };
        return {
          version: v.version,
          decision: r.decision,
          reviewerName: one<{ display_name: string }>(r.reviewer)?.display_name ?? null,
          messageToRider: r.message_to_rider,
          internalNote: r.internal_note,
          decidedAt: r.decided_at,
        };
      }),
    ),
  };
}

export async function claimAdventureReview(
  supabase: ServerSupabase,
  submissionId: string,
): Promise<void> {
  unwrap(await supabase.rpc("claim_adventure_review", { submission_id: submissionId }));
}

export async function decideAdventureReview(
  supabase: ServerSupabase,
  input: {
    submissionId: string;
    decision: AdventureReviewDecision;
    checklist: Record<ReviewCheckKey, boolean>;
    acceptedDistanceKm: string | null;
    completedOn: string | null;
    messageToRider: string;
    internalNote: string;
  },
): Promise<void> {
  unwrap(
    await supabase.rpc("decide_adventure_review", {
      submission_id: input.submissionId,
      decision: input.decision,
      checklist: input.checklist,
      // Generated argument types are not nullable; SQL takes null here.
      accepted_distance_km: input.acceptedDistanceKm as unknown as number,
      completed_on: input.completedOn as unknown as string,
      message_to_rider: input.messageToRider,
      internal_note: input.internalNote,
    }),
  );
}

export async function revokeAdventureCertificate(
  supabase: ServerSupabase,
  certificateId: string,
  reason: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("revoke_adventure_certificate", {
      certificate_id: certificateId,
      reason,
    }),
  );
}

// --------------------------------------------------------------- packs ----

export type AdventurePack = {
  id: string;
  bookingId: string;
  reference: string;
  certificateReference: string;
  customerName: string;
  routeName: string;
  tshirtSize: string | null;
  items: string[];
  status: AdventurePackStatus;
  note: string;
  readyAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
};

/** Packs, oldest first: open ones, or one booking's. */
export async function listAdventurePacks(
  supabase: ServerSupabase,
  scope: { bookingId: string } | { open: boolean },
): Promise<AdventurePack[]> {
  let query = supabase
    .from("adventure_fulfilments")
    .select(
      "id, booking_id, tshirt_size, items, status, note, ready_at, fulfilled_at, created_at, certificate:certificate_id (reference, status), booking:booking_id (reference, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name))",
    );
  if ("bookingId" in scope) query = query.eq("booking_id", scope.bookingId);
  else if (scope.open) query = query.neq("status", "fulfilled");
  else query = query.eq("status", "fulfilled");
  const data = rows(
    await query.order("created_at", { ascending: "bookingId" in scope || scope.open }).limit(200),
  );
  return data.map((p) => {
    const booking = one<{ reference: string; customer: unknown; revision: unknown }>(p.booking);
    return {
      id: p.id,
      bookingId: p.booking_id,
      reference: booking?.reference ?? "",
      certificateReference: one<{ reference: string }>(p.certificate)?.reference ?? "",
      customerName: riderLabel(booking?.customer),
      routeName: one<{ name: string }>(booking?.revision)?.name ?? "Unknown route",
      tshirtSize: p.tshirt_size,
      items: p.items,
      status: p.status,
      note: p.note ?? "",
      readyAt: p.ready_at,
      fulfilledAt: p.fulfilled_at,
      createdAt: p.created_at,
    };
  });
}

export async function setAdventurePackStatus(
  supabase: ServerSupabase,
  fulfilmentId: string,
  status: AdventurePackStatus,
  note: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("set_adventure_pack_status", {
      fulfilment_id: fulfilmentId,
      status,
      note,
    }),
  );
}

// ------------------------------------------------------------ settings ----

export type AdventureSalesSettings = {
  salesEnabled: boolean;
  termsVersion: string;
  checkoutMinutes: number;
  updatedAt: string;
  updatedBy: string | null;
};

export async function getAdventureSalesSettings(
  supabase: ServerSupabase,
): Promise<AdventureSalesSettings | null> {
  const row = unwrap(
    await supabase
      .from("adventure_settings")
      .select(
        "sales_enabled, terms_version, checkout_minutes, updated_at, staff:updated_by (display_name)",
      )
      .eq("id", 1)
      .maybeSingle(),
  );
  if (!row) return null;
  return {
    salesEnabled: row.sales_enabled,
    termsVersion: row.terms_version ?? "",
    checkoutMinutes: row.checkout_minutes,
    updatedAt: row.updated_at,
    updatedBy: (one(row.staff) as Named)?.display_name ?? null,
  };
}

export async function setAdventureSales(
  supabase: ServerSupabase,
  salesEnabled: boolean,
  termsVersion: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("set_adventure_sales", {
      sales_enabled: salesEnabled,
      terms_version: termsVersion,
    }),
  );
}
