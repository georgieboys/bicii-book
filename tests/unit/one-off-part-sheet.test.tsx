/**
 * New one-off item (D264): a part that isn't in the system yet, made and put
 * on the job in one step, consigned (from the consignor offered first) or
 * the shop's, with what each mode needs.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const addOneOff = vi.fn();
vi.mock("@/app/(staff)/jobs/actions", () => ({
  addOneOffPartToJob: (...args: unknown[]) => addOneOff(...args),
}));
vi.mock("@/app/(staff)/consignment/actions", () => ({
  searchConsignorsAction: vi.fn(async () => ({ ok: true, data: [] })),
}));

import { OneOffPartSheet, type OneOffOptions } from "@/components/domain/one-off-part-sheet";
import { ToastProvider } from "@/components/ui/toast";

const JOB = "00000000-0000-4000-8000-000000000001";
const OWNER = { id: "00000000-0000-4000-8000-0000000000aa", label: "Abhishek" };
const options = (o: Partial<OneOffOptions> = {}): OneOffOptions => ({
  canShop: true,
  canConsign: true,
  defaultConsignor: OWNER,
  locations: [{ id: "00000000-0000-4000-8000-0000000000b1", name: "RV Shop floor" }],
  defaultLocationId: "00000000-0000-4000-8000-0000000000b1",
  ...o,
});

const sheet = (o?: Partial<OneOffOptions>, hasBuild = false) =>
  render(
    <ToastProvider>
      <OneOffPartSheet
        workOrderId={JOB}
        initialName="Vintage Motohandlebars"
        hasBuild={hasBuild}
        options={options(o)}
        onClose={vi.fn()}
      />
    </ToastProvider>,
  );

const money = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  addOneOff.mockReset();
  addOneOff.mockResolvedValue({ ok: true, data: { lineId: "x", productShortId: "P-000200" } });
});

describe("New one-off item (D264)", () => {
  it("defaults to consigned from the consignor offered first, with the search as its name", async () => {
    sheet();
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe(
      "Vintage Motohandlebars",
    );
    money(/Price each/, "120");
    money(/Owed to them for each/, "60");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to job" }));
    });
    expect(addOneOff).toHaveBeenCalledWith(
      expect.objectContaining({
        workOrderId: JOB,
        name: "Vintage Motohandlebars",
        consigned: true,
        consignorId: OWNER.id,
        agreedAmountOwed: expect.stringMatching(/^60/),
        unitCost: "",
        buildExtra: false,
      }),
    );
  });

  it("the shop's asks for a cost instead of what is owed", async () => {
    sheet({ canConsign: false, defaultConsignor: null }, true);
    expect(screen.queryByLabelText(/Owed to them/)).toBeNull();
    money(/Price each/, "25");
    money(/Cost each/, "10");
    fireEvent.click(screen.getByLabelText(/Charge on top of the build package/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to job" }));
    });
    expect(addOneOff).toHaveBeenCalledWith(
      expect.objectContaining({ consigned: false, consignorId: "", buildExtra: true }),
    );
  });

  it("with consignment rights only and no default consignor, it opens on Consigned", () => {
    sheet({ canShop: false, canConsign: true, defaultConsignor: null });
    expect(screen.getByLabelText(/Consigned from/)).toBeTruthy();
    expect(screen.queryByLabelText(/Cost each/)).toBeNull();
  });
});
