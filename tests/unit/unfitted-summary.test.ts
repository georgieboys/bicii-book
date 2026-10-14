// @vitest-environment node
/**
 * getUnfittedSummary (src/lib/domain/indent.ts; R-082): the job page's memo
 * under the Lines total reads public.work_order_unfitted_requests, which
 * counts and sums the approved items not on the bill in Postgres. Money
 * leaves as Postgres computed it; none gives null; a read that fails gives
 * null (logged by code) so the job page never breaks over a memo. The view
 * itself is tests/db/indent-parts.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const error = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error, warn: vi.fn(), info: vi.fn() } }));

const { getUnfittedSummary } = await import("@/lib/domain/indent");
import type { ServerSupabase } from "@/lib/supabase/server";

const JOB = "66666666-7777-4888-9999-000000000000";

type Result = { data: unknown; error: { code: string; message: string } | null };

/** A client whose one view resolves to `result`, recording its filters. */
function supabaseWith(result: Result) {
  const filters: unknown[][] = [];
  const client = {
    from(table: string) {
      if (table !== "work_order_unfitted_requests") throw new Error(`unexpected table ${table}`);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) {
        builder[m] = (...args: unknown[]) => {
          filters.push([m, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => unknown) => resolve(result);
      return builder;
    },
  };
  return { supabase: client as unknown as ServerSupabase, filters };
}

describe("getUnfittedSummary (R-082)", () => {
  it("returns Postgres's count and total for the job, the money as a fixed-point string", async () => {
    const { supabase, filters } = supabaseWith({
      data: [{ item_count: 2, quoted_total: 265, currency: "SGD" }],
      error: null,
    });
    expect(await getUnfittedSummary(supabase, JOB)).toEqual({
      itemCount: 2,
      quotedTotal: "265.00",
      currency: "SGD",
    });
    expect(filters).toContainEqual(["eq", "work_order_id", JOB]);
  });

  it("is null when nothing approved is waiting to be fitted", async () => {
    const { supabase } = supabaseWith({ data: [], error: null });
    expect(await getUnfittedSummary(supabase, JOB)).toBeNull();
  });

  it("is null, logged by the error's code only, when the read fails", async () => {
    const { supabase } = supabaseWith({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    expect(await getUnfittedSummary(supabase, JOB)).toBeNull();
    expect(error).toHaveBeenCalledWith(
      { workOrderId: JOB, code: "42P01" },
      "unfitted indent read failed",
    );
  });
});
