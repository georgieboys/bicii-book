import { describe, expect, it } from "vitest";

import { Constants } from "@/lib/database.types";
import { describeEvent, type TimelineEvent } from "@/lib/workshop-timeline";

const d = (event: TimelineEvent, currency?: string) =>
  describeEvent(event, currency ? { currency } : undefined);

describe("describeEvent", () => {
  it("describes every work order event type", () => {
    for (const type of Constants.public.Enums.work_order_event_type) {
      const out = d({ type, payload: {} });
      expect(out.title, type).not.toBe("");
      expect(["info", "waiting", "progress", "done", "danger", "neutral"]).toContain(out.tone);
    }
  });

  it("check-in names the job number and quotes the requested work", () => {
    expect(
      d({
        type: "checked_in",
        payload: { job_number: "J-000010", requested_work: "Full service", customer_id: "x" },
      }),
    ).toEqual({ title: "Checked in as J-000010", detail: "Full service", tone: "info" });
  });

  it("status changes: work started, a plain move with its note", () => {
    expect(
      d({
        type: "status_changed",
        payload: { from: "received", to: "in_progress", started: true },
      }),
    ).toEqual({ title: "Work started", detail: null, tone: "progress" });
    expect(
      d({
        type: "status_changed",
        payload: { from: "in_progress", to: "awaiting_parts", note: "Chain on order" },
      }),
    ).toEqual({
      title: "Status: In progress → Waiting on parts",
      detail: "Chain on order",
      tone: "waiting",
    });
    expect(d({ type: "status_changed", payload: { to: "nonsense" } }).title).toBe("Status changed");
  });

  it("completion, collection, cancellation and reopening, with notes and reasons", () => {
    expect(d({ type: "completed", payload: { from: "in_progress", to: "completed" } })).toEqual({
      title: "Completed",
      detail: null,
      tone: "done",
    });
    expect(d({ type: "ready_for_collection", payload: {} }).title).toBe("Ready for collection");
    expect(d({ type: "collected", payload: { note: "Paid by card" } })).toEqual({
      title: "Collected",
      detail: "Paid by card",
      tone: "neutral",
    });
    expect(d({ type: "cancelled", payload: { note: "Customer changed mind" } })).toEqual({
      title: "Cancelled",
      detail: "Customer changed mind",
      tone: "danger",
    });
    expect(d({ type: "reopened", payload: { note: "Brake rub" } })).toEqual({
      title: "Reopened",
      detail: "Brake rub",
      tone: "waiting",
    });
  });

  it("assignments name the staff member", () => {
    const a = (payload: object, subjectName?: string | null) =>
      d({ type: "assignment_changed", payload, subjectName }).title;
    expect(a({ action: "assigned", role: "lead" }, "Marcus Tan")).toBe(
      "Marcus Tan assigned as lead",
    );
    expect(a({ action: "assigned", role: "additional" }, "Nur Aisyah")).toBe(
      "Nur Aisyah added to the job",
    );
    expect(a({ action: "unassigned", role: "lead" }, "Marcus Tan")).toBe(
      "Marcus Tan removed from the job",
    );
    expect(a({ action: "assigned", role: "lead" }, null)).toBe(
      "A former colleague assigned as lead",
    );
  });

  it("notes and diagnoses quote their body", () => {
    expect(d({ type: "note_added", payload: { body: "Called customer" } })).toEqual({
      title: "Note",
      detail: "Called customer",
      tone: "neutral",
    });
    expect(d({ type: "diagnosis_added", payload: { body: "Worn chain" } }).title).toBe("Diagnosis");
  });

  it("details changes name the fields and quote a single new value", () => {
    expect(
      d({ type: "details_changed", payload: { requested_work: { from: "a", to: "b" } } }),
    ).toEqual({ title: "Requested work updated", detail: "b", tone: "neutral" });
    expect(
      d({
        type: "details_changed",
        payload: {
          intake_notes: { from: null, to: "x" },
          internal_notes: { from: null, to: "y" },
          completion_notes: { from: null, to: "z" },
        },
      }),
    ).toEqual({
      title: "Condition on arrival, internal notes and completion notes updated",
      detail: null,
      tone: "neutral",
    });
  });

  it("the approval flag", () => {
    expect(
      d({ type: "approval_flagged", payload: { flagged: true, note: "OK by phone" } }),
    ).toEqual({ title: "Marked customer-approved", detail: "OK by phone", tone: "done" });
    expect(d({ type: "approval_flagged", payload: { flagged: false, note: null } }).title).toBe(
      "Approval flag cleared",
    );
  });

  it("photos", () => {
    expect(d({ type: "photo_added", payload: { visibility: "internal" } })).toEqual({
      title: "Photo added",
      detail: null,
      tone: "neutral",
    });
    expect(d({ type: "photo_added", payload: { visibility: "customer" } }).detail).toBe(
      "Visible to the customer",
    );
    expect(d({ type: "photo_removed", payload: { reason: "Blurry" } })).toEqual({
      title: "Photo deleted",
      detail: "Blurry",
      tone: "neutral",
    });
  });

  it("lines: what was added or voided, with quantity and sale total only", () => {
    expect(
      d({
        type: "line_added",
        payload: {
          description: "Wheel True",
          quantity: 2,
          unit_sale_price: 35,
          sale_total: 70,
          currency: "SGD",
        },
      }).title,
    ).toBe("Added Wheel True × 2 · $70.00");
    expect(
      d({
        type: "line_added",
        payload: { description: "Full Service", quantity: 1, sale_total: 200 },
      }).title,
    ).toBe("Added Full Service · $200.00");
    expect(
      d({
        type: "line_voided",
        payload: { description: "Valve core", quantity: 1, sale_total: 5, reason: "Not needed" },
      }),
    ).toEqual({ title: "Voided Valve core · $5.00", detail: "Not needed", tone: "danger" });
    expect(
      d(
        { type: "line_added", payload: { description: "Labour", quantity: 1.5, sale_total: 90 } },
        "SGD",
      ).title,
    ).toBe("Added Labour × 1.5 · $90.00");
  });

  it("stock events (Phase 4) say what was used or returned, where, and never a cost", () => {
    const consumed = {
      line_id: "l1",
      movement_id: 7,
      product_id: "p1",
      product_short_id: "P-000003",
      inventory_unit_id: null,
      unit_short_id: null,
      location_id: "loc",
      location_name: "Shop floor",
      quantity: 2,
      on_hand_after: 38,
    };
    const used = d({
      type: "stock_consumed",
      payload: consumed,
      lineDescription: "Road inner tube",
    });
    expect(used.title).toBe("Used 2 × Road inner tube (P-000003) from Shop floor");
    const returned = d({
      type: "stock_reversed",
      payload: { ...consumed, reversal_of_id: 7 },
      lineDescription: "Road inner tube",
    });
    expect(returned.title).toBe("Returned 2 × Road inner tube (P-000003) to Shop floor");
    // A unit's line already names its U- number; no quantity for a unique item.
    expect(
      d({
        type: "stock_consumed",
        payload: { ...consumed, unit_short_id: "U-000002", quantity: 1 },
        lineDescription: "Brompton C Line · U-000002",
      }).title,
    ).toBe("Used Brompton C Line · U-000002 from Shop floor");
    // Without the line, the short ID stands in; an empty payload still reads.
    expect(d({ type: "stock_consumed", payload: consumed }).title).toBe(
      "Used 2 × P-000003 from Shop floor",
    );
    expect(d({ type: "stock_consumed", payload: {} }).title).toBe("Used a part");
    expect(d({ type: "stock_reversed", payload: {} }).title).toBe("Returned a part");
    for (const e of [used, returned]) {
      expect(`${e.title} ${e.detail ?? ""}`).not.toMatch(/\$|cost|yield|cult/i);
    }
  });

  it("D40: a job opened at check-in says so, names the appointment and links to it", () => {
    const appointmentId = "e2000000-0000-4000-8000-000000000003";
    expect(
      d({
        type: "appointment_linked",
        payload: {
          appointment_id: appointmentId,
          starts_at: "2026-10-06T02:00:00Z",
          appointment_type_name: "Service drop-off",
          created: true,
        },
      }),
    ).toEqual({
      title: "Opened from the appointment on Tue 6 Oct 10:00 (Service drop-off)",
      detail: null,
      tone: "info",
      href: `/appointments/${appointmentId}`,
    });
  });

  it("D40: an existing job linked at check-in reads as linked, with the link", () => {
    const appointmentId = "e2000000-0000-4000-8000-000000000007";
    const linked = d({
      type: "appointment_linked",
      payload: {
        appointment_id: appointmentId,
        starts_at: "2026-10-06T07:30:00Z",
        appointment_type_name: "Bike fit",
        created: false,
      },
    });
    expect(linked.title).toBe("Linked to the appointment on Tue 6 Oct 15:30 (Bike fit)");
    expect(linked.href).toBe(`/appointments/${appointmentId}`);
  });

  it("an incomplete appointment payload still reads, without a broken link", () => {
    expect(d({ type: "appointment_linked", payload: {} })).toEqual({
      title: "Linked to an appointment",
      detail: null,
      tone: "info",
    });
    const opened = d({
      type: "appointment_linked",
      payload: { appointment_id: "not-a-uuid", starts_at: "soon", created: true },
    });
    expect(opened.title).toBe("Opened from an appointment");
    expect(opened.href).toBeUndefined();
  });

  it("survives a payload that is not an object", () => {
    expect(d({ type: "line_added", payload: null }).title).toBe("Added A line");
    expect(d({ type: "checked_in", payload: [1, 2] }).title).toBe("Checked in as a new job");
  });

  it("indent parts and quotes (Phase 13) read as one sentence each, with no price", () => {
    expect(
      d({
        type: "part_requested",
        payload: { kind: "part", description: "Shimano chain", quantity: 2 },
      }),
    ).toEqual({ title: "Proposed 2 × Shimano chain", detail: null, tone: "neutral" });
    expect(
      d({
        type: "part_requested",
        payload: { kind: "service", description: "Chain Replacement", quantity: 1 },
      }),
    ).toEqual({ title: "Proposed Chain Replacement", detail: null, tone: "neutral" });
    expect(
      d({ type: "quote_sent", payload: { channel: "whatsapp", items: 2, valid_days: 7 } }),
    ).toEqual({ title: "Quote sent by WhatsApp (2 items)", detail: null, tone: "info" });
    expect(
      d({ type: "quote_answered", payload: { name: "Tan Ah Kow", approved: 1, declined: 1 } }),
    ).toEqual({
      title: "Quote answered by Tan Ah Kow: 1 approved, 1 declined",
      detail: null,
      tone: "done",
    });
    expect(d({ type: "quote_answered", payload: { approved: 0, declined: 2 } }).tone).toBe(
      "waiting",
    );
    expect(
      d({ type: "part_ordered", payload: { purchase_order: "PO-000006", items: [] } }),
    ).toEqual({
      title: "Parts ordered on PO-000006",
      detail: null,
      tone: "info",
    });
    expect(
      d({
        type: "part_request_cancelled",
        payload: { description: "Shimano chain", reason: "Out of stock" },
      }),
    ).toEqual({
      title: "Cancelled the proposed Shimano chain",
      detail: "Out of stock",
      tone: "neutral",
    });
    expect(d({ type: "part_fitted", payload: { description: "Shimano chain" } }).title).toBe(
      "Fitted Shimano chain",
    );
  });
});
