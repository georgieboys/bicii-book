/**
 * Adventure emails (D183-D184, DATA-MODEL §20 "Emails"): the words of each
 * email and the loop that sends them. Pure, so the unit tests read every
 * variant and drive the loop with a fake clock; the integration
 * (src/lib/integrations/adventures/notices.ts) passes the database and
 * Resend.
 *
 *   rider  ticket_paid        "Your BICII 125 ticket (AV-000012)"
 *   rider  changes_requested  "Your BICII 125 ride: we need something more"
 *   rider  certified          "You're certified: BICII 125"
 *   rider  not_certified      "Your BICII 125 ride wasn't certified"
 *   rider  pack_ready         "Your BICII 125 finisher pack is ready"
 *   shop   ride_submitted     "Ride to review: BICII 125, Dana Rider (AV-000012)"
 *   shop   payment_attention  "Payment needs attention: AV-000012"
 *
 * The loop keeps the outbox's rules (RISKS R-100): it claims a few rows at
 * a time, sends one after another, and once its deadline passes it releases
 * the rows it did not get to, which uses no attempt. Each result is
 * recorded with the claim's token.
 */

export type AdventureNoticeKind =
  | "ticket_paid"
  | "changes_requested"
  | "certified"
  | "not_certified"
  | "pack_ready"
  | "ride_submitted"
  | "payment_attention"
  | "departure_joined"
  | "departure_cancelled"
  | "cancellation_requested"
  | "booking_cancelled"
  | "tracker_late_fee"
  | "departure_changed";

export type AdventureNotice = {
  id: string;
  claimToken: string;
  kind: AdventureNoticeKind;
  audience: "shop" | "customer";
  recipient: string;
  bookingId: string;
  reference: string;
  adventureName: string;
  riderName: string;
  riderFirstName: string | null;
  messageToRider: string | null;
  certificateReference: string | null;
  completedOn: string | null;
  acceptedDistanceKm: string | null;
  packItems: string[] | null;
  attentionReason: string | null;
  publicSiteUrl: string | null;
  departureStartsAt: string | null;
  departureMeetingPoint: string | null;
  /** The reason on the event (a cancellation's). */
  eventNote: string | null;
};

export type AdventureNoticeRow = {
  id: string | null;
  claim_token: string | null;
  kind: AdventureNoticeKind | null;
  audience: "shop" | "customer" | null;
  recipient: string | null;
  booking_id: string | null;
  reference: string | null;
  adventure_name: string | null;
  rider_name: string | null;
  rider_first_name: string | null;
  message_to_rider: string | null;
  certificate_reference: string | null;
  completed_on: string | null;
  accepted_distance_km: number | string | null;
  pack_items: string[] | null;
  attention_reason: string | null;
  public_site_url: string | null;
  departure_starts_at?: string | null;
  departure_meeting_point?: string | null;
  event_note?: string | null;
};

export function adventureNoticeFromRow(row: AdventureNoticeRow): AdventureNotice {
  return {
    id: row.id ?? "",
    claimToken: row.claim_token ?? "",
    kind: row.kind ?? "ticket_paid",
    audience: row.audience ?? "customer",
    recipient: row.recipient ?? "",
    bookingId: row.booking_id ?? "",
    reference: row.reference ?? "",
    adventureName: row.adventure_name ?? "your BICII ride",
    riderName: row.rider_name ?? "A rider",
    riderFirstName: row.rider_first_name,
    messageToRider: row.message_to_rider,
    certificateReference: row.certificate_reference,
    completedOn: row.completed_on,
    acceptedDistanceKm: row.accepted_distance_km === null ? null : String(row.accepted_distance_km),
    packItems: row.pack_items,
    attentionReason: row.attention_reason,
    publicSiteUrl: row.public_site_url,
    departureStartsAt: row.departure_starts_at ?? null,
    departureMeetingPoint: row.departure_meeting_point ?? null,
    eventNote: row.event_note ?? null,
  };
}

export type NoticeEmail = { subject: string; text: string; html: string };

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const button = (href: string, label: string) =>
  `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`;

function page(base: string | null, path: string): string | null {
  const root = base?.trim().replace(/\/+$/, "");
  return root ? `${root}${path}` : null;
}

/** "15 Nov 2026" for a YYYY-MM-DD day (read at noon in Singapore). */
function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  }).format(new Date(`${day}T12:00:00+08:00`));
}

/** "Sat 21 Nov 2026, 7:00 am" in Singapore. */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Singapore",
  })
    .format(at)
    .replace(",", "");
  const time = new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Singapore",
  }).format(at);
  return `${day}, ${time}`;
}

/** Paragraphs to text and HTML; a link becomes a button in HTML and a line in text. */
function compose(
  subject: string,
  paragraphs: Array<string | null>,
  link: { href: string | null; label: string } | null,
): NoticeEmail {
  const kept = paragraphs.filter((p): p is string => p !== null && p.trim() !== "");
  const text = [...kept, ...(link?.href ? [`${link.label}: ${link.href}`] : [])].join("\n\n");
  const html = [
    ...kept.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`),
    ...(link?.href ? [button(link.href, link.label)] : []),
  ].join("\n");
  return { subject, text, html };
}

function riderEmail(n: AdventureNotice): NoticeEmail {
  const hello = n.riderFirstName?.trim() ? `Hi ${n.riderFirstName.trim()},` : "Hi,";
  const ride = page(n.publicSiteUrl, `/account/adventures/${n.bookingId}`);
  const route = n.adventureName;
  const message = n.messageToRider?.trim() ? `From BICII:\n${n.messageToRider.trim()}` : null;
  switch (n.kind) {
    case "ticket_paid":
      return compose(
        `Your ${route} ticket (${n.reference})`,
        [
          hello,
          `Thanks: your ticket for ${route} is paid. Ride it when you like, with a GPS device or phone recording the whole ride.`,
          "Afterwards, upload the recording and your checkpoint photos on your ride's page and send it to us. We check every ride by hand.",
        ],
        { href: ride, label: "Open your ride" },
      );
    case "changes_requested":
      return compose(
        `Your ${route} ride: we need something more`,
        [
          hello,
          `We've looked at your ${route} ride and need something more before we can certify it.`,
          message,
        ],
        { href: ride, label: "Add to your ride" },
      );
    case "certified":
      return compose(
        `You're certified: ${route}`,
        [
          hello,
          `Congratulations: your ${route} ride is certified${n.completedOn ? `, completed on ${dayLabel(n.completedOn)}` : ""}.`,
          n.certificateReference ? `Your certificate is ${n.certificateReference}.` : null,
          "Your name is on the route's finisher board, and we'll tell you when your finisher pack is ready.",
          message,
        ],
        { href: ride, label: "See your certificate" },
      );
    case "not_certified":
      return compose(
        `Your ${route} ride wasn't certified`,
        [
          hello,
          `We've checked your ${route} ride and couldn't certify it.`,
          message,
          "Questions? Reply to the shop on Instagram.",
        ],
        { href: ride, label: "Open your ride" },
      );
    case "pack_ready":
      return compose(
        `Your ${route} finisher pack is ready`,
        [
          hello,
          `Your finisher pack${n.packItems?.length ? ` (${n.packItems.join(", ")})` : ""} is ready to collect at the shop.`,
          "Come by during opening hours.",
        ],
        { href: page(n.publicSiteUrl, "/contact"), label: "Opening hours" },
      );
    case "departure_joined":
      return compose(
        `You've joined a ${route} group ride`,
        [
          hello,
          `You're on the ${route} group ride${n.departureStartsAt ? ` on ${whenLabel(n.departureStartsAt)}` : ""}${n.departureMeetingPoint ? `, meeting at ${n.departureMeetingPoint}` : ""}.`,
          "It's a peer group: riders support each other, and each of you records and sends your own ride. You can leave the date from your ride's page.",
        ],
        { href: ride, label: "Open your ride" },
      );
    case "departure_changed":
      return compose(
        `Your ${route} ride date has changed`,
        [
          hello,
          `Your ${route} ride is now${n.departureStartsAt ? ` on ${whenLabel(n.departureStartsAt)}` : " on a new date"}${n.departureMeetingPoint ? `, meeting at ${n.departureMeetingPoint}` : ""}.`,
          "Your ticket stands. If the new date doesn't work for you, message the shop.",
        ],
        { href: ride, label: "Open your ride" },
      );
    case "departure_cancelled":
      return compose(
        `The ${route} group ride is cancelled`,
        [
          hello,
          `The ${route} group ride${n.departureStartsAt ? ` on ${whenLabel(n.departureStartsAt)}` : ""} is cancelled. We're sorry for the change.`,
          "Your ticket still stands: ride on your own, or join another date from your ride's page.",
        ],
        { href: ride, label: "Open your ride" },
      );
    case "booking_cancelled":
      return compose(
        `Your ${route} booking is cancelled`,
        [
          hello,
          `Your ${route} booking (${n.reference}) is cancelled.`,
          n.eventNote ? `From BICII:\n${n.eventNote}` : null,
          "If a refund is owed under the terms you signed, it's made to the card you paid with. Questions? Message the shop.",
        ],
        null,
      );
    case "tracker_late_fee":
      return compose(
        `A late fee for your ${route} tracker`,
        [
          hello,
          "Thanks for bringing the tracker back.",
          n.eventNote,
          "As in the terms you signed, a tracker gets a grace day after its return day, then costs a fee for each further day. Pay it at the shop; message us if anything looks wrong.",
        ],
        { href: ride, label: "Open your ride" },
      );
    default:
      return compose(`Your ${route} ride`, [hello], { href: ride, label: "Open your ride" });
  }
}

function shopEmail(n: AdventureNotice, adminOrigin: string | null): NoticeEmail {
  const admin = adminOrigin?.trim().replace(/\/+$/, "") || null;
  if (n.kind === "cancellation_requested") {
    return compose(
      `Cancellation asked: ${n.reference}`,
      [
        `${n.riderName} asked to cancel their ${n.adventureName} booking (${n.reference}).`,
        n.eventNote ? `Their reason: ${n.eventNote}` : null,
        "Decide under the terms they accepted. To cancel, an admin presses Cancel booking and refunds in Stripe.",
      ],
      {
        href: admin ? `${admin}/adventures/bookings/${n.bookingId}` : null,
        label: "Open the booking",
      },
    );
  }
  if (n.kind === "payment_attention") {
    return compose(
      `Payment needs attention: ${n.reference}`,
      [
        `A payment for ${n.riderName}'s ${n.adventureName} booking (${n.reference}) needs an admin.`,
        n.attentionReason ? `Why: ${n.attentionReason}` : null,
        "Handle it in Stripe, then clear the flag on the booking. The ride can't be certified until then.",
      ],
      {
        href: admin ? `${admin}/adventures/bookings/${n.bookingId}` : null,
        label: "Open the booking",
      },
    );
  }
  return compose(
    `Ride to review: ${n.adventureName}, ${n.riderName} (${n.reference})`,
    [`${n.riderName} has sent their ${n.adventureName} ride for certification.`],
    { href: admin ? `${admin}/adventures/reviews` : null, label: "Open the reviews" },
  );
}

/** The email for one queued notice; `adminOrigin` links shop alerts to the Admin. */
export function adventureNoticeEmail(n: AdventureNotice, adminOrigin: string | null): NoticeEmail {
  return n.audience === "shop" ? shopEmail(n, adminOrigin) : riderEmail(n);
}

// ---------------------------------------------------------------- loop ----

export type NoticeOutcome = "sent" | "failed" | "released";

export type AdventureNoticeDeps = {
  claim: (max: number) => Promise<AdventureNotice[]>;
  finish: (notice: AdventureNotice, result: NoticeOutcome, error: string | null) => Promise<void>;
  send: (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }) => Promise<{ ok: true } | { ok: false; reason: "rejected" | "unavailable"; status?: number }>;
  adminOrigin: string | null;
  now: () => number;
};

export type AdventureNoticeSummary = {
  claimed: number;
  sent: number;
  failed: number;
  released: number;
};

/**
 * Sends due adventure emails until `deadlineMs`. The notice id is Resend's
 * idempotency key, so a send that succeeded but was not recorded is not
 * doubled on its retry. A failed write of one result does not stop the
 * others; that row's claim lapses and it is tried again.
 */
export async function runAdventureNotices(
  deps: AdventureNoticeDeps,
  options: { max: number; deadlineMs: number },
): Promise<AdventureNoticeSummary> {
  const summary: AdventureNoticeSummary = { claimed: 0, sent: 0, failed: 0, released: 0 };
  const notices = await deps.claim(options.max);
  summary.claimed = notices.length;
  const record = async (n: AdventureNotice, result: NoticeOutcome, error: string | null) => {
    try {
      await deps.finish(n, result, error);
    } catch {
      // Left claimed: the claim lapses and the row is tried again.
    }
  };
  for (const n of notices) {
    if (deps.now() > options.deadlineMs) {
      await record(n, "released", null);
      summary.released += 1;
      continue;
    }
    let result: Awaited<ReturnType<AdventureNoticeDeps["send"]>>;
    try {
      result = await deps.send({
        to: n.recipient,
        ...adventureNoticeEmail(n, deps.adminOrigin),
        idempotencyKey: `adventure-notice-${n.id}`,
      });
    } catch {
      result = { ok: false, reason: "unavailable" };
    }
    if (result.ok) {
      await record(n, "sent", null);
      summary.sent += 1;
    } else {
      await record(
        n,
        "failed",
        `Email ${result.reason}${result.status ? ` (${result.status})` : ""}`,
      );
      summary.failed += 1;
    }
  }
  return summary;
}
