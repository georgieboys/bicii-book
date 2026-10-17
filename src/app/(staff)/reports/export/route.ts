import { after, type NextRequest } from "next/server";

import { hasPermission } from "@/lib/auth/permissions";
import { getCorrelationId, getSession, getStaff } from "@/lib/auth/session";
import { toCsv } from "@/lib/csv";
import { mapDbError } from "@/lib/db-errors";
import { ExportError } from "@/lib/domain/period-reports";
import { EXPORT_FETCHERS } from "@/lib/domain/report-exports";
import { child } from "@/lib/logger";
import { isReportKey, parseReportParams } from "@/lib/period-reports";
import {
  exportColumns,
  exportFilename,
  exportKindSchema,
  mayExport,
  type ExportKind,
  type ExportRows,
} from "@/lib/report-exports";
import { shopToday } from "@/lib/dates";
import { isUuid } from "@/lib/uuid";
import { createClient } from "@/lib/supabase/server";

/**
 * CSV exports of the period reports (Phase 9; SPEC §19.2, §22; ADR-001 A2,
 * A7): GET /reports/export?kind=…&period=…&date=…|from=…&to=…&basis=…&by=…
 * (&key=… for one group's lines); the Phase 9 step 4 snapshot kinds
 * exceptions, stock and units (&all=1, &product=<uuid> for the last two)
 * ignore the period, as does Phase 14's payments_held (D154c); Phase 14's
 * payments (D154b) reads the period but not the basis.
 *
 * The app's first Route Handler. It is a public endpoint as far as Next is
 * concerned and the (staff) layout does not run for it: proxy.ts sends a
 * signed-out GET to /login (the browser case), and this handler checks
 * again for itself, answering with its own status instead of requireStaff,
 * forbidden() or redirect(): no session → 401, not active staff or lacking
 * the kind's permission → 403, both text/plain with no detail. The
 * database checks a third time (each RPC's guard, D30's NULL columns).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) return plain(401, "Sign in to export reports.");
  const staff = await getStaff();
  const search = request.nextUrl.searchParams;
  const kindParse = exportKindSchema.safeParse(search.get("kind"));
  if (!staff || !staff.active) return plain(403, "Forbidden");
  if (!kindParse.success) return plain(400, "Choose what to export.");
  const kind = kindParse.data;
  if (!mayExport(kind, (p) => hasPermission(staff, p))) return plain(403, "Forbidden");

  const params = parseReportParams(Object.fromEntries(search.entries()), shopToday());
  if (params.error) return plain(400, params.error);
  const key = search.get("key");
  if (kind === "lines" && key !== null && !isReportKey(params.by, key)) {
    return plain(400, "That report row does not exist.");
  }

  // stock and units (Phase 9 step 4): the reconciliation's scope and product.
  const productParam = search.get("product");
  const productId = productParam && isUuid(productParam) ? productParam.toLowerCase() : null;
  if (productParam !== null && productId === null) {
    return plain(400, "That product does not exist.");
  }
  const onlyIssues = search.get("all") !== "1";

  const correlationId = await getCorrelationId();
  const showCosts = hasPermission(staff, "view_costs");
  let rows = 0;
  let outcome = "ok";
  try {
    const supabase = await createClient();
    const data = await fetchRows(kind, supabase, { ...params, key, onlyIssues, productId });
    rows = data.length;
    const csv = toCsv(exportColumns(kind, showCosts), data);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(kind, params, shopToday())}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof ExportError) {
      outcome = err.reason;
      return plain(err.reason === "changed" ? 409 : 413, err.message);
    }
    const mapped = mapDbError(err);
    outcome = mapped.kind;
    if (mapped.kind === "forbidden") return plain(403, "Forbidden");
    if (mapped.kind === "business") return plain(400, mapped.message);
    after(() => {
      child(correlationId).error({ err, kind }, "report export failed");
    });
    return plain(500, mapped.message);
  } finally {
    after(() => {
      child(correlationId).info({ actor: staff.staffId, kind, rows, outcome }, "report export");
    });
  }
}

/** One kind's rows, typed by the kind (EXPORT_FETCHERS). */
function fetchRows<K extends ExportKind>(
  kind: K,
  supabase: Awaited<ReturnType<typeof createClient>>,
  q: Parameters<(typeof EXPORT_FETCHERS)[K]>[1],
): Promise<ExportRows[K][]> {
  return (
    EXPORT_FETCHERS[kind] as (s: typeof supabase, query: typeof q) => Promise<ExportRows[K][]>
  )(supabase, q);
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
