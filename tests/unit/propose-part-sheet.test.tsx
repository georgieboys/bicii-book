/**
 * The Propose part sheet's new-product id (audit A-87): a refusal archived
 * the product that submit created, so the next submit uses a fresh id; an
 * answer that never came back keeps the id, so a retry replays it.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proposePartAction = vi.fn();
const searchIndent = vi.fn(async (_: unknown) => ({ ok: true, data: [] as unknown[] }));
vi.mock("@/app/(staff)/jobs/indent-actions", () => ({
  proposePartAction: (...args: unknown[]) => proposePartAction(...args),
  supplierOptions: vi.fn(async () => ({ ok: true, data: [] })),
  searchIndentProductOptions: (a: unknown) => searchIndent(a),
  cancelPartRequestAction: vi.fn(),
  fitPartRequestAction: vi.fn(),
  fitPartBoughtOutsideAction: vi.fn(),
  proposeOneOffPartAction: vi.fn(),
}));
vi.mock("@/app/(staff)/consignment/actions", () => ({ searchConsignorsAction: vi.fn() }));
vi.mock("@/app/(staff)/jobs/actions", () => ({ searchServiceOptions: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { IndentCard } from "@/components/domain/indent-card";
import { ToastProvider } from "@/components/ui/toast";

beforeEach(() => {
  proposePartAction.mockReset();
});

const card = () =>
  render(
    <ToastProvider>
      <IndentCard
        workOrderId="00000000-0000-4000-8000-000000000001"
        jobNumber="J-000123"
        open
        jobStatus="in_progress"
        panel={{ requests: [], quote: null }}
        customer={{ firstName: "Priya", phone: null, email: null }}
        canOrder={false}
        purchaseData={false}
        canCreateProduct
        emailEnabled={false}
      />
    </ToastProvider>,
  );

async function submitNewPart() {
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Propose part" }).at(-1)!);
  });
}

const sentIds = () =>
  proposePartAction.mock.calls.map((c) => (c[0] as { newProductId: string }).newProductId);

describe("Propose part: a new product (A-87)", () => {
  it("uses a fresh product id after a refusal, the same one after a lost answer", async () => {
    card();
    fireEvent.click(screen.getByRole("button", { name: "Propose part" }));
    fireEvent.click(screen.getByRole("radio", { name: "New product" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Brake pad" } });

    proposePartAction.mockResolvedValueOnce({ ok: false, error: "This job is not open." });
    await submitNewPart();
    proposePartAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    await submitNewPart();
    proposePartAction.mockResolvedValueOnce({ ok: false, error: "This job is not open." });
    await submitNewPart();

    const [first, second, third] = sentIds();
    expect(first).not.toBe("");
    expect(second).not.toBe(first);
    expect(third).toBe(second);
  });
});

describe("Propose part: parts already in the shop (D265)", () => {
  const option = (o: Record<string, unknown>) => ({
    id: "00000000-0000-4000-8000-000000000019",
    name: "Dia-Compe 188 levers",
    shortId: "P-000019",
    sku: null,
    salePrice: "43.00",
    currency: "SGD",
    onHand: 7,
    consigned: true,
    orderable: true,
    ...o,
  });

  async function pick(data: unknown[]) {
    searchIndent.mockResolvedValueOnce({ ok: true, data });
    card();
    fireEvent.click(screen.getByRole("button", { name: "Propose part" }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Name, SKU or P- number"), {
        target: { value: "Dia-Compe" },
      });
    });
    const found = await screen.findByRole("option", { name: /Dia-Compe 188 levers/ });
    fireEvent.click(found);
    return found;
  }

  it("consigned stock counted by quantity can be proposed", async () => {
    const found = await pick([option({})]);
    expect(found.textContent).toContain("Consigned · 7 in stock");
    expect(screen.queryByRole("status")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "Propose part" });
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a one-of-a-kind item points to Add part and cannot be proposed", async () => {
    const found = await pick([option({ orderable: false, consigned: false, onHand: 1 })]);
    expect(found.textContent).toContain("In stock · use Add part");
    expect(screen.getByRole("status").textContent).toMatch(
      /one-of-a-kind item already in the shop/,
    );
    const buttons = screen.getAllByRole("button", { name: "Propose part" });
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(true);
  });
});
