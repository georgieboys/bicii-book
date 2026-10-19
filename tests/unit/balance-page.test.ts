import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BALANCE_CLOSED_KEYS,
  BALANCE_OPEN_KEYS,
  NOT_VALID_NOTICE,
  balanceNotice,
  balanceReturn,
  isBalanceToken,
  parseBalanceView,
  paidLabel,
  paymentNote,
  type OpenBalance,
} from "@/lib/balance-page";
import { BALANCE_LIMITS, BALANCE_WINDOW_SECONDS, balanceBuckets } from "@/lib/balance-limits";
import { quoteBuckets } from "@/lib/quote-limits";

/**
 * The customer's pay page (Phase 14 step 3; D156f; step3-critique C10,
 * C11): what `balance_by_token` returns, parsed at the trust boundary with
 * its two key sets pinned, the words for every state, the return marker,
 * and the page's own limits. The RPC itself is tests/db/balance-links.test.ts.
 */

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";

/** What the RPC returns for an open link (numbers, as jsonb gives them). */
const openPayload = {
  status: "open",
  shop_name: "BICII",
  job_number: "J-000042",
  bike: "Brompton C Line",
  first_name: "Mei",
  currency: "SGD",
  lines: [
    { description: "Labour", quantity: 1, line_total: 80 },
    { description: "Brake pads", quantity: 2, line_total: 25.5 },
  ],
  job_total: 105.5,
  paid: 30,
  refunded: 0,
  paid_ahead: 0,
  balance_due: 75.5,
  payment: "due",
};

const open = (over: Partial<Record<keyof typeof openPayload, unknown>> = {}): OpenBalance => {
  const view = parseBalanceView({ ...openPayload, ...over });
  if (view?.status !== "open") throw new Error("expected an open bill");
  return view;
};

describe("isBalanceToken (D156c)", () => {
  it("accepts 43 base64url characters only", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isBalanceToken(TOKEN)).toBe(true);
    for (const bad of [
      "",
      TOKEN.slice(1),
      `${TOKEN}a`,
      `${TOKEN.slice(1)}=`,
      `${TOKEN.slice(1)}/`,
      `${TOKEN.slice(1)}.`,
    ]) {
      expect(isBalanceToken(bad), bad).toBe(false);
    }
  });
});

describe("parseBalanceView (D156f): the two key sets", () => {
  it("pins the open bill's twelve keys and the closed link's two", () => {
    expect(BALANCE_OPEN_KEYS).toEqual([
      "balance_due",
      "bike",
      "currency",
      "first_name",
      "job_number",
      "job_total",
      "lines",
      "paid",
      "paid_ahead",
      "payment",
      "refunded",
      "shop_name",
      "status",
    ]);
    expect(BALANCE_CLOSED_KEYS).toEqual(["job_number", "status"]);
    expect(Object.keys(open()).sort()).toEqual(BALANCE_OPEN_KEYS);
    for (const line of open().lines) {
      expect(Object.keys(line).sort()).toEqual(["description", "line_total", "quantity"]);
    }
  });

  it("reads an open bill with money and quantities as strings, never computed", () => {
    expect(open()).toEqual({
      status: "open",
      shop_name: "BICII",
      job_number: "J-000042",
      bike: "Brompton C Line",
      first_name: "Mei",
      currency: "SGD",
      lines: [
        { description: "Labour", quantity: "1", line_total: "80" },
        { description: "Brake pads", quantity: "2", line_total: "25.5" },
      ],
      job_total: "105.5",
      paid: "30",
      refunded: "0",
      paid_ahead: "0",
      balance_due: "75.5",
      payment: "due",
    });
    // Strings (numeric as text) pass through unchanged.
    expect(open({ balance_due: "75.50", job_total: "105.50" })).toMatchObject({
      balance_due: "75.50",
      job_total: "105.50",
    });
    // An empty bike (concat_ws of nothing) and no first name are allowed.
    expect(open({ bike: null, first_name: null })).toMatchObject({ bike: null, first_name: null });
    expect(open({ lines: [] }).lines).toEqual([]);
  });

  it("keeps only the pinned keys: anything else the payload carries is dropped", () => {
    const view = open({
      // Not in the contract: never rendered, never kept.
      ...({
        serial_number: "SN-PIN-1",
        work_order_id: "00000000-0000-4000-8000-000000000001",
      } as object),
    });
    expect(Object.keys(view).sort()).toEqual(BALANCE_OPEN_KEYS);
    const line = open({
      lines: [{ description: "Wheelset", quantity: 1, line_total: 300, unit_id: "U-000001" }],
    }).lines[0];
    expect(Object.keys(line).sort()).toEqual(["description", "line_total", "quantity"]);
    expect(
      Object.keys(
        parseBalanceView({ status: "withdrawn", job_number: "J-1", first_name: "Mei" }) ?? {},
      ).sort(),
    ).toEqual(BALANCE_CLOSED_KEYS);
  });

  it("reads withdrawn, expired and closed links as their state and job only", () => {
    for (const status of ["withdrawn", "expired", "closed"] as const) {
      expect(parseBalanceView({ status, job_number: "J-000042" })).toEqual({
        status,
        job_number: "J-000042",
      });
    }
  });

  it("gives null for an unknown token or a shape it does not know", () => {
    expect(parseBalanceView(null)).toBeNull();
    expect(parseBalanceView(undefined)).toBeNull();
    expect(parseBalanceView("open")).toBeNull();
    expect(parseBalanceView({ status: "open", job_number: "J-1" })).toBeNull();
    expect(parseBalanceView({ status: "answered", job_number: "J-1" })).toBeNull();
    expect(parseBalanceView({ status: "withdrawn" })).toBeNull();
    expect(parseBalanceView({ ...openPayload, payment: "paid" })).toBeNull();
    expect(parseBalanceView({ ...openPayload, balance_due: null })).toBeNull();
    expect(parseBalanceView({ ...openPayload, lines: [{ description: "x" }] })).toBeNull();
    expect(parseBalanceView({ ...openPayload, lines: null })).toBeNull();
  });
});

describe("the pay page's words (D156f; step3-app-spec §2)", () => {
  it("a link that is not valid", () => {
    expect(NOT_VALID_NOTICE).toEqual({
      title: "This link is not valid",
      body: "Check you opened the whole link, or ask the shop for a new one.",
    });
  });

  it("withdrawn, expired and closed links say what to do, with the job only", () => {
    expect(balanceNotice({ status: "withdrawn", job_number: "J-000042" })).toEqual({
      title: "Your bill for job J-000042",
      body: "This payment link was replaced or stopped. Ask the shop for a new one.",
    });
    expect(balanceNotice({ status: "expired", job_number: "J-000042" })).toEqual({
      title: "Your bill for job J-000042",
      body: "This payment link has expired. Ask the shop for a new one.",
    });
    expect(balanceNotice({ status: "closed", job_number: "J-000042" })).toEqual({
      title: "Your bill for job J-000042",
      body: "This job has changed. Ask the shop how to pay.",
    });
  });

  it("says what is left to do for each payment state; due has the Pay button instead", () => {
    expect(paymentNote(open({ payment: "due" }))).toBeNull();
    expect(paymentNote(open({ payment: "processing" }))).toEqual([
      "Your payment is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again.",
    ]);
    expect(paymentNote(open({ payment: "too_small", balance_due: "0.30" }))).toEqual([
      "Less than $0.50 is left; pay it at the shop.",
    ]);
    expect(paymentNote(open({ payment: "too_large" }))).toEqual([
      "This bill is too large to pay online; pay it at the shop.",
    ]);
    expect(
      paymentNote(open({ payment: "nothing_due", balance_due: "0", paid_ahead: "0" })),
    ).toEqual(["Nothing is left to pay. Thank you."]);
    // Paid ahead: a value from Postgres, compared, never computed.
    expect(
      paymentNote(open({ payment: "nothing_due", balance_due: 0, paid_ahead: "0.01" })),
    ).toEqual([
      "Nothing is left to pay. Thank you.",
      "You have paid more than the bill; the shop will sort out the difference.",
    ]);
    expect(
      paymentNote(open({ payment: "nothing_due", balance_due: 0, paid_ahead: 12.5 })),
    ).toHaveLength(2);
  });

  it("balanceReturn takes Stripe's two returns only (display, never proof of payment)", () => {
    expect(balanceReturn("returned")).toBe("returned");
    expect(balanceReturn("cancelled")).toBe("cancelled");
    expect(balanceReturn("paid")).toBeNull();
    expect(balanceReturn("")).toBeNull();
    expect(balanceReturn(undefined)).toBeNull();
    expect(balanceReturn(["returned", "cancelled"])).toBeNull();
  });
});

describe("balanceBuckets (the pay page's own limits)", () => {
  it("counts views and Pay per client and per token, never either in clear", () => {
    expect(BALANCE_WINDOW_SECONDS).toBe(300);
    expect(BALANCE_LIMITS).toEqual({
      view: { client: 60, token: 60 },
      pay: { client: 10, token: 10 },
    });
    for (const attempt of ["view", "pay"] as const) {
      const buckets = balanceBuckets(attempt, "203.0.113.9", TOKEN);
      expect(buckets.map((b) => b.limit)).toEqual([
        BALANCE_LIMITS[attempt].client,
        BALANCE_LIMITS[attempt].token,
      ]);
      expect(buckets[0].key).toMatch(new RegExp(`^balance-${attempt}:client:[0-9a-f]{64}$`));
      expect(buckets[1].key).toMatch(new RegExp(`^balance-${attempt}:token:[0-9a-f]{64}$`));
      for (const b of buckets) {
        // public.note_sign_in_attempt takes keys of 1 to 200 characters.
        expect(b.key.length).toBeGreaterThan(0);
        expect(b.key.length).toBeLessThanOrEqual(200);
        expect(b.key).not.toContain("203.0.113.9");
        expect(b.key).not.toContain(TOKEN);
      }
    }
  });

  it("salts the token with balance-limit:, apart from the stored hash and the quote page's keys", () => {
    const [, token] = balanceBuckets("pay", null, TOKEN);
    const salted = createHash("sha256").update(`balance-limit:${TOKEN}`).digest("hex");
    const stored = createHash("sha256").update(TOKEN).digest("hex");
    expect(token.key).toBe(`balance-pay:token:${salted}`);
    expect(token.key).not.toContain(stored);
    // The same token on the quote page counts in its own buckets.
    const quote = quoteBuckets("pay", null, TOKEN);
    expect(token.key).not.toBe(quote[1].key);
    expect(token.key.split(":")[2]).not.toBe(quote[1].key.split(":")[2]);
    expect(balanceBuckets("pay", null, TOKEN)[0].key).not.toBe(quote[0].key);
  });

  it("keeps views and Pay apart, shares an unknown client, and scales by the multiplier", () => {
    expect(balanceBuckets("view", null, TOKEN)[0].key).not.toBe(
      balanceBuckets("pay", null, TOKEN)[0].key,
    );
    expect(balanceBuckets("view", null, TOKEN)[0].key).toBe(
      balanceBuckets("view", null, "x")[0].key,
    );
    expect(balanceBuckets("view", "1.2.3.4", TOKEN, 1000).map((b) => b.limit)).toEqual([
      60_000, 60_000,
    ]);
  });
});

describe("paidLabel (U2-11)", () => {
  it("says how much was refunded once anything was, since paid is net of it", () => {
    expect(paidLabel(open())).toBe("Paid so far");
    expect(paidLabel(open({ refunded: "0.00" }))).toBe("Paid so far");
    expect(paidLabel(open({ refunded: "20.00" }))).toBe("Paid so far (after $20.00 refunded)");
    // A payload from before the key: nothing refunded.
    const before = Object.fromEntries(
      Object.entries(openPayload).filter(([key]) => key !== "refunded"),
    );
    const view = parseBalanceView(before);
    if (view?.status !== "open") throw new Error("expected an open bill");
    expect(view.refunded).toBe("0");
    expect(paidLabel(view)).toBe("Paid so far");
  });
});
