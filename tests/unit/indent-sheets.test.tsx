import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fitPartRequestAction = vi.fn();
const fitPartBoughtOutsideAction = vi.fn();
vi.mock("@/app/(staff)/jobs/indent-actions", () => ({
  cancelPartRequestAction: vi.fn(),
  fitPartRequestAction: (...args: unknown[]) => fitPartRequestAction(...args),
  fitPartBoughtOutsideAction: (...args: unknown[]) => fitPartBoughtOutsideAction(...args),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { FitSheet } from "@/components/domain/indent-sheets";
import { ToastProvider } from "@/components/ui/toast";
import type { PartRequest } from "@/lib/domain/indent";

const part: PartRequest = {
  id: "00000000-0000-4000-8000-0000000000a1",
  kind: "part",
  status: "approved",
  description: "Disc rotor",
  quantity: "2.00",
  unitSalePrice: "45.00",
  lineTotal: "90.00",
  currency: "SGD",
  productId: "00000000-0000-4000-8000-0000000000b1",
  serviceId: null,
  cancelReason: null,
  lineId: null,
  order: null,
};

const sheet = (request: PartRequest, purchaseData = true) =>
  render(
    <ToastProvider>
      <FitSheet
        request={request}
        locationName="Shop floor"
        purchaseData={purchaseData}
        onClose={() => {}}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  fitPartRequestAction.mockReset();
  fitPartBoughtOutsideAction.mockReset();
  fitPartRequestAction.mockResolvedValue({ ok: true, data: { lineId: "x" } });
  fitPartBoughtOutsideAction.mockResolvedValue({ ok: true, data: { lineId: "x" } });
  refresh.mockReset();
});

describe("FitSheet: Bought outside BICII (D149a)", () => {
  it("is offered for an approved part never ordered, to cost and purchasing holders", () => {
    sheet({
      ...part,
      purchase: { expectedUnitCost: "28.00", supplierId: null, supplierName: null },
    });
    const dialog = screen.getByRole("dialog", { name: "Fit part" });
    const group = within(dialog).getByRole("radiogroup", { name: "Where it comes from" });
    expect(within(group).getByRole("radio", { name: "From stock" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(dialog).toHaveTextContent("choose Bought outside BICII so the stock count stays right");

    fireEvent.click(within(group).getByRole("radio", { name: "Bought outside BICII" }));
    // Prefilled with the expected cost (D147: the viewer holds the permission).
    expect(within(dialog).getByLabelText(/Cost each/)).toHaveValue("28.00");
    expect(dialog).toHaveTextContent("Expected when proposed: $28.00.");
    expect(dialog).toHaveTextContent(
      "Records 2 × Disc rotor as bought outside BICII at Shop floor and fits it now. The stock count there doesn't change, and the job's yield uses this cost.",
    );
    expect(dialog).toHaveTextContent("Cost 2 × $28.00 = $56.00");
    expect(within(dialog).getByRole("button", { name: "Record and fit" })).toBeEnabled();
  });

  it("is not offered without the permission, for an ordered part or for a service", () => {
    const { unmount } = sheet(part, false);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "ask someone with View costs or Manage purchasing to fit it as bought outside",
    );
    unmount();

    const ordered = sheet({
      ...part,
      status: "ordered",
      order: { purchaseOrderId: "po", poNumber: "PO-000012", arrived: false, locationId: null },
    });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Its order (PO-000012) has not been received yet.",
    );
    ordered.unmount();

    sheet({ ...part, kind: "service", productId: null, serviceId: "s" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add to job" })).toBeInTheDocument();
  });

  it("records and fits with the cost and where it was bought", async () => {
    sheet(part);
    const dialog = screen.getByRole("dialog", { name: "Fit part" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Bought outside BICII" }));
    fireEvent.change(within(dialog).getByLabelText(/Cost each/), { target: { value: "30.00" } });
    fireEvent.change(within(dialog).getByLabelText(/Bought from/), {
      target: { value: "Bike Hub receipt 4471" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Record and fit" }));
    });
    expect(fitPartRequestAction).not.toHaveBeenCalled();
    expect(fitPartBoughtOutsideAction).toHaveBeenCalledWith({
      requestId: part.id,
      lineId: expect.any(String),
      unitCost: "30.00",
      locationId: "",
      reference: "Bike Hub receipt 4471",
    });
    expect(
      await screen.findByText("Disc rotor is on the job (bought outside BICII)."),
    ).toBeInTheDocument();
  });

  it("a cost holder with no product cost: From stock stays disabled, Bought outside records", () => {
    sheet({ ...part, costMissing: true });
    const dialog = screen.getByRole("dialog", { name: "Fit part" });
    expect(within(dialog).getByRole("button", { name: "Fit part" })).toBeDisabled();
    expect(dialog).toHaveTextContent("so it can't be fitted from stock");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Bought outside BICII" }));
    expect(within(dialog).getByRole("button", { name: "Record and fit" })).toBeEnabled();
  });

  it("a stock fit refused for a missing cost switches to Bought outside and asks what was paid", async () => {
    fitPartRequestAction.mockResolvedValue({
      ok: false,
      code: "part_cost_missing",
      error: "This part has no cost yet. Ask someone with View costs to set it.",
    });
    sheet(part);
    const dialog = screen.getByRole("dialog", { name: "Fit part" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Fit part" }));
    });
    expect(within(dialog).getByRole("radio", { name: "Bought outside BICII" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(dialog).toHaveTextContent(
      "This part has no cost yet. If you bought it outside BICII, enter what you paid; otherwise ask someone with View costs to set the product's cost.",
    );
    await waitFor(() => expect(within(dialog).getByLabelText(/Cost each/)).toHaveFocus());
    expect(fitPartBoughtOutsideAction).not.toHaveBeenCalled();
  });

  it("an ordered part refused for a missing cost is received first; a stale order refreshes", async () => {
    fitPartRequestAction.mockResolvedValue({
      ok: false,
      code: "part_cost_missing",
      error: "This part has no cost yet.",
    });
    const { unmount } = sheet({
      ...part,
      status: "ordered",
      order: { purchaseOrderId: "po", poNumber: "PO-000012", arrived: true, locationId: null },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fit part" }));
    });
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "Its cost is set when its order is received in Purchasing. Receive it first.",
    );
    unmount();

    fitPartBoughtOutsideAction.mockResolvedValue({
      ok: false,
      code: "part_request_ordered",
      error: "It is on a purchase order. Receive it in Purchasing, then fit it.",
    });
    sheet(part);
    fireEvent.click(screen.getByRole("radio", { name: "Bought outside BICII" }));
    fireEvent.change(screen.getByLabelText(/Cost each/), { target: { value: "30.00" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record and fit" }));
    });
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "It is on a purchase order.",
    );
    expect(refresh).toHaveBeenCalled();
  });
});
