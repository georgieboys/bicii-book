/**
 * How a job's timeline reads (SPEC §7.3; DATA-MODEL §4 "Timeline"): one
 * sentence per work_order_events row, from its type and payload. Pure, so
 * the job page and tests share it. Payloads never carry costs, yield or
 * Cult Commons (the database guarantees it), so nothing here can show one.
 * They may carry customer prices and, from Phase 14, customer payments
 * (amounts Stripe confirmed or refunded), which are not costs.
 */
import { formatAppointmentMoment } from "@/lib/appointments/format";
import type { Database } from "@/lib/database.types";
import { DEFAULT_CURRENCY, formatMoney, formatQuantity } from "@/lib/money";
import { isUuid } from "@/lib/uuid";
import {
  STATUS_LABELS,
  WORK_ORDER_STATUSES,
  statusTone,
  type StatusTone,
  type WorkOrderStatus,
} from "@/lib/workshop";

export type WorkOrderEventType = Database["public"]["Enums"]["work_order_event_type"];

export type TimelineEvent = {
  type: WorkOrderEventType;
  payload: unknown;
  /** The staff member an assignment event is about (work_order_timeline's subject name). */
  subjectName?: string | null;
  /**
   * The description of the line a stock event is about (its payload's
   * line_id; the job's own lines), since stock payloads carry short IDs,
   * not names.
   */
  lineDescription?: string | null;
};

export type EventDescription = {
  title: string;
  /** A note, reason or the text that changed; shown quoted under the title. */
  detail: string | null;
  tone: StatusTone;
  /** Where the title links (the appointment a job was opened from). */
  href?: string;
};

type Payload = Record<string, unknown>;

const asPayload = (value: unknown): Payload =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Payload) : {};

const text = (p: Payload, key: string): string | null => {
  const v = p[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
};

const amount = (p: Payload, key: string): string | number | null => {
  const v = p[key];
  return typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()))
    ? v
    : null;
};

const status = (p: Payload, key: string): WorkOrderStatus | null => {
  const v = p[key];
  return typeof v === "string" && (WORK_ORDER_STATUSES as readonly string[]).includes(v)
    ? (v as WorkOrderStatus)
    : null;
};

const DETAIL_FIELDS: Record<string, string> = {
  requested_work: "Requested work",
  intake_notes: "Condition on arrival",
  internal_notes: "Internal notes",
  completion_notes: "Completion notes",
};

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Full Service × 2 · $70.00" (the quantity only when it is not 1). */
function lineSummary(p: Payload, currency: string): string {
  const description = text(p, "description") ?? "A line";
  const quantity = amount(p, "quantity");
  const total = amount(p, "sale_total");
  const lineCurrency = text(p, "currency") ?? currency;
  const qty =
    quantity !== null && formatQuantity(quantity) !== "1" ? ` × ${formatQuantity(quantity)}` : "";
  const money = total !== null ? ` · ${formatMoney(total, lineCurrency)}` : "";
  return `${description}${qty}${money}`;
}

/**
 * "2 × Road inner tube (P-000003)" for a counted part; a unique unit's
 * line description already names its U- number, so it stands alone. The
 * payload's short IDs stand in when the line's description is unknown.
 */
function partSummary(p: Payload, lineDescription: string | null | undefined): string {
  const unit = text(p, "unit_short_id");
  const shortId = unit ?? text(p, "product_short_id");
  const name = lineDescription?.trim() || null;
  const quantity = amount(p, "quantity");
  const label = name
    ? shortId && !name.includes(shortId)
      ? `${name} (${shortId})`
      : name
    : (shortId ?? "a part");
  return unit || quantity === null ? label : `${formatQuantity(quantity)} × ${label}`;
}

/**
 * The title, detail and tone for one timeline event. `currency` is the
 * job's, for amounts whose payload does not name one (a void).
 */
export function describeEvent(
  event: TimelineEvent,
  { currency = DEFAULT_CURRENCY }: { currency?: string } = {},
): EventDescription {
  const p = asPayload(event.payload);
  const note = text(p, "note");
  switch (event.type) {
    case "checked_in":
      return {
        title: `Checked in as ${text(p, "job_number") ?? "a new job"}`,
        detail: text(p, "requested_work"),
        tone: "info",
      };
    case "status_changed": {
      if (p.started === true) return { title: "Work started", detail: note, tone: "progress" };
      const from = status(p, "from");
      const to = status(p, "to");
      return {
        title:
          from && to
            ? `Status: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`
            : to
              ? `Status: ${STATUS_LABELS[to]}`
              : "Status changed",
        detail: note,
        tone: to ? statusTone(to) : "neutral",
      };
    }
    case "completed":
      return { title: "Completed", detail: note, tone: "done" };
    case "ready_for_collection":
      return { title: "Ready for collection", detail: note, tone: "done" };
    case "collected":
      return { title: "Collected", detail: note, tone: "neutral" };
    case "cancelled":
      return { title: "Cancelled", detail: note, tone: "danger" };
    case "reopened":
      return { title: "Reopened", detail: note, tone: "waiting" };
    case "assignment_changed": {
      const name = event.subjectName ?? "A former colleague";
      const title =
        p.action === "unassigned"
          ? `${name} removed from the job`
          : p.role === "lead"
            ? `${name} assigned as lead`
            : `${name} added to the job`;
      return { title, detail: null, tone: "neutral" };
    }
    case "note_added":
      return { title: "Note", detail: text(p, "body"), tone: "neutral" };
    case "diagnosis_added":
      return { title: "Diagnosis", detail: text(p, "body"), tone: "info" };
    case "details_changed": {
      const fields = Object.keys(p).filter((k) => k in DETAIL_FIELDS);
      if (fields.length === 0) return { title: "Details updated", detail: null, tone: "neutral" };
      const words = fields.map((f, i) =>
        i === 0 ? DETAIL_FIELDS[f] : DETAIL_FIELDS[f].toLowerCase(),
      );
      const only = fields.length === 1 ? asPayload(p[fields[0]]) : null;
      return {
        title: `${joinWords(words)} updated`,
        detail: only ? text(only, "to") : null,
        tone: "neutral",
      };
    }
    case "approval_flagged":
      return {
        title: p.flagged === true ? "Marked customer-approved" : "Approval flag cleared",
        detail: note,
        tone: p.flagged === true ? "done" : "neutral",
      };
    case "photo_added":
      return {
        title: "Photo added",
        detail: p.visibility === "customer" ? "Visible to the customer" : null,
        tone: "neutral",
      };
    case "photo_removed":
      return { title: "Photo deleted", detail: text(p, "reason"), tone: "neutral" };
    case "line_added":
      return { title: `Added ${lineSummary(p, currency)}`, detail: null, tone: "neutral" };
    case "line_voided":
      return {
        title: `Voided ${lineSummary(p, currency)}`,
        detail: text(p, "reason"),
        tone: "danger",
      };
    case "stock_consumed": {
      const where = text(p, "location_name");
      return {
        title: `Used ${partSummary(p, event.lineDescription)}${where ? ` from ${where}` : ""}`,
        detail: null,
        tone: "neutral",
      };
    }
    case "stock_reversed": {
      const where = text(p, "location_name");
      return {
        title: `Returned ${partSummary(p, event.lineDescription)}${where ? ` to ${where}` : ""}`,
        detail: null,
        tone: "info",
      };
    }
    case "appointment_linked": {
      // Phase 2 (D40): written when check-in creates (created: true) or
      // links the job. Payload {appointment_id, starts_at,
      // appointment_type_name, created}; staff only, never a cost.
      const opened = p.created === true;
      const appointmentId = text(p, "appointment_id");
      const startsAt = text(p, "starts_at");
      const when = startsAt && !Number.isNaN(Date.parse(startsAt)) ? startsAt : null;
      const typeName = text(p, "appointment_type_name");
      const title = when
        ? `${opened ? "Opened from" : "Linked to"} the appointment on ${formatAppointmentMoment(when)}${typeName ? ` (${typeName})` : ""}`
        : opened
          ? "Opened from an appointment"
          : "Linked to an appointment";
      return {
        title,
        detail: null,
        tone: "info",
        ...(isUuid(appointmentId) ? { href: `/appointments/${appointmentId}` } : {}),
      };
    }
    // Phase 13 (D140-D146): indent parts and quotes. Payloads carry names,
    // quantities, counts and purchase order numbers, never a price or cost;
    // from Phase 14, part_ordered may carry deposit_override (the staff
    // reason for ordering before the deposit was paid, D152).
    case "part_requested": {
      const what = text(p, "description") ?? (p.kind === "service" ? "a service" : "a part");
      const qty = amount(p, "quantity");
      return {
        title: `Proposed ${qty !== null && Number(qty) !== 1 ? `${formatQuantity(qty)} × ` : ""}${what}`,
        detail: null,
        tone: "neutral",
      };
    }
    case "part_request_cancelled":
      return {
        title: `Cancelled the proposed ${text(p, "description") ?? "item"}`,
        detail: text(p, "reason"),
        tone: "neutral",
      };
    case "quote_sent": {
      const items = amount(p, "items");
      const channel =
        p.channel === "whatsapp" ? " by WhatsApp" : p.channel === "email" ? " by email" : "";
      return {
        title: `Quote sent${channel}${items !== null ? ` (${items} ${Number(items) === 1 ? "item" : "items"})` : ""}`,
        detail: null,
        tone: "info",
      };
    }
    case "quote_withdrawn":
      return { title: "Quote withdrawn", detail: null, tone: "neutral" };
    case "quote_answered": {
      const approved = Number(amount(p, "approved") ?? 0);
      const declined = Number(amount(p, "declined") ?? 0);
      const name = text(p, "name");
      return {
        title: `Quote answered${name ? ` by ${name}` : ""}: ${approved} approved, ${declined} declined`,
        detail: null,
        tone: approved > 0 ? "done" : "waiting",
      };
    }
    case "part_ordered": {
      const po = text(p, "purchase_order");
      // D152: ordered before the deposit was paid, by an admin or manager with a reason.
      const override = asPayload(p.deposit_override);
      const reason = text(override, "reason");
      return {
        title: `Parts ordered${po ? ` on ${po}` : ""}`,
        detail: reason ? `Ordered before the deposit was paid: ${reason}` : null,
        tone: reason ? "waiting" : "info",
      };
    }
    case "part_fitted":
      return {
        title: `Fitted ${text(p, "description") ?? "the proposed item"}`,
        detail: null,
        tone: "done",
      };
    // Phase 14 (D153, D155, D159): customer payments, from Stripe's word
    // only. Payloads carry customer amounts (money held, not revenue,
    // D154), never a cost; amounts are formatted here, never computed.
    case "payment_received": {
      const what = p.kind === "deposit" ? "Deposit" : "Payment";
      const paidCurrency = text(p, "currency") ?? currency;
      const received = amount(p, "amount");
      const asked = amount(p, "asked");
      const receivedText = received !== null ? formatMoney(received, paidCurrency) : null;
      const askedText = asked !== null ? formatMoney(asked, paidCurrency) : null;
      return {
        title: receivedText ? `${what} of ${receivedText} paid online` : `${what} paid online`,
        detail:
          askedText && receivedText !== askedText
            ? `Stripe's amount differs from the ${askedText} asked`
            : null,
        tone: "done",
      };
    }
    case "payment_refunded": {
      const refundCurrency = text(p, "currency") ?? currency;
      const refunded = amount(p, "refunded");
      const total = amount(p, "refunded_total");
      return {
        title:
          refunded !== null
            ? `${formatMoney(refunded, refundCurrency)} refunded in Stripe`
            : "Refunded in Stripe",
        detail:
          p.full === true
            ? "The whole payment is refunded"
            : total !== null
              ? `${formatMoney(total, refundCurrency)} refunded in total`
              : null,
        tone: "info",
      };
    }
    case "payment_refund_failed": {
      const refundCurrency = text(p, "currency") ?? currency;
      const failed = amount(p, "amount");
      const total = amount(p, "refunded_total");
      return {
        title:
          failed !== null
            ? `A refund of ${formatMoney(failed, refundCurrency)} failed in Stripe`
            : "A refund failed in Stripe",
        detail: total !== null ? `${formatMoney(total, refundCurrency)} refunded in total` : null,
        tone: "danger",
      };
    }
    default: {
      const unknown: never = event.type;
      return { title: String(unknown), detail: null, tone: "neutral" };
    }
  }
}
