/**
 * The actions the appointment screens offer, against the status machine the
 * database tests drive (tests/fixtures/appointment-transitions.ts; PLAN
 * D36, D37, D39, D40): every status, the no-show timing, and reinstatement
 * on the appointment's own shop day versus a later one.
 */
import { describe, expect, it } from "vitest";

import { describeAppointmentEvent } from "@/lib/appointments/history";
import {
  APPOINTMENT_SOURCE_LABELS,
  APPOINTMENT_STATUS_LABELS,
  appointmentTone,
  availableActions,
  cancelHint,
  isLate,
  primaryAction,
} from "@/lib/appointments/status";

import {
  APPOINTMENT_STATUSES,
  CANCEL,
  CHECK_IN,
  MARK_STATUS,
} from "../fixtures/appointment-transitions";

// 10:00 Singapore on Tuesday 4 March 2031.
const STARTS = "2031-03-04T10:00:00+08:00";
const BEFORE = new Date("2031-03-04T09:00:00+08:00");
const AFTER = new Date("2031-03-04T10:20:00+08:00");
const NEXT_DAY = new Date("2031-03-05T09:00:00+08:00");
const LATE_EVENING = new Date("2031-03-04T23:59:00+08:00");

describe("availableActions mirrors the database's status machine", () => {
  for (const status of APPOINTMENT_STATUSES) {
    it(`${status}: once started, on its own day`, () => {
      const a = availableActions(status, STARTS, AFTER);
      expect(a.confirm).toBe(MARK_STATUS[status].confirmed === "ok");
      // arrive covers the expected statuses; reinstate is no_show -> arrived.
      expect(a.arrive || a.reinstate).toBe(MARK_STATUS[status].arrived === "ok");
      expect(a.reinstate).toBe(status === "no_show" && MARK_STATUS[status].arrived === "ok");
      expect(a.noShow).toBe(MARK_STATUS[status].no_show === "ok");
      expect(a.cancel).toBe(CANCEL[status] === "ok");
      expect(a.checkIn).toBe(CHECK_IN[status] === "ok");
    });
  }

  it("never offers completed by hand (it follows the job, D36)", () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(Object.keys(availableActions(status, STARTS, AFTER))).not.toContain("complete");
    }
  });

  it("offers no-show only once the appointment has started (D39)", () => {
    expect(availableActions("booked", STARTS, BEFORE).noShow).toBe(false);
    expect(availableActions("confirmed", STARTS, BEFORE).noShow).toBe(false);
    expect(availableActions("booked", STARTS, new Date(STARTS)).noShow).toBe(true);
    expect(availableActions("confirmed", STARTS, AFTER).noShow).toBe(true);
  });

  it("reinstates a no-show only on the appointment's own shop day (D39)", () => {
    expect(availableActions("no_show", STARTS, AFTER).reinstate).toBe(true);
    expect(availableActions("no_show", STARTS, LATE_EVENING).reinstate).toBe(true);
    expect(availableActions("no_show", STARTS, NEXT_DAY).reinstate).toBe(false);
  });

  it("reads the shop day in Singapore, not UTC", () => {
    // 00:30 Singapore on the 5th is still the 4th in UTC.
    const early = "2031-03-05T00:30:00+08:00";
    expect(
      availableActions("no_show", early, new Date("2031-03-05T01:00:00+08:00")).reinstate,
    ).toBe(true);
    expect(
      availableActions("no_show", early, new Date("2031-03-04T23:00:00+08:00")).reinstate,
    ).toBe(false);
  });

  it("lets staff cancel at any time, even after the start (no cutoff for staff, D37)", () => {
    expect(availableActions("booked", STARTS, NEXT_DAY).cancel).toBe(true);
    expect(availableActions("arrived", STARTS, NEXT_DAY).cancel).toBe(true);
  });
});

describe("primaryAction", () => {
  it("is Arrived, then Check in, or Reinstate on the day", () => {
    const p = (s: Parameters<typeof availableActions>[0], now = AFTER) =>
      primaryAction(s, availableActions(s, STARTS, now));
    expect(p("booked")).toBe("arrive");
    expect(p("confirmed")).toBe("arrive");
    expect(p("arrived")).toBe("checkIn");
    expect(p("no_show")).toBe("reinstate");
    expect(p("no_show", NEXT_DAY)).toBeNull();
    expect(p("checked_in")).toBeNull();
    expect(p("completed")).toBeNull();
    expect(p("cancelled")).toBeNull();
  });
});

describe("labels and tones", () => {
  it("names every status and source", () => {
    expect(APPOINTMENT_STATUS_LABELS).toEqual({
      booked: "Booked",
      confirmed: "Confirmed",
      arrived: "Arrived",
      checked_in: "Checked in",
      completed: "Completed",
      cancelled: "Cancelled",
      no_show: "No-show",
    });
    expect(APPOINTMENT_SOURCE_LABELS).toEqual({
      customer: "Booked online",
      staff: "Booked by staff",
    });
  });

  it("gives each status its tone", () => {
    expect(APPOINTMENT_STATUSES.map(appointmentTone)).toEqual([
      "info",
      "progress",
      "waiting",
      "done",
      "done",
      "neutral",
      "danger",
    ]);
  });

  it("calls a booked or confirmed appointment late 15 minutes after its start", () => {
    expect(
      isLate({ status: "booked", startsAt: STARTS }, new Date("2031-03-04T10:15:00+08:00")),
    ).toBe(false);
    expect(
      isLate({ status: "booked", startsAt: STARTS }, new Date("2031-03-04T10:16:00+08:00")),
    ).toBe(true);
    expect(isLate({ status: "confirmed", startsAt: STARTS }, AFTER)).toBe(true);
    expect(isLate({ status: "arrived", startsAt: STARTS }, AFTER)).toBe(false);
    expect(isLate({ status: "no_show", startsAt: STARTS }, AFTER)).toBe(false);
  });
});

describe("describeAppointmentEvent", () => {
  it("says who acted, in plain language", () => {
    const d = (type: Parameters<typeof describeAppointmentEvent>[0]["type"], extra = {}) =>
      describeAppointmentEvent({
        type,
        fromStatus: null,
        payload: {},
        actorName: "Marcus Tan",
        ...extra,
      }).title;
    expect(d("booked", { payload: { source: "staff" } })).toBe("Booked by Marcus Tan");
    expect(d("booked", { payload: { source: "customer" }, actorName: null })).toBe(
      "Booked online by the customer",
    );
    expect(d("arrived", { fromStatus: "booked" })).toBe("Marked as arrived by Marcus Tan");
    expect(d("arrived", { fromStatus: "no_show" })).toBe("Reinstated as arrived by Marcus Tan");
    expect(d("no_show")).toBe("Marked as a no-show by Marcus Tan");
    expect(d("cancelled", { payload: { via: "staff" } })).toBe("Cancelled by Marcus Tan");
    expect(d("cancelled", { payload: { via: "customer" }, actorName: null })).toBe(
      "Cancelled online by the customer",
    );
    expect(d("work_order_linked", { payload: { job_number: "J-000123", created: true } })).toBe(
      "Job J-000123 opened",
    );
    expect(d("work_order_linked", { payload: { job_number: "J-000123", created: false } })).toBe(
      "Linked to job J-000123",
    );
    expect(d("details_changed", { payload: { bike_id: {}, internal_note: {} } })).toBe(
      "Bike and internal note changed by Marcus Tan",
    );
  });

  it("quotes the cancellation reason", () => {
    expect(
      describeAppointmentEvent(
        { type: "cancelled", fromStatus: "booked", payload: { via: "customer" }, actorName: null },
        "Away that week",
      ),
    ).toMatchObject({ title: "Cancelled online by the customer", detail: "Away that week" });
  });
});

describe("cancelHint", () => {
  it("says an online booking emails the customer, without the reason", () => {
    expect(cancelHint("customer")).toContain("The customer is emailed");
    expect(cancelHint("customer")).toContain("your reason isn't in it");
  });
  it("says a staff booking tells the customer nothing", () => {
    expect(cancelHint("staff")).toContain("The customer is not told automatically.");
  });
});
