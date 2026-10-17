// @vitest-environment node
/**
 * The pay page's Server Actions (Phase 14 step 3; D156g, D156h): the token
 * is checked and counted under the page's "pay" limit before Stripe is
 * reached; Pay's outcomes map to a URL, a refresh (the page words what is
 * now true) or one safe sentence; the return's check passes Stripe's
 * answer through. The token never reaches a log line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const noteBalanceAttempt = vi.fn();
vi.mock("@/lib/admin/balance-throttle", () => ({
  noteBalanceAttempt: (...args: unknown[]) => noteBalanceAttempt(...args),
}));
const startBalanceCheckout = vi.fn();
const confirmBalanceReturn = vi.fn();
vi.mock("@/lib/integrations/stripe/checkout", () => ({
  startBalanceCheckout: (...args: unknown[]) => startBalanceCheckout(...args),
  confirmBalanceReturn: (...args: unknown[]) => confirmBalanceReturn(...args),
}));
const deps = { marker: "deps" };
vi.mock("@/lib/integrations/stripe/deps", () => ({ defaultStripeDeps: () => deps }));
vi.mock("@/lib/auth/session", () => ({ getCorrelationId: async () => "corr-1" }));
const info = vi.fn();
vi.mock("@/lib/logger", () => ({ child: () => ({ info }) }));

const { checkBalanceAction, startBalanceCheckoutAction } =
  await import("@/app/(customer)/pay/[token]/actions");

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";
const UNAVAILABLE =
  "Online payment isn't available right now. Try again in a few minutes, or contact the shop.";

beforeEach(() => {
  noteBalanceAttempt.mockReset().mockResolvedValue("ok");
  startBalanceCheckout.mockReset();
  confirmBalanceReturn.mockReset();
  info.mockReset();
});

function neverLogsTheToken() {
  expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
}

describe("startBalanceCheckoutAction", () => {
  it("refuses a token of the wrong shape before counting or calling Stripe", async () => {
    for (const token of ["", "short", `${TOKEN}x`, `${TOKEN.slice(1)}/`]) {
      await expect(startBalanceCheckoutAction({ token })).resolves.toEqual({
        ok: false,
        error: "This link is not valid.",
      });
    }
    await expect(startBalanceCheckoutAction({} as never)).resolves.toMatchObject({ ok: false });
    expect(noteBalanceAttempt).not.toHaveBeenCalled();
    expect(startBalanceCheckout).not.toHaveBeenCalled();
  });

  it("counts under the pay limit and stops there when it is reached", async () => {
    noteBalanceAttempt.mockResolvedValue("limited");
    await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
      ok: false,
      error: "Too many attempts. Wait a few minutes and try again.",
    });
    expect(noteBalanceAttempt).toHaveBeenCalledWith("pay", TOKEN);
    expect(startBalanceCheckout).not.toHaveBeenCalled();
  });

  it("goes to Stripe's URL, with the server's own deps", async () => {
    startBalanceCheckout.mockResolvedValue({
      kind: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    });
    await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
      ok: true,
      data: { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
    });
    expect(startBalanceCheckout).toHaveBeenCalledWith(TOKEN, deps);
    expect(info).toHaveBeenCalledWith({ action: "balance.pay", outcome: "redirect" }, "action");
    neverLogsTheToken();
  });

  it.each(["processing", "nothing_due"])(
    "%s: refreshes so the page says what is now true",
    async (kind) => {
      startBalanceCheckout.mockResolvedValue({ kind });
      await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
        ok: true,
        data: { url: null },
      });
    },
  );

  it.each([
    "balance_link_not_found",
    "balance_link_withdrawn",
    "balance_link_expired",
    "balance_link_job_closed",
    "balance_too_large",
  ])("refused %s: refreshes so the page words it", async (reason) => {
    startBalanceCheckout.mockResolvedValue({ kind: "refused", reason, message: "db sentence" });
    await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
      ok: true,
      data: { url: null },
    });
    expect(info).toHaveBeenCalledWith(
      { action: "balance.pay", outcome: "refused", reason },
      "action",
    );
    neverLogsTheToken();
  });

  it("another refusal is one safe sentence with its code; unavailable says to try again", async () => {
    startBalanceCheckout.mockResolvedValue({
      kind: "refused",
      reason: "checkout_session_conflict",
      message: "Something changed. Reload and try again.",
    });
    await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
      ok: false,
      error: "Something changed. Reload and try again.",
      code: "checkout_session_conflict",
    });
    startBalanceCheckout.mockResolvedValue({ kind: "unavailable" });
    await expect(startBalanceCheckoutAction({ token: TOKEN })).resolves.toEqual({
      ok: false,
      error: UNAVAILABLE,
    });
  });
});

describe("checkBalanceAction", () => {
  it("passes Stripe's answer through after the pay limit", async () => {
    for (const state of ["paid", "processing", "due", "nothing_due", null]) {
      confirmBalanceReturn.mockResolvedValueOnce({ state });
      await expect(checkBalanceAction({ token: TOKEN })).resolves.toEqual({
        ok: true,
        data: { state },
      });
    }
    expect(confirmBalanceReturn).toHaveBeenCalledWith(TOKEN, deps);
    expect(noteBalanceAttempt).toHaveBeenCalledWith("pay", TOKEN);
    expect(info).toHaveBeenLastCalledWith(
      { action: "balance.check_return", outcome: "unknown" },
      "action",
    );
    neverLogsTheToken();
  });

  it("refuses a bad token and stops at the limit, never reading Stripe", async () => {
    await expect(checkBalanceAction({ token: "nope" })).resolves.toMatchObject({ ok: false });
    noteBalanceAttempt.mockResolvedValue("limited");
    await expect(checkBalanceAction({ token: TOKEN })).resolves.toMatchObject({ ok: false });
    expect(confirmBalanceReturn).not.toHaveBeenCalled();
  });
});
