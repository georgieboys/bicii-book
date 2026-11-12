/**
 * Booking emails (PLAN D163, DATA-MODEL §3 "Booking emails"): the words of
 * the four emails the Admin's sender sends for an appointment booked online.
 * Pure, so the unit tests read every variant; the sender
 * (src/lib/integrations/notifications/appointments.ts) claims the rows and
 * sends them through Resend.
 *
 *   shop     booked     "New booking: Tune-up, Wed 13 Nov 2026, 10:00 am"
 *   shop     cancelled  "Booking cancelled: …" (the customer cancelled)
 *   customer booked     "Your BICII booking: …"
 *   customer cancelled  "Your BICII booking is cancelled" (they did, or the shop)
 *
 * The shop alerts carry the customer's contact details and a link to the
 * appointment in the Admin; customer emails never carry staff notes or a
 * staff cancellation reason.
 */
import { SHOP_LOCALE, SHOP_TIME_ZONE } from "@/lib/dates";

export type AppointmentNotice = {
  id: string;
  kind: "booked" | "cancelled";
  audience: "shop" | "customer";
  recipient: string;
  attempts: number;
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  appointmentType: string;
  customerName: string;
  customerFirstName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  bike: string | null;
  customerNote: string | null;
  cancelledBy: "staff" | "customer" | null;
  reason: string | null;
  publicSiteUrl: string | null;
  timezone: string | null;
};

export type NoticeEmail = { subject: string; text: string; html: string };

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** "Wed 13 Nov 2026, 10:00 am" in the shop's time zone. */
export function noticeWhen(startsAt: string, timeZone: string | null = null): string {
  const zone = timeZone || SHOP_TIME_ZONE;
  const at = new Date(startsAt);
  const day = new Intl.DateTimeFormat(SHOP_LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  })
    .format(at)
    .replace(",", "");
  const time = new Intl.DateTimeFormat(SHOP_LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  }).format(at);
  return `${day}, ${time}`;
}

/** The public site's page, or null when its address is not set. */
function sitePage(base: string | null, path: string): string | null {
  const root = base?.trim().replace(/\/+$/, "");
  return root ? `${root}${path}` : null;
}

type Line = [label: string, value: string | null | undefined];

function detailLines(n: AppointmentNotice): Line[] {
  return [
    ["When", noticeWhen(n.startsAt, n.timezone)],
    ["What", n.appointmentType],
    ["Customer", n.customerName],
    ["Phone", n.customerPhone],
    ["Email", n.customerEmail],
    ["Bike", n.bike],
    ["Note from the customer", n.customerNote],
  ];
}

const textLines = (lines: Line[]) =>
  lines.filter(([, v]) => v && v.trim()).map(([label, v]) => `${label}: ${v!.trim()}`);

const htmlLines = (lines: Line[]) =>
  lines
    .filter(([, v]) => v && v.trim())
    .map(([label, v]) => `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(v!.trim())}`)
    .join("<br>");

const button = (href: string, label: string) =>
  `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`;

function shopEmail(n: AppointmentNotice, adminOrigin: string | null): NoticeEmail {
  const when = noticeWhen(n.startsAt, n.timezone);
  const cancelled = n.kind === "cancelled";
  const subject = cancelled
    ? `Booking cancelled: ${n.appointmentType}, ${when}`
    : `New booking: ${n.appointmentType}, ${when}`;
  const intro = cancelled
    ? "The customer cancelled this online booking."
    : "A customer booked online.";
  const lines: Line[] = [
    ...(cancelled ? ([["Their reason", n.reason]] as Line[]) : []),
    ...detailLines(n),
  ];
  const link = adminOrigin
    ? `${adminOrigin.replace(/\/+$/, "")}/appointments/${n.appointmentId}`
    : null;
  const text = [
    intro,
    "",
    ...textLines(lines),
    ...(link ? ["", `Open it in BICII Admin: ${link}`] : []),
  ].join("\n");
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${htmlLines(lines)}</p>`,
    ...(link ? [button(link, "Open in BICII Admin")] : []),
  ].join("\n");
  return { subject, text, html };
}

function customerEmail(n: AppointmentNotice): NoticeEmail {
  const when = noticeWhen(n.startsAt, n.timezone);
  const hello = n.customerFirstName?.trim() ? `Hi ${n.customerFirstName.trim()},` : "Hi,";
  const account = sitePage(n.publicSiteUrl, "/account");
  const bookPage = sitePage(n.publicSiteUrl, "/book");
  const contact = sitePage(n.publicSiteUrl, "/contact");

  if (n.kind === "booked") {
    const lines: Line[] = [
      ["When", when],
      ["What", n.appointmentType],
      ["Bike", n.bike],
      ["Your note", n.customerNote],
    ];
    const manage = account
      ? `To cancel or change it, sign in at ${account}.`
      : "To cancel or change it, sign in on the BICII website.";
    const text = [
      hello,
      "",
      `Your ${n.appointmentType} at BICII is booked for ${when}.`,
      "",
      ...textLines(lines),
      "",
      manage,
      "See you then.",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(hello)}</p>`,
      `<p>Your ${escapeHtml(n.appointmentType)} at BICII is booked for <strong>${escapeHtml(when)}</strong>.</p>`,
      `<p>${htmlLines(lines)}</p>`,
      ...(account ? [button(account, "View your booking")] : []),
      `<p>${escapeHtml(manage)}</p>`,
      "<p>See you then.</p>",
    ].join("\n");
    return { subject: `Your BICII booking: ${n.appointmentType}, ${when}`, text, html };
  }

  const byShop = n.cancelledBy === "staff";
  const what = byShop
    ? `The shop has cancelled your ${n.appointmentType} on ${when}. We're sorry for the change.`
    : `Your ${n.appointmentType} on ${when} is cancelled, as you asked.`;
  const next = [
    bookPage
      ? `Book another time at ${bookPage}.`
      : "You can book another time on the BICII website.",
    ...(byShop && contact ? [`Questions? Contact the shop: ${contact}`] : []),
  ];
  const text = [hello, "", what, "", ...next].join("\n");
  const html = [
    `<p>${escapeHtml(hello)}</p>`,
    `<p>${escapeHtml(what)}</p>`,
    ...(bookPage ? [button(bookPage, "Book another time")] : []),
    ...next.map((line) => `<p>${escapeHtml(line)}</p>`),
  ].join("\n");
  return { subject: "Your BICII booking is cancelled", text, html };
}

/** The email for one queued notice; `adminOrigin` links shop alerts to the Admin. */
export function appointmentNoticeEmail(
  notice: AppointmentNotice,
  adminOrigin: string | null,
): NoticeEmail {
  return notice.audience === "shop" ? shopEmail(notice, adminOrigin) : customerEmail(notice);
}

/** A row of claim_appointment_notices as the sender uses it. */
export type AppointmentNoticeRow = {
  id: string | null;
  kind: "booked" | "cancelled" | null;
  audience: "shop" | "customer" | null;
  recipient: string | null;
  attempts: number | null;
  appointment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  appointment_type: string | null;
  customer_name: string | null;
  customer_first_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  bike: string | null;
  customer_note: string | null;
  cancelled_by: "staff" | "customer" | null;
  reason: string | null;
  public_site_url: string | null;
  timezone: string | null;
};

export function noticeFromRow(row: AppointmentNoticeRow): AppointmentNotice {
  return {
    id: row.id ?? "",
    kind: row.kind ?? "booked",
    audience: row.audience ?? "shop",
    recipient: row.recipient ?? "",
    attempts: row.attempts ?? 0,
    appointmentId: row.appointment_id ?? "",
    startsAt: row.starts_at ?? "",
    endsAt: row.ends_at ?? "",
    appointmentType: row.appointment_type ?? "Appointment",
    customerName: row.customer_name ?? "A customer",
    customerFirstName: row.customer_first_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    bike: row.bike,
    customerNote: row.customer_note,
    cancelledBy: row.cancelled_by,
    reason: row.reason,
    publicSiteUrl: row.public_site_url,
    timezone: row.timezone,
  };
}

export type NoticeSendResult =
  { ok: true } | { ok: false; reason: "rejected" | "unavailable"; status?: number };

/** What the sending loop needs; the integration passes the database and Resend. */
export type NoticeDeps = {
  claim: (max: number) => Promise<AppointmentNotice[]>;
  finish: (id: string, ok: boolean, error: string | null) => Promise<void>;
  send: (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }) => Promise<NoticeSendResult>;
  adminOrigin: string | null;
};

export type NoticeRunSummary = { claimed: number; sent: number; failed: number };

/**
 * Claims due booking emails and sends each once (D163d). The notice id is
 * Resend's idempotency key, so a send that succeeded but was not recorded
 * is not doubled on its retry. A failure is recorded with Resend's reason
 * and status only, never the address.
 */
export async function runAppointmentNotices(deps: NoticeDeps, max = 20): Promise<NoticeRunSummary> {
  const notices = await deps.claim(max);
  let sent = 0;
  let failed = 0;
  for (const notice of notices) {
    const email = appointmentNoticeEmail(notice, deps.adminOrigin);
    let result: NoticeSendResult;
    try {
      result = await deps.send({
        to: notice.recipient,
        ...email,
        idempotencyKey: `appointment-notice-${notice.id}`,
      });
    } catch {
      result = { ok: false, reason: "unavailable" };
    }
    if (result.ok) {
      await deps.finish(notice.id, true, null);
      sent += 1;
    } else {
      await deps.finish(
        notice.id,
        false,
        `Email ${result.reason}${result.status ? ` (${result.status})` : ""}`,
      );
      failed += 1;
    }
  }
  return { claimed: notices.length, sent, failed };
}
