/**
 * The job's payment sheets (Phase 14 step 3; D156, D161; step3-critique
 * C19): SendBalanceLinkSheet (channels only where they work, 1 to 30 days,
 * the replaced link named, the id made on open) and BalanceLinkSentSheet
 * (the link once, Open WhatsApp, emailed and failed lines, the replaced
 * link's Checkout note); CounterPaymentSheet (the deposit offered with its
 * fixed amount, "Towards the bill" prefilled, the warnings, a confirm step
 * that repeats the amount and the method, today sent as nothing, the id
 * made on open, and the online Checkout note kept on screen).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendBalanceLinkAction = vi.fn();
const recordCounterPaymentAction = vi.fn();
vi.mock("@/app/(staff)/jobs/payment-actions", () => ({
  sendBalanceLinkAction: (...a: unknown[]) => sendBalanceLinkAction(...a),
  recordCounterPaymentAction: (...a: unknown[]) => recordCounterPaymentAction(...a),
}));

import {
  BalanceLinkSentSheet,
  SendBalanceLinkSheet,
} from "@/components/domain/balance-link-sheets";
import { CounterPaymentSheet } from "@/components/domain/counter-payment-sheet";
import { ToastProvider } from "@/components/ui/toast";
import { shopToday, shiftShopDay } from "@/lib/dates";
import type { JobDeposit } from "@/lib/domain/payments";

const JOB = "66666666-7777-4888-9999-000000000000";
const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const wait = () => new Promise((r) => setTimeout(r, 450));

beforeEach(() => {
  sendBalanceLinkAction.mockReset();
  recordCounterPaymentAction.mockReset();
});

describe("SendBalanceLinkSheet (D156)", () => {
  const base = {
    workOrderId: JOB,
    stillToPay: "180.00",
    currency: "SGD",
    hasWhatsapp: true,
    emailEnabled: true,
    emailTo: "priya@example.test",
    replaces: null,
    onSent: vi.fn(),
    onClose: vi.fn(),
  };

  it("offers WhatsApp, Email and Copy link only where they work, and says what is left", () => {
    const { unmount } = wrap(<SendBalanceLinkSheet {...base} />);
    const dialog = screen.getByRole("dialog", { name: "Send payment link" });
    const by = within(dialog).getByRole("radiogroup", { name: "Send by" });
    expect(
      within(by)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["WhatsApp", "Email", "Copy link"]);
    expect(dialog).toHaveTextContent("Still to pay$180.00");
    expect(dialog).not.toHaveTextContent("This replaces the link");
    unmount();

    wrap(
      <SendBalanceLinkSheet {...base} hasWhatsapp={false} emailEnabled={false} emailTo={null} />,
    );
    const only = screen.getByRole("radiogroup", { name: "Send by" });
    expect(
      within(only)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Copy link"]);
    expect(screen.getByText(/No WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/No email: emails aren't set up yet/)).toBeInTheDocument();
  });

  it("says which live link it replaces", () => {
    wrap(
      <SendBalanceLinkSheet
        {...base}
        replaces={{ sentAt: "2026-10-17T02:00:00Z", expiresAt: "2026-10-24T02:00:00Z" }}
        now={new Date("2026-10-18T02:00:00Z")}
      />,
    );
    expect(
      screen.getByText("This replaces the link sent on 17 Oct 2026. That link stops working."),
    ).toBeInTheDocument();
  });

  it("never says an expired link 'stops working': it stopped when it expired", () => {
    wrap(
      <SendBalanceLinkSheet
        {...base}
        replaces={{ sentAt: "2026-10-01T02:00:00Z", expiresAt: "2026-10-08T02:00:00Z" }}
        now={new Date("2026-10-18T02:00:00Z")}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Send payment link" });
    expect(
      within(dialog).getByText(
        "This replaces the link sent on 1 Oct 2026, which expired on 8 Oct 2026.",
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("stops working");
  });

  it("sends with an id made when it opened (the same on a retry), the channel and the days", async () => {
    sendBalanceLinkAction.mockResolvedValueOnce({ ok: false, error: "Try again." });
    const onSent = vi.fn();
    wrap(<SendBalanceLinkSheet {...base} onSent={onSent} />);
    fireEvent.click(screen.getByRole("radio", { name: "Copy link" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    });
    expect(
      within(screen.getByRole("dialog", { name: "Send payment link" })).getByRole("alert"),
    ).toHaveTextContent("Try again.");
    const first = sendBalanceLinkAction.mock.calls[0][0];
    expect(first).toMatchObject({ workOrderId: JOB, channel: "link", validDays: "7" });
    expect(first.linkId).toMatch(UUID);

    const sent = {
      link: "https://admin.bicii.test/pay/tok",
      amount: "180.00",
      validDays: 7,
      expiresAt: "2026-10-24T02:00:00Z",
      emailedTo: null,
      emailFailed: false,
      checkoutNote: null,
    };
    sendBalanceLinkAction.mockResolvedValueOnce({ ok: true, data: sent });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    });
    expect(sendBalanceLinkAction.mock.calls[1][0].linkId).toBe(first.linkId);
    expect(onSent).toHaveBeenCalledWith(sent);
  });
});

describe("BalanceLinkSentSheet (D156)", () => {
  const sent = {
    link: "https://admin.bicii.test/pay/tok",
    amount: "180.00",
    validDays: 7,
    expiresAt: "2026-10-24T02:00:00Z",
    emailedTo: null,
    emailFailed: false,
    checkoutNote: null,
  };

  it("shows the link once, the message, and Open WhatsApp with it", () => {
    wrap(
      <BalanceLinkSentSheet sent={sent} message="Hi Priya" phone="91234567" onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Payment link ready to send" });
    expect(dialog).toHaveTextContent("This link is shown only now.");
    expect(dialog).toHaveTextContent("It asks $180.00 now and works until 24 Oct 2026.");
    expect(within(dialog).getByText(sent.link)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/6591234567?text=Hi%20Priya",
    );
    expect(within(dialog).getByRole("textbox", { name: "Message" })).toHaveValue("Hi Priya");
  });

  it("emailed, email failed, and the replaced link's Checkout note", () => {
    const { unmount } = wrap(
      <BalanceLinkSentSheet
        sent={{ ...sent, emailedTo: "priya@example.test" }}
        message="m"
        phone="91234567"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Emailed to priya@example.test.");
    // Emailed: no WhatsApp button as well.
    expect(screen.queryByRole("link", { name: "Open WhatsApp" })).toBeNull();
    unmount();
    wrap(
      <BalanceLinkSentSheet
        sent={{ ...sent, emailFailed: true, checkoutNote: "The earlier link's page may be open." }}
        message="m"
        phone={null}
        onClose={vi.fn()}
      />,
    );
    const alerts = within(screen.getByRole("dialog"))
      .getAllByRole("alert")
      .map((a) => a.textContent);
    expect(alerts).toEqual([
      "The email didn't go out. Copy the link and send it another way.",
      "The earlier link's page may be open.",
    ]);
  });
});

const DEPOSIT: JobDeposit = {
  quoteId: QUOTE,
  sentAt: "2026-10-11T02:00:00Z",
  answeredAt: "2026-10-12T04:00:00Z",
  percent: 50,
  amount: "300.00",
  currency: "SGD",
  state: "due",
  partRequestIds: ["r1"],
};

const counter = (props: Partial<Parameters<typeof CounterPaymentSheet>[0]> = {}) =>
  wrap(
    <CounterPaymentSheet
      workOrderId={JOB}
      jobNumber="J-000123"
      jobStatus="in_progress"
      jobOpen
      checkedInAt="2026-10-01T01:00:00Z"
      deposits={[DEPOSIT]}
      balanceDue="145.00"
      jobTotal="145.00"
      currency="SGD"
      onClose={vi.fn()}
      {...props}
    />,
  );

describe("CounterPaymentSheet (D161, C19)", () => {
  it("offers the due deposit with its fixed amount, and towards the bill prefilled with what is left", () => {
    counter();
    const dialog = screen.getByRole("dialog", { name: "Record counter payment" });
    expect(
      within(dialog).getByRole("radio", {
        name: /Record the \$300\.00 deposit for the quote answered 12 Oct 2026/,
      }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Towards the bill/ })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: /Amount/ })).toHaveValue("145.00");
    // A deposit is still due on an open job: the quote page still asks it.
    expect(dialog).toHaveTextContent(
      "The customer's quote page still asks the full $300.00 deposit online. Record the deposit instead if this money is for it.",
    );

    fireEvent.click(within(dialog).getByRole("radio", { name: /Record the \$300\.00 deposit/ }));
    expect(within(dialog).queryByRole("textbox", { name: /^Amount/ })).toBeNull();
    expect(dialog).toHaveTextContent("Amount (the deposit)$300.00");
    expect(dialog).not.toHaveTextContent("still asks the full");
  });

  it("never offers a paid, processing or none deposit, nor any on a cancelled job", () => {
    const { unmount } = counter({
      deposits: [
        { ...DEPOSIT, quoteId: "q-paid", state: "paid" },
        { ...DEPOSIT, quoteId: "q-proc", state: "processing" },
        { ...DEPOSIT, quoteId: "q-none", state: "none" },
      ],
    });
    expect(screen.queryByRole("radio", { name: /deposit/ })).toBeNull();
    unmount();
    counter({ jobStatus: "cancelled", jobOpen: false });
    expect(screen.queryByRole("radio", { name: /deposit/ })).toBeNull();
  });

  it("warns on a final bill: the deposit stays due, and an amount above what is left", () => {
    counter({ jobStatus: "ready_for_collection", jobOpen: false, balanceDue: "35.00" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "The deposit stays 'due' on this card, and is asked online again if the job is reopened, unless you record it as the deposit.",
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Amount/ }), {
      target: { value: "3800" },
    });
    expect(dialog).toHaveTextContent(
      "This is $3,765.00 more than still to pay; it will show as paid above the bill.",
    );
  });

  it("commits in two steps that repeat the amount and the method; today sends nothing", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: true,
      data: { replayed: false, checkoutNote: null },
    });
    const onClose = vi.fn();
    counter({ deposits: [], onClose });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Amount/ }), {
      target: { value: "3800" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Reference/ }), {
      target: { value: "R-77" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $3,800.00 cash…" }));
    const group = within(dialog).getByRole("group", { name: "Record $3,800.00 cash?" });
    expect(within(group).getByRole("button", { name: "Back" })).toHaveFocus();
    const confirm = within(group).getByRole("button", { name: "Record $3,800.00" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(confirm).toBeEnabled());
    await act(async () => {
      fireEvent.click(confirm);
    });
    const input = recordCounterPaymentAction.mock.calls[0][0];
    expect(input).toEqual({
      id: expect.stringMatching(UUID),
      workOrderId: JOB,
      quoteId: null,
      amount: "3800",
      method: "cash",
      receivedAt: null,
      reference: "R-77",
      note: null,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("the method changes both labels; Back returns without recording", () => {
    counter({ deposits: [] });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "PayNow" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00 by PayNow…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByRole("button", { name: "Record $145.00 by PayNow…" })).toHaveFocus();
    expect(recordCounterPaymentAction).not.toHaveBeenCalled();
  });

  it("a deposit sends its quote and the deposit's own amount; an earlier day sends its instant", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: true,
      data: { replayed: false, checkoutNote: null },
    });
    counter();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Record the \$300\.00 deposit/ }));
    const yesterday = shiftShopDay(shopToday(), -1);
    const paidOn = within(dialog).getByLabelText(/Paid on/);
    fireEvent.change(paidOn, { target: { value: yesterday } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $300.00 cash…" }));
    await wait();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record $300.00" }));
    });
    expect(recordCounterPaymentAction.mock.calls[0][0]).toMatchObject({
      quoteId: QUOTE,
      amount: "300.00",
      receivedAt: new Date(`${yesterday}T12:00:00+08:00`).toISOString(),
    });
  });

  it("the day picker never offers a day before the check-in or more than 29 days back", () => {
    counter({ deposits: [], checkedInAt: new Date().toISOString() });
    const paidOn = screen.getByLabelText(/Paid on/);
    expect(paidOn).toHaveAttribute("min", shopToday());
    expect(paidOn).toHaveAttribute("max", shopToday());
  });

  it("a refusal shows above the form and keeps everything typed", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: false,
      error: "An online payment on this job is still being confirmed.",
    });
    counter({ deposits: [] });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00 cash…" }));
    await wait();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00" }));
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "An online payment on this job is still being confirmed.",
    );
    expect(within(dialog).getByRole("textbox", { name: /Amount/ })).toHaveValue("145.00");
  });

  it("refuses an amount above the cap before the confirm step (At most $999,999.99.)", () => {
    counter({ deposits: [] });
    const dialog = screen.getByRole("dialog");
    const amount = within(dialog).getByRole("textbox", { name: /Amount/ });
    fireEvent.change(amount, { target: { value: "1000000" } });
    expect(amount).toHaveAccessibleDescription(/At most \$999,999\.99\./);
    expect(amount).toHaveAttribute("aria-invalid", "true");
    // The start button names no amount and cannot open the confirm step.
    const startButton = within(dialog).getByRole("button", { name: "Record payment…" });
    expect(startButton).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: /Record \$1,000,000\.00/ })).toBeNull();
    // The cap itself is allowed.
    fireEvent.change(amount, { target: { value: "999999.99" } });
    expect(within(dialog).getByRole("button", { name: "Record $999,999.99 cash…" })).toBeEnabled();
    expect(amount).not.toHaveAttribute("aria-invalid");
    // Zero keeps its own sentence.
    fireEvent.change(amount, { target: { value: "0" } });
    expect(amount).toHaveAccessibleDescription(/Enter an amount above 0, like 12\.50\./);
  });

  it("after a refusal with field errors, focus moves to the first invalid field (DESIGN Forms)", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: { reference: ["Keep the reference under 200 characters."] },
    });
    counter({ deposits: [] });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00 cash…" }));
    await wait();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00" }));
    });
    const reference = within(dialog).getByRole("textbox", { name: /Reference/ });
    expect(reference).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(reference).toHaveFocus());
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Check the highlighted fields.");
  });

  it("after a refusal without field errors, focus returns to the start button", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: false,
      error: "An online payment on this job is still being confirmed.",
    });
    counter({ deposits: [] });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00 cash…" }));
    await wait();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record $145.00" }));
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Record $145.00 cash…" })).toHaveFocus(),
    );
  });

  it("keeps the online Checkout note on screen after recording", async () => {
    recordCounterPaymentAction.mockResolvedValue({
      ok: true,
      data: {
        replayed: false,
        checkoutNote:
          "An online payment page may still be open for this job; use Check with Stripe.",
      },
    });
    const onClose = vi.fn();
    counter({ deposits: [], onClose });
    fireEvent.click(screen.getByRole("button", { name: "Record $145.00 cash…" }));
    await wait();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record $145.00" }));
    });
    const done = screen.getByRole("dialog", { name: "Counter payment recorded" });
    expect(within(done).getByRole("alert")).toHaveTextContent(
      "An online payment page may still be open for this job; use Check with Stripe.",
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(done).getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
