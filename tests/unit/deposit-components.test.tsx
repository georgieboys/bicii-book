/**
 * The quote page's deposit components (Phase 14 step 2; D151, D153, D158;
 * R-086): Pay deposit resets when the browser restores the page from its
 * back-forward cache, and the return from Stripe leaves the address once it
 * has done its job and words the next step by whether Stripe is on.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startDepositCheckoutAction = vi.fn();
const checkDepositAction = vi.fn();
vi.mock("@/app/(customer)/quote/[token]/actions", () => ({
  startDepositCheckoutAction: (...args: unknown[]) => startDepositCheckoutAction(...args),
  checkDepositAction: (...args: unknown[]) => checkDepositAction(...args),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { ConfirmingPayment } from "@/app/(customer)/quote/[token]/confirming-payment";
import { DepositCard } from "@/app/(customer)/quote/[token]/deposit-card";
import { PayDepositButton } from "@/app/(customer)/quote/[token]/pay-deposit-button";
import { STRIPE_PRIVACY_LINE } from "@/app/(customer)/stripe-privacy-line";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

beforeEach(() => {
  startDepositCheckoutAction.mockReset();
  checkDepositAction.mockReset();
  refresh.mockReset();
  window.history.replaceState(null, "", `/quote/${TOKEN}?deposit=returned`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PayDepositButton", () => {
  it("stays busy while leaving for Stripe, and resets when Back restores the page", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      startDepositCheckoutAction.mockResolvedValue({
        ok: true,
        data: { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
      });
      render(<PayDepositButton token={TOKEN} amountLabel="$120.00" />);
      const button = screen.getByRole("button", { name: /Pay \$120\.00 deposit|Opening Stripe/ });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
      await waitFor(() => expect(button).toHaveTextContent("Opening Stripe…"));

      // A page shown fresh (not from the cache) changes nothing.
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      });
      expect(button).toHaveTextContent("Opening Stripe…");
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await waitFor(() => expect(button).toHaveTextContent("Pay $120.00 deposit"));
      expect(button).toBeEnabled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});

describe("ConfirmingPayment", () => {
  it("drops ?deposit=returned once the check says it is settled", async () => {
    checkDepositAction.mockResolvedValue({ ok: true, data: { state: "paid" } });
    render(<ConfirmingPayment token={TOKEN} amountLabel="$120.00" payOnline />);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(`/quote/${TOKEN}`);
  });

  it("keeps the marker while Stripe confirms, then drops it after a minute and words the next step", async () => {
    vi.useFakeTimers();
    checkDepositAction.mockResolvedValue({ ok: true, data: { state: "due" } });
    const { unmount } = render(
      <ConfirmingPayment token={TOKEN} amountLabel="$120.00" payOnline={false} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.location.search).toBe("?deposit=returned");
    expect(screen.getByRole("status")).toHaveTextContent("We're confirming your payment");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 13);
    });
    expect(window.location.search).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Stripe hasn't confirmed your payment yet. If you paid, you don't need to pay again; it shows here soon. The shop will tell you how to pay the deposit.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    window.history.replaceState(null, "", `/quote/${TOKEN}?deposit=returned`);
    render(<ConfirmingPayment token={TOKEN} amountLabel="$120.00" payOnline />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 * 14);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "If you didn't finish, you can pay below.",
    );
    expect(screen.getByRole("button", { name: "Pay $120.00 deposit" })).toBeVisible();
    expect(screen.getByText(STRIPE_PRIVACY_LINE)).toBeVisible();
  });
});

describe("DepositCard: the privacy line under Pay (the privacy notice names Stripe)", () => {
  const deposit = (status: "due" | "paid" | "processing" | "refunded") => ({
    percent: 50,
    amount: "120.00",
    status,
    parts_ordered: false,
    job_closed: false,
  });

  it("says Stripe takes the payment on its own page, under Pay only", () => {
    window.history.replaceState(null, "", `/quote/${TOKEN}`);
    const { unmount } = render(
      <DepositCard
        token={TOKEN}
        deposit={deposit("due")}
        currency="SGD"
        payOnline
        returning={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Pay $120.00 deposit" })).toBeVisible();
    expect(screen.getByText(STRIPE_PRIVACY_LINE)).toBeVisible();
    expect(STRIPE_PRIVACY_LINE).toBe(
      "Payments are taken by Stripe on its own page, so Stripe's privacy policy applies to them; BICII never sees or keeps your card details.",
    );
    unmount();

    for (const [status, payOnline] of [
      ["due", false],
      ["paid", true],
      ["processing", true],
      ["refunded", true],
    ] as const) {
      const card = render(
        <DepositCard
          token={TOKEN}
          deposit={deposit(status)}
          currency="SGD"
          payOnline={payOnline}
          returning={null}
        />,
      );
      expect(screen.queryByRole("button"), status).toBeNull();
      expect(screen.queryByText(STRIPE_PRIVACY_LINE), status).toBeNull();
      card.unmount();
    }
  });
});
