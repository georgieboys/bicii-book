/**
 * The Reports period tiles (SummaryTiles) with D273 Stripe fees: the fee
 * tile, the Cult Commons hint and the BICII label say the fees came off,
 * the provisional note shows while a fee is unread, and none of it shows
 * without View costs.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SummaryTiles } from "@/components/domain/reports/report-sections";
import type { PeriodSummary } from "@/lib/period-reports";

const summary = (patch: Partial<PeriodSummary> = {}): PeriodSummary => ({
  basis: "sale",
  from: "2026-11-01",
  to: "2026-11-30",
  currency: "SGD",
  lineCount: 1,
  jobCount: 1,
  saleCount: 0,
  saleTotal: "40.00",
  costTotal: "0.00",
  yieldTotal: "40.00",
  cultCommons: "12.00",
  afterCc: "28.00",
  lossLineCount: 0,
  costPendingLines: 0,
  stripeFees: "0.00",
  stripeFeesBorne: "0.00",
  stripeFeePendingJobs: 0,
  refundsTotal: null,
  refundCount: null,
  consignmentSales: null,
  consignmentSalesTotal: null,
  newConsignorLiability: null,
  settlementsPaid: null,
  purchasesReceived: null,
  excludedForeignLineCount: 0,
  ...patch,
});

const figures = () => screen.getByRole("group", { name: "Period figures" });

describe("SummaryTiles (D273 Stripe fees)", () => {
  it("without fees keeps the plain tiles", () => {
    render(<SummaryTiles summary={summary()} showCosts />);
    expect(figures()).not.toHaveTextContent(/Stripe/);
    expect(figures()).toHaveTextContent("BICII after Cult Commons");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("with fees: the fee tile, the hint and the BICII label say the fees came off", () => {
    render(
      <SummaryTiles
        summary={summary({
          stripeFees: "15.00",
          stripeFeesBorne: "12.00",
          cultCommons: "0.00",
          afterCc: "25.00",
        })}
        showCosts
      />,
    );
    expect(figures()).toHaveTextContent("Stripe fees");
    expect(figures()).toHaveTextContent("$15.00");
    expect(figures()).toHaveTextContent("less $12.00 of Stripe fees");
    expect(figures()).toHaveTextContent("BICII after Cult Commons and Stripe fees");
  });

  it("a fee Stripe has not reported yet makes the period provisional", () => {
    render(<SummaryTiles summary={summary({ stripeFeePendingJobs: 2 })} showCosts />);
    expect(
      screen.getByText(
        "Provisional: Stripe has not reported the fees on 2 jobs yet, so Cult Commons may still go down.",
      ),
    ).toBeInTheDocument();
  });

  it("shows none of it without View costs", () => {
    render(
      <SummaryTiles
        summary={summary({
          costTotal: null,
          yieldTotal: null,
          cultCommons: null,
          afterCc: null,
          stripeFees: null,
          stripeFeesBorne: null,
          stripeFeePendingJobs: 0,
        })}
        showCosts={false}
      />,
    );
    expect(figures()).not.toHaveTextContent(/Stripe|Cult Commons/);
    expect(screen.queryByText(/Provisional: Stripe/)).toBeNull();
  });
});
