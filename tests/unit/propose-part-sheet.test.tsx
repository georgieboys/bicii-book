/**
 * The Propose part sheet's new-product id (audit A-87): a refusal archived
 * the product that submit created, so the next submit uses a fresh id; an
 * answer that never came back keeps the id, so a retry replays it.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proposePartAction = vi.fn();
vi.mock("@/app/(staff)/jobs/indent-actions", () => ({
  proposePartAction: (...args: unknown[]) => proposePartAction(...args),
  supplierOptions: vi.fn(async () => ({ ok: true, data: [] })),
  searchIndentProductOptions: vi.fn(async () => ({ ok: true, data: [] })),
  cancelPartRequestAction: vi.fn(),
  fitPartRequestAction: vi.fn(),
  fitPartBoughtOutsideAction: vi.fn(),
}));
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
