import { describe, expect, it, vi } from "vitest";

import { quoteEmail } from "@/lib/indent";
import { RESEND_ENDPOINT, emailConfig, sendEmail } from "@/lib/integrations/email/resend";
import { QUOTE_LIMITS, quoteBuckets } from "@/lib/quote-limits";
import { approvedSummary, isQuoteToken, parseQuoteView } from "@/lib/quote-page";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

const item = (over: Record<string, unknown> = {}) => ({
  id: "6f1c1c1e-0000-4000-8000-000000000001",
  kind: "part",
  description: "Rohloff hub",
  quantity: 2,
  unit_sale_price: 120,
  line_total: 240,
  decision: null,
  ...over,
});

const openQuote = {
  status: "open",
  job_number: "J-000004",
  bike: "Brompton C Line",
  first_name: "Chloe",
  currency: "SGD",
  total: 275,
  sent_at: "2026-10-14T02:00:00+00:00",
  expires_at: "2026-10-21T02:00:00+00:00",
  answered_at: null,
  answered_name: null,
  items: [item()],
};

describe("isQuoteToken (D141)", () => {
  it("accepts 43 base64url characters only", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isQuoteToken(TOKEN)).toBe(true);
    for (const bad of [
      "",
      TOKEN.slice(1),
      `${TOKEN}a`,
      `${TOKEN.slice(1)}=`,
      `${TOKEN.slice(1)}/`,
    ]) {
      expect(isQuoteToken(bad), bad).toBe(false);
    }
  });
});

describe("parseQuoteView (D143)", () => {
  it("reads an open quote, with money and quantities as strings", () => {
    const view = parseQuoteView(openQuote);
    expect(view).toMatchObject({ status: "open", total: "275", first_name: "Chloe" });
    if (view?.status !== "open") throw new Error("expected an open quote");
    expect(view.items[0]).toMatchObject({ quantity: "2", unit_sale_price: "120", decision: null });
  });

  it("reads withdrawn and expired quotes as their state and job only", () => {
    expect(parseQuoteView({ status: "withdrawn", job_number: "J-1" })).toEqual({
      status: "withdrawn",
      job_number: "J-1",
    });
    expect(parseQuoteView({ status: "expired", job_number: "J-1" })?.status).toBe("expired");
  });

  it("gives null for an unknown token or a shape it does not know", () => {
    expect(parseQuoteView(null)).toBeNull();
    expect(parseQuoteView(undefined)).toBeNull();
    expect(parseQuoteView({ status: "open", job_number: "J-1" })).toBeNull();
    expect(parseQuoteView({ ...openQuote, status: "paid" })).toBeNull();
    expect(parseQuoteView({ ...openQuote, items: [item({ decision: "maybe" })] })).toBeNull();
  });

  it("counts approved items for the answered page", () => {
    const view = parseQuoteView({
      ...openQuote,
      status: "answered",
      answered_at: "2026-10-15T02:00:00+00:00",
      answered_name: "Chloe Tan",
      items: [
        item({ decision: "approved" }),
        item({ id: "6f1c1c1e-0000-4000-8000-000000000002", decision: "declined" }),
      ],
    });
    if (view?.status !== "answered") throw new Error("expected an answered quote");
    expect(approvedSummary(view.items)).toEqual({ approved: 1, of: 2 });
  });
});

describe("quoteBuckets (D143)", () => {
  it("counts per client and per token, never either in clear", () => {
    const buckets = quoteBuckets("answer", "203.0.113.9", TOKEN);
    expect(buckets.map((b) => b.limit)).toEqual([
      QUOTE_LIMITS.answer.client,
      QUOTE_LIMITS.answer.token,
    ]);
    expect(buckets[0].key).toMatch(/^quote-answer:client:[0-9a-f]{64}$/);
    expect(buckets[1].key).toMatch(/^quote-answer:token:[0-9a-f]{64}$/);
    for (const b of buckets) {
      expect(b.key).not.toContain("203.0.113.9");
      expect(b.key).not.toContain(TOKEN);
    }
  });

  it("keeps views and answers apart, shares an unknown client, and scales by the multiplier", () => {
    expect(quoteBuckets("view", null, TOKEN)[0].key).not.toBe(
      quoteBuckets("answer", null, TOKEN)[0].key,
    );
    expect(quoteBuckets("view", null, TOKEN)[0].key).toBe(quoteBuckets("view", null, "x")[0].key);
    expect(quoteBuckets("view", "1.2.3.4", TOKEN, 1000)[0].limit).toBe(
      QUOTE_LIMITS.view.client * 1000,
    );
  });
});

describe("quoteEmail (D144)", () => {
  it("says what the WhatsApp message says, with an escaped button link", () => {
    const email = quoteEmail({
      firstName: "Chloe <b>",
      jobNumber: "J-000004",
      link: "https://admin.example/quote/abc?x=1&y=2",
      days: 7,
    });
    expect(email.subject).toBe("Your quote from BICII (job J-000004)");
    expect(email.text).toContain("Please approve or decline each item here:");
    expect(email.html).toContain("Hi Chloe &lt;b&gt;,");
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain('href="https://admin.example/quote/abc?x=1&amp;y=2"');
    expect(email.html).toContain("The link works for 7 days.");
  });
});

describe("sendEmail through Resend (D144)", () => {
  const config = { apiKey: "re_test", from: "BICII <workshop@example.com>" };
  const message = {
    to: "chloe@example.com",
    subject: "s",
    text: "t",
    html: "<p>h</p>",
    idempotencyKey: "quote-1",
  };

  it("is off unless both variables are set", () => {
    expect(emailConfig({})).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: "re_test" })).toBeNull();
    expect(emailConfig({ EMAIL_FROM: "a@b.c" })).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: "re_test", EMAIL_FROM: "a@b.c" })).toEqual({
      apiKey: "re_test",
      from: "a@b.c",
    });
  });

  it("posts one email with the key, the sender and the idempotency key", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));
    await expect(sendEmail(config, message, fetchMock)).resolves.toEqual({
      ok: true,
      id: "email_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Idempotency-Key": "quote-1",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: config.from,
      to: ["chloe@example.com"],
      subject: "s",
      text: "t",
      html: "<p>h</p>",
    });
  });

  it("says rejected for a refused request and unavailable for an outage, never Resend's message", async () => {
    const refused = vi.fn(async () =>
      Response.json({ message: "domain not verified" }, { status: 403 }),
    );
    await expect(sendEmail(config, message, refused)).resolves.toEqual({
      ok: false,
      reason: "rejected",
      status: 403,
    });
    const busy = vi.fn(async () => new Response("", { status: 503 }));
    await expect(sendEmail(config, message, busy)).resolves.toMatchObject({
      reason: "unavailable",
    });
    const limited = vi.fn(async () => new Response("", { status: 429 }));
    await expect(sendEmail(config, message, limited)).resolves.toMatchObject({
      reason: "unavailable",
    });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(sendEmail(config, message, down)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
