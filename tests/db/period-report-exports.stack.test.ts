/**
 * The period-report reads and export pagers of the app (Phase 9 step 2;
 * src/lib/domain/period-reports.ts, src/lib/domain/report-exports.ts)
 * against the devstack's seeded database, through PostgREST as the app
 * calls it:
 *
 *   * the breakdown keyset: walking report_breakdown two groups at a time
 *     with the cursor passed back as received (sale_total never rounded)
 *     visits every group exactly once, in the same order as one page;
 *   * the export pagers' consistency check: the groups' line counts add
 *     up to report_period_summary's, the lines of one group number its
 *     line_count, and the breakdown export ends with the summary's own
 *     TOTAL row (never a sum made in TypeScript);
 *   * a caller without view_financial_reports (view_costs alone included)
 *     is refused by the database (42501); the by-mechanic activity is
 *     for every active staff member, its lead-less row "Unassigned".
 *
 * Needs the devstack (`npm run db:reset && npm run devstack:start`); skips
 * otherwise, unless BICII_REQUIRE_STACK=1. Read-only.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { shiftShopDay, shopToday } from "@/lib/dates";
import {
  getAllBreakdownForExport,
  getAllLineItemsForExport,
  getBreakdown,
  getPeriodSummary,
} from "@/lib/domain/period-reports";
import { EXPORT_FETCHERS } from "@/lib/domain/report-exports";
import type { BreakdownCursor, ReportParams } from "@/lib/period-reports";
import type { ServerSupabase } from "@/lib/supabase/server";

import { REPORT_JOB } from "../fixtures/ids";
import { stackReachable, staffClient } from "./stack";

const reachable = await stackReachable("period report exports");

/** A month around the seeded history (the seed's anchor is the reset day). */
const TO = shopToday();
const FROM = shiftShopDay(TO, -40);
const REPORT: ReportParams = {
  period: "custom",
  anchor: TO,
  from: FROM,
  to: TO,
  basis: "sale",
  by: "job",
};

let admin: ServerSupabase;
let mechanic1: ServerSupabase;
let mechanic2: ServerSupabase;

beforeAll(async () => {
  if (!reachable) return;
  // supabase-js and @supabase/ssr build the same client class.
  admin = (await staffClient("admin")) as unknown as ServerSupabase;
  mechanic1 = (await staffClient("mechanic1")) as unknown as ServerSupabase;
  mechanic2 = (await staffClient("mechanic2")) as unknown as ServerSupabase;
});

describe.skipIf(!reachable)("period report reads and exports", () => {
  it("walks the breakdown keyset two groups at a time without losing or repeating one", async () => {
    for (const dimension of ["job", "product", "mechanic"] as const) {
      const q = { ...REPORT, dimension, currency: "SGD" };
      const whole = await getBreakdown(admin, { ...q, limit: 500 });
      expect(whole.more).toBe(false);
      expect(whole.items.length).toBeGreaterThan(2);
      const walked: string[] = [];
      let after: BreakdownCursor | null = null;
      for (let i = 0; i < 100; i++) {
        const page: Awaited<ReturnType<typeof getBreakdown>> = await getBreakdown(admin, {
          ...q,
          limit: 2,
          after,
        });
        walked.push(...page.items.map((r) => r.key));
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      expect(walked).toEqual(whole.items.map((r) => r.key));
    }
  });

  it("exports every group with the summary's TOTAL row, and the counts agree", async () => {
    const summary = await getPeriodSummary(admin, FROM, TO, "sale");
    const { rows, summary: same } = await getAllBreakdownForExport(admin, {
      ...REPORT,
      dimension: "job",
    });
    expect(same).toEqual(summary);
    expect(rows.reduce((n, r) => n + r.lineCount, 0)).toBe(summary.lineCount);
    expect(rows.map((r) => r.key)).toContain(REPORT_JOB.combined);
    const csvRows = await EXPORT_FETCHERS.breakdown(admin, { ...REPORT, key: null });
    expect(csvRows.at(-1)).toMatchObject({
      dimension: "TOTAL",
      lineCount: summary.lineCount,
      saleTotal: summary.saleTotal,
      cultCommons: summary.cultCommons,
    });
  });

  it("exports the lines of the period and of one group, matching their counts", async () => {
    const summary = await getPeriodSummary(admin, FROM, TO, "sale");
    const all = await getAllLineItemsForExport(admin, { from: FROM, to: TO, basis: "sale" });
    // D273, D274: fee entries are listed with the lines but are not lines
    // (the seed's online sale has a pending Shopify fee entry).
    const isFee = (l: { lineType: string }) =>
      l.lineType === "stripe_fee" || l.lineType === "shopify_fee";
    expect(all.filter((l) => !isFee(l))).toHaveLength(summary.lineCount);
    const combined = await getAllLineItemsForExport(admin, {
      from: FROM,
      to: TO,
      basis: "sale",
      dimension: "job",
      key: REPORT_JOB.combined,
    });
    expect(combined).toHaveLength(2);
    expect(new Set(combined.map((l) => l.documentNumber))).toEqual(new Set(["J-000013"]));
    // Newest basis date first.
    const dates = all.map((l) => Date.parse(l.basisAt));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it("refuses the financial reads without view_financial_reports; activity is for all staff", async () => {
    // mechanic1 holds view_costs as an exception but not view_financial_reports.
    await expect(getPeriodSummary(mechanic1, FROM, TO, "sale")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(getPeriodSummary(mechanic2, FROM, TO, "sale")).rejects.toMatchObject({
      code: "42501",
    });
    const rows = await EXPORT_FETCHERS.mechanics(mechanic2, { ...REPORT, key: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.staffId !== null || r.name === "Unassigned")).toBe(true);
  });
});
