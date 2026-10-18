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
 * The `err` serializer: type, message, code and stack only. Postgres puts
 * the failing row ("Failing row contains (…)", every column of it) or the
 * duplicate key's value in DETAIL, which PostgREST returns as `details`,
 * and DbError and PostgrestError carry it and `hint` as own properties;
 * pino's standard serializer copies every own property, so a customer's
 * or consignor's details would reach the log. A string passes through.
 */
export function errSerializer(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return err;
  const e = err as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
  const out: Record<string, unknown> = {
    type: typeof e.name === "string" ? e.name : (err.constructor?.name ?? "Error"),
    message: typeof e.message === "string" ? e.message : String(err),
  };
  if (typeof e.code === "string" || typeof e.code === "number") out.code = e.code;
  if (typeof e.stack === "string") out.stack = e.stack;
  return out;
}

/**
 * A request path safe to log: the token segment of a customer link
 * (/quote/<token>, /pay/<token>) masked and the query dropped (it carries
 * Stripe's return markers and staff search terms). R-081.
 */
export function loggablePath(path: string): string {
  const pathname = path.split("?", 1)[0];
  return pathname.replace(/^\/(quote|pay)\/[^/]+/, "/$1/[token]");
}

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
  serializers: { err: errSerializer },
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
