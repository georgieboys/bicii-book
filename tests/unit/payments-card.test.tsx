/**
 * The job's Customer payments card (Phase 14; D151, D154, D156, D161;
 * step3-critique C3, C15, C18, C20): the totals show only once something
 * was paid, attempted or sent (work_order_payment_totals has a row for
 * every job); the header's Send payment link (any staff member, Stripe on,
 * a final SGD bill of at least S$0.50, nothing being confirmed) and Record
 * counter payment (admins, not on a cancelled job); totals that count
 * counter money and name what Stripe is still confirming; the live link's
 * line; counter rows with an admin's two void controls; issues keyed by
 * either id, Check with Stripe never on a counter row; a deposit due on a
 * job that is no longer open reads "Part of the balance"; the footer.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkWithStripeAction = vi.fn();
const voidCounterPaymentAction = vi.fn();
vi.mock("@/app/(staff)/jobs/payment-actions", () => ({
  checkWithStripeAction: (...a: unknown[]) => checkWithStripeAction(...a),
  voidCounterPaymentAction: (...a: unknown[]) => voidCounterPaymentAction(...a),
  sendBalanceLinkAction: vi.fn(),
  recordCounterPaymentAction: vi.fn(),
}));

import { PaymentsCard, type PaymentsCardJob } from "@/components/domain/payments-card";
import { ToastProvider } from "@/components/ui/toast";
import type { CounterPayment, JobPayment, JobPayments } from "@/lib/domain/payments";
import { showsPaymentsCard } from "@/lib/payments";

const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const COUNTER = "22222222-3333-4444-8555-000000000001";

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
  netPaid: "0.00",
  processingOnline: "0.00",
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
  counterPayments: [],
  link: null,
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

const CASH: CounterPayment = {
  id: COUNTER,
  kind: "balance",
  quoteId: null,
  amount: "45.00",
  currency: "SGD",
  method: "cash",
  receivedAt: "2026-10-03T04:00:00Z",
  reference: "R-12",
  note: null,
  recordedBy: "Sam Admin",
  createdAt: "2026-10-03T04:01:00Z",
  voided: null,
};

const OPEN_JOB: PaymentsCardJob = {
  id: "66666666-7777-4888-9999-000000000000",
  jobNumber: "J-000123",
  status: "in_progress",
  open: true,
  currency: "SGD",
  checkedInAt: "2026-10-01T01:00:00Z",
};
const READY_JOB: PaymentsCardJob = { ...OPEN_JOB, status: "ready_for_collection", open: false };

function show(payments: JobPayments, props: Partial<Parameters<typeof PaymentsCard>[0]> = {}) {
  return render(
    <ToastProvider>
      <PaymentsCard
        job={OPEN_JOB}
        payments={payments}
        canCheck
        canOpenStripe={false}
        payOnline
        {...props}
      />
    </ToastProvider>,
  );
}

const totalsBlock = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('dl[aria-label="Payment totals"]');

beforeEach(() => {
  checkWithStripeAction.mockReset();
  voidCounterPaymentAction.mockReset().mockResolvedValue({ ok: true, data: { replayed: false } });
});

describe("when the job page renders the card (C15)", () => {
  const none = {
    deposits: 0,
    payments: 0,
    counterPayments: 0,
    canSendLink: false,
    canRecordCounter: false,
    jobStatus: "in_progress" as const,
  };
  it("with a deposit, a Stripe payment or a counter payment", () => {
    expect(showsPaymentsCard(none)).toBe(false);
    expect(showsPaymentsCard({ ...none, deposits: 1 })).toBe(true);
    expect(showsPaymentsCard({ ...none, payments: 1 })).toBe(true);
    expect(showsPaymentsCard({ ...none, counterPayments: 1 })).toBe(true);
  });
  it("when a link can be sent, or an admin can record on a job that is not cancelled", () => {
    expect(showsPaymentsCard({ ...none, canSendLink: true })).toBe(true);
    expect(showsPaymentsCard({ ...none, canRecordCounter: true })).toBe(true);
    expect(showsPaymentsCard({ ...none, canRecordCounter: true, jobStatus: "cancelled" })).toBe(
      false,
    );
  });
});

describe("PaymentsCard header actions", () => {
  const completedDue = {
    ...DUE,
    deposits: [],
    totals: { ...TOTALS, balanceDue: "145.00" },
  };

  it("Send payment link on a completed or ready job with S$0.50 or more left, Stripe on", () => {
    for (const status of ["completed", "ready_for_collection"] as const) {
      const { unmount } = show(completedDue, { job: { ...READY_JOB, status } });
      expect(screen.getByRole("button", { name: "Send payment link" })).toBeInTheDocument();
      unmount();
    }
  });

  it("no Send payment link while open, with Stripe off, under S$0.50, or while Stripe confirms a payment", () => {
    const cases: Array<[JobPayments, Partial<Parameters<typeof PaymentsCard>[0]>]> = [
      [completedDue, { job: OPEN_JOB }],
      [completedDue, { job: READY_JOB, payOnline: false }],
      [{ ...completedDue, totals: { ...TOTALS, balanceDue: "0.49" } }, { job: READY_JOB }],
      [{ ...completedDue, totals: { ...TOTALS, processingOnline: "145.00" } }, { job: READY_JOB }],
      [completedDue, { job: { ...READY_JOB, status: "collected" } }],
    ];
    for (const [payments, props] of cases) {
      const { unmount } = show(payments, props);
      expect(screen.queryByRole("button", { name: "Send payment link" })).toBeNull();
      unmount();
    }
  });

  it("Record counter payment for an admin on any job but a cancelled one, Stripe off too", () => {
    const { unmount } = show(DUE, { canRecordCounter: true, payOnline: false });
    expect(screen.getByRole("button", { name: "Record counter payment" })).toBeInTheDocument();
    unmount();
    const second = show(DUE, {
      canRecordCounter: true,
      job: { ...OPEN_JOB, status: "cancelled", open: false },
    });
    expect(screen.queryByRole("button", { name: "Record counter payment" })).toBeNull();
    second.unmount();
    show(DUE, { canRecordCounter: false });
    expect(screen.queryByRole("button", { name: "Record counter payment" })).toBeNull();
  });
});

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
    expect(block.getByText("Job total so far")).toBeInTheDocument();
    expect(block.getByText("Still to pay")).toBeInTheDocument();
    expect(block.getByText("$25.00")).toBeInTheDocument();
    expect(block.queryByText("Paid at the counter")).toBeNull();
  });

  it("count counter money on its own row (D161)", () => {
    const { container } = show({
      ...DUE,
      deposits: [],
      counterPayments: [CASH],
      totals: { ...TOTALS, paidAtCounter: "45.00", netPaid: "45.00", balanceDue: "100.00" },
    });
    const block = within(totalsBlock(container)!);
    expect(block.getByText("Paid online")).toBeInTheDocument();
    expect(block.getByText("Paid at the counter")).toBeInTheDocument();
    expect(block.getByText("$45.00")).toBeInTheDocument();
    expect(block.getByText("$100.00")).toBeInTheDocument();
  });

  it("say what Stripe is still confirming, so it is not taken again", () => {
    const { container } = show({
      ...DUE,
      payments: [{ ...PAID, status: "pending", processing: true, paidAt: null }],
      totals: { ...TOTALS, processingOnline: "120.00" },
    });
    expect(totalsBlock(container)).toHaveTextContent(
      "$120.00 paid online is being confirmed by Stripe; don't take it again.",
    );
  });

  it("paid ahead on an open job keeps the indent sentence; on a final bill it is paid above the bill", () => {
    const ahead = {
      ...DUE,
      payments: [PAID],
      totals: {
        ...TOTALS,
        netPaidOnline: "200.00",
        netPaid: "200.00",
        balanceDue: "0.00",
        paidAhead: "55.00",
      },
    };
    const { container, unmount } = show(ahead);
    expect(totalsBlock(container)).toHaveTextContent(
      "Paid ahead$55.00. Indent parts join the job total when they're fitted.",
    );
    unmount();
    const ready = show(ahead, { job: READY_JOB });
    const block = totalsBlock(ready.container)!;
    expect(within(block).getByText("Paid above the bill")).toBeInTheDocument();
    expect(within(block).getByText("Job total")).toBeInTheDocument();
    expect(block).not.toHaveTextContent("Indent parts");
  });

  it("a closed job holding counter money above its bill never says to refund it in Stripe", () => {
    const { container } = show(
      {
        ...DUE,
        deposits: [],
        counterPayments: [CASH],
        totals: {
          ...TOTALS,
          jobTotal: "0.00",
          balanceDue: null,
          paidAhead: null,
          heldOverTotal: "45.00",
          paidAtCounter: "45.00",
          netPaid: "45.00",
        },
      },
      { job: { ...OPEN_JOB, status: "collected", open: false } },
    );
    expect(totalsBlock(container)).toHaveTextContent(
      "$45.00 was paid at the counter above this job's bill of $0.00. If it is given back, an admin records it as given back; or agree with the customer how it counts.",
    );
  });

  it("show with a live link even before anything is paid", () => {
    const { container } = show(
      {
        ...DUE,
        deposits: [],
        link: {
          id: "l1",
          channel: "whatsapp",
          sentAt: "2026-10-17T02:00:00Z",
          expiresAt: "2099-10-24T02:00:00Z",
          validDays: 7,
          amountAtSend: "145.00",
          sentBy: "Sam",
        },
      },
      { job: READY_JOB },
    );
    expect(within(totalsBlock(container)!).getByText("Still to pay")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment link")).toHaveTextContent(
      "Payment link sent 17 Oct 2026 by WhatsApp ($145.00 when sent), valid until 24 Oct 2099.",
    );
  });

  it("stay hidden when the totals row is missing", () => {
    const { container } = show({ ...DUE, payments: [PAID], totals: null });
    expect(totalsBlock(container)).toBeNull();
  });
});

describe("PaymentsCard deposits, issues and footer", () => {
  it("a deposit due on a job that is no longer open reads Part of the balance (C15)", () => {
    const { unmount } = show(DUE, { job: READY_JOB });
    expect(screen.getByText("Part of the balance")).toBeInTheDocument();
    expect(screen.queryByText("Deposit due")).toBeNull();
    unmount();
    show(DUE, { job: READY_JOB, payOnline: false });
    // The "can't pay online" note is for an open job's deposit only.
    expect(screen.queryByText(/Stripe isn't set up/)).toBeNull();
  });

  it("issues keyed by either id; Check with Stripe only for a Stripe payment's issue", () => {
    show({
      ...DUE,
      payments: [PAID],
      counterPayments: [CASH],
      issues: [
        {
          paymentId: null,
          counterPaymentId: COUNTER,
          issue: "paid_job_cancelled",
          severity: "danger",
          message: "$45.00 taken at the counter is held but this job is cancelled.",
          since: null,
        },
        {
          paymentId: null,
          counterPaymentId: COUNTER,
          issue: "paid_above_bill",
          severity: "danger",
          message: "$45.00 more than this job's bill has been paid.",
          since: null,
        },
      ],
    });
    const problems = screen.getByRole("list", { name: "Payment problems" });
    expect(within(problems).getAllByRole("listitem")).toHaveLength(2);
    // The paid deposit has no issue of its own, so no Check with Stripe; the
    // counter row never has one.
    expect(screen.queryByRole("button", { name: "Check with Stripe" })).toBeNull();
  });

  it("a Stripe payment's own issue still offers Check with Stripe", () => {
    show({
      ...DUE,
      payments: [PAID],
      issues: [
        {
          paymentId: PAID.id,
          counterPaymentId: null,
          issue: "paid_twice",
          severity: "danger",
          message: "Paid twice.",
          since: null,
        },
      ],
    });
    expect(screen.getByRole("button", { name: "Check with Stripe" })).toBeInTheDocument();
  });

  it("the footer names both corrections", () => {
    show(DUE);
    expect(
      screen.getByText(
        "Money held against this job, not a sale. Online refunds are made in Stripe; an admin corrects a counter payment by voiding it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Online through Stripe, and at the counter")).toBeInTheDocument();
  });
});

describe("PaymentsCard counter rows (D161, C18)", () => {
  const withCash = (c: CounterPayment) => ({ ...DUE, deposits: [], counterPayments: [c] });

  it("show the method, amount, day, reference and who recorded it, to every staff member", () => {
    show(withCash(CASH));
    const list = screen.getByRole("region", { name: "At the counter" });
    const row = within(list).getByRole("listitem", { name: "Towards the bill $45.00, Cash" });
    expect(row).toHaveTextContent("Towards the bill · Cash");
    expect(row).toHaveTextContent("$45.00");
    expect(row).toHaveTextContent("Paid 3 Oct 2026 · Ref R-12 · recorded by Sam Admin");
    // Not an admin: no void controls.
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("a voided row is struck through with why, who and when", () => {
    show(
      withCash({
        ...CASH,
        kind: "deposit",
        quoteId: QUOTE,
        voided: {
          kind: "given_back",
          reason: "Paid online as well",
          voidedBy: "Sam Admin",
          voidedAt: "2026-10-04T02:00:00Z",
        },
      }),
      { canRecordCounter: true },
    );
    const row = screen.getByRole("listitem", { name: "Deposit $45.00, Cash" });
    expect(row).toHaveTextContent("Given back: Paid online as well · Sam Admin ·");
    expect(within(row).getByText("$45.00")).toHaveClass("line-through");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("an admin's two voids, each its own ReasonConfirm with Keep payment", async () => {
    show(withCash(CASH), { canRecordCounter: true });
    const row = screen.getByRole("listitem", { name: "Towards the bill $45.00, Cash" });
    expect(
      within(row).getByRole("button", {
        name: "Void (recorded in error)… Towards the bill $45.00, Cash",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole("button", { name: "Given back… Towards the bill $45.00, Cash" }),
    );
    // While one is open the other is hidden.
    expect(within(row).queryByRole("button", { name: /^Void \(recorded in error\)/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Keep payment" })).toBeInTheDocument();
    const reason = within(row).getByLabelText(/Why was it given back\?/);
    fireEvent.change(reason, { target: { value: "Customer overpaid" } });
    const confirm = within(row).getByRole("button", { name: "Record as given back" });
    await new Promise((r) => setTimeout(r, 450));
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(voidCounterPaymentAction).toHaveBeenCalledWith({
        counterPaymentId: COUNTER,
        kind: "given_back",
        reason: "Customer overpaid",
      }),
    );
  });

  it("Keep payment closes the confirmation and brings both controls back", () => {
    show(withCash(CASH), { canRecordCounter: true });
    const row = screen.getByRole("listitem", { name: "Towards the bill $45.00, Cash" });
    fireEvent.click(within(row).getByRole("button", { name: /^Void \(recorded in error\)/ }));
    expect(within(row).getByLabelText(/Why was it recorded in error\?/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Keep payment" }));
    expect(within(row).getByRole("button", { name: /^Given back…/ })).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /^Void \(recorded in error\)/ }),
    ).toBeInTheDocument();
    expect(voidCounterPaymentAction).not.toHaveBeenCalled();
  });
});
