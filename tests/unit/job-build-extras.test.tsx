/**
 * Build extras (D261) on the job page: the build card lists extras apart,
 * charged on top, and moves a part between the package and the extras; Add
 * part offers "Charge on top" only on a job with a package, and a one-off
 * line (a manual line) carrying the search.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const setExtra = vi.fn();
vi.mock("@/app/(staff)/jobs/build-actions", () => ({
  clearJobBuildAction: vi.fn(),
  fitBuildToBudgetAction: vi.fn(),
  linkBuildOrderAction: vi.fn(),
  repriceBuildLineAction: vi.fn(),
  setJobBuildAction: vi.fn(),
  setBuildLineExtraAction: (...args: unknown[]) => setExtra(...args),
}));
vi.mock("@/app/(staff)/settings/build-packages/actions", () => ({
  createBuildPackageAction: vi.fn(),
  pushBuildPackageAction: vi.fn(),
  setBuildPackageArchivedAction: vi.fn(),
  updateBuildPackageAction: vi.fn(),
}));
const searchParts = vi.fn();
vi.mock("@/app/(staff)/inventory/actions", () => ({
  searchParts: (...args: unknown[]) => searchParts(...args),
}));
vi.mock("@/app/(staff)/consignment/actions", () => ({ searchConsignorsAction: vi.fn() }));
vi.mock("@/app/(staff)/jobs/actions", () => ({
  addPartToJob: vi.fn(),
  addManualLine: vi.fn(),
  addOneOffPartToJob: vi.fn(),
}));

import { AddPartButton } from "@/components/domain/add-part-sheet";
import { JobBuildPanel, type JobBuildView } from "@/components/domain/build-package-controls";
import { ToastProvider } from "@/components/ui/toast";

const FRAME = "a0000000-0000-4000-8000-000000000001";
const SADDLE = "a0000000-0000-4000-8000-000000000002";

const build: JobBuildView = {
  packageId: "b0000000-0000-4000-8000-000000000001",
  name: "Classic",
  kind: "full_build",
  price: "390.00",
  labourAmount: "180.00",
  partsBudget: "210.00",
  labourLineId: "c0000000-0000-4000-8000-000000000001",
  partsListTotal: "300.00",
  partsTotal: "210.00",
  labourTotal: "180.00",
  packageTotal: "390.00",
  difference: "0.00",
  currency: "SGD",
  listPrices: { [FRAME]: "300.00", [SADDLE]: "120.00" },
  extraLineIds: [SADDLE],
  extrasTotal: "120.00",
};

const parts = [
  { id: FRAME, description: "Groupset", quantity: "1", unitSalePrice: "210.00" },
  { id: SADDLE, description: "Brooks saddle", quantity: "1", unitSalePrice: "120.00" },
];

function panel(open = true) {
  return render(
    <ToastProvider>
      <JobBuildPanel
        workOrderId="d0000000-0000-4000-8000-000000000001"
        open={open}
        build={build}
        packages={[]}
        parts={parts}
        linkedOrder={null}
        unlinkedOrders={[]}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  setExtra.mockReset();
  searchParts.mockReset();
});

describe("build card extras (D261)", () => {
  it("lists extras apart, charged on top, with their total", () => {
    panel();
    const inBuild = screen.getByRole("list", { name: "Parts in the build" });
    expect(within(inBuild).getByText("Groupset")).toBeTruthy();
    expect(within(inBuild).queryByText("Brooks saddle")).toBeNull();
    const extras = screen.getByRole("list", { name: "Extras charged on top" });
    expect(within(extras).getByText("Brooks saddle")).toBeTruthy();
    expect(screen.getByText("Extras on top")).toBeTruthy();
  });

  it("charges a part on top, and puts an extra back in the package", async () => {
    setExtra.mockResolvedValue({ ok: true, data: null });
    panel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Charge Groupset on top" }));
    });
    await waitFor(() => expect(setExtra).toHaveBeenCalledWith({ lineId: FRAME, extra: true }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Put Brooks saddle back in the package" }),
      );
    });
    await waitFor(() => expect(setExtra).toHaveBeenCalledWith({ lineId: SADDLE, extra: false }));
  });

  it("offers no changes on a closed job", () => {
    panel(false);
    expect(screen.queryByRole("button", { name: /on top|back in the package/ })).toBeNull();
  });
});

describe("Add part on a build (D261)", () => {
  const open = (hasBuild: boolean) =>
    render(
      <ToastProvider>
        <AddPartButton
          workOrderId="d0000000-0000-4000-8000-000000000001"
          viewCosts={false}
          currency="SGD"
          hasActiveLocation
          hasBuild={hasBuild}
        />
      </ToastProvider>,
    );

  it("switches to a one-off line carrying the search", async () => {
    searchParts.mockResolvedValue({ ok: true, data: [] });
    open(true);
    fireEvent.click(screen.getByRole("button", { name: "Add part" }));
    const box = screen.getByPlaceholderText("Name, SKU, P- or U- number");
    await act(async () => {
      fireEvent.change(box, { target: { value: "Vintage bell" } });
    });
    await waitFor(() => expect(searchParts).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "New one-off item" }));
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe("Vintage bell");
  });

  const unit = {
    kind: "unit",
    productId: "e0000000-0000-4000-8000-000000000001",
    unitId: "e0000000-0000-4000-8000-000000000002",
    shortId: "U-000012",
    title: "Brooks saddle",
    sku: null,
    salePrice: "120.00",
    currency: "SGD",
    onHandAtDefault: 1,
    onHandTotal: 1,
    byLocation: [
      { locationId: "f0000000-0000-4000-8000-000000000001", name: "Shop floor", onHand: 1 },
    ],
    defaultLocationId: "f0000000-0000-4000-8000-000000000001",
  };

  async function pick(hasBuild: boolean) {
    searchParts.mockResolvedValue({ ok: true, data: [unit] });
    open(hasBuild);
    fireEvent.click(screen.getByRole("button", { name: "Add part" }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Name, SKU, P- or U- number"), {
        target: { value: "Brooks" },
      });
    });
    fireEvent.click(await screen.findByRole("option", { name: /Brooks saddle/ }));
  }

  it("offers Charge on top once a part is picked, only on a job with a package", async () => {
    await pick(true);
    expect(screen.getByLabelText(/Charge on top of the build package/)).toBeTruthy();
  });

  it("does not offer it without a package", async () => {
    await pick(false);
    expect(screen.queryByLabelText(/Charge on top of the build package/)).toBeNull();
  });
});
