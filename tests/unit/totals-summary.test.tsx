import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TotalsSummary } from "@/components/domain/totals-summary";
import type { Totals } from "@/lib/domain/lines";
import type { WorkOrderYield } from "@/lib/reports";

const saleOnly: Totals = { currency: "SGD", lineCount: 2, saleTotal: "60.00" };

const withCosts: Totals = {
  ...saleOnly,
  costs: {
    costTotal: "35.00",
    yieldTotal: "25.00",
    ccShare: "12.00",
    yieldAfterCc: "13.00",
    costPendingCount: 0,
    stripeFees: "0.00",
    stripeFeesBorne: "0.00",
    ccAfterFees: "12.00",
    yieldAfterFees: "13.00",
    stripeFeePendingCount: 0,
  },
};

/** D273: the same job paid by card, Stripe keeping $4.10 less GST. */
const withFees = (patch: Partial<NonNullable<Totals["costs"]>> = {}): Totals => ({
  ...saleOnly,
  costs: {
    ...withCosts.costs!,
    stripeFees: "4.10",
    stripeFeesBorne: "4.10",
    ccAfterFees: "7.90",
    yieldAfterFees: "13.00",
    ...patch,
  },
});

const report = (patch: Partial<WorkOrderYield> = {}): WorkOrderYield => ({
  workOrderId: "d5000000-0000-4000-8000-000000000004",
  jobNumber: "J-000014",
  status: "collected",
  currency: "SGD",
  lineCount: 2,
  saleTotal: "60.00",
  costTotal: "35.00",
  yieldTotal: "25.00",
  cultCommons: "12.00",
  biciiAfterCc: "13.00",
  lossLineCount: 1,
  lossTotal: "-15.00",
  ccRates: ["0.3000"],
  recognizedAt: "2026-10-03T08:00:00Z",
  recognizedDay: "2026-10-03",
  costPendingCount: 0,
  stripeFees: "0.00",
  stripeFeesBorne: "0.00",
  ccAfterFees: "12.00",
  biciiAfterFees: "13.00",
  stripeFeePendingCount: 0,
  ...patch,
});

const totals = () => screen.getByLabelText("Totals");

describe("TotalsSummary (the job yield panel)", () => {
  it("shows a mechanic without view_costs the sale total only", () => {
    render(<TotalsSummary totals={saleOnly} />);
    expect(totals()).toHaveTextContent("Total$60.00");
    expect(totals()).not.toHaveTextContent(/Cost|Yield|Cult Commons/);
    expect(screen.queryByText(/Counted in reports|sold at a loss/)).toBeNull();
  });

  it("without a report keeps Phase 3's summary and shared rate", () => {
    render(<TotalsSummary totals={withCosts} ccRate="0.3000" />);
    expect(totals()).toHaveTextContent("Cult Commons (30%)$12.00");
    expect(totals()).toHaveTextContent("BICII yield after Cult Commons$13.00");
    expect(screen.queryByText(/Counted in reports/)).toBeNull();
  });

  it("adds the loss note and the recognition day from the report", () => {
    render(<TotalsSummary totals={withCosts} ccRate="0.3000" report={report()} />);
    expect(totals()).toHaveTextContent("Cult Commons (30%)$12.00");
    expect(
      screen.getByText(
        "1 line sold at a loss: −$15.00. Losses don't reduce Cult Commons on other lines.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Counted in reports on Sat, 3 Oct 2026 (completed)"),
    ).toBeInTheDocument();
  });

  it("labels mixed snapshot rates as a range, over the page's shared rate", () => {
    render(
      <TotalsSummary
        totals={withCosts}
        ccRate={null}
        report={report({ ccRates: ["0.2500", "0.3000"], lossLineCount: 0, lossTotal: "0.00" })}
      />,
    );
    expect(totals()).toHaveTextContent("Cult Commons (25–30%)$12.00");
    expect(screen.queryByText(/sold at a loss/)).toBeNull();
  });

  it("says an open or reopened job counts once it is completed", () => {
    render(
      <TotalsSummary
        totals={withCosts}
        report={report({ status: "in_progress", recognizedAt: null, recognizedDay: null })}
      />,
    );
    expect(screen.getByText("Counted in reports once the job is completed")).toBeInTheDocument();
  });

  it("says a cancelled job is never counted, not that it will be once completed", () => {
    render(
      <TotalsSummary
        totals={withCosts}
        report={report({ status: "cancelled", recognizedAt: null, recognizedDay: null })}
      />,
    );
    expect(screen.getByText("Not counted in reports (cancelled)")).toBeInTheDocument();
    expect(screen.queryByText(/once the job is completed/)).toBeNull();
  });

  it("D273: shows Stripe fees, what Cult Commons bears and the after-fees figures", () => {
    render(<TotalsSummary totals={withFees()} ccRate="0.3000" report={report()} />);
    expect(totals()).toHaveTextContent("Cult Commons (30%)$12.00");
    expect(totals()).toHaveTextContent("Stripe fees$4.10");
    expect(totals()).toHaveTextContent("Stripe fees borne by Cult Commons−$4.10");
    expect(totals()).toHaveTextContent("Cult Commons after Stripe fees$7.90");
    expect(totals()).toHaveTextContent("BICII yield after Cult Commons and Stripe fees$13.00");
    expect(screen.queryByText(/Provisional: Stripe/)).toBeNull();
    expect(screen.queryByText(/when the job is completed/)).toBeNull();
  });

  it("D273: fees above the share leave Cult Commons at 0 and the rest on BICII", () => {
    render(
      <TotalsSummary
        totals={withFees({
          stripeFees: "15.00",
          stripeFeesBorne: "12.00",
          ccAfterFees: "0.00",
          yieldAfterFees: "10.00",
        })}
        report={report()}
      />,
    );
    expect(totals()).toHaveTextContent("Stripe fees borne by Cult Commons−$12.00");
    expect(totals()).toHaveTextContent("Cult Commons after Stripe fees$0.00");
    expect(totals()).toHaveTextContent("BICII yield after Cult Commons and Stripe fees$10.00");
  });

  it("D273: a fee not read yet is provisional; an open job deducts at completion; a cancelled one never", () => {
    const { unmount } = render(
      <TotalsSummary
        totals={withFees({ stripeFeePendingCount: 1 })}
        report={report({ status: "in_progress", recognizedAt: null, recognizedDay: null })}
      />,
    );
    expect(
      screen.getByText(
        "Provisional: Stripe has not reported the fee on 1 payment yet, so Cult Commons after Stripe fees may still go down.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Stripe fees come off Cult Commons when the job is completed."),
    ).toBeInTheDocument();
    unmount();
    render(
      <TotalsSummary
        totals={withFees({ stripeFeesBorne: "0.00", ccAfterFees: "12.00", yieldAfterFees: "8.90" })}
        report={report({ status: "cancelled", recognizedAt: null, recognizedDay: null })}
      />,
    );
    expect(
      screen.getByText("This job is cancelled, so BICII bears its Stripe fees, not Cult Commons."),
    ).toBeInTheDocument();
  });

  it("D273: a fee not reported yet reads as such, never as a known $0.00 or −$0.00", () => {
    render(
      <TotalsSummary
        totals={withFees({
          stripeFees: "0.00",
          stripeFeesBorne: "0.00",
          ccAfterFees: "12.00",
          stripeFeePendingCount: 1,
        })}
        report={report()}
      />,
    );
    expect(totals()).toHaveTextContent("Stripe feesNot reported yet");
    expect(totals()).not.toHaveTextContent("borne by Cult Commons");
    expect(totals()).not.toHaveTextContent("−$0.00");
    expect(screen.getByText(/Provisional: Stripe has not reported the fee/)).toBeInTheDocument();
  });

  it("D273: a cancelled job's Cult Commons after fees is not counted", () => {
    render(
      <TotalsSummary
        totals={withFees({ stripeFeesBorne: "0.00", ccAfterFees: "12.00", yieldAfterFees: "8.90" })}
        report={report({ status: "cancelled", recognizedAt: null, recognizedDay: null })}
      />,
    );
    expect(totals()).toHaveTextContent("Cult Commons after Stripe feesNot counted (cancelled)");
    expect(totals()).not.toHaveTextContent("borne by Cult Commons");
  });

  it("without fees keeps the plain BICII row", () => {
    render(<TotalsSummary totals={withCosts} />);
    expect(totals()).not.toHaveTextContent(/Stripe/);
  });

  it("never shows report text to someone without costs, even if a report were passed", () => {
    render(<TotalsSummary totals={saleOnly} report={report()} />);
    expect(screen.queryByText(/Counted in reports|sold at a loss/)).toBeNull();
  });
});
