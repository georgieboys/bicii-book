import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const setLine = vi.fn();
const removeLine = vi.fn();
vi.mock("@/app/(staff)/purchasing/actions", () => ({
  setPurchaseOrderLine: (...args: unknown[]) => setLine(...args),
  removePurchaseOrderLine: (...args: unknown[]) => removeLine(...args),
  purchaseCostDefaults: vi.fn(async () => ({ ok: true, data: [] })),
  searchPurchasableProducts: vi.fn(async () => ({ ok: true, data: [] })),
  searchSuppliers: vi.fn(async () => ({ ok: true, data: [] })),
}));

import {
  PurchaseOrderLineSheet,
  minimumQuantity,
  quantityHint,
  type EditableLine,
  type LineSheetOrder,
} from "@/components/domain/purchasing/purchase-order-line-sheet";
import { QuantityProgress } from "@/components/domain/purchasing/quantity-progress";
import { ToastProvider } from "@/components/ui/toast";

const ORDER: LineSheetOrder = {
  id: "d7100000-0000-4000-8000-000000000002",
  supplierId: "d7000000-0000-4000-8000-000000000001",
  status: "partially_received",
  currency: "SGD",
  productIds: ["9a000000-0000-4000-8000-000000000006"],
};

const LINE: EditableLine = {
  id: "d7200000-0000-4000-8000-000000000002",
  product: {
    id: "9a000000-0000-4000-8000-000000000006",
    shortId: "P-000006",
    name: "Chain 11-speed",
    sku: "CN-HG601",
  },
  ordered: 20,
  received: 18,
  expectedAt: null,
  notes: null,
  hasReceipts: true,
  hasJobParts: false,
  unitCost: "24.00",
};

function renderSheet(order: LineSheetOrder, line?: EditableLine) {
  return render(
    <ToastProvider>
      <PurchaseOrderLineSheet order={order} line={line} onClose={vi.fn()} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  setLine.mockReset();
  removeLine.mockReset();
  setLine.mockImplementation(async () => ({ ok: true, data: null }));
});

describe("QuantityProgress", () => {
  it("is a progressbar with the counts and the same facts in words", () => {
    render(
      <QuantityProgress
        label="Chain received"
        ordered={20}
        received={18}
        outstanding={2}
        cancelled={0}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Chain received" });
    expect(bar).toHaveAttribute("aria-valuenow", "18");
    expect(bar).toHaveAttribute("aria-valuemax", "20");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "18 of 20 received · 2 to come");
    expect(screen.getByText("18 of 20 received · 2 to come")).toBeVisible();
  });

  it("names a cancelled remainder (D61) and never exceeds the maximum", () => {
    render(
      <QuantityProgress
        label="Tubes received"
        ordered={20}
        received={0}
        outstanding={0}
        cancelled={20}
      />,
    );
    expect(screen.getByText("0 of 20 received · 20 cancelled")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("PurchaseOrderLineSheet", () => {
  it("never lets the quantity go below what has arrived (D65)", () => {
    expect(minimumQuantity(0)).toBe(1);
    expect(minimumQuantity(18)).toBe(18);
    renderSheet(ORDER, { ...LINE, ordered: 18 });
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
    expect(screen.getByText(/18 already received/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(screen.getByLabelText("Quantity", { exact: false })).toHaveValue("19");
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(screen.getByLabelText("Quantity", { exact: false })).toHaveValue("18");
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
  });

  it("asks for an optional reason once the order is submitted, not on a draft", () => {
    const { unmount } = renderSheet(ORDER, LINE);
    expect(screen.getByLabelText(/Reason for the change/)).toBeInTheDocument();
    unmount();
    renderSheet({ ...ORDER, status: "draft" }, { ...LINE, received: 0, hasReceipts: false });
    expect(screen.queryByLabelText(/Reason for the change/)).not.toBeInTheDocument();
  });

  it("explains why a line with receipts can't be removed", () => {
    renderSheet(ORDER, LINE);
    expect(screen.getByRole("button", { name: "Remove line" })).toBeDisabled();
    expect(screen.getByText(/Part of this line has been received/)).toBeInTheDocument();
  });

  it("explains why a line a customer job's part was ordered on can't be removed", () => {
    renderSheet(
      { ...ORDER, status: "draft" },
      { ...LINE, received: 0, hasReceipts: false, hasJobParts: true },
    );
    expect(screen.getByRole("button", { name: "Remove line" })).toBeDisabled();
    expect(screen.getByText(/Customer jobs ordered parts on this line/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove line…" })).not.toBeInTheDocument();
  });

  it("names the jobs waiting on a line and keeps its quantity at what they need (A-21)", () => {
    const waiting = {
      ...LINE,
      ordered: 5,
      received: 0,
      hasReceipts: false,
      hasJobParts: true,
      waitingJobs: [
        { id: "e0000000-0000-4000-8000-000000000001", jobNumber: "J-000101", quantity: 2 },
        { id: "e0000000-0000-4000-8000-000000000002", jobNumber: "J-000107", quantity: 1 },
      ],
      waitingQuantity: 3,
    };
    expect(minimumQuantity(0, 3)).toBe(3);
    expect(quantityHint(waiting)).toBe(
      "J-000101 and J-000107 are waiting for 3 of these: the order can't be for fewer until they arrive or are cancelled on those jobs.",
    );
    expect(quantityHint(LINE)).toBe("18 already received: the order can't be for fewer.");
    expect(quantityHint({ received: 0 })).toBeUndefined();
    renderSheet(ORDER, waiting);
    expect(screen.getByRole("button", { name: "Remove line" })).toBeDisabled();
    // The way out is named: receive, or cancel on the jobs. Never "Fit".
    expect(
      screen.getByText(
        "J-000101 and J-000107 are waiting for parts on this line, so it stays and can't go below 3. Receive the parts, or cancel them on those jobs first.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Lower its quantity instead/)).not.toBeInTheDocument();
  });

  it("sends the line with its cost as typed, 0 included (D24 as amended)", async () => {
    renderSheet({ ...ORDER, status: "draft" }, { ...LINE, received: 0, hasReceipts: false });
    fireEvent.change(screen.getByLabelText("Unit cost", { exact: false }), {
      target: { value: "0" },
    });
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save line" }));
    });
    await waitFor(() => expect(setLine).toHaveBeenCalled());
    const formData = setLine.mock.calls[0][1] as FormData;
    expect(formData.get("unitCost")).toBe("0");
    expect(formData.get("id")).toBe(LINE.id);
    expect(formData.get("quantityOrdered")).toBe("20");
    expect(formData.get("reason")).toBeNull();
  });
});
