// @vitest-environment node
/**
 * The logger's redaction (ADR-001 A8; Phase 14): URLs carry the quote
 * token, and keys, secrets and Stripe signatures must never reach a log
 * line, even when a caller passes them by mistake.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";

import { loggablePath, loggerOptions } from "@/lib/logger";

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

describe("logger error serializer (audit 2026-10-18)", () => {
  /** What PostgREST returns for a CHECK violation: DETAIL is the whole row. */
  function rowError() {
    const e = new Error('new row for relation "customers" violates check constraint "c"');
    Object.assign(e, {
      name: "DbError",
      code: "23514",
      details: "Failing row contains (c1, Chloe, chloe@example.com, STAFF-ONLY NOTE)",
      hint: "HINT_VALUE",
    });
    return e;
  }

  it("keeps type, message, code and stack, never details or hint", () => {
    const { log, lines, last } = capture();
    log.warn({ err: rowError(), kind: "validation" }, "action failed");
    const err = last().err as Record<string, unknown>;
    expect(err.type).toBe("DbError");
    expect(err.code).toBe("23514");
    expect(err.message).toContain("customers");
    expect(typeof err.stack).toBe("string");
    expect(Object.keys(err).sort()).toEqual(["code", "message", "stack", "type"]);
    const text = lines.join("\n");
    for (const banned of ["Failing row", "chloe@example.com", "STAFF-ONLY", "HINT_VALUE"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("serializes a plain error object (a PostgREST { error }) the same way", () => {
    const { log, lines, last } = capture();
    log.error({ err: { message: "duplicate key", code: "23505", details: "Key (email)=(a@b.c)" } });
    expect(last().err).toEqual({ type: "Object", message: "duplicate key", code: "23505" });
    expect(lines.join("\n")).not.toContain("a@b.c");
  });

  it("passes a string through", () => {
    const { log, last } = capture();
    log.warn({ err: "shopify call failed" });
    expect(last().err).toBe("shopify call failed");
  });
});

describe("loggablePath (R-081)", () => {
  it("masks a customer link's token and drops the query", () => {
    expect(loggablePath("/quote/SECRET_TOKEN?deposit=returned")).toBe("/quote/[token]");
    expect(loggablePath("/pay/SECRET_TOKEN")).toBe("/pay/[token]");
    expect(loggablePath("/pay/SECRET_TOKEN/x?balance=1")).toBe("/pay/[token]/x");
  });

  it("keeps staff paths but not their query", () => {
    expect(loggablePath("/jobs/abc")).toBe("/jobs/abc");
    expect(loggablePath("/search?q=Chloe")).toBe("/search");
    expect(loggablePath("/reports/quotes")).toBe("/reports/quotes");
  });
});
