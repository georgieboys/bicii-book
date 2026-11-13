import "server-only";

import { unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Tracker hire for staff (DATA-MODEL §20 "Tracker hire", D185-D188). Reads
 * go through RLS (any active staff member); every change is an RPC that
 * checks manage_adventures (or admin) and its own rules: one holder per
 * device, one device per hire, history never rewritten.
 */

type Rows<T> = { data: T[] | null; error: Parameters<typeof unwrap>[0]["error"] };

function rows<T>(result: Rows<T>): T[] {
  return unwrap(result) ?? [];
}

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

export type TrackerServiceState = "in_service" | "maintenance" | "lost" | "retired";
export type TrackerReturnCondition = "good" | "needs_service" | "faulty" | "lost";
export type TrackerReservationStatus = "held" | "confirmed" | "completed" | "cancelled";

export type TrackingDevice = {
  id: string;
  label: string;
  provider: "spot" | "fake";
  providerDeviceId: string;
  model: string;
  serviceState: TrackerServiceState;
  note: string;
  /** Who has it now, if anyone. */
  holder: {
    assignmentId: string;
    bookingId: string;
    reference: string;
    riderName: string;
    issuedAt: string;
  } | null;
};

type HolderRow = {
  id: string;
  device_id: string;
  issued_at: string;
  booking: unknown;
};

export async function listTrackingDevices(supabase: ServerSupabase): Promise<TrackingDevice[]> {
  const [devices, open] = await Promise.all([
    supabase
      .from("tracking_devices")
      .select("id, label, provider, provider_device_id, model, service_state, note")
      .order("label"),
    supabase
      .from("tracker_assignments")
      .select(
        "id, device_id, issued_at, booking:booking_id (id, reference, customer:customer_id (display_name, first_name, last_name, email))",
      )
      .is("returned_at", null) as unknown as Promise<Rows<HolderRow>>,
  ]);
  const holders = new Map(rows(open).map((h) => [h.device_id, h]));
  return rows(devices).map((d) => {
    const h = holders.get(d.id);
    const booking = h ? one<{ id: string; reference: string; customer: unknown }>(h.booking) : null;
    return {
      id: d.id,
      label: d.label,
      provider: d.provider,
      providerDeviceId: d.provider_device_id,
      model: d.model,
      serviceState: d.service_state,
      note: d.note,
      holder:
        h && booking
          ? {
              assignmentId: h.id,
              bookingId: booking.id,
              reference: booking.reference,
              riderName: riderLabel(booking.customer),
              issuedAt: h.issued_at,
            }
          : null,
    };
  });
}

export type TrackerHire = {
  reservationId: string;
  bookingId: string;
  reference: string;
  riderName: string;
  routeName: string;
  collectOn: string;
  returnOn: string;
  days: number;
  status: TrackerReservationStatus;
  needsAttention: boolean;
  cancelReason: string | null;
  /** The latest assignment, if a tracker was given out. */
  assignment: {
    id: string;
    deviceLabel: string;
    issuedAt: string;
    returnedAt: string | null;
    returnCondition: TrackerReturnCondition | null;
  } | null;
};

type HireRow = {
  id: string;
  booking_id: string;
  collect_on: string;
  return_on: string;
  days: number;
  status: TrackerReservationStatus;
  cancel_reason: string | null;
  booking: unknown;
  assignments: unknown;
};

const HIRE_COLUMNS =
  "id, booking_id, collect_on, return_on, days, status, cancel_reason, booking:booking_id (reference, needs_attention, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name)), assignments:tracker_assignments (id, issued_at, returned_at, return_condition, device:device_id (label))";

function hireFromRow(r: HireRow): TrackerHire {
  const booking = one<{
    reference: string;
    needs_attention: boolean;
    customer: unknown;
    revision: unknown;
  }>(r.booking);
  const assignments = (
    (Array.isArray(r.assignments) ? r.assignments : r.assignments ? [r.assignments] : []) as Array<{
      id: string;
      issued_at: string;
      returned_at: string | null;
      return_condition: TrackerReturnCondition | null;
      device: unknown;
    }>
  ).sort((a, b) => b.issued_at.localeCompare(a.issued_at));
  const latest = assignments[0] ?? null;
  return {
    reservationId: r.id,
    bookingId: r.booking_id,
    reference: booking?.reference ?? "",
    riderName: riderLabel(booking?.customer),
    routeName: one<{ name: string }>(booking?.revision)?.name ?? "Unknown route",
    collectOn: r.collect_on,
    returnOn: r.return_on,
    days: r.days,
    status: r.status,
    needsAttention: booking?.needs_attention ?? false,
    cancelReason: r.cancel_reason,
    assignment: latest
      ? {
          id: latest.id,
          deviceLabel: one<{ label: string }>(latest.device)?.label ?? "",
          issuedAt: latest.issued_at,
          returnedAt: latest.returned_at,
          returnCondition: latest.return_condition,
        }
      : null,
  };
}

/**
 * The counter's list: paid hires not yet finished (to collect, out),
 * oldest collection first, plus the latest finished ones.
 */
export async function listHandovers(
  supabase: ServerSupabase,
): Promise<{ open: TrackerHire[]; finished: TrackerHire[] }> {
  const [open, finished] = await Promise.all([
    supabase
      .from("tracker_reservations")
      .select(HIRE_COLUMNS)
      .eq("status", "confirmed")
      .order("collect_on")
      .limit(200) as unknown as Promise<Rows<HireRow>>,
    supabase
      .from("tracker_reservations")
      .select(HIRE_COLUMNS)
      .in("status", ["completed", "cancelled"])
      .order("updated_at", { ascending: false })
      .limit(30) as unknown as Promise<Rows<HireRow>>,
  ]);
  return { open: rows(open).map(hireFromRow), finished: rows(finished).map(hireFromRow) };
}

/** One booking's hire, or null. */
export async function getBookingHire(
  supabase: ServerSupabase,
  bookingId: string,
): Promise<TrackerHire | null> {
  const data = rows(
    (await supabase
      .from("tracker_reservations")
      .select(HIRE_COLUMNS)
      .eq("booking_id", bookingId)) as unknown as Rows<HireRow>,
  );
  return data[0] ? hireFromRow(data[0]) : null;
}

export type TrackerHireSettings = { enabled: boolean; maxDays: number };

export async function getTrackerHireSettings(
  supabase: ServerSupabase,
): Promise<TrackerHireSettings | null> {
  const row = unwrap(
    await supabase
      .from("adventure_settings")
      .select("tracker_hire_enabled, tracker_hire_max_days")
      .eq("id", 1)
      .maybeSingle(),
  );
  return row ? { enabled: row.tracker_hire_enabled, maxDays: row.tracker_hire_max_days } : null;
}

// ------------------------------------------------------------- changes ----

export async function registerTrackingDevice(
  supabase: ServerSupabase,
  input: { label: string; provider: "spot" | "fake"; providerDeviceId: string; model: string },
): Promise<{ id: string }> {
  const row = unwrap(
    await supabase.rpc("register_tracking_device", {
      label: input.label,
      provider: input.provider,
      provider_device_id: input.providerDeviceId,
      model: input.model,
    }),
  );
  return { id: (row as { id: string }).id };
}

export async function setTrackingDeviceState(
  supabase: ServerSupabase,
  deviceId: string,
  state: TrackerServiceState,
  note: string,
): Promise<void> {
  unwrap(await supabase.rpc("set_tracking_device_state", { device_id: deviceId, state, note }));
}

export async function issueTracker(
  supabase: ServerSupabase,
  reservationId: string,
  deviceId: string,
  note: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("issue_adventure_tracker", {
      reservation_id: reservationId,
      device_id: deviceId,
      note,
    }),
  );
}

export async function replaceTracker(
  supabase: ServerSupabase,
  assignmentId: string,
  deviceId: string,
  reason: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("replace_adventure_tracker", {
      assignment_id: assignmentId,
      device_id: deviceId,
      reason,
    }),
  );
}

export async function returnTracker(
  supabase: ServerSupabase,
  assignmentId: string,
  condition: TrackerReturnCondition,
  note: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("return_adventure_tracker", {
      assignment_id: assignmentId,
      condition,
      note,
    }),
  );
}

export async function cancelTrackerHire(
  supabase: ServerSupabase,
  reservationId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("cancel_tracker_hire", { reservation_id: reservationId, reason }));
}

export async function setTrackerHire(
  supabase: ServerSupabase,
  enabled: boolean,
  maxDays: number,
): Promise<void> {
  unwrap(await supabase.rpc("set_adventure_tracker_hire", { enabled, max_days: maxDays }));
}

// --------------------------------------------------------------- feeds ----
// D190: feeds the worker reads. Their access is in TRACKING_FEED_* server
// variables; only the variable's name is stored.

export type TrackingFeed = {
  id: string;
  provider: "spot" | "fake";
  label: string;
  configName: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  failures: number;
  watermarkAt: string;
};

export async function listTrackingFeeds(supabase: ServerSupabase): Promise<TrackingFeed[]> {
  return rows(
    await supabase
      .from("tracking_feeds")
      .select(
        "id, provider, label, config_name, enabled, last_success_at, last_error, failures, watermark_at",
      )
      .order("label"),
  ).map((f) => ({
    id: f.id,
    provider: f.provider,
    label: f.label,
    configName: f.config_name,
    enabled: f.enabled,
    lastSuccessAt: f.last_success_at,
    lastError: f.last_error,
    failures: f.failures,
    watermarkAt: f.watermark_at,
  }));
}

export async function saveTrackingFeed(
  supabase: ServerSupabase,
  input: {
    feedId: string | null;
    provider: "spot" | "fake";
    label: string;
    configName: string;
    enabled: boolean;
  },
): Promise<void> {
  unwrap(
    await supabase.rpc("save_tracking_feed", {
      feed_id: input.feedId as unknown as string,
      provider: input.provider,
      label: input.label,
      config_name: input.configName,
      enabled: input.enabled,
    }),
  );
}

/** D189: staff correct a ride window with a reason; points are attributed again. */
export async function correctCapture(
  supabase: ServerSupabase,
  attemptId: string,
  startedAt: string,
  finishedAt: string | null,
  reason: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("correct_adventure_capture", {
      attempt_id: attemptId,
      started_at: startedAt,
      finished_at: finishedAt as unknown as string,
      reason,
    }),
  );
}

// ---------------------------------------------------------- live rides ----
// D192: rides whose window is open, with their latest position and its age.

export type LiveRide = {
  attemptId: string;
  bookingId: string;
  reference: string;
  riderName: string;
  routeName: string;
  startedAt: string;
  deviceLabel: string | null;
  positions: number;
  latestAt: string | null;
  latestReceivedAt: string | null;
  /** Minutes since the latest position was recorded, when there is one. */
  latestAgeMinutes: number | null;
  /** Up to the last 300 points, oldest first, for the map. */
  points: Array<{ lat: number; lon: number }>;
};

type LiveRow = {
  id: string;
  booking_id: string;
  capture_started_at: string;
  booking: unknown;
  assignments: unknown;
};

export async function listLiveRides(supabase: ServerSupabase): Promise<LiveRide[]> {
  const attempts = rows(
    (await supabase
      .from("adventure_attempts")
      .select(
        "id, booking_id, capture_started_at, booking:booking_id (reference, customer:customer_id (display_name, first_name, last_name, email), revision:revision_id (name)), assignments:tracker_assignments (returned_at, device:device_id (label))",
      )
      .not("capture_started_at", "is", null)
      .is("capture_finished_at", null)
      .order("capture_started_at")
      .limit(50)) as unknown as Rows<LiveRow>,
  );
  return Promise.all(
    attempts.map(async (a) => {
      const booking = one<{ reference: string; customer: unknown; revision: unknown }>(a.booking);
      const assignments = (
        Array.isArray(a.assignments) ? a.assignments : a.assignments ? [a.assignments] : []
      ) as Array<{
        returned_at: string | null;
        device: unknown;
      }>;
      const current = assignments.find((x) => x.returned_at === null) ?? null;
      const recent = rows(
        await supabase
          .from("tracking_messages")
          .select("recorded_at, received_at, latitude, longitude")
          .eq("attempt_id", a.id)
          .not("latitude", "is", null)
          .order("recorded_at", { ascending: false })
          .limit(300),
      );
      return {
        attemptId: a.id,
        bookingId: a.booking_id,
        reference: booking?.reference ?? "",
        riderName: riderLabel(booking?.customer),
        routeName: one<{ name: string }>(booking?.revision)?.name ?? "Unknown route",
        startedAt: a.capture_started_at,
        deviceLabel: current ? (one<{ label: string }>(current.device)?.label ?? null) : null,
        positions: recent.length,
        latestAt: recent[0]?.recorded_at ?? null,
        latestReceivedAt: recent[0]?.received_at ?? null,
        latestAgeMinutes: recent[0]
          ? Math.max(
              0,
              Math.round((Date.now() - new Date(recent[0].recorded_at).getTime()) / 60_000),
            )
          : null,
        points: recent
          .slice()
          .reverse()
          .map((p) => ({ lat: Number(p.latitude), lon: Number(p.longitude) })),
      };
    }),
  );
}
