/**
 * D274 screens: Shopify Payments fees on the Reports tiles, Today's entry
 * list, a job's totals and the sale's Yield card, and the copy helpers they
 * share. Every figure is the database's; these check the words and that
 * an unread fee never reads as a known $0.00.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SummaryTiles } from "@/components/domain/reports/report-sections";
import {
  SaleShopifyFeeRows,
  saleShopifyFeeLine,
  saleShopifyFeeNotes,
} from "@/components/domain/sale-shopify-fees";
import { FinancialEntries } from "@/components/domain/today/financial-entries";
import { TotalsSummary } from "@/components/domain/totals-summary";
import type { Totals } from "@/lib/domain/lines";
import type { SaleShopifyFees } from "@/lib/domain/sales";
import type { PeriodSummary } from "@/lib/period-reports";
import {
  afterFeesLabel,
  exceptionCopy,
  feesLessHint,
  shopifyFeePendingNote,
  type FinancialEntry,
  type WorkOrderYield,
} from "@/lib/reports";

describe("the copy helpers", () => {
  it("say which fees came off, and how many documents are unread", () => {
    expect(feesLessHint("Base", "0.00", "0.00", "SGD")).toBe("Base");
    expect(feesLessHint("Base", "1.00", null, "SGD")).toBe("Base, less $1.00 of Stripe fees");
    expect(feesLessHint("Base", null, "2.50", "SGD")).toBe("Base, less $2.50 of Shopify fees");
    expect(feesLessHint("Base", "1.00", "2.50", "SGD")).toBe(
      "Base, less $1.00 of Stripe fees and $2.50 of Shopify fees",
    );
    expect(afterFeesLabel(false, false)).toBe("BICII after Cult Commons");
    expect(afterFeesLabel(true, false)).toBe("BICII after Cult Commons and Stripe fees");
    expect(afterFeesLabel(false, true)).toBe("BICII after Cult Commons and Shopify fees");
    expect(afterFeesLabel(true, true)).toBe("BICII after Cult Commons and payment fees");
    expect(shopifyFeePendingNote(0, 0)).toBeNull();
    expect(shopifyFeePendingNote(1, 0)).toBe(
      "Provisional: Shopify has not reported the fee on 1 sale yet, so Cult Commons may still go down.",
    );
    expect(shopifyFeePendingNote(2, 1)).toBe(
      "Provisional: Shopify has not reported the fees on 2 sales and 1 job yet, so Cult Commons may still go down.",
    );
  });

  it("an unread sale fee on the exceptions list points at the sale, not the queue", () => {
    const row = {
      severity: "warning",
      entityLabel: "S-000005",
      subjectLabel: "x",
      days: 2,
      quantity: null,
    };
    expect(exceptionCopy("integration_failed", { ...row, entityType: "sale" })).toEqual({
      text: "Shopify fee not read: Cult Commons provisional",
      tone: "waiting",
    });
    expect(
      exceptionCopy("integration_failed", { ...row, entityType: "integration_job" }).text,
    ).toBe("Fix it in the Shopify queue");
  });
});

const summary = (patch: Partial<PeriodSummary> = {}): PeriodSummary => ({
  basis: "sale",
  from: "2026-11-01",
  to: "2026-11-30",
  currency: "SGD",
  lineCount: 1,
  jobCount: 0,
  saleCount: 1,
  saleTotal: "100.00",
  costTotal: "40.00",
  yieldTotal: "60.00",
  cultCommons: "14.80",
  afterCc: "42.00",
  lossLineCount: 0,
  costPendingLines: 0,
  stripeFees: "0.00",
  stripeFeesBorne: "0.00",
  stripeFeePendingJobs: 0,
  shopifyFees: "3.20",
  shopifyFeesBorne: "3.20",
  shopifyFeePendingSales: 0,
  shopifyFeePendingJobs: 0,
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

describe("SummaryTiles (D274 Shopify fees)", () => {
  const figures = () => screen.getByRole("group", { name: "Period figures" });

  it("the Shopify fee tile, the hint and the BICII label", () => {
    render(<SummaryTiles summary={summary()} showCosts />);
    expect(figures()).toHaveTextContent("Shopify fees");
    expect(figures()).toHaveTextContent("less $3.20 of Shopify fees");
    expect(figures()).toHaveTextContent("BICII after Cult Commons and Shopify fees");
    expect(figures()).not.toHaveTextContent(/Stripe/);
  });

  it("both kinds: both tiles, one hint, payment fees", () => {
    render(
      <SummaryTiles summary={summary({ stripeFees: "1.00", stripeFeesBorne: "1.00" })} showCosts />,
    );
    expect(figures()).toHaveTextContent("less $1.00 of Stripe fees and $3.20 of Shopify fees");
    expect(figures()).toHaveTextContent("BICII after Cult Commons and payment fees");
  });

  it("an unread fee makes the period provisional; none of it without View costs", () => {
    const { unmount } = render(
      <SummaryTiles
        summary={summary({ shopifyFees: "0.00", shopifyFeePendingSales: 1 })}
        showCosts
      />,
    );
    expect(
      screen.getByText(
        "Provisional: Shopify has not reported the fee on 1 sale yet, so Cult Commons may still go down.",
      ),
    ).toBeInTheDocument();
    unmount();
    render(
      <SummaryTiles
        summary={summary({
          costTotal: null,
          yieldTotal: null,
          cultCommons: null,
          afterCc: null,
          shopifyFees: null,
          shopifyFeesBorne: null,
          shopifyFeePendingSales: 0,
        })}
        showCosts={false}
      />,
    );
    expect(figures()).not.toHaveTextContent(/Shopify|Cult Commons/);
    expect(screen.queryByText(/Provisional: Shopify/)).toBeNull();
  });
});

describe("FinancialEntries (D274: a sale's Shopify fee entry)", () => {
  const line: FinancialEntry = {
    entryKey: "sl:1",
    source: "sale",
    documentId: "d5000000-0000-4000-8000-000000000099",
    documentNumber: "S-000005",
    channel: "online",
    recognizedAt: "2026-10-05T03:00:00Z",
    lineType: "inventory",
    description: "Tyre",
    quantity: "1.00",
    unitSalePrice: "100.00",
    saleTotal: "100.00",
    costTotal: "40.00",
    yield: "60.00",
    cultCommons: "18.00",
    ccRate: "0.3000",
    isLoss: false,
    costPending: false,
    currency: "SGD",
    entryKind: "line",
    stripeFee: "0.00",
    stripeFeePending: false,
    shopifyFee: "0.00",
    shopifyFeePending: false,
  };
  const fee = (patch: Partial<FinancialEntry> = {}): FinancialEntry => ({
    ...line,
    entryKey: "sfee:1",
    lineType: "shopify_fee",
    description: "Shopify fees",
    quantity: "0.00",
    unitSalePrice: "0.00",
    saleTotal: "0.00",
    yield: "0.00",
    cultCommons: "-3.20",
    ccRate: null,
    entryKind: "shopify_fee",
    shopifyFee: "3.20",
    ...patch,
  });

  it("counts lines only and shows the share and what Cult Commons bore", () => {
    render(<FinancialEntries entries={[line, fee()]} open />);
    expect(screen.getByText("1 line")).toBeInTheDocument();
    const list = screen.getByLabelText("Lines of S-000005");
    expect(within(list).getByText("Shopify fees (less GST)")).toBeInTheDocument();
    expect(within(list).getByText("$3.20")).toBeInTheDocument();
    expect(within(list).getByText("Borne by Cult Commons −$3.20")).toBeInTheDocument();
  });

  it("an unread fee says so, never $0.00", () => {
    render(
      <FinancialEntries
        entries={[line, fee({ shopifyFee: "0.00", cultCommons: "0.00", shopifyFeePending: true })]}
        open
      />,
    );
    const list = screen.getByLabelText("Lines of S-000005");
    expect(within(list).getByText("Not reported yet")).toBeInTheDocument();
    expect(within(list).getByText("Fee not reported yet")).toBeInTheDocument();
  });
});

describe("TotalsSummary (D274: a build job's Shopify share)", () => {
  const totals = (patch: Partial<NonNullable<Totals["costs"]>> = {}): Totals => ({
    currency: "SGD",
    lineCount: 2,
    saleTotal: "390.00",
    costs: {
      costTotal: "120.00",
      yieldTotal: "270.00",
      ccShare: "81.00",
      yieldAfterCc: "189.00",
      costPendingCount: 0,
      stripeFees: "0.00",
      stripeFeesBorne: "0.00",
      ccAfterFees: "77.10",
      yieldAfterFees: "189.00",
      stripeFeePendingCount: 0,
      shopifyFees: "3.90",
      shopifyFeesBorne: "3.90",
      shopifyFeePendingCount: 0,
      ...patch,
    },
  });
  const report = (patch: Partial<WorkOrderYield> = {}): WorkOrderYield => ({
    workOrderId: "d5000000-0000-4000-8000-000000000004",
    jobNumber: "J-000014",
    status: "in_progress",
    currency: "SGD",
    lineCount: 2,
    saleTotal: "390.00",
    costTotal: "120.00",
    yieldTotal: "270.00",
    cultCommons: "81.00",
    biciiAfterCc: "189.00",
    lossLineCount: 0,
    lossTotal: "0.00",
    ccRates: ["0.3000"],
    recognizedAt: null,
    recognizedDay: null,
    costPendingCount: 0,
    stripeFees: "0.00",
    stripeFeesBorne: "0.00",
    ccAfterFees: "77.10",
    biciiAfterFees: "189.00",
    stripeFeePendingCount: 0,
    shopifyFees: "3.90",
    shopifyFeesBorne: "3.90",
    shopifyFeePendingCount: 0,
    ...patch,
  });
  const rows = () =>
    Object.fromEntries(
      within(screen.getByLabelText("Totals"))
        .getAllByRole("term")
        .map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );

  it("the share, what Cult Commons bore and the after-fees rows; deducted at completion", () => {
    render(<TotalsSummary totals={totals()} report={report()} />);
    expect(rows()).toMatchObject({
      "Shopify fees": "$3.90",
      "Shopify fees borne by Cult Commons": "−$3.90",
      "Cult Commons after Shopify fees": "$77.10",
      "BICII yield after Cult Commons and Shopify fees": "$189.00",
    });
    expect(rows()).not.toHaveProperty("Stripe fees");
    expect(
      screen.getByText("Shopify fees come off Cult Commons when the job is completed."),
    ).toBeInTheDocument();
  });

  it("with Stripe fees too, the after rows say fees; an unread share is provisional", () => {
    render(
      <TotalsSummary
        totals={totals({
          stripeFees: "4.10",
          stripeFeesBorne: "4.10",
          shopifyFees: "0.00",
          shopifyFeesBorne: "0.00",
          shopifyFeePendingCount: 1,
        })}
        report={report()}
      />,
    );
    expect(rows()).toMatchObject({
      "Stripe fees": "$4.10",
      "Shopify fees": "Not reported yet",
      "Cult Commons after fees": "$77.10",
    });
    expect(screen.getByText(/Shopify has not reported the fee on this job/)).toBeInTheDocument();
    expect(
      screen.getByText("Fees come off Cult Commons when the job is completed."),
    ).toBeInTheDocument();
  });
});

describe("the sale's Yield card and list line (D274)", () => {
  const fees = (patch: Partial<SaleShopifyFees> = {}): SaleShopifyFees => ({
    shopifyFees: "3.20",
    shopifyFeesBorne: "3.20",
    ccAfterFees: "14.80",
    biciiAfterFees: "42.00",
    buildOrderFees: "0.00",
    pending: false,
    ...patch,
  });
  const card = (f: SaleShopifyFees) => {
    render(
      <dl aria-label="Sale economics">
        <SaleShopifyFeeRows fees={f} currency="SGD" />
      </dl>,
    );
    const dl = screen.getByLabelText("Sale economics");
    return Object.fromEntries(
      within(dl)
        .getAllByRole("term")
        .map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
  };

  it("the fee, what Cult Commons bore and the net figures from the database", () => {
    expect(card(fees())).toEqual({
      "Shopify fees (less GST)": "$3.20",
      "Shopify fees borne by Cult Commons": "−$3.20",
      "Cult Commons after Shopify fees": "$14.80",
      "BICII after Cult Commons and Shopify fees": "$42.00",
    });
    expect(saleShopifyFeeNotes(fees(), "SGD")).toEqual([]);
    expect(saleShopifyFeeLine(fees())).toBe("Shopify fees $3.20 · Cult Commons after fees $14.80");
  });

  it("unread: not reported yet and provisional; a build order's share is named", () => {
    const f = fees({ shopifyFees: "0.00", shopifyFeesBorne: "0.00", pending: true });
    expect(card(f)).toMatchObject({ "Shopify fees (less GST)": "Not reported yet" });
    expect(saleShopifyFeeLine(f)).toBe("Shopify fee not reported yet");
    expect(saleShopifyFeeNotes({ ...f, buildOrderFees: "3.90" }, "SGD")).toEqual([
      "Provisional: Shopify has not reported the fee on this order yet, so Cult Commons may still go down.",
      "$3.90 of the order's Shopify fees come off the build's job when it is completed.",
    ]);
  });
});
