/**
 * The product sheet's frame grade (D260): offered for frames only; its base
 * price goes into Sale price with Use it; a failed save keeps the chosen
 * grade (React resets the form after every action, so the grade travels
 * in a hidden input).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const updateProduct = vi.fn();
vi.mock("@/app/(staff)/inventory/actions", () => ({
  createProduct: vi.fn(),
  createUniqueItem: vi.fn(),
  searchShopBikes: vi.fn(),
  updateProduct: (...args: unknown[]) => updateProduct(...args),
}));

import { ProductSheet, type ProductFields } from "@/components/domain/product-sheet";
import { ToastProvider } from "@/components/ui/toast";

const FRAMES = { id: "c0000000-0000-4000-8000-000000000001", name: "Frames & forks" };
const SADDLES = { id: "c0000000-0000-4000-8000-000000000002", name: "Saddles" };
const GRADES = [
  { grade: "B", suggestedPrice: "400.00", currency: "SGD" },
  { grade: "B+", suggestedPrice: "500.00", currency: "SGD" },
];

const frame = (overrides: Partial<ProductFields> = {}): ProductFields => ({
  id: "d0000000-0000-4000-8000-000000000144",
  name: "Marin Bolinas Ridge steel frame and fork",
  sku: null,
  brand: "Marin",
  categoryId: FRAMES.id,
  description: null,
  defaultSalePrice: "470.00",
  reorderPoint: null,
  active: true,
  trackingType: "unique",
  frameGrade: null,
  updatedAt: "2026-11-22T02:00:00.123456+00:00",
  ...overrides,
});

function open(product: ProductFields) {
  return render(
    <ToastProvider>
      <ProductSheet
        open
        onOpenChange={vi.fn()}
        product={product}
        categories={[FRAMES, SADDLES]}
        frameGrades={GRADES}
        locations={[]}
        defaultLocationId={null}
        viewCosts={false}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  updateProduct.mockReset();
});

describe("ProductSheet frame grade (D260)", () => {
  it("offers the grade for a frame and puts its base price in with Use it", () => {
    open(frame());
    const price = screen.getByLabelText("Sale price") as HTMLInputElement;
    expect(price.value).toBe("470.00");
    fireEvent.change(screen.getByLabelText("Frame grade"), { target: { value: "B+" } });
    expect(screen.getByText(/Base price for B\+/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(price.value).toBe("500.00");
  });

  it("does not offer a grade outside a frames category", () => {
    open(frame({ categoryId: SADDLES.id }));
    expect(screen.queryByLabelText("Frame grade")).toBeNull();
  });

  it("keeps the chosen grade through a failed save, and sends it again", async () => {
    updateProduct.mockResolvedValue({ ok: false, error: "Not saved.", fieldErrors: {} });
    open(frame());
    fireEvent.change(screen.getByLabelText("Frame grade"), { target: { value: "B+" } });
    const save = screen.getByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(updateProduct).toHaveBeenCalledTimes(1));
    expect((updateProduct.mock.calls[0][1] as FormData).get("frameGrade")).toBe("B+");
    await waitFor(() => expect(screen.getByText("Not saved.")).toBeTruthy());
    expect((screen.getByLabelText("Frame grade") as HTMLSelectElement).value).toBe("B+");
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(updateProduct).toHaveBeenCalledTimes(2));
    expect((updateProduct.mock.calls[1][1] as FormData).get("frameGrade")).toBe("B+");
  });
});
