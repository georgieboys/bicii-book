import "server-only";

import { unwrap } from "@/lib/db-errors";
import { customerLabel } from "@/lib/people";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Departures for staff (DATA-MODEL §20 "Departures", D193-D195). Reads go
 * through RLS (any active staff member; the manifest's contact details are
 * the customer records staff already see). Changes are RPCs that need
 * manage_adventures and check places and versions themselves.
 */

type Rows<T> = { data: T[] | null; error: Parameters<typeof unwrap>[0]["error"] };

function rows<T>(result: Rows<T>): T[] {
  return unwrap(result) ?? [];
}

function one<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return (value as T) ?? null;
}

export type DepartureKind = "self_supported_group" | "supported";
export type DepartureStatus = "scheduled" | "cancelled" | "completed";

export type Departure = {
  id: string;
  adventureId: string;
  routeName: string;
  kind: DepartureKind;
  startsAt: string;
  expectedFinishAt: string | null;
  meetingPoint: string;
  capacity: number;
  taken: number;
  status: DepartureStatus;
  note: string;
  staffNote: string;
  cancelReason: string | null;
  version: number;
};

export type ManifestRider = {
  checkedInAt: string | null;
  bookingId: string;
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  showName: boolean;
  joinedAt: string;
};

type DepartureRow = {
  id: string;
  adventure_id: string;
  kind: DepartureKind;
  starts_at: string;
  expected_finish_at: string | null;
  meeting_point: string;
  capacity: number;
  status: DepartureStatus;
  note: string;
  staff_note: string;
  cancel_reason: string | null;
  version: number;
  adventure: unknown;
  participants: unknown;
};

const COLUMNS =
  "id, adventure_id, kind, starts_at, expected_finish_at, meeting_point, capacity, status, note, staff_note, cancel_reason, version, adventure:adventure_id (slug, revision:current_revision_id (name)), participants:adventure_departure_participants (left_at)";

function fromRow(d: DepartureRow): Departure {
  const adventure = one<{ slug: string; revision: unknown }>(d.adventure);
  const parts = (Array.isArray(d.participants) ? d.participants : []) as Array<{
    left_at: string | null;
  }>;
  return {
    id: d.id,
    adventureId: d.adventure_id,
    routeName:
      one<{ name: string }>(adventure?.revision)?.name ?? adventure?.slug ?? "Unknown route",
    kind: d.kind,
    startsAt: d.starts_at,
    expectedFinishAt: d.expected_finish_at,
    meetingPoint: d.meeting_point,
    capacity: d.capacity,
    taken: parts.filter((p) => p.left_at === null).length,
    status: d.status,
    note: d.note,
    staffNote: d.staff_note,
    cancelReason: d.cancel_reason,
    version: d.version,
  };
}

/** Upcoming scheduled departures, soonest first, and the latest others. */
export async function listDepartures(
  supabase: ServerSupabase,
): Promise<{ upcoming: Departure[]; past: Departure[] }> {
  const [upcoming, past] = await Promise.all([
    supabase
      .from("adventure_departures")
      .select(COLUMNS)
      .eq("status", "scheduled")
      .gte("starts_at", new Date(Date.now() - 86_400_000).toISOString())
      .order("starts_at")
      .limit(100) as unknown as Promise<Rows<DepartureRow>>,
    supabase
      .from("adventure_departures")
      .select(COLUMNS)
      .or(`status.neq.scheduled,starts_at.lt.${new Date(Date.now() - 86_400_000).toISOString()}`)
      .order("starts_at", { ascending: false })
      .limit(30) as unknown as Promise<Rows<DepartureRow>>,
  ]);
  return { upcoming: rows(upcoming).map(fromRow), past: rows(past).map(fromRow) };
}

export async function getDeparture(
  supabase: ServerSupabase,
  id: string,
): Promise<{ departure: Departure; riders: ManifestRider[] } | null> {
  const d = unwrap(
    (await supabase
      .from("adventure_departures")
      .select(COLUMNS)
      .eq("id", id)
      .maybeSingle()) as unknown as {
      data: DepartureRow | null;
      error: Parameters<typeof unwrap>[0]["error"];
    },
  );
  if (!d) return null;
  const riders = rows(
    (await supabase
      .from("adventure_departure_participants")
      .select(
        "booking_id, show_name, joined_at, checked_in_at, booking:booking_id (reference, customer:customer_id (display_name, first_name, last_name, email, phone))",
      )
      .eq("departure_id", id)
      .is("left_at", null)
      .is("hold_until", null)
      .order("joined_at")) as unknown as Rows<{
      booking_id: string;
      show_name: boolean;
      joined_at: string;
      checked_in_at: string | null;
      booking: unknown;
    }>,
  );
  return {
    departure: fromRow(d),
    riders: riders.map((r) => {
      const booking = one<{ reference: string; customer: unknown }>(r.booking);
      const c = one<{
        display_name: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
      }>(booking?.customer);
      return {
        bookingId: r.booking_id,
        reference: booking?.reference ?? "",
        name: c
          ? customerLabel({
              displayName: c.display_name,
              firstName: c.first_name,
              lastName: c.last_name,
              email: c.email,
            })
          : "Unknown rider",
        email: c?.email ?? null,
        phone: c?.phone ?? null,
        showName: r.show_name,
        joinedAt: r.joined_at,
        checkedInAt: r.checked_in_at,
      };
    }),
  };
}

/** Published routes that can take a date of this kind (have the matching offer). */
export async function listDepartureRoutes(
  supabase: ServerSupabase,
): Promise<Array<{ id: string; name: string }>> {
  const data = rows(
    (await supabase
      .from("adventures")
      .select(
        "id, slug, status, revision:current_revision_id (name, offers:adventure_offers (kind))",
      )
      .eq("status", "published")
      .order("sort_order")) as unknown as Rows<{ id: string; slug: string; revision: unknown }>,
  );
  return data
    .map((a) => {
      const rev = one<{ name: string; offers: unknown }>(a.revision);
      const kinds = ((rev?.offers as Array<{ kind: string }> | null) ?? []).map((o) => o.kind);
      return { id: a.id, name: rev?.name ?? a.slug, kinds };
    })
    .filter((a) => a.kinds.includes("self_supported") || a.kinds.includes("supported"))
    .map(({ id, name }) => ({ id, name }));
}

export async function createDeparture(
  supabase: ServerSupabase,
  input: {
    adventureId: string;
    kind: DepartureKind;
    startsAt: string;
    expectedFinishAt: string | null;
    meetingPoint: string;
    capacity: number;
    note: string;
    staffNote: string;
  },
): Promise<{ id: string }> {
  const row = unwrap(
    await supabase.rpc("create_adventure_departure", {
      adventure_id: input.adventureId,
      kind: input.kind,
      starts_at: input.startsAt,
      expected_finish_at: input.expectedFinishAt as unknown as string,
      meeting_point: input.meetingPoint,
      capacity: input.capacity,
      note: input.note,
      staff_note: input.staffNote,
    }),
  );
  return { id: (row as { id: string }).id };
}

export async function updateDeparture(
  supabase: ServerSupabase,
  input: {
    departureId: string;
    expectedVersion: number;
    startsAt: string;
    expectedFinishAt: string | null;
    meetingPoint: string;
    capacity: number;
    note: string;
    staffNote: string;
  },
): Promise<void> {
  unwrap(
    await supabase.rpc("update_adventure_departure", {
      departure_id: input.departureId,
      expected_version: input.expectedVersion,
      starts_at: input.startsAt,
      expected_finish_at: input.expectedFinishAt as unknown as string,
      meeting_point: input.meetingPoint,
      capacity: input.capacity,
      note: input.note,
      staff_note: input.staffNote,
    }),
  );
}

export async function cancelDeparture(
  supabase: ServerSupabase,
  departureId: string,
  reason: string,
): Promise<void> {
  unwrap(await supabase.rpc("cancel_adventure_departure", { departure_id: departureId, reason }));
}

// ------------------------------------------------- Phase E: staff, notes ----
// D199: who works a departure, and what facilitators recorded.

export type DepartureStaff = { staffId: string; name: string; role: "lead" | "facilitator" };
export type DepartureObservation = {
  id: string;
  kind: "attendance" | "deviation" | "withdrawal" | "completion" | "note";
  body: string;
  staffName: string | null;
  bookingId: string | null;
  createdAt: string;
};

export async function getDepartureWork(
  supabase: ServerSupabase,
  departureId: string,
): Promise<{
  staff: DepartureStaff[];
  observations: DepartureObservation[];
  activeStaff: Array<{ id: string; name: string }>;
}> {
  const [staff, observations, active] = await Promise.all([
    supabase
      .from("adventure_departure_staff")
      .select("staff_id, role, staff:staff_id (display_name)")
      .eq("departure_id", departureId)
      .order("assigned_at") as unknown as Promise<
      Rows<{ staff_id: string; role: "lead" | "facilitator"; staff: unknown }>
    >,
    supabase
      .from("adventure_departure_observations")
      .select("id, kind, body, booking_id, created_at, staff:staff_id (display_name)")
      .eq("departure_id", departureId)
      .order("created_at", { ascending: false })
      .limit(200) as unknown as Promise<
      Rows<{
        id: string;
        kind: DepartureObservation["kind"];
        body: string;
        booking_id: string | null;
        created_at: string;
        staff: unknown;
      }>
    >,
    supabase.from("staff").select("id, display_name").eq("active", true).order("display_name"),
  ]);
  return {
    staff: rows(staff).map((x) => ({
      staffId: x.staff_id,
      role: x.role,
      name: one<{ display_name: string }>(x.staff)?.display_name ?? "Staff",
    })),
    observations: rows(observations).map((o) => ({
      id: o.id,
      kind: o.kind,
      body: o.body,
      bookingId: o.booking_id,
      createdAt: o.created_at,
      staffName: one<{ display_name: string }>(o.staff)?.display_name ?? null,
    })),
    activeStaff: rows(active).map((a) => ({ id: a.id, name: a.display_name })),
  };
}

export async function assignDepartureStaff(
  supabase: ServerSupabase,
  departureId: string,
  staffId: string,
  role: "lead" | "facilitator",
): Promise<void> {
  unwrap(
    await supabase.rpc("assign_departure_staff", {
      departure_id: departureId,
      staff_id: staffId,
      role,
    }),
  );
}

export async function removeDepartureStaff(
  supabase: ServerSupabase,
  departureId: string,
  staffId: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("remove_departure_staff", { departure_id: departureId, staff_id: staffId }),
  );
}

export async function checkInRider(
  supabase: ServerSupabase,
  departureId: string,
  bookingId: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("check_in_departure_rider", {
      departure_id: departureId,
      booking_id: bookingId,
    }),
  );
}

export async function recordObservation(
  supabase: ServerSupabase,
  departureId: string,
  bookingId: string | null,
  kind: DepartureObservation["kind"],
  body: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("record_departure_observation", {
      departure_id: departureId,
      booking_id: bookingId as unknown as string,
      kind,
      body,
    }),
  );
}

// ---------------------------------------------------- Phase F: moving ----
// D202: a booking's current date, and the other dates it could move to.

export async function getBookingDate(
  supabase: ServerSupabase,
  bookingId: string,
): Promise<{ departure: Departure; others: Departure[] } | null> {
  const current = rows(
    (await supabase
      .from("adventure_departure_participants")
      .select("departure_id")
      .eq("booking_id", bookingId)
      .is("left_at", null)
      .is("hold_until", null)
      .limit(1)) as unknown as Rows<{ departure_id: string }>,
  )[0];
  if (!current) return null;
  const d = unwrap(
    (await supabase
      .from("adventure_departures")
      .select(COLUMNS)
      .eq("id", current.departure_id)
      .maybeSingle()) as unknown as {
      data: DepartureRow | null;
      error: Parameters<typeof unwrap>[0]["error"];
    },
  );
  if (!d) return null;
  const departure = fromRow(d);
  const others = rows(
    (await supabase
      .from("adventure_departures")
      .select(COLUMNS)
      .eq("adventure_id", departure.adventureId)
      .eq("kind", departure.kind)
      .eq("status", "scheduled")
      .neq("id", departure.id)
      .gt("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(50)) as unknown as Rows<DepartureRow>,
  ).map(fromRow);
  return { departure, others };
}

export async function moveSeat(
  supabase: ServerSupabase,
  bookingId: string,
  departureId: string,
  reason: string,
): Promise<void> {
  unwrap(
    await supabase.rpc("move_adventure_seat", {
      booking_id: bookingId,
      departure_id: departureId,
      reason,
    }),
  );
}
