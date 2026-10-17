import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Structured JSON logs (ADR-001 A8). Server only: pino is in Next's default
 * `serverExternalPackages`, so it is required at runtime rather than bundled.
 * Emit from actions inside `after()` so logging never delays a response.
 * Critical mutations log `{ correlationId, actor, rpc, entityId, outcome }`.
 *
 * LOG_LEVEL is read directly (not via getServerEnv) so that logging an env
 * error does not itself need a valid environment.
 */
const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

/**
 * The options every log line is written with; exported so
 * tests/unit/logger.test.ts checks the redaction against a captured stream.
 */
export const loggerOptions: LoggerOptions = {
  level,
  base: { app: "bicii-admin" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // "level":"info" rather than "level":30, so log sinks can filter by name
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "headers.cookie",
      "serviceRoleKey",
      // Stripe (Phase 14): URLs carry the quote token; keys, secrets and
      // signatures never reach a log line even by mistake.
      "url",
      "*.url",
      "successUrl",
      "*.successUrl",
      "cancelUrl",
      "*.cancelUrl",
      "checkoutUrl",
      "*.checkoutUrl",
      "secretKey",
      "*.secretKey",
      "webhookSecret",
      "*.webhookSecret",
      'headers["stripe-signature"]',
      '*.headers["stripe-signature"]',
      // Phase 14 step 3: a balance payment link is a bearer link to the
      // customer's bill (R-091); the send action's result carries it.
      "link",
      "*.link",
    ],
    censor: "[redacted]",
  },
};

export const logger: Logger = pino(loggerOptions);

/**
 * Logger bound to one request's correlation ID (the `x-request-id` set by
 * proxy.ts and passed to RPCs as `app.correlation_id`).
 */
export function child(correlationId: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ correlationId, ...bindings });
}
