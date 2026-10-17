// @vitest-environment node
/**
 * The logger's redaction (ADR-001 A8; Phase 14): URLs carry the quote
 * token, and keys, secrets and Stripe signatures must never reach a log
 * line, even when a caller passes them by mistake.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";

import { loggerOptions } from "@/lib/logger";

/** The production options, at info, written to a captured stream. */
function capture() {
  const lines: string[] = [];
  const log = pino({ ...loggerOptions, level: "info" }, { write: (l: string) => lines.push(l) });
  return { log, lines, last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown> };
}

const TOKEN_URL = "https://admin.example.com/quote/SECRET_TOKEN?deposit=returned";

describe("logger redaction", () => {
  it("redacts Stripe URLs, keys, secrets and signatures at the top level", () => {
    const { log, lines, last } = capture();
    log.info(
      {
        url: TOKEN_URL,
        successUrl: TOKEN_URL,
        cancelUrl: TOKEN_URL,
        checkoutUrl: TOKEN_URL,
        secretKey: "rk_test_NotARealKey",
        webhookSecret: "whsec_NotARealSecret",
        headers: { "stripe-signature": "t=1,v1=abc", "content-type": "application/json" },
        eventId: "evt_1",
      },
      "stripe",
    );
    const line = last();
    for (const key of [
      "url",
      "successUrl",
      "cancelUrl",
      "checkoutUrl",
      "secretKey",
      "webhookSecret",
    ]) {
      expect(line[key], key).toBe("[redacted]");
    }
    expect(line.headers).toEqual({
      "stripe-signature": "[redacted]",
      "content-type": "application/json",
    });
    expect(line.eventId).toBe("evt_1");
    const text = lines.join("\n");
    for (const banned of ["SECRET_TOKEN", "rk_test_", "whsec_", "v1=abc"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("redacts them one level down too", () => {
    const { log, lines, last } = capture();
    log.info(
      {
        input: { successUrl: TOKEN_URL, cancelUrl: TOKEN_URL, url: TOKEN_URL },
        config: { secretKey: "sk_live_NotARealKey", webhookSecret: "whsec_x" },
        delivery: { headers: { "stripe-signature": "t=1,v1=abc" } },
      },
      "stripe",
    );
    expect(last()).toMatchObject({
      input: { successUrl: "[redacted]", cancelUrl: "[redacted]", url: "[redacted]" },
      config: { secretKey: "[redacted]", webhookSecret: "[redacted]" },
      delivery: { headers: { "stripe-signature": "[redacted]" } },
    });
    expect(lines.join("\n")).not.toContain("SECRET_TOKEN");
  });

  it("redacts a payment link at the top level and one level down (step 3; C13)", () => {
    const { log, lines, last } = capture();
    const link = "https://admin.example.com/pay/SECRET_TOKEN";
    log.info({ link, result: { link, amount: "380.00" }, linkId: "l-1" }, "balance link sent");
    expect(last()).toMatchObject({
      link: "[redacted]",
      result: { link: "[redacted]", amount: "380.00" },
      // Ids are not links: only the `link` key itself is redacted.
      linkId: "l-1",
    });
    expect(lines.join("\n")).not.toContain("SECRET_TOKEN");
  });

  it("still redacts what it redacted before Phase 14", () => {
    const { log, last } = capture();
    log.info({ token: "t", password: "p", authorization: "a", serviceRoleKey: "s" }, "x");
    expect(last()).toMatchObject({
      token: "[redacted]",
      password: "[redacted]",
      authorization: "[redacted]",
      serviceRoleKey: "[redacted]",
    });
  });
});
