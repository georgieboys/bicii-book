import { describe, expect, it } from "vitest";

import {
  classifyRates,
  formatRate,
  jobEconomics,
  lineEconomics,
  percentToRate,
  stripeFeeEconomics,
} from "@/lib/cult-commons";

import { FEE_FIXTURES, JOB_FIXTURES, LINE_FIXTURES } from "../fixtures/cult-commons";

describe("Cult Commons is 30% of positive yield after direct costs (SPEC §10)", () => {
  it.each(LINE_FIXTURES)("$name", (f) => {
    const e = lineEconomics({
      quantity: f.quantity,
      unitSalePrice: f.unitSalePrice,
      unitDirectCost: f.unitDirectCost,
      rate: f.rate,
    });
    expect({
      sale: e.sale.toFixed(2),
      cost: e.cost.toFixed(2),
      yield: e.yield.toFixed(2),
      cc: e.ccShare.toFixed(2),
      afterCc: e.yieldAfterCc.toFixed(2),
    }).toEqual({ sale: f.sale, cost: f.cost, yield: f.yield, cc: f.cc, afterCc: f.afterCc });
  });
});

describe("a job's Cult Commons is the sum of its lines' shares (D1)", () => {
  it.each(JOB_FIXTURES)("$name", (job) => {
    const e = jobEconomics(job.lines.map((i) => LINE_FIXTURES[i]));
    expect({
      sale: e.sale.toFixed(2),
      cost: e.cost.toFixed(2),
      yield: e.yield.toFixed(2),
      cc: e.ccShare.toFixed(2),
      afterCc: e.yieldAfterCc.toFixed(2),
    }).toEqual({
      sale: job.sale,
      cost: job.cost,
      yield: job.yield,
      cc: job.cc,
      afterCc: job.afterCc,
    });
  });

  it("an empty job is all zeros", () => {
    const e = jobEconomics([]);
    expect([e.sale, e.cost, e.yield, e.ccShare, e.yieldAfterCc].map((d) => d.toFixed(2))).toEqual(
      Array(5).fill("0.00"),
    );
  });
});

describe("D273: a completed job's Cult Commons bears its Stripe fees, never below 0", () => {
  it.each(FEE_FIXTURES)("$name", (f) => {
    const job = jobEconomics(JOB_FIXTURES[f.job].lines.map((i) => LINE_FIXTURES[i]));
    const e = stripeFeeEconomics(job, f.fees);
    expect({
      fees: e.fees.toFixed(2),
      borne: e.borne.toFixed(2),
      ccAfterFees: e.ccAfterFees.toFixed(2),
      afterFees: e.yieldAfterFees.toFixed(2),
    }).toEqual({
      fees: f.fees,
      borne: f.borne,
      ccAfterFees: f.ccAfterFees,
      afterFees: f.afterFees,
    });
  });
});

describe("Cult Commons rates as staff type them (D21)", () => {
  it("converts a percentage with up to two decimals exactly to a 4 dp fraction", () => {
    expect(percentToRate("30")).toBe("0.3000");
    expect(percentToRate("12.5")).toBe("0.1250");
    expect(percentToRate("12.25")).toBe("0.1225");
    expect(percentToRate(" 33.33 % ")).toBe("0.3333");
    expect(percentToRate("0")).toBe("0.0000");
    expect(percentToRate("100")).toBe("1.0000");
    // 0.1 + 0.2 style floating point never enters: 29.99 % is exactly 0.2999.
    expect(percentToRate("29.99")).toBe("0.2999");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "-1", "100.01", "12.345", "abc", "1e2", "30,5", ".5"]) {
      expect(percentToRate(bad), bad).toBeNull();
    }
  });

  it("shows a fraction as a percentage", () => {
    expect(formatRate("0.3000")).toBe("30%");
    expect(formatRate("0.1225")).toBe("12.25%");
    expect(formatRate(0.125)).toBe("12.5%");
  });

  it("classifies rates the way private.cult_commons_rate_at reads them", () => {
    const now = new Date("2026-10-04T04:00:00Z");
    const rows = [
      { id: "base", rate: "0.3000", effectiveFrom: "1970-01-01T00:00:00Z", cancelledAt: null },
      { id: "mid", rate: "0.2500", effectiveFrom: "2026-09-01T00:00:00Z", cancelledAt: null },
      { id: "next", rate: "0.2000", effectiveFrom: "2026-11-01T00:00:00Z", cancelledAt: null },
      {
        id: "withdrawn",
        rate: "0.1000",
        effectiveFrom: "2026-10-10T00:00:00Z",
        cancelledAt: "2026-10-02T00:00:00Z",
      },
    ];
    expect(classifyRates(rows, now).map((r) => [r.id, r.state])).toEqual([
      ["next", "scheduled"],
      ["withdrawn", "cancelled"],
      ["mid", "current"],
      ["base", "past"],
    ]);
  });

  it("a cancelled rate that has started is never current", () => {
    const now = new Date("2026-10-04T04:00:00Z");
    const rows = [
      { id: "base", rate: "0.3000", effectiveFrom: "1970-01-01T00:00:00Z", cancelledAt: null },
      {
        id: "x",
        rate: "0.1000",
        effectiveFrom: "2026-10-01T00:00:00Z",
        cancelledAt: "2026-09-30T00:00:00Z",
      },
    ];
    expect(classifyRates(rows, now).find((r) => r.state === "current")?.id).toBe("base");
  });
});
