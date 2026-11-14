/**
 * Adventure emails (D183-D184): every email's words and links, and the
 * sending loop's rules (RISKS R-100): rows it does not reach before its
 * deadline are released, a failure is recorded with Resend's reason only,
 * and one failed result write does not stop the rest.
 */
import { describe, expect, it, vi } from "vitest";

import {
  adventureNoticeEmail,
  adventureNoticeFromRow,
  runAdventureNotices,
  type AdventureNotice,
  type AdventureNoticeKind,
} from "@/lib/adventure-notices";

function notice(kind: AdventureNoticeKind, over: Partial<AdventureNotice> = {}): AdventureNotice {
  return {
    id: `n-${kind}`,
    claimToken: "t-1",
    kind,
    audience: kind === "ride_submitted" || kind === "payment_attention" ? "shop" : "customer",
    recipient: "dana@example.com",
    bookingId: "b-1",
    reference: "AV-000012",
    adventureName: "BICII 125",
    riderName: "Dana Rider",
    riderFirstName: "Dana",
    messageToRider: null,
    certificateReference: null,
    completedOn: null,
    acceptedDistanceKm: null,
    packItems: null,
    attentionReason: null,
    publicSiteUrl: "https://bicii.sg/",
    departureStartsAt: null,
    departureMeetingPoint: null,
    eventNote: null,
    ...over,
  };
}

describe("the emails (D183)", () => {
  it("the paid ticket links to the rider's ride page", () => {
    const e = adventureNoticeEmail(notice("ticket_paid"), null);
    expect(e.subject).toBe("Your BICII 125 ticket (AV-000012)");
    expect(e.text).toContain("Hi Dana,");
    expect(e.text).toContain("https://bicii.sg/account/adventures/b-1");
    expect(e.html).toContain('href="https://bicii.sg/account/adventures/b-1"');
  });

  it("changes and a refusal carry the reviewer's message, escaped in HTML", () => {
    const e = adventureNoticeEmail(
      notice("changes_requested", { messageToRider: "Add the <Seletar> photo & resend." }),
      null,
    );
    expect(e.subject).toBe("Your BICII 125 ride: we need something more");
    expect(e.text).toContain("Add the <Seletar> photo & resend.");
    expect(e.html).toContain("Add the &lt;Seletar&gt; photo &amp; resend.");
    expect(e.html).not.toContain("<Seletar>");
    const no = adventureNoticeEmail(
      notice("not_certified", { messageToRider: "The track stops at 80 km." }),
      null,
    );
    expect(no.subject).toBe("Your BICII 125 ride wasn't certified");
    expect(no.text).toContain("The track stops at 80 km.");
  });

  it("certified names the certificate and the day; pack ready lists the items", () => {
    const c = adventureNoticeEmail(
      notice("certified", { certificateReference: "BC-000007", completedOn: "2026-11-15" }),
      null,
    );
    expect(c.subject).toBe("You're certified: BICII 125");
    expect(c.text).toContain("BC-000007");
    expect(c.text).toContain("15 Nov 2026");
    const p = adventureNoticeEmail(notice("pack_ready", { packItems: ["T-shirt", "Patch"] }), null);
    expect(p.subject).toBe("Your BICII 125 finisher pack is ready");
    expect(p.text).toContain("(T-shirt, Patch)");
    expect(p.text).toContain("https://bicii.sg/contact");
  });

  it("shop alerts link to the Admin and never to the rider's page", () => {
    const r = adventureNoticeEmail(notice("ride_submitted"), "https://admin.example/");
    expect(r.subject).toBe("Ride to review: BICII 125, Dana Rider (AV-000012)");
    expect(r.text).toContain("https://admin.example/adventures/reviews");
    expect(r.text).not.toContain("/account/");
    const a = adventureNoticeEmail(
      notice("payment_attention", { attentionReason: "Paid twice" }),
      "https://admin.example",
    );
    expect(a.subject).toBe("Payment needs attention: AV-000012");
    expect(a.text).toContain("Why: Paid twice");
    expect(a.text).toContain("https://admin.example/adventures/bookings/b-1");
  });

  it("without the site's address the email has no link, and no first name says Hi", () => {
    const e = adventureNoticeEmail(
      notice("ticket_paid", { publicSiteUrl: null, riderFirstName: null }),
      null,
    );
    expect(e.text.startsWith("Hi,")).toBe(true);
    expect(e.text).not.toContain("http");
    expect(e.html).not.toContain("<a ");
  });

  it("maps a claimed row", () => {
    expect(
      adventureNoticeFromRow({
        id: "n1",
        claim_token: "t1",
        kind: "certified",
        audience: "customer",
        recipient: "x@example.com",
        booking_id: "b1",
        reference: "AV-000001",
        adventure_name: "BICII 125",
        rider_name: "X Y",
        rider_first_name: "X",
        message_to_rider: "",
        certificate_reference: "BC-000001",
        completed_on: "2026-11-15",
        accepted_distance_km: 128.5,
        pack_items: ["Pin"],
        attention_reason: null,
        public_site_url: null,
      }),
    ).toMatchObject({ claimToken: "t1", acceptedDistanceKm: "128.5", packItems: ["Pin"] });
  });
});

describe("departure emails (D195)", () => {
  it("joined and cancelled name the date and meeting point; a cancellation says the ticket stands", () => {
    const at = {
      departureStartsAt: "2026-11-21T23:00:00Z",
      departureMeetingPoint: "294 River Valley",
    };
    const joined = adventureNoticeEmail(notice("departure_joined", at), null);
    expect(joined.subject).toBe("You've joined a BICII 125 group ride");
    expect(joined.text).toContain("Sun 22 Nov 2026, 7:00 am");
    expect(joined.text).toContain("294 River Valley");
    const cancelled = adventureNoticeEmail(notice("departure_cancelled", at), null);
    expect(cancelled.subject).toBe("The BICII 125 group ride is cancelled");
    expect(cancelled.text).toContain("Your ticket still stands");
  });
});

describe("cancellation emails (D200, D201)", () => {
  it("the shop hears the rider's reason; the rider hears the decision", () => {
    const asked = adventureNoticeEmail(
      notice("cancellation_requested", { audience: "shop", eventNote: "Knee injury" }),
      "https://admin.example",
    );
    expect(asked.subject).toBe("Cancellation asked: AV-000012");
    expect(asked.text).toContain("Their reason: Knee injury");
    expect(asked.text).toContain("https://admin.example/adventures/bookings/b-1");
    const done = adventureNoticeEmail(
      notice("booking_cancelled", { eventNote: "Refunded in full" }),
      null,
    );
    expect(done.subject).toBe("Your BICII 125 booking is cancelled");
    expect(done.text).toContain("Refunded in full");
  });
});

describe("the date changed email (D221)", () => {
  it("gives the new time and meeting point", () => {
    const mail = adventureNoticeEmail(
      notice("departure_changed", {
        departureStartsAt: "2026-11-21T23:00:00Z",
        departureMeetingPoint: "294 River Valley",
      }),
      null,
    );
    expect(mail.subject).toBe("Your BICII 125 ride date has changed");
    expect(mail.text).toContain("Sun 22 Nov 2026, 7:00 am");
    expect(mail.text).toContain("meeting at 294 River Valley");
  });
});

describe("the supported date cancelled email (D223)", () => {
  it("promises a move or a refund, not that the ticket stands", () => {
    const mail = adventureNoticeEmail(
      notice("supported_cancelled", { eventNote: "Storm warning" }),
      null,
    );
    expect(mail.subject).toBe("Your BICII 125 supported ride is cancelled");
    expect(mail.text).toContain("move you to another supported date or refund you");
    expect(mail.text).not.toContain("ticket still stands");
  });
});

describe("the tracker late fee email (D213)", () => {
  it("tells the rider the fee and where to pay it", () => {
    const fee = adventureNoticeEmail(
      notice("tracker_late_fee", {
        eventNote: "The late fee is $40.00 ($20.00 a day), payable at the shop.",
      }),
      null,
    );
    expect(fee.subject).toBe("A late fee for your BICII 125 tracker");
    expect(fee.text).toContain("The late fee is $40.00");
    expect(fee.text).toContain("Pay it at the shop");
  });
});

describe("the sending loop (D184; R-100)", () => {
  function deps(
    clock: { t: number },
    sendImpl?: (
      to: string,
    ) => Promise<{ ok: true } | { ok: false; reason: "rejected" | "unavailable"; status?: number }>,
  ) {
    const finished: Array<[string, string, string | null]> = [];
    const sent: Array<{ to: string; idempotencyKey: string }> = [];
    return {
      finished,
      sent,
      deps: {
        claim: async () => [
          notice("ticket_paid", { id: "a" }),
          notice("certified", { id: "b" }),
          notice("pack_ready", { id: "c" }),
        ],
        finish: vi.fn(async (n: AdventureNotice, result: string, error: string | null) => {
          finished.push([n.id, result, error]);
        }),
        send: async (m: { to: string; idempotencyKey: string }) => {
          sent.push({ to: m.to, idempotencyKey: m.idempotencyKey });
          clock.t += 20_000; // each send takes 20 s
          return sendImpl ? sendImpl(m.to) : { ok: true as const };
        },
        adminOrigin: null,
        now: () => clock.t,
      },
    };
  }

  it("sends until the deadline, then releases the rest unused", async () => {
    const clock = { t: 0 };
    const { deps: d, finished, sent } = deps(clock);
    const summary = await runAdventureNotices(d, { max: 5, deadlineMs: 30_000 });
    expect(summary).toEqual({ claimed: 3, sent: 2, failed: 0, released: 1 });
    expect(finished).toEqual([
      ["a", "sent", null],
      ["b", "sent", null],
      ["c", "released", null],
    ]);
    expect(sent.map((s) => s.idempotencyKey)).toEqual(["adventure-notice-a", "adventure-notice-b"]);
  });

  it("records a failure with Resend's reason only, and a thrown send as unavailable", async () => {
    const clock = { t: 0 };
    let i = 0;
    const { deps: d, finished } = deps(clock, async () => {
      i += 1;
      if (i === 1) return { ok: false, reason: "rejected", status: 422 };
      throw new Error("socket hang up dana@example.com");
    });
    const summary = await runAdventureNotices(d, { max: 5, deadlineMs: 1_000_000 });
    expect(summary).toMatchObject({ sent: 0, failed: 3 });
    expect(finished[0]).toEqual(["a", "failed", "Email rejected (422)"]);
    expect(finished[1]).toEqual(["b", "failed", "Email unavailable"]);
    expect(JSON.stringify(finished)).not.toContain("@");
  });

  it("one failed result write does not stop the others", async () => {
    const clock = { t: 0 };
    const { deps: d, sent } = deps(clock);
    d.finish.mockRejectedValueOnce(new Error("db down"));
    const summary = await runAdventureNotices(d, { max: 5, deadlineMs: 1_000_000 });
    expect(summary.sent).toBe(3);
    expect(sent).toHaveLength(3);
  });
});
