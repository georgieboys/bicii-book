import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const voidLine = vi.fn();
vi.mock("@/app/(staff)/jobs/actions", () => ({
  voidLine: (...args: unknown[]) => voidLine(...args),
}));

import { VoidLineControl } from "@/components/domain/void-line-control";
import { ToastProvider } from "@/components/ui/toast";
import { CONFIRM_GUARD_MS } from "@/components/ui/use-armed";

const LINE = "00000000-0000-4000-8000-0000000000c1";

beforeEach(() => {
  voidLine.mockReset();
  voidLine.mockResolvedValue({ ok: true, data: null });
});

const open = (props: Partial<Parameters<typeof VoidLineControl>[0]> = {}) => {
  render(
    <ToastProvider>
      <VoidLineControl lineId={LINE} description="Disc rotor" {...props} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Void…" }));
};

describe("VoidLineControl", () => {
  it("says what goes back to stock on a part line", () => {
    open({ stockReturn: "2 to Shop floor" });
    expect(
      screen.getByText(
        "Voiding returns 2 to Shop floor (a reversal is recorded; nothing is deleted).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/back to approved/)).not.toBeInTheDocument();
  });

  it("D160: on a fitted indent line it says the item goes back to approved, then what goes back to stock", () => {
    open({
      stockReturn: "2 to Shop floor",
      indent: { description: "Disc rotor", backTo: "approved" },
    });
    expect(
      screen.getByText(
        "Voiding puts Disc rotor back to approved: fit it again or cancel it before completing the job. Voiding returns 2 to Shop floor (a reversal is recorded; nothing is deleted).",
      ),
    ).toBeInTheDocument();
  });

  it("D160: an ordered item goes back to ordered; a fitting service has no stock sentence", async () => {
    open({ indent: { description: "Wheel True", backTo: "ordered" } });
    expect(
      screen.getByText(
        "Voiding puts Wheel True back to ordered: fit it again or cancel it before completing the job.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Not needed" } });
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_GUARD_MS + 20));
    fireEvent.click(screen.getByRole("button", { name: "Void line" }));
    await waitFor(() =>
      expect(voidLine).toHaveBeenCalledWith({ lineId: LINE, reason: "Not needed" }),
    );
    expect(await screen.findByText("Wheel True is back to ordered")).toBeInTheDocument();
  });
});
