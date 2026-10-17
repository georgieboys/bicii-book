/**
 * The pay page's client components (Phase 14 step 3; D156g, D156h; R-086;
 * step3-critique C11): Pay resets when the browser restores the page from
 * its back-forward cache and refreshes when the page has moved on; the
 * return from Stripe makes one check, polls while the bill is still due,
 * leaves the address once it has done its job, and keeps what Stripe said
 * on screen even when the page then reads as a notice.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startBalanceCheckoutAction = vi.fn();
const checkBalanceAction = vi.fn();
vi.mock("@/app/(customer)/pay/[token]/actions", () => ({
  startBalanceCheckoutAction: (...args: unknown[]) => startBalanceCheckoutAction(...args),
  checkBalanceAction: (...args: unknown[]) => checkBalanceAction(...args),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import {
  BalanceReturn,
  ReturnSlot,
  type PageState,
} from "@/app/(customer)/pay/[token]/balance-return";
import { PayBalanceButton } from "@/app/(customer)/pay/[token]/pay-balance-button";

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";

beforeEach(() => {
  startBalanceCheckoutAction.mockReset();
  checkBalanceAction.mockReset();
  refresh.mockReset();
  window.history.replaceState(null, "", `/pay/${TOKEN}?balance=returned`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PayBalanceButton", () => {
  it("stays busy while leaving for Stripe, and resets when Back restores the page", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      startBalanceCheckoutAction.mockResolvedValue({
        ok: true,
        data: { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
      });
      render(<PayBalanceButton token={TOKEN} amountLabel="$75.50" />);
      const button = screen.getByRole("button", { name: /Pay \$75\.50|Opening Stripe/ });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(startBalanceCheckoutAction).toHaveBeenCalledWith({ token: TOKEN });
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
      await waitFor(() => expect(button).toHaveTextContent("Opening Stripe…"));

      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      });
      expect(button).toHaveTextContent("Opening Stripe…");
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await waitFor(() => expect(button).toHaveTextContent("Pay $75.50"));
      expect(button).toBeEnabled();
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("refreshes the page when there is nowhere to go, and shows a refusal as one alert", async () => {
    startBalanceCheckoutAction.mockResolvedValueOnce({ ok: true, data: { url: null } });
    render(<PayBalanceButton token={TOKEN} amountLabel="$75.50" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pay $75.50" }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();

    startBalanceCheckoutAction.mockResolvedValueOnce({
      ok: false,
      error: "Online payment isn't available right now.",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pay $75.50" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Online payment isn't available right now.",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

/** The page as BalanceReturn wraps it: a due bill's Pay sits in the slot. */
function Page({
  page,
  returned = true,
  jobNumber = "J-000042",
  payOnline = true,
  balanceDue = "75.50",
}: {
  page: PageState;
  returned?: boolean;
  jobNumber?: string | null;
  payOnline?: boolean;
  /** balance_due as Postgres gives it; the page formats it. */
  balanceDue?: string;
}) {
  return (
    <BalanceReturn
      token={TOKEN}
      returned={returned}
      page={page}
      jobNumber={jobNumber}
      balanceDue={page === "due" || page === "open" ? balanceDue : null}
    >
      {page === "due" ? (
        <ReturnSlot payOnline={payOnline} amount={`$${balanceDue}`}>
          <button type="button">Pay ${balanceDue}</button>
        </ReturnSlot>
      ) : page === "open" ? (
        <p>Nothing is left to pay. Thank you.</p>
      ) : page === "closed" ? (
        <p>This payment link was replaced or stopped. Ask the shop for a new one.</p>
      ) : (
        <p>This bill can&apos;t be shown right now</p>
      )}
    </BalanceReturn>
  );
}

describe("BalanceReturn (back from Stripe)", () => {
  it("checks once while the bill is due, hiding Pay; Stripe's paid stays on screen and the marker goes", async () => {
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: "paid" } });
    const { rerender } = render(<Page page="due" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thanks. We're confirming your payment with Stripe…",
    );
    expect(screen.queryByRole("button")).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(checkBalanceAction).toHaveBeenCalledTimes(1);
    expect(checkBalanceAction).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thank you. Stripe has confirmed your payment.",
    );
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(`/pay/${TOKEN}`);

    // The refresh shows the bill paid: the page speaks for itself.
    rerender(<Page page="open" returned={false} />);
    expect(screen.getByText("Nothing is left to pay. Thank you.")).toBeVisible();

    // The job was collected meanwhile (the link stopped): the message is
    // still Stripe's answer, not the link's notice.
    rerender(<Page page="closed" returned={false} />);
    expect(screen.getByRole("heading", { name: "Your bill for job J-000042" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thank you. Stripe has confirmed your payment.",
    );
    expect(screen.queryByText(/replaced or stopped/)).toBeNull();
    expect(checkBalanceAction).toHaveBeenCalledTimes(1);
  });

  it("says a payment being confirmed in place of the notice too", async () => {
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: "processing" } });
    const { rerender } = render(<Page page="due" />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Thank you. Your payment is being confirmed by Stripe. You don't need to pay again.",
      ),
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Page page="closed" returned={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your payment is being confirmed by Stripe. You don't need to pay again.",
    );
  });

  it("keeps the marker while Stripe confirms, then drops it after a minute and offers Pay again", async () => {
    vi.useFakeTimers();
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: "due" } });
    const { unmount } = render(<Page page="due" payOnline={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?balance=returned");
    expect(screen.getByRole("status")).toHaveTextContent("We're confirming your payment");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 12);
    });
    // One refresh after the check, then one every 5 seconds, twelve times.
    expect(refresh).toHaveBeenCalledTimes(13);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 3);
    });
    expect(refresh).toHaveBeenCalledTimes(13);
    expect(window.location.search).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Stripe hasn't confirmed your payment yet. If you paid, you don't need to pay again; it shows here soon.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("pay below");
    expect(screen.getByRole("button", { name: "Pay $75.50" })).toBeVisible();
    unmount();

    window.history.replaceState(null, "", `/pay/${TOKEN}?balance=returned`);
    render(<Page page="due" payOnline />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 14);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "If you didn't finish, you can pay below.",
    );
    expect(screen.getByRole("button", { name: "Pay $75.50" })).toBeVisible();
  });

  it("stops asking once the page says something other than due, and lets it speak", async () => {
    vi.useFakeTimers();
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: null } });
    const { rerender } = render(<Page page="due" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
    // A read that failed (an error page) keeps it asking.
    rerender(<Page page="unknown" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(window.location.search).toBe("?balance=returned");
    rerender(<Page page="due" />);
    rerender(<Page page="open" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 4);
    });
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(window.location.search).toBe("");
    expect(screen.getByText("Nothing is left to pay. Thank you.")).toBeVisible();
    expect(screen.queryByText(/confirming your payment/)).toBeNull();
  });

  it("paid, but the bill read again is still due at another amount: the line and Pay together", async () => {
    // Link sent at $100; the customer opened a $100 session; an admin then
    // voided a $100 counter payment, so $200 was due when they came back.
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: "paid" } });
    const { rerender } = render(<Page page="due" balanceDue="200.00" />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // Before the refresh lands (the same bill): the line only, so a
    // just-paid "Pay $200.00" never flashes.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thank you. Stripe has confirmed your payment.",
    );
    expect(screen.queryByRole("button")).toBeNull();

    // The refresh lands: still due, $100 lower. Pay shows at the live amount.
    rerender(<Page page="due" returned={false} balanceDue="100.00" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thank you. Stripe has confirmed your payment. $100.00 is still due on this bill.",
    );
    expect(screen.getByRole("button", { name: "Pay $100.00" })).toBeVisible();
    expect(window.location.search).toBe("");
    expect(checkBalanceAction).toHaveBeenCalledTimes(1);
  });

  it("stops confirming when the bill read again is still due at another amount (recorded meanwhile)", async () => {
    vi.useFakeTimers();
    // The webhook recorded the payment between the page's read and the check.
    checkBalanceAction.mockResolvedValue({ ok: true, data: { state: "due" } });
    const { rerender } = render(<Page page="due" balanceDue="200.00" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("We're confirming your payment");
    rerender(<Page page="due" returned={false} balanceDue="100.00" />);
    // The bill speaks for itself: no confirming line, no payment claim, Pay.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Pay $100.00" })).toBeVisible();
    expect(window.location.search).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 3);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a visit that is not a return to a due bill", async () => {
    render(<Page page="due" returned={false} />);
    expect(screen.getByRole("button", { name: "Pay $75.50" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();

    // Back from Stripe after the webhook already arrived: the page says it.
    window.history.replaceState(null, "", `/pay/${TOKEN}?balance=returned`);
    render(<Page page="open" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(checkBalanceAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText("Nothing is left to pay. Thank you.")).toBeVisible();
  });
});
