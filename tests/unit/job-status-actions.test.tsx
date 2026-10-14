import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setWorkOrderStatus = vi.fn();
vi.mock("@/app/(staff)/jobs/actions", () => ({
  setWorkOrderStatus: (...args: unknown[]) => setWorkOrderStatus(...args),
}));

import { JobStatusActions } from "@/components/domain/job-status-actions";
import { ToastProvider } from "@/components/ui/toast";
import type { WorkOrderStatus } from "@/lib/workshop";

beforeEach(() => {
  setWorkOrderStatus.mockReset();
  setWorkOrderStatus.mockResolvedValue({ ok: true, data: null });
});

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
    const { unmount } = render(withPaid({ paid: "$60.00", stillToPay: "$85.00", paidAhead: null }));
    const collected = screen.getByRole("button", { name: "Collected…" });
    await waitFor(() => expect(collected).toBeEnabled());
    fireEvent.click(collected);
    const group = screen.getByRole("group", { name: "Mark J-000123 collected by Priya Raman?" });
    expect(group).toHaveTextContent("$60.00 was paid online. Take only $85.00.");
    unmount();

    render(withPaid({ paid: "$120.00", stillToPay: "$0.00", paidAhead: "$35.00" }));
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
  });
});
