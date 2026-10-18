import type { Instrumentation } from "next";

/**
 * Server observability (ADR-001 A8). Every error Next.js captures on the
 * server (render, Route Handler, Server Action, proxy) is logged as one
 * structured line with the digest the error page shows staff, so a
 * reference read out from a phone finds the stack trace.
 */
export async function register() {
  // Nothing to set up yet. The logger is imported on the first error only,
  // so instrumentation stays cheap for the Edge runtime and cold starts.
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger, loggablePath } = await import("@/lib/logger");
  const error = err instanceof Error ? err : new Error(String(err));
  const digest =
    typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined;
  const requestId = request.headers["x-request-id"];
  logger.error(
    {
      err: error,
      digest,
      correlationId: Array.isArray(requestId) ? requestId[0] : requestId,
      method: request.method,
      path: loggablePath(request.path),
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    "request error",
  );
};
