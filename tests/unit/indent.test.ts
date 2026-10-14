import { describe, expect, it } from "vitest";

import { Constants } from "@/lib/database.types";
import {
  CANCELLABLE,
  COST_MISSING_NOTE,
  PART_REQUEST_LABELS,
  PART_REQUEST_TONES,
  canCancelRequest,
  canFit,
  isUnfitted,
  neverOrderedNote,
  notFittedNote,
  quoteMessage,
  quotePath,
  requestBadge,
  unansweredQuoteNote,
  unfittedMemo,
  whatsappHref,
  whatsappNumber,
} from "@/lib/indent";

describe("whatsappNumber (D144)", () => {
  it("adds 65 to an 8-digit Singapore number, however it is spaced", () => {
    expect(whatsappNumber("9123 4567")).toBe("6591234567");
    expect(whatsappNumber("8123-4567")).toBe("6581234567");
    expect(whatsappNumber("6123 4567")).toBe("6561234567");
    expect(whatsappNumber("+65 9123 4567")).toBe("6591234567");
    expect(whatsappNumber("65 9123 4567")).toBe("6591234567");
  });

  it("keeps an international number given with + or 00", () => {
    expect(whatsappNumber("+60 12-345 6789")).toBe("60123456789");
    expect(whatsappNumber("0044 7700 900123")).toBe("447700900123");
  });

  it("gives nothing WhatsApp could not use", () => {
    for (const phone of [null, undefined, "", "12345", "1234 5678", "not a phone"]) {
      expect(whatsappNumber(phone), String(phone)).toBeNull();
    }
  });
});

describe("whatsappHref and quoteMessage (D144)", () => {
  it("greets the customer, names the job and carries the link and validity", () => {
    const text = quoteMessage({
      firstName: "Chloe",
      jobNumber: "J-000004",
      link: "https://admin.example/quote/abc",
      days: 7,
    });
    expect(text).toBe(
      [
        "Hi Chloe, here is the quote for your bike (job J-000004) from BICII.",
        "Please approve or decline each item here: https://admin.example/quote/abc",
        "The link works for 7 days.",
      ].join("\n"),
    );
    const anonymous = quoteMessage({ firstName: null, jobNumber: "J-1", link: "x", days: 1 });
    expect(anonymous.startsWith("Hi, here is the quote")).toBe(true);
    expect(anonymous.endsWith("The link works for 1 day.")).toBe(true);
  });

  it("opens wa.me with the number and the encoded message, or nothing without a number", () => {
    expect(whatsappHref("9123 4567", "Hi & bye")).toBe(
      "https://wa.me/6591234567?text=Hi%20%26%20bye",
    );
    expect(whatsappHref(null, "Hi")).toBeNull();
  });

  it("builds the quote page path from the token", () => {
    expect(quotePath("A".repeat(43))).toBe(`/quote/${"A".repeat(43)}`);
  });
});

describe("request states", () => {
  it("labels every status the database has", () => {
    for (const status of Constants.public.Enums.part_request_status) {
      expect(PART_REQUEST_LABELS[status], status).toBeTruthy();
    }
  });

  it("fits approved items and ordered parts only; never cancels quoted or fitted ones", () => {
    expect(canFit("part", "approved")).toBe(true);
    expect(canFit("part", "ordered")).toBe(true);
    expect(canFit("service", "approved")).toBe(true);
    expect(canFit("service", "ordered")).toBe(false);
    for (const status of ["proposed", "quoted", "declined", "fitted", "cancelled"] as const) {
      expect(canFit("part", status), status).toBe(false);
    }
    expect(CANCELLABLE).not.toContain("quoted");
    expect(CANCELLABLE).not.toContain("fitted");
  });
});

describe("approved items not on the bill (R-082, D140, D149)", () => {
  const statuses = Constants.public.Enums.part_request_status;
  const jobStatuses = Constants.public.Enums.work_order_status;

  it("counts approved and ordered as unfitted, as work_order_unfitted_requests does", () => {
    expect(statuses.filter(isUnfitted)).toEqual(["approved", "ordered"]);
    // The green done tone stays for fitted; the card shows "Not fitted" instead on a closed job.
    expect(PART_REQUEST_TONES.approved).toBe("done");
  });

  it("writes the memo under the total: open says fit to bill, otherwise never fitted", () => {
    const one = { itemCount: 1, quotedTotal: "2.00", currency: "SGD" };
    expect(unfittedMemo(one, true)).toBe(
      "Approved, not on the bill yet: 1 item, $2.00. Fit it to bill it.",
    );
    expect(unfittedMemo({ itemCount: 2, quotedTotal: "265.00", currency: "SGD" }, true)).toBe(
      "Approved, not on the bill yet: 2 items, $265.00. Fit them to bill them.",
    );
    expect(unfittedMemo(one, false)).toBe("Approved but never fitted: $2.00 (not billed).");
    expect(unfittedMemo(null, true)).toBeNull();
    expect(unfittedMemo({ ...one, itemCount: 0 }, true)).toBeNull();
  });

  it("says why an item is not on the bill for each status that is not open", () => {
    expect(notFittedNote("completed")).toBe(
      "Not on the bill: the job was completed before this was fitted. Reopen the job with Change status to fit it, or cancel it.",
    );
    expect(notFittedNote("ready_for_collection")).toBe(notFittedNote("completed"));
    expect(notFittedNote("collected")).toBe(
      "Not on the bill, and it can no longer be fitted: the job is collected. An admin or manager can cancel it and refund any deposit in Stripe.",
    );
    expect(notFittedNote("cancelled")).toContain("the job is cancelled");
    for (const open of [
      "received",
      "diagnosing",
      "in_progress",
      "paused",
      "awaiting_parts",
    ] as const)
      expect(notFittedNote(open)).toBeNull();
    expect(jobStatuses.filter((j) => notFittedNote(j) !== null).sort()).toEqual([
      "cancelled",
      "collected",
      "completed",
      "ready_for_collection",
    ]);
  });

  it("lets anyone cancel until the job is collected or cancelled, then admins and managers only (D149)", () => {
    for (const job of jobStatuses) {
      const closed = job === "collected" || job === "cancelled";
      for (const status of statuses) {
        const cancellable = CANCELLABLE.includes(status);
        expect(canCancelRequest(status, job, false), `${status} on ${job}`).toBe(
          cancellable && !closed,
        );
        // On a closed job an admin or manager also cancels an item on the
        // open quote (the cancel withdraws it); never a fitted one.
        expect(canCancelRequest(status, job, true), `${status} on ${job}, manager`).toBe(
          cancellable || (closed && status === "quoted"),
        );
      }
    }
    expect(canCancelRequest("quoted", "completed", true)).toBe(false);
    expect(canCancelRequest("quoted", "collected", true)).toBe(true);
    expect(canCancelRequest("quoted", "collected", false)).toBe(false);
    expect(canCancelRequest("fitted", "collected", true)).toBe(false);
  });

  it("badges an item on a job that is no longer open: Not fitted, Not answered, else its status", () => {
    expect(requestBadge("approved", true)).toEqual({ label: "Approved", tone: "done" });
    expect(requestBadge("quoted", true)).toEqual({
      label: "Waiting for the customer",
      tone: "waiting",
    });
    expect(requestBadge("approved", false)).toEqual({ label: "Not fitted", tone: "danger" });
    expect(requestBadge("ordered", false)).toEqual({ label: "Not fitted", tone: "danger" });
    expect(requestBadge("quoted", false)).toEqual({ label: "Not answered", tone: "neutral" });
    for (const status of ["proposed", "declined", "fitted", "cancelled"] as const) {
      expect(requestBadge(status, false), status).toEqual(requestBadge(status, true));
    }
  });

  it("says what can be done with a quote left open when the job stopped being open", () => {
    expect(unansweredQuoteNote("completed")).toBe(
      "Reopen the job with Change status to withdraw it or send it again.",
    );
    expect(unansweredQuoteNote("ready_for_collection")).toBe(unansweredQuoteNote("completed"));
    expect(unansweredQuoteNote("collected")).toBe(
      "An admin or manager can cancel its items, which withdraws it.",
    );
    expect(unansweredQuoteNote("cancelled")).toBe(unansweredQuoteNote("collected"));
    expect(jobStatuses.filter((j) => unansweredQuoteNote(j) !== null).sort()).toEqual([
      "cancelled",
      "collected",
      "completed",
      "ready_for_collection",
    ]);
  });

  it("warns before fitting a part never ordered in BICII, or one with no cost", () => {
    expect(neverOrderedNote("Shop floor")).toBe(
      "Never ordered in BICII: fitting takes it out of stock at Shop floor. If it was bought outside BICII, that count may go below zero until the stock is corrected.",
    );
    expect(neverOrderedNote(null)).toContain("at the default location.");
    expect(COST_MISSING_NOTE).toBe(
      "This part has no cost yet, so it can't be fitted: its yield can't be worked out. Set its cost on the product's page first.",
    );
  });
});
