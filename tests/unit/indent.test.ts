import { describe, expect, it } from "vitest";

import { Constants } from "@/lib/database.types";
import {
  CANCELLABLE,
  PART_REQUEST_LABELS,
  canFit,
  quoteMessage,
  quotePath,
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
