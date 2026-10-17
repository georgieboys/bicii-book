/**
 * The job's Customer payments card (Phase 14; D151, D154, D161): since
 * 20261014001300, public.work_order_payment_totals has a row for every job,
 * so the card shows its totals only once the job has a Stripe payment or a
 * live counter payment. A job whose quote asked a deposit and has nothing
 * paid shows the deposit, not "Paid online $0.00".
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(staff)/jobs/payment-actions", () => ({ checkWithStripeAction: vi.fn() }));

import { PaymentsCard } from "@/components/domain/payments-card";
import { ToastProvider } from "@/components/ui/toast";
import type { JobPayment, JobPayments } from "@/lib/domain/payments";

const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const TOTALS: NonNullable<JobPayments["totals"]> = {
  currency: "SGD",
  paidOnline: "0.00",
  refundedOnline: "0.00",
  netPaidOnline: "0.00",
  jobTotal: "145.00",
  balanceDue: "145.00",
  paidAhead: "0.00",
  heldOverTotal: "0.00",
  paidAtCounter: "0.00",
};

const DUE: JobPayments = {
  deposits: [
    {
      quoteId: QUOTE,
      sentAt: "2026-10-01T02:00:00Z",
      answeredAt: "2026-10-02T02:00:00Z",
      percent: 100,
      amount: "120.00",
      currency: "SGD",
      state: "due",
      partRequestIds: ["r1"],
    },
  ],
  payments: [],
  issues: [],
  totals: TOTALS,
};

const PAID: JobPayment = {
  id: "11111111-2222-4333-8444-000000000001",
  kind: "deposit",
  quoteId: QUOTE,
  amount: "120.00",
  amountReceived: "120.00",
  refundedAmount: "0.00",
  currency: "SGD",
  status: "paid",
  processing: false,
  createdAt: "2026-10-02T02:01:00Z",
  paidAt: "2026-10-02T02:05:00Z",
  checkedAt: null,
  sessionExpiresAt: "2026-10-02T03:01:00Z",
  paymentIntentId: "pi_1",
  livemode: false,
  refundPending: false,
};

const show = (payments: JobPayments) =>
  render(
    <ToastProvider>
      <PaymentsCard payments={payments} canCheck canOpenStripe={false} payOnline />
    </ToastProvider>,
  );

const totalsBlock = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('dl[aria-label="Paid online"]');

describe("PaymentsCard totals", () => {
  it("are hidden on a job with a deposit asked and nothing paid, though the totals row exists", () => {
    const { container } = show(DUE);
    expect(screen.getByText("Deposit due")).toBeInTheDocument();
    expect(totalsBlock(container)).toBeNull();
    expect(screen.queryByText("Still to pay")).not.toBeInTheDocument();
  });

  it("show once the job has a Stripe payment, as before", () => {
    const { container } = show({
      ...DUE,
      deposits: [{ ...DUE.deposits[0], state: "paid" }],
      payments: [PAID],
      totals: { ...TOTALS, paidOnline: "120.00", netPaidOnline: "120.00", balanceDue: "25.00" },
    });
    const block = within(totalsBlock(container)!);
    expect(block.getByText("$120.00")).toBeInTheDocument();
    expect(block.getByText("Still to pay")).toBeInTheDocument();
    expect(block.getByText("$25.00")).toBeInTheDocument();
  });

  it("show when only an admin's counter payment is on the job (D161), with the wording unchanged", () => {
    const { container } = show({
      ...DUE,
      deposits: [{ ...DUE.deposits[0], state: "paid" }],
      totals: { ...TOTALS, balanceDue: "25.00", paidAtCounter: "120.00" },
    });
    const block = within(totalsBlock(container)!);
    expect(block.getByText("Paid online")).toBeInTheDocument();
    expect(block.getByText("$0.00")).toBeInTheDocument();
    expect(block.getByText("$25.00")).toBeInTheDocument();
  });

  it("stay hidden when the totals row is missing", () => {
    const { container } = show({ ...DUE, payments: [PAID], totals: null });
    expect(totalsBlock(container)).toBeNull();
  });
});
