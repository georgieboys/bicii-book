import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setWorkOrderStatus = vi.fn();
vi.mock("@/app/(staff)/jobs/actions", () => ({
  setWorkOrderStatus: (...args: unknown[]) => setWorkOrderStatus(...args),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/app/(staff)/jobs/indent-actions", () => ({
  cancelPartRequestAction: vi.fn(),
  fitPartRequestAction: vi.fn(),
  fitPartBoughtOutsideAction: vi.fn(),
}));

import { JobStatusActions } from "@/components/domain/job-status-actions";
import type { SettleContext } from "@/components/domain/settle-items-sheet";
import { ToastProvider } from "@/components/ui/toast";
import type { PartRequest } from "@/lib/domain/indent";
import type { WorkOrderStatus } from "@/lib/workshop";

beforeEach(() => {
  setWorkOrderStatus.mockReset();
  setWorkOrderStatus.mockResolvedValue({ ok: true, data: null });
  refresh.mockReset();
});

const brakePad: PartRequest = {
  id: "00000000-0000-4000-8000-0000000000a1",
  kind: "part",
  status: "approved",
  description: "Brake pad",
  quantity: "1.00",
  unitSalePrice: "2.00",
  lineTotal: "2.00",
  currency: "SGD",
  productId: "00000000-0000-4000-8000-0000000000b1",
  serviceId: null,
  cancelReason: null,
  lineId: null,
  order: null,
};

const settleWith = (items: PartRequest[], extra: Partial<SettleContext> = {}): SettleContext => ({
  items,
  quote: null,
  quotedItems: 0,
  purchaseData: false,
  canOrder: false,
  defaultLocationName: "Shop floor",
  deposits: [],
  ...extra,
});

const withItems = (status: WorkOrderStatus, settle: SettleContext) => (
  <ToastProvider>
    <JobStatusActions
      workOrderId="00000000-0000-4000-8000-000000000001"
      jobNumber="J-000123"
      customerLabel="Priya Raman"
      status={status}
      settle={settle}
    />
  </ToastProvider>
);

const ui = (status: WorkOrderStatus) => (
  <ToastProvider>
    <JobStatusActions
      workOrderId="00000000-0000-4000-8000-000000000001"
      jobNumber="J-000123"
      customerLabel="Priya Raman"
      status={status}
    />
  </ToastProvider>
);

describe("JobStatusActions", () => {
  it("keeps the one-tap row disabled for a moment after each status change (double tap)", async () => {
    const { rerender } = render(ui("in_progress"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Complete" })).toBeEnabled());

    // The page refreshes with the next status: its first button is where
    // the finger was, and must not take the second tap.
    rerender(ui("completed"));
    expect(screen.getByRole("button", { name: "Ready for collection" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ready for collection" })).toBeEnabled(),
    );
  });

  it("never marks a job collected in one tap: it confirms, naming the job and the customer", async () => {
    render(ui("ready_for_collection"));
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    expect(setWorkOrderStatus).not.toHaveBeenCalled();

    const group = screen.getByRole("group", { name: "Mark J-000123 collected by Priya Raman?" });
    expect(within(group).getByRole("button", { name: "Back" })).toHaveFocus();
    const confirm = within(group).getByRole("button", { name: "Mark collected" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(confirm).toBeEnabled());
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(setWorkOrderStatus).toHaveBeenCalledWith({
      workOrderId: "00000000-0000-4000-8000-000000000001",
      status: "collected",
    });
  });

  it("says what the customer already paid online, so staff take only what is left (D154)", async () => {
    const withPaid = (paidOnline: Parameters<typeof JobStatusActions>[0]["paidOnline"]) => (
      <ToastProvider>
        <JobStatusActions
          workOrderId="00000000-0000-4000-8000-000000000001"
          jobNumber="J-000123"
          customerLabel="Priya Raman"
          status="ready_for_collection"
          paidOnline={paidOnline}
        />
      </ToastProvider>
    );
    const { unmount } = render(
      withPaid({ paid: "$60.00", stillToPay: "$85.00", paidAhead: null, moreThanBill: null }),
    );
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    const group = screen.getByRole("group", { name: "Mark J-000123 collected by Priya Raman?" });
    expect(group).toHaveTextContent("$60.00 was paid online. Take only $85.00.");
    unmount();

    render(
      withPaid({ paid: "$120.00", stillToPay: "$0.00", paidAhead: "$35.00", moreThanBill: null }),
    );
    const again = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    expect(screen.getByRole("group")).toHaveTextContent(
      "$120.00 was paid online. That is $35.00 more than the job total; take nothing more.",
    );
  });

  it("says nothing about online payments when there are none", async () => {
    render(ui("ready_for_collection"));
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    expect(screen.getByRole("group")).not.toHaveTextContent("paid online");
  });

  it("Back leaves the job as it is", async () => {
    render(ui("ready_for_collection"));
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Collected…" })).toBeInTheDocument();
    expect(setWorkOrderStatus).not.toHaveBeenCalled();
  });
});

describe("Change status sheet", () => {
  it("chooses nothing for the user, and hides its submit while a cancel reason is open", async () => {
    render(ui("in_progress"));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const sheet = screen.getByRole("dialog", { name: "Change status" });

    expect(
      within(sheet)
        .getAllByRole("radio")
        .filter((r) => (r as HTMLInputElement).checked),
    ).toHaveLength(0);
    const submit = within(sheet).getByRole("button", { name: "Change status" });
    expect(submit).toBeDisabled();
    fireEvent.click(within(sheet).getByLabelText("Paused"));
    expect(submit).toBeEnabled();

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel job…" }));
    expect(within(sheet).queryByRole("button", { name: "Change status" })).toBeNull();
    // Its own way back says what it does, beside the red "Cancel job".
    expect(within(sheet).getByRole("button", { name: "Keep job" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Cancel job" })).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: "Keep job" }));
    expect(within(sheet).getByRole("button", { name: "Change status" })).toBeInTheDocument();
  });

  it("warns that Collected is final when it is picked", () => {
    render(ui("completed"));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const sheet = screen.getByRole("dialog", { name: "Change status" });
    expect(within(sheet).queryByText(/Collected is final/)).toBeNull();
    fireEvent.click(within(sheet).getByLabelText("Collected"));
    expect(within(sheet).getByText(/Collected is final/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/paid online/)).toBeNull();
  });
});

describe("settle before closing (D149b, D149c)", () => {
  it("Complete with approved items opens the checklist and changes nothing", async () => {
    render(withItems("in_progress", settleWith([brakePad])));
    const complete = screen.getByRole("button", { name: "Complete…" });
    await waitFor(() => expect(complete).toBeEnabled());
    fireEvent.click(complete);
    expect(setWorkOrderStatus).not.toHaveBeenCalled();
    const sheet = screen.getByRole("dialog", { name: "Before completing J-000123" });
    expect(sheet).toHaveTextContent("Fit or cancel each approved or ordered item first.");
    const item = within(sheet).getByRole("listitem", { name: "Brake pad" });
    expect(item).toHaveTextContent("1 × Brake pad · $2.00");
    expect(within(item).getByRole("button", { name: "Fit" })).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: /^Cancel item/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Complete job" })).toBeDisabled();
  });

  it("goes on once nothing is left: the list comes from the page", async () => {
    const { rerender } = render(withItems("in_progress", settleWith([brakePad])));
    const complete = screen.getByRole("button", { name: "Complete…" });
    await waitFor(() => expect(complete).toBeEnabled());
    fireEvent.click(complete);
    rerender(withItems("in_progress", settleWith([])));
    const sheet = screen.getByRole("dialog", { name: "Before completing J-000123" });
    expect(sheet).toHaveTextContent("All settled.");
    const go = within(sheet).getByRole("button", { name: "Complete job" });
    expect(go).toBeEnabled();
    await act(async () => {
      fireEvent.click(go);
    });
    expect(setWorkOrderStatus).toHaveBeenCalledWith({
      workOrderId: "00000000-0000-4000-8000-000000000001",
      status: "completed",
    });
  });

  it("the Change status sheet opens the same checklist for a move out of the open statuses", () => {
    render(withItems("in_progress", settleWith([brakePad])));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const sheet = screen.getByRole("dialog", { name: "Change status" });
    fireEvent.click(within(sheet).getByLabelText("Completed"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Change status" }));
    expect(setWorkOrderStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Before completing J-000123" })).toBeInTheDocument();
  });

  it("Cancel job offers Cancel item only, and its own Cancel job… waits for the list", () => {
    const ordered: PartRequest = {
      ...brakePad,
      id: "00000000-0000-4000-8000-0000000000a2",
      description: "Chain",
      status: "ordered",
      order: { purchaseOrderId: "po-1", poNumber: "PO-000012", arrived: false, locationId: null },
    };
    render(withItems("in_progress", settleWith([brakePad, ordered], { canOrder: true })));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const change = screen.getByRole("dialog", { name: "Change status" });
    expect(change).toHaveTextContent("cancel its approved and ordered indent items");
    fireEvent.click(within(change).getByRole("button", { name: "Cancel job…" }));
    const sheet = screen.getByRole("dialog", { name: "Before cancelling J-000123" });
    expect(sheet).toHaveTextContent(
      "Cancel each approved or ordered item first. A cancelled job can't keep items waiting.",
    );
    expect(within(sheet).queryByRole("button", { name: "Fit" })).toBeNull();
    expect(within(sheet).getAllByRole("button", { name: /^Cancel item/ })).toHaveLength(2);
    const chain = within(sheet).getByRole("listitem", { name: "Chain" });
    expect(chain).toHaveTextContent("Ordered · PO-000012 · Not arrived yet");
    expect(within(chain).getByRole("link", { name: "Open PO-000012" })).toHaveAttribute(
      "href",
      "/purchasing/orders/po-1",
    );
    expect(within(sheet).getByRole("button", { name: "Cancel job…" })).toBeDisabled();
    expect(setWorkOrderStatus).not.toHaveBeenCalled();
  });

  it("a job completed before the guard: Collected lists the items, to reopen and fit or to cancel", async () => {
    render(withItems("completed", settleWith([brakePad])));
    const collected = screen.getByRole("button", { name: "Collected…" });
    expect(screen.getByRole("button", { name: "Ready for collection…" })).toBeInTheDocument();
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    expect(screen.queryByRole("group", { name: /Mark J-000123 collected/ })).toBeNull();
    const sheet = screen.getByRole("dialog", { name: "Before marking J-000123 collected" });
    expect(sheet).toHaveTextContent("Reopen the job with Change status to fit it, or cancel it.");
    expect(within(sheet).queryByRole("button", { name: "Fit" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: /^Cancel item/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Collected…" })).toBeDisabled();
  });

  it("after the checklist, Collected… still asks for the confirmation", async () => {
    const { rerender } = render(withItems("ready_for_collection", settleWith([brakePad])));
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    rerender(withItems("ready_for_collection", settleWith([])));
    const sheet = screen.getByRole("dialog", { name: "Before marking J-000123 collected" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Collected…" }));
    expect(screen.queryByRole("dialog", { name: /Before marking/ })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Mark J-000123 collected by Priya Raman?" }),
    ).toBeInTheDocument();
    expect(setWorkOrderStatus).not.toHaveBeenCalled();
  });

  it("names an open quote the move withdraws", async () => {
    render(
      withItems(
        "in_progress",
        settleWith([brakePad], {
          quote: {
            id: "q",
            state: "open",
            channel: "whatsapp",
            total: "27.00",
            currency: "SGD",
            sentAt: "2026-10-15T02:00:00Z",
            expiresAt: "2026-10-22T02:00:00Z",
            answeredAt: null,
            answeredName: null,
          },
          quotedItems: 2,
        }),
      ),
    );
    const complete = screen.getByRole("button", { name: "Complete…" });
    await waitFor(() => expect(complete).toBeEnabled());
    fireEvent.click(complete);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /Completing the job withdraws the quote sent .*: the customer's link will say it was withdrawn, and its 2 items go back to Proposed\./,
    );
  });

  it("keeps the Change status note through the checklist and the Collected confirmation", async () => {
    const note = "Customer asked for a quick finish";
    const { rerender } = render(withItems("in_progress", settleWith([brakePad])));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    let change = screen.getByRole("dialog", { name: "Change status" });
    fireEvent.click(within(change).getByLabelText("Completed"));
    fireEvent.change(within(change).getByRole("textbox", { name: "Note" }), {
      target: { value: note },
    });
    fireEvent.click(within(change).getByRole("button", { name: "Change status" }));
    rerender(withItems("in_progress", settleWith([])));
    const sheet = screen.getByRole("dialog", { name: "Before completing J-000123" });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Complete job" }));
    });
    expect(setWorkOrderStatus).toHaveBeenCalledWith({
      workOrderId: "00000000-0000-4000-8000-000000000001",
      status: "completed",
      note,
    });

    // Collected: the note waits for the confirmation's Mark collected.
    setWorkOrderStatus.mockClear();
    rerender(withItems("ready_for_collection", settleWith([brakePad])));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    change = screen.getByRole("dialog", { name: "Change status" });
    fireEvent.click(within(change).getByLabelText("Collected"));
    fireEvent.change(within(change).getByRole("textbox", { name: "Note" }), {
      target: { value: "Collected by her brother" },
    });
    fireEvent.click(within(change).getByRole("button", { name: "Change status" }));
    rerender(withItems("ready_for_collection", settleWith([])));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Before marking J-000123 collected" })).getByRole(
        "button",
        { name: "Collected…" },
      ),
    );
    const confirm = within(
      screen.getByRole("group", { name: "Mark J-000123 collected by Priya Raman?" }),
    ).getByRole("button", { name: "Mark collected" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(setWorkOrderStatus).toHaveBeenCalledWith({
      workOrderId: "00000000-0000-4000-8000-000000000001",
      status: "collected",
      note: "Collected by her brother",
    });
  });

  it("drops the note when the checklist is left with Back", async () => {
    const { rerender } = render(withItems("in_progress", settleWith([brakePad])));
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const change = screen.getByRole("dialog", { name: "Change status" });
    fireEvent.click(within(change).getByLabelText("Completed"));
    fireEvent.change(within(change).getByRole("textbox", { name: "Note" }), {
      target: { value: "Not this time" },
    });
    fireEvent.click(within(change).getByRole("button", { name: "Change status" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Before completing J-000123" })).getByRole(
        "button",
        { name: "Back" },
      ),
    );
    rerender(withItems("in_progress", settleWith([])));
    const complete = screen.getByRole("button", { name: "Complete" });
    await waitFor(() => expect(complete).toBeEnabled());
    await act(async () => {
      fireEvent.click(complete);
    });
    expect(setWorkOrderStatus).toHaveBeenCalledTimes(1);
    expect(setWorkOrderStatus.mock.calls[0][0]).toMatchObject({ status: "completed" });
    expect(setWorkOrderStatus.mock.calls[0][0].note).toBeUndefined();
  });

  it("a stale Cancel job refused for items says to cancel them, never to fit them", async () => {
    setWorkOrderStatus.mockResolvedValue({
      ok: false,
      error: "Fit or cancel the job's approved and ordered items first.",
      code: "work_order_has_unfitted_requests",
    });
    // Confirms past the reason step's double-tap guard.
    const confirmCancel = async (container: HTMLElement) => {
      fireEvent.change(within(container).getByRole("textbox", { name: /Why is this job/ }), {
        target: { value: "Customer withdrew" },
      });
      const later = Date.now() + 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        await act(async () => {
          fireEvent.click(within(container).getByRole("button", { name: "Cancel job" }));
        });
      } finally {
        clock.mockRestore();
      }
    };
    render(withItems("in_progress", settleWith([])));
    // Change status: the page showed nothing to settle.
    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    const change = screen.getByRole("dialog", { name: "Change status" });
    fireEvent.click(within(change).getByRole("button", { name: "Cancel job…" }));
    await confirmCancel(change);
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Job not cancelled")).toBeInTheDocument();
    expect(
      screen.getByText("Cancel the job's approved and ordered items before cancelling it."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Fit or cancel the job's/)).toBeNull();
    const sheet = screen.getByRole("dialog", { name: "Before cancelling J-000123" });
    // The checklist's own Cancel job, still stale: the same sentence.
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel job…" }));
    await confirmCancel(sheet);
    expect(setWorkOrderStatus).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        screen.getAllByText("Cancel the job's approved and ordered items before cancelling it."),
      ).toHaveLength(2),
    );
    expect(screen.queryByText(/Fit or cancel the job's/)).toBeNull();
  });

  it("a stale page refused by the database toasts, refreshes and opens the checklist", async () => {
    setWorkOrderStatus.mockResolvedValue({
      ok: false,
      error: "Fit or cancel the job's approved and ordered items first.",
      code: "work_order_has_unfitted_requests",
    });
    render(withItems("in_progress", settleWith([])));
    const complete = screen.getByRole("button", { name: "Complete" });
    await waitFor(() => expect(complete).toBeEnabled());
    await act(async () => {
      fireEvent.click(complete);
    });
    expect(setWorkOrderStatus).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Status not changed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Before completing J-000123" })).toBeInTheDocument();
  });
});
