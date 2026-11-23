/**
 * The sale sheet's Quantity field (src/components/domain/record-sale-sheet.tsx):
 * only a whole number of 1 or more is a quantity, so the line, the stock
 * check and the recorded sale never use a different number than the field
 * shows ("1.5" is not read as 1).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const searchSaleableAction = vi.fn();
const recordSaleAction = vi.fn();
vi.mock("@/app/(staff)/sales/actions", () => ({
  searchSaleableAction: (...args: unknown[]) => searchSaleableAction(...args),
  recordSaleAction: (...args: unknown[]) => recordSaleAction(...args),
}));
vi.mock("@/app/(staff)/customers/actions", () => ({
  searchCustomers: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

import { RecordSaleButton } from "@/components/domain/record-sale-sheet";
import { ToastProvider } from "@/components/ui/toast";

const PRODUCT = "9a000000-0000-4000-8000-000000000010";
const LOCATION = "1c000000-0000-4000-8000-000000000001";

const ROW = {
  key: `${PRODUCT}:${LOCATION}`,
  kind: "product",
  productId: PRODUCT,
  productShortId: "P-000010",
  unitId: null,
  unitShortId: null,
  title: "Inner tube 700c",
  subtitle: "",
  locationId: LOCATION,
  locationName: "Shop floor",
  onHand: 20,
  unitPrice: "8.00",
  ownership: "shop",
  consignment: null,
};

beforeEach(() => {
  searchSaleableAction.mockReset();
  recordSaleAction.mockReset();
  searchSaleableAction.mockResolvedValue({ ok: true, data: { rows: [ROW], rate: null } });
});

async function openWithProduct() {
  render(
    <ToastProvider>
      <RecordSaleButton viewCosts={false} preset={{ q: "P-000010", productId: PRODUCT }} />
    </ToastProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
  });
  await waitFor(() => expect(screen.getByLabelText(/^Quantity/)).toBeInTheDocument());
  return screen.getByLabelText(/^Quantity/);
}

const recordButton = () => screen.getByRole("button", { name: /^Record sale/ });

describe("RecordSaleSheet quantity", () => {
  it("a whole number prices the line and enables Record sale", async () => {
    const qty = await openWithProduct();
    fireEvent.change(qty, { target: { value: "2" } });
    expect(recordButton()).toBeEnabled();
    expect(recordButton()).toHaveTextContent("16.00");
    expect(qty).not.toHaveAttribute("aria-invalid", "true");
  });

  it.each(["1.5", "2x", "1e3", "0"])(
    "%s marks the field invalid and disables Record sale",
    async (text) => {
      const qty = await openWithProduct();
      fireEvent.change(qty, { target: { value: text } });
      expect(screen.getByText("Enter a whole number, like 1.")).toBeInTheDocument();
      expect(qty).toHaveAttribute("aria-invalid", "true");
      expect(recordButton()).toBeDisabled();
    },
  );

  it("an empty field disables Record sale without an error yet", async () => {
    const qty = await openWithProduct();
    fireEvent.change(qty, { target: { value: "" } });
    expect(screen.queryByText("Enter a whole number, like 1.")).not.toBeInTheDocument();
    expect(recordButton()).toBeDisabled();
  });
});

describe("RecordSaleSheet consigned stock BICII holds too little of (D267)", () => {
  const CONSIGNED = {
    ...ROW,
    key: `product:${PRODUCT}:${LOCATION}:shop`,
    title: "Consigned bidon",
    onHand: 0,
    unitPrice: "12.00",
    ownership: "consignment",
    consignment: null,
  };

  it("says what is received on sale and keeps Record sale on", async () => {
    searchSaleableAction.mockResolvedValue({ ok: true, data: { rows: [CONSIGNED], rate: null } });
    const qty = await openWithProduct();
    expect(screen.getByText("Consigned · none recorded: received when sold")).toBeInTheDocument();
    fireEvent.change(qty, { target: { value: "2" } });
    expect(
      screen.getByText(
        "2 not recorded at Shop floor: it is received from the consignor when you record the sale, and a manager checks it later.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Only /)).not.toBeInTheDocument();
    expect(recordButton()).toBeEnabled();
    expect(recordButton()).toHaveTextContent("24.00");
  });

  it("shop stock past what is there is still marked and Record sale stays off", async () => {
    searchSaleableAction.mockResolvedValue({
      ok: true,
      data: { rows: [{ ...ROW, onHand: 1 }], rate: null },
    });
    const qty = await openWithProduct();
    fireEvent.change(qty, { target: { value: "2" } });
    expect(screen.getByText("Only 1 at Shop floor.")).toBeInTheDocument();
    expect(screen.queryByText(/not recorded at/)).not.toBeInTheDocument();
    expect(recordButton()).toBeDisabled();
  });
});
