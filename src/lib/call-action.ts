import type { ActionResult } from "@/lib/actions";
import { echoValues } from "@/lib/form-data";

/**
 * The message when a Server Action never arrived or its answer never came
 * back (U1-1): the change may or may not have been saved, as the error
 * page says, so staff check the record before repeating it.
 */
export const UNREACHABLE =
  "Couldn't reach the server, so this may not have been saved. Check the connection, then check the record before trying again.";

/** Next's own control flow (redirect, notFound) travels as a thrown error with a NEXT_ digest. */
function isNextControlFlow(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_")
  );
}

/**
 * Runs a Server Action from a client component and turns a transport
 * failure (offline, a dropped connection, a deploy mid-request) into an
 * ordinary refusal, so the sheet's inline error or toast shows it instead
 * of the whole page falling through to the 500 screen. A form's typed
 * values come back too, as a server refusal returns them, so nothing typed
 * is lost.
 */
export async function callAction<T>(
  run: () => Promise<ActionResult<T>>,
  formData?: FormData,
): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return { ok: false, error: UNREACHABLE, ...(formData ? { values: echoValues(formData) } : {}) };
  }
}
