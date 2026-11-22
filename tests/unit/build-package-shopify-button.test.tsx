/**
 * Settings → Build packages: the Shopify buttons (D252). Shopify takes a
 * package only while it is public and not archived, so such a package that
 * is still online offers only Take off Shopify; the success toast names
 * the donor-bike option only when the package has a donor bike service.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const push = vi.fn();
vi.mock("@/app/(staff)/settings/build-packages/actions", () => ({
  createBuildPackageAction: vi.fn(),
  pushBuildPackageAction: (...args: unknown[]) => push(...args),
  setBuildPackageArchivedAction: vi.fn(),
  updateBuildPackageAction: vi.fn(),
}));
vi.mock("@/app/(staff)/jobs/build-actions", () => ({
  clearJobBuildAction: vi.fn(),
  fitBuildToBudgetAction: vi.fn(),
  linkBuildOrderAction: vi.fn(),
  repriceBuildLineAction: vi.fn(),
  setJobBuildAction: vi.fn(),
  setBuildLineExtraAction: vi.fn(),
}));
vi.mock("@/app/(staff)/inventory/actions", () => ({ searchParts: vi.fn() }));
vi.mock("@/app/(staff)/jobs/actions", () => ({ addPartToJob: vi.fn(), addManualLine: vi.fn() }));

import { ShopifyPackageButton, frameChoiceText } from "@/components/domain/build-package-controls";
import { ToastProvider } from "@/components/ui/toast";

const ID = "b0000000-0000-4000-8000-000000000001";

function renderButton(props: Partial<Parameters<typeof ShopifyPackageButton>[0]> = {}) {
  return render(
    <ToastProvider>
      <ShopifyPackageButton
        id={ID}
        online={false}
        pushed={false}
        sellable
        hasDonor={false}
        {...props}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  push.mockReset();
  push.mockImplementation(async () => ({ ok: true, data: null }));
});

describe("ShopifyPackageButton", () => {
  it("offers Update and Take off for a sellable package already online", () => {
    renderButton({ online: true, pushed: true });
    expect(screen.getByRole("button", { name: "Update on Shopify" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take off Shopify" })).toBeInTheDocument();
  });

  it("offers only Take off Shopify for an archived or hidden package still online", () => {
    renderButton({ online: true, pushed: true, sellable: false });
    expect(screen.queryByRole("button", { name: "Update on Shopify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Put on Shopify" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take off Shopify" })).toBeInTheDocument();
  });

  it("names the donor-bike option only when the package has a donor service", async () => {
    renderButton({ hasDonor: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Put on Shopify" }));
    });
    expect(push).toHaveBeenCalledWith({ id: ID, publishOnline: true });
    expect(
      await screen.findByText(
        "Customers choose where the frame comes from: one of ours or their own.",
      ),
    ).toBeInTheDocument();
    expect(frameChoiceText(true)).toBe(
      "Customers choose where the frame comes from: one of ours, their own, or a donor bike.",
    );
  });
});
