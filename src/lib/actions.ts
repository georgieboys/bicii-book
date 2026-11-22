import "server-only";

import { after } from "next/server";
import { unstable_rethrow } from "next/navigation";
import type { Logger } from "pino";
import { z } from "zod";

import type { PermissionKey, StaffDTO, StaffRole } from "@/lib/auth/permissions";
import { authorizeStaff, getCorrelationId, type Session } from "@/lib/auth/session";
import { mapDbError } from "@/lib/db-errors";
import { DomainError } from "@/lib/domain/errors";
import { echoValues, formDataToObject } from "@/lib/form-data";
import { child } from "@/lib/logger";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";

/**
 * What every Server Action returns. `error` is always safe to show; raw
 * database messages never reach the client (src/lib/db-errors.ts).
 */
export type ActionResult<T = null> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      /**
       * The business-error code when an RPC refused (DATA-MODEL §16, e.g.
       * `attachment_object_missing`) or a domain function refused with one
       * (`stale_edit`), so a client can react to that case specifically. A
       * stable code, never a raw database message.
       */
      code?: string;
      /**
       * What a form submitted, so it can render the values again: React
       * resets uncontrolled fields after every form action, whatever the
       * result. Text fields only; never passwords or other secrets
       * (src/lib/form-data.ts). Forms render `defaultValue={values?.x}` (DESIGN.md
       * "Forms").
       */
      values?: Record<string, string>;
    };

export type ActionContext = {
  staff: StaffDTO;
  /** The verified session (userId, email) of the signed-in staff member. */
  session: Session;
  /** RLS-scoped client for the signed-in staff member. */
  supabase: ServerSupabase;
  correlationId: string;
  log: Logger;
};

/**
 * Throw from a handler to fail with a message you chose (already safe to
 * show), optionally per field. Domain functions throw DomainError, which is
 * treated the same way.
 */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export type StaffActionOptions = {
  /** Stable name for logs, e.g. "staff.grant_permission". */
  name: string;
  /** Required permission (from the role or an exception, PLAN D91). */
  permission?: PermissionKey;
  /** Require role admin (admin-only settings: private.require_admin()). */
  admin?: boolean;
  /** Require one of these roles (e.g. refunds: admin or manager, D94). */
  roles?: readonly StaffRole[];
};

/**
 * A Server Action callable directly (`action(input)`) or as a form action
 * with useActionState (`(prevState, formData)`).
 */
export type StaffAction<Input, Data> = {
  (input: Input | FormData): Promise<ActionResult<Data>>;
  (prevState: ActionResult<Data> | null, formData: FormData): Promise<ActionResult<Data>>;
};

/**
 * The Server Action pattern (ADR-001 A2): every action is a public POST
 * endpoint, so it
 *
 *   1. authenticates and authorizes on ONE Supabase client:
 *      authorizeStaff(client, { permission, admin, roles }) — redirect to /login
 *      when signed out, 403 when not allowed (these propagate). React
 *      cache() does not memoise inside an action, so requireStaff() would
 *      verify the session twice; the same client then goes to the handler;
 *   2. validates input with zod (field errors come back, nothing runs);
 *   3. runs the handler, which delegates to one domain function (ADR-001
 *      A2) with the RLS client (writes go through RPCs, which check
 *      authorization again);
 *   4. maps DomainError/ActionError and database errors to safe messages;
 *      a failed FORM submission also returns its non-secret values so the
 *      form can show them again;
 *   5. logs `{ correlationId, actor, action, outcome }` in after(), so
 *      logging never delays the response.
 *
 * Export the result from a "use server" module:
 *
 *   export const grantPermission = staffAction(schema, { name, permission }, handler);
 */
export function staffAction<Schema extends z.ZodType, Data>(
  schema: Schema,
  options: StaffActionOptions,
  handler: (input: z.output<Schema>, ctx: ActionContext) => Promise<Data>,
): StaffAction<z.input<Schema>, Data> {
  const action = async (first: unknown, second?: FormData): Promise<ActionResult<Data>> => {
    const started = Date.now();
    const supabase = await createClient();
    const { staff, session } = await authorizeStaff(supabase, {
      permission: options.permission,
      admin: options.admin,
      roles: options.roles,
    });
    const correlationId = await getCorrelationId();
    const log = child(correlationId, { action: options.name, actor: staff.staffId });

    const raw = second instanceof FormData ? second : first;
    const values = raw instanceof FormData ? echoValues(raw) : undefined;
    const parsed = schema.safeParse(raw instanceof FormData ? formDataToObject(raw) : raw);
    if (!parsed.success) {
      const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>;
      after(() => log.info({ outcome: "invalid", fields: Object.keys(fieldErrors) }, "action"));
      return { ok: false, error: "Check the highlighted fields.", fieldErrors, values };
    }

    try {
      const data = await handler(parsed.data, { staff, session, supabase, correlationId, log });
      after(() => log.info({ outcome: "ok", durationMs: Date.now() - started }, "action"));
      return { ok: true, data };
    } catch (err) {
      // redirect(), forbidden(), notFound() etc. are control flow, not errors.
      unstable_rethrow(err);
      if (err instanceof ActionError || err instanceof DomainError) {
        after(() => log.info({ outcome: "rejected", reason: err.message }, "action"));
        return {
          ok: false,
          error: err.message,
          fieldErrors: err.fieldErrors,
          code: err instanceof DomainError ? err.code : undefined,
          values,
        };
      }
      const mapped = mapDbError(err);
      after(() =>
        log[mapped.kind === "unknown" || mapped.kind === "unavailable" ? "error" : "warn"](
          {
            outcome: "error",
            kind: mapped.kind,
            code: mapped.code,
            reason: mapped.reason,
            err,
            durationMs: Date.now() - started,
          },
          "action failed",
        ),
      );
      return {
        ok: false,
        error: mapped.message,
        code: mapped.kind === "business" ? mapped.reason : undefined,
        values,
      };
    }
  };
  return action as StaffAction<z.input<Schema>, Data>;
}
