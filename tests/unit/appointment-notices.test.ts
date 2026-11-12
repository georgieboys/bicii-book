import { describe, expect, it } from "vitest";

import {
  appointmentNoticeEmail,
  noticeFromRow,
  noticeWhen,
  runAppointmentNotices,
  type AppointmentNotice,
  type NoticeDeps,
} from "@/lib/appointment-notices";
import { bookingAlertsSchema } from "@/lib/schedule";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// 13 Nov 2026, 10:00 in Singapore.
const STARTS = "2026-11-13T02:00:00Z";

const base: AppointmentNotice = {
  id: ID(1),
  kind: "booked",
  audience: "shop",
  recipient: "team@example.com",
  attempts: 1,
  appointmentId: ID(2),
  startsAt: STARTS,
  endsAt: "2026-11-13T02:30:00Z",
  appointmentType: "Tune-up",
  customerName: "Alex Rider",
  customerFirstName: "Alex",
  customerEmail: "alex@example.com",
  customerPhone: "+65 9000 1234",
  bike: "Canyon Endurace CF",
  customerNote: "Squeaky <brakes>",
  cancelledBy: null,
  reason: null,
  publicSiteUrl: "https://shop.example.com/",
  timezone: "Asia/Singapore",
};

describe("booking email wording (D163c)", () => {
  it("states the time in the shop's time zone", () => {
    expect(noticeWhen(STARTS, "Asia/Singapore")).toBe("Fri 13 Nov 2026, 10:00 am");
    expect(noticeWhen(STARTS, null)).toBe("Fri 13 Nov 2026, 10:00 am");
  });

  it("a shop alert names the booking, the customer's contact and links to the Admin", () => {
    const email = appointmentNoticeEmail(base, "https://admin.example.com/");
    expect(email.subject).toBe("New booking: Tune-up, Fri 13 Nov 2026, 10:00 am");
    expect(email.text).toBe(
      [
        "A customer booked online.",
        "",
        "When: Fri 13 Nov 2026, 10:00 am",
        "What: Tune-up",
        "Customer: Alex Rider",
        "Phone: +65 9000 1234",
        "Email: alex@example.com",
        "Bike: Canyon Endurace CF",
        "Note from the customer: Squeaky <brakes>",
        "",
        `Open it in BICII Admin: https://admin.example.com/appointments/${ID(2)}`,
      ].join("\n"),
    );
    expect(email.html).toContain("Squeaky &lt;brakes&gt;");
    expect(email.html).not.toContain("<brakes>");
  });

  it("a shop alert leaves out what is unknown, and the link without the Admin's address", () => {
    const email = appointmentNoticeEmail(
      { ...base, customerPhone: null, bike: null, customerNote: "  " },
      null,
    );
    expect(email.text).not.toMatch(/Phone:|Bike:|Note from the customer:|Open it in/);
  });

  it("a cancellation alert says the customer cancelled and gives their reason", () => {
    const email = appointmentNoticeEmail(
      { ...base, kind: "cancelled", cancelledBy: "customer", reason: "Away that week" },
      "https://admin.example.com",
    );
    expect(email.subject).toBe("Booking cancelled: Tune-up, Fri 13 Nov 2026, 10:00 am");
    expect(email.text.split("\n").slice(0, 3)).toEqual([
      "The customer cancelled this online booking.",
      "",
      "Their reason: Away that week",
    ]);
  });

  it("the customer's confirmation gives the time, their note and where to change it", () => {
    const email = appointmentNoticeEmail({ ...base, audience: "customer" }, "https://admin.x");
    expect(email.subject).toBe("Your BICII booking: Tune-up, Fri 13 Nov 2026, 10:00 am");
    expect(email.text).toContain("Hi Alex,");
    expect(email.text).toContain("Your Tune-up at BICII is booked for Fri 13 Nov 2026, 10:00 am.");
    expect(email.text).toContain("Your note: Squeaky <brakes>");
    expect(email.text).toContain(
      "To cancel or change it, sign in at https://shop.example.com/account.",
    );
    // Nothing of the shop's: no Admin link, no phone line.
    expect(email.text).not.toMatch(/admin\.x|Phone:/);
  });

  it("the customer's cancellation says who cancelled; the shop's reason never appears", () => {
    const mine = appointmentNoticeEmail(
      { ...base, audience: "customer", kind: "cancelled", cancelledBy: "customer" },
      null,
    );
    expect(mine.subject).toBe("Your BICII booking is cancelled");
    expect(mine.text).toContain(
      "Your Tune-up on Fri 13 Nov 2026, 10:00 am is cancelled, as you asked.",
    );
    expect(mine.text).toContain("Book another time at https://shop.example.com/book.");

    const theirs = appointmentNoticeEmail(
      {
        ...base,
        audience: "customer",
        kind: "cancelled",
        cancelledBy: "staff",
        reason: "Internal: mechanic off sick",
      },
      null,
    );
    expect(theirs.text).toContain(
      "The shop has cancelled your Tune-up on Fri 13 Nov 2026, 10:00 am. We're sorry for the change.",
    );
    expect(theirs.text).toContain("Questions? Contact the shop: https://shop.example.com/contact");
    expect(theirs.text).not.toContain("mechanic off sick");
  });

  it("without the public site's address, a customer email points to the website in words", () => {
    const email = appointmentNoticeEmail(
      { ...base, audience: "customer", publicSiteUrl: null, customerFirstName: null },
      null,
    );
    expect(email.text).toContain("Hi,");
    expect(email.text).toContain("To cancel or change it, sign in on the BICII website.");
  });
});

describe("the sending loop (D163d)", () => {
  function fakes(results: Array<"ok" | "rejected" | "unavailable" | "throw">) {
    const finished: Array<[string, boolean, string | null]> = [];
    const sent: Array<{ to: string; idempotencyKey: string; subject: string }> = [];
    const notices = results.map((_, i) => ({ ...base, id: ID(10 + i), recipient: `p${i}@x.com` }));
    let call = 0;
    const deps: NoticeDeps = {
      claim: async (max) => notices.slice(0, max),
      finish: async (id, ok, error) => {
        finished.push([id, ok, error]);
      },
      send: async (message) => {
        sent.push(message);
        const r = results[call++];
        if (r === "throw") throw new Error("network");
        return r === "ok" ? { ok: true } : { ok: false, reason: r, status: 503 };
      },
      adminOrigin: "https://admin.example.com",
    };
    return { deps, finished, sent };
  }

  it("sends each claimed email once, keyed by its id, and records each result", async () => {
    const { deps, finished, sent } = fakes(["ok", "unavailable", "throw"]);
    expect(await runAppointmentNotices(deps)).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(sent.map((m) => [m.to, m.idempotencyKey])).toEqual([
      ["p0@x.com", `appointment-notice-${ID(10)}`],
      ["p1@x.com", `appointment-notice-${ID(11)}`],
      ["p2@x.com", `appointment-notice-${ID(12)}`],
    ]);
    expect(finished).toEqual([
      [ID(10), true, null],
      [ID(11), false, "Email unavailable (503)"],
      [ID(12), false, "Email unavailable"],
    ]);
  });

  it("maps a claimed row, filling what the database left empty", () => {
    const n = noticeFromRow({
      id: ID(1),
      kind: "cancelled",
      audience: "customer",
      recipient: "a@b.co",
      attempts: 2,
      appointment_id: ID(2),
      starts_at: STARTS,
      ends_at: STARTS,
      appointment_type: null,
      customer_name: null,
      customer_first_name: null,
      customer_email: null,
      customer_phone: null,
      bike: null,
      customer_note: null,
      cancelled_by: "staff",
      reason: null,
      public_site_url: null,
      timezone: null,
    });
    expect(n).toMatchObject({
      kind: "cancelled",
      audience: "customer",
      appointmentType: "Appointment",
      customerName: "A customer",
      cancelledBy: "staff",
    });
  });
});

describe("who gets booking alerts: the form (D163b)", () => {
  it("splits, trims, lowercases and de-duplicates the addresses", () => {
    expect(
      bookingAlertsSchema.parse({
        staffIds: [ID(1), ID(1)],
        emails: " Team@Bicii.sg \n\nteam@bicii.sg, desk@example.com;",
      }),
    ).toEqual({ staffIds: [ID(1)], emails: ["team@bicii.sg", "desk@example.com"] });
    expect(bookingAlertsSchema.parse({ staffIds: [], emails: "" })).toEqual({
      staffIds: [],
      emails: [],
    });
  });

  it("refuses an address that is not one, and more than 10", () => {
    const error = (emails: string) =>
      bookingAlertsSchema.safeParse({ staffIds: [], emails }).error?.issues[0]?.message;
    expect(error("team at bicii")).toBe(
      "Enter each address in full, like team@example.com, one per line.",
    );
    expect(error(Array.from({ length: 11 }, (_, i) => `p${i}@x.com`).join("\n"))).toBe(
      "List at most 10 other addresses.",
    );
  });
});
