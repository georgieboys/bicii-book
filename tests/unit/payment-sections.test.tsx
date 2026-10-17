/**
 * The Customer payments parts of Reports (Phase 14 step 3; PLAN D154a–e;
 * src/components/domain/reports/payment-sections.tsx): the five tiles with
 * their counts and the notes that say they are not sales; the other-
 * currency note only when there is one; "Held on jobs now" as three lists,
 * each with its own total, no grand total, the basis sentence and a row
 * per job linking to it; the movement list and table with signed amounts
 * and the recorder on counter rows only.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  HeldOnJobs,
  PaymentItemList,
  PaymentItemTable,
  PaymentSummaryFigures,
  recordedLine,
} from "@/components/domain/reports/payment-sections";
import type { HeldJob, PaymentItem, PaymentSummary } from "@/lib/payment-reports";

const JOB_A = "66666666-7777-4888-9999-000000000001";
const JOB_B = "66666666-7777-4888-9999-000000000002";
const PAY = "11111111-2222-4333-8444-000000000001";
const COUNTER = "22222222-3333-4444-8555-000000000001";

const SUMMARY: PaymentSummary = {
  from: "2026-10-12",
  to: "2026-10-18",
  currency: "SGD",
  onlineCount: 3,
  onlineTotal: "480.00",
  depositOnlineTotal: "300.00",
  balanceOnlineTotal: "180.00",
  refundCount: 1,
  refundTotal: "50.00",
  counterCount: 2,
  counterTotal: "45.00",
  givenBackCount: 1,
  givenBackTotal: "10.00",
  netTotal: "465.00",
  otherCurrencyCount: 0,
};

const held = (over: Partial<HeldJob>): HeldJob => ({
  group: "open",
  workOrderId: JOB_A,
  jobNumber: "J-000001",
  jobHref: `/jobs/${JOB_A}`,
  status: "in_progress",
  customerLabel: "Ana Lim",
  amount: "300.00",
  netPaid: "300.00",
  netPaidOnline: "300.00",
  paidAtCounter: "0.00",
  jobTotal: "145.00",
  balanceDue: "0.00",
  paidAhead: "155.00",
  currency: "SGD",
  ...over,
});

const ITEM: PaymentItem = {
  at: "2026-10-16T02:00:00+00:00",
  id: PAY,
  movement: "online_payment",
  workOrderId: JOB_A,
  jobNumber: "J-000007",
  jobHref: `/jobs/${JOB_A}`,
  customerLabel: "Ana Lim",
  kind: "deposit",
  method: "stripe",
  amount: "300.00",
  signedAmount: "300.00",
  currency: "SGD",
  otherCurrency: false,
  recordedAt: null,
  recordedByName: null,
};

const GIVEN_BACK: PaymentItem = {
  ...ITEM,
  id: COUNTER,
  movement: "counter_given_back",
  kind: "balance",
  method: "cash",
  amount: "45.00",
  signedAmount: "-45.00",
  recordedAt: "2026-10-16T09:30:00+00:00",
  recordedByName: "Sam Tan",
};

/** A tile's label and value, as the dl reads them. */
const tile = (label: string) => {
  const group = screen.getByRole("group", { name: "Customer payment figures" });
  const dt = within(group).getByText(label, { selector: "dt" });
  return dt.closest("div")!;
};

describe("PaymentSummaryFigures", () => {
  it("shows the five tiles with their counts, the online split and the net", () => {
    render(<PaymentSummaryFigures summary={SUMMARY} />);
    expect(tile("Taken online")).toHaveTextContent("$480.00");
    expect(tile("Taken online")).toHaveTextContent("3 payments");
    expect(tile("Taken online")).toHaveTextContent("Deposits $300.00 · balances $180.00");
    expect(tile("Refunded online")).toHaveTextContent("$50.00");
    expect(tile("Refunded online")).toHaveTextContent("1 refund");
    expect(tile("Recorded at the counter")).toHaveTextContent("$45.00");
    expect(tile("Recorded at the counter")).toHaveTextContent("2 payments");
    expect(tile("Given back at the counter")).toHaveTextContent("$10.00");
    expect(tile("Given back at the counter")).toHaveTextContent("1 payment");
    expect(tile("Net taken")).toHaveTextContent("$465.00");
    expect(tile("Net taken")).toHaveTextContent("Taken less refunded and given back");
    // Each tile holds its own figure only.
    expect(tile("Refunded online")).not.toHaveTextContent("$480.00");
    expect(tile("Net taken")).not.toHaveTextContent("payments");
  });

  it("says the figures are not sales and what the counter figure is", () => {
    render(<PaymentSummaryFigures summary={SUMMARY} />);
    const notes = screen.getAllByRole("note").map((n) => n.textContent);
    expect(notes).toEqual([
      "Not sales: money taken and given back by the day it moved.",
      "Recorded at the counter: only what an admin recorded in BICII; not the till's takings.",
    ]);
    expect(screen.queryByRole("link", { name: "See exceptions" })).toBeNull();
  });

  it("adds the other-currency note with a link to Exceptions only when there is one", () => {
    render(<PaymentSummaryFigures summary={{ ...SUMMARY, otherCurrencyCount: 2 }} />);
    expect(screen.getAllByRole("note")[2]).toHaveTextContent(
      "2 payments in another currency are counted at the amount asked or left out of these totals.",
    );
    expect(screen.getByRole("link", { name: "See exceptions" })).toHaveAttribute(
      "href",
      "/reports/exceptions",
    );
  });

  it("shows a negative net with a real minus sign and no split while nothing was taken online", () => {
    render(
      <PaymentSummaryFigures
        summary={{
          ...SUMMARY,
          onlineCount: 0,
          onlineTotal: "0.00",
          depositOnlineTotal: "0.00",
          balanceOnlineTotal: "0.00",
          netTotal: "-15.00",
        }}
      />,
    );
    expect(tile("Net taken")).toHaveTextContent("−$15.00");
    expect(tile("Taken online")).toHaveTextContent("0 payments");
    expect(tile("Taken online")).not.toHaveTextContent("Deposits");
  });
});

describe("HeldOnJobs (D154c)", () => {
  const rows: HeldJob[] = [
    held({ group: "open", workOrderId: JOB_A, jobNumber: "J-000001", amount: "300.00" }),
    held({
      group: "awaiting_collection",
      workOrderId: JOB_B,
      jobNumber: "J-000002",
      status: "ready_for_collection",
      amount: "100.00",
      netPaid: "100.00",
      netPaidOnline: "0.00",
      paidAtCounter: "100.00",
      balanceDue: "45.00",
      paidAhead: "0.00",
      jobHref: `/jobs/${JOB_B}`,
    }),
  ];

  it("says the basis, then three lists in order, each with its own total and count", () => {
    render(<HeldOnJobs rows={rows} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Not sales. On the Sale date basis, a job counts as sales on the day it is completed",
    );
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Paid on open jobs",
      "Paid on jobs awaiting collection",
      "Paid above the bill",
    ]);
    const open = screen.getByRole("region", { name: "Paid on open jobs" });
    expect(open).toHaveTextContent("Total $300.00 · 1 job");
    const awaiting = screen.getByRole("region", { name: "Paid on jobs awaiting collection" });
    expect(awaiting).toHaveTextContent("Total $100.00 · 1 job");
    const above = screen.getByRole("region", { name: "Paid above the bill" });
    expect(above).toHaveTextContent("Total $0.00 · 0 jobs");
    expect(above).toHaveTextContent("No job is paid above its bill.");
    // No grand total anywhere.
    expect(screen.queryByText(/\$400\.00/)).toBeNull();
  });

  it("lists each job linking to it, with its line", () => {
    render(<HeldOnJobs rows={rows} />);
    const awaiting = screen.getByRole("region", { name: "Paid on jobs awaiting collection" });
    const link = within(awaiting).getByRole("link");
    expect(link).toHaveAttribute("href", `/jobs/${JOB_B}`);
    expect(link).toHaveTextContent("J-000002 · Ana Lim");
    expect(link).toHaveTextContent("$100.00");
    expect(link).toHaveTextContent(
      "Ready for collection · Paid at the counter · Still to pay $45.00",
    );
    const open = screen.getByRole("region", { name: "Paid on open jobs" });
    expect(within(open).getByRole("link")).toHaveTextContent(
      "In progress · Paid online · Paid ahead $155.00",
    );
  });
});

describe("the movement list and table", () => {
  it("phones and tablets: a row per movement, the give-back negative, the recorder on the counter row only", () => {
    render(<PaymentItemList items={[ITEM, GIVEN_BACK]} />);
    const items = within(screen.getByRole("list", { name: "Payments" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Taken online");
    expect(items[0]).toHaveTextContent("$300.00");
    expect(items[0]).toHaveTextContent("Deposit · Stripe");
    expect(items[0]).not.toHaveTextContent("Recorded");
    expect(items[1]).toHaveTextContent("Given back at the counter");
    expect(items[1]).toHaveTextContent("−$45.00");
    expect(items[1]).toHaveTextContent("Towards the bill · Cash");
    expect(items[1]).toHaveTextContent("Recorded Fri, 16 Oct 2026 17:30 by Sam Tan");
    expect(within(items[1]).getByRole("link", { name: "J-000007" })).toHaveAttribute(
      "href",
      `/jobs/${JOB_A}`,
    );
  });

  it("lg and up: the columns, signed amounts and a dash where Stripe has no recorder", () => {
    render(
      <PaymentItemTable
        items={[ITEM, GIVEN_BACK, { ...ITEM, id: JOB_B, otherCurrency: true }]}
        caption="Customer payments"
      />,
    );
    const table = screen.getByRole("table", { name: "Customer payments" });
    const head = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(head).toEqual([
      "Date",
      "Job",
      "Movement",
      "Amount",
      "Customer",
      "Kind",
      "Method",
      "Recorded",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      within(rows[0])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "Fri, 16 Oct 2026 10:00",
      "J-000007",
      "Taken online",
      "$300.00",
      "Ana Lim",
      "Deposit",
      "Stripe",
      "—",
    ]);
    expect(
      within(rows[1])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "Fri, 16 Oct 2026 10:00",
      "J-000007",
      "Given back at the counter",
      "−$45.00",
      "Ana Lim",
      "Towards the bill",
      "Cash",
      "Fri, 16 Oct 2026 17:30 · Sam Tan",
    ]);
    expect(rows[2]).toHaveTextContent("Other currency");
  });

  it("words the recorder line, without a name when the directory has none", () => {
    expect(recordedLine(ITEM)).toBeNull();
    expect(recordedLine({ recordedAt: "2026-10-16T09:30:00+00:00", recordedByName: null })).toBe(
      "Recorded Fri, 16 Oct 2026 17:30",
    );
  });
});
