/**
 * The customer's payment link page, /pay/<token> (Phase 14 step 3; D156f;
 * step3-critique C10, C11): the token's shape is checked first, then the
 * view limit, then `balance_by_token` as anon; each state's words; the
 * bill's lines and totals as Postgres gives them; Pay, its copy and the
 * privacy line only on a due bill with Stripe on; and the metadata that
 * keeps the page out of search and referrers. The page is called as the
 * async function it is and its result rendered (the data sources mocked).
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const noteBalanceAttempt = vi.fn();
vi.mock("@/lib/admin/balance-throttle", () => ({
  noteBalanceAttempt: (...args: unknown[]) => noteBalanceAttempt(...args),
}));
const rpc = vi.fn();
vi.mock("@/lib/supabase/anon", () => ({ createAnonClient: () => ({ rpc }) }));
const stripeIsOn = vi.fn();
vi.mock("@/lib/integrations/stripe/client", () => ({ stripeIsOn: () => stripeIsOn() }));
const checkBalanceAction = vi.fn();
vi.mock("@/app/(customer)/pay/[token]/actions", () => ({
  startBalanceCheckoutAction: vi.fn(),
  checkBalanceAction: (...args: unknown[]) => checkBalanceAction(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const pageModule = await import("@/app/(customer)/pay/[token]/page");
const PayPage = pageModule.default;
import { STRIPE_PRIVACY_LINE } from "@/app/(customer)/stripe-privacy-line";

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";

const openView = {
  status: "open",
  shop_name: "BICII",
  job_number: "J-000042",
  bike: "Brompton C Line",
  first_name: "Mei",
  currency: "SGD",
  lines: [
    { description: "Labour", quantity: 1, line_total: 80 },
    { description: "Brake pads", quantity: 2, line_total: 25.5 },
  ],
  job_total: 105.5,
  paid: 30,
  paid_ahead: 0,
  balance_due: 75.5,
  payment: "due",
};

async function renderPage(token = TOKEN, search: Record<string, string> = {}) {
  const element = await PayPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(search),
  } as never);
  return render(element);
}

beforeEach(() => {
  noteBalanceAttempt.mockReset().mockResolvedValue("ok");
  rpc.mockReset().mockResolvedValue({ data: openView, error: null });
  stripeIsOn.mockReset().mockReturnValue(true);
  checkBalanceAction.mockReset().mockResolvedValue({ ok: true, data: { state: null } });
  window.history.replaceState(null, "", `/pay/${TOKEN}`);
});

describe("/pay/[token] metadata", () => {
  it("is not indexed, sends no referrer, and allows Pay its Stripe calls", () => {
    expect(pageModule.metadata).toEqual({
      title: { absolute: "Your bill · BICII" },
      robots: { index: false, follow: false, nocache: true },
      referrer: "no-referrer",
    });
    expect(pageModule.maxDuration).toBe(60);
  });
});

describe("/pay/[token] before the bill", () => {
  it("checks the token's shape before counting or reading anything", async () => {
    await renderPage("not-a-token");
    expect(screen.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
    expect(noteBalanceAttempt).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("counts the view before reading, and reads nothing past the limit", async () => {
    noteBalanceAttempt.mockResolvedValue("limited");
    await renderPage();
    expect(noteBalanceAttempt).toHaveBeenCalledWith("view", TOKEN);
    expect(screen.getByRole("heading", { name: "Too many requests" })).toBeVisible();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads balance_by_token with the token", async () => {
    await renderPage();
    expect(noteBalanceAttempt).toHaveBeenCalledWith("view", TOKEN);
    expect(rpc).toHaveBeenCalledWith("balance_by_token", { p_token: TOKEN });
  });

  it("says when the bill can't be read, an unknown token, and a shape it does not know", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const { unmount } = await renderPage();
    expect(
      screen.getByRole("heading", { name: "This bill can't be shown right now" }),
    ).toBeVisible();
    expect(screen.queryByText("timeout")).toBeNull();
    unmount();

    for (const data of [null, { status: "open", job_number: "J-1" }]) {
      rpc.mockResolvedValue({ data, error: null });
      const page = await renderPage();
      expect(screen.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
      expect(
        screen.getByText("Check you opened the whole link, or ask the shop for a new one."),
      ).toBeVisible();
      page.unmount();
    }
  });

  it.each([
    ["withdrawn", "This payment link was replaced or stopped. Ask the shop for a new one."],
    ["expired", "This payment link has expired. Ask the shop for a new one."],
    ["closed", "This job has changed. Ask the shop how to pay."],
  ])("a %s link shows the job and what to do, no bill and no Pay", async (status, body) => {
    rpc.mockResolvedValue({ data: { status, job_number: "J-000042" }, error: null });
    await renderPage();
    expect(screen.getByRole("heading", { name: "Your bill for job J-000042" })).toBeVisible();
    expect(screen.getByText(body)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(STRIPE_PRIVACY_LINE)).toBeNull();
  });
});

describe("/pay/[token] with an open link", () => {
  it("shows the job, the bike, the greeting, the lines and the totals as Postgres gives them", async () => {
    await renderPage();
    expect(screen.getByText("Job J-000042 · Brompton C Line")).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 1, name: "Hi Mei, here is your bill" }),
    ).toBeVisible();
    const lines = within(screen.getByRole("list", { name: "Your bill" })).getAllByRole("listitem");
    expect(lines.map((l) => l.textContent)).toEqual([
      "LabourQuantity 1$80.00",
      "Brake padsQuantity 2$25.50",
    ]);
    const totals = (term: string) => screen.getByText(term).nextElementSibling?.textContent;
    expect(totals("Job total")).toBe("$105.50");
    expect(totals("Paid so far")).toBe("$30.00");
    expect(totals("Balance due")).toBe("$75.50");
  });

  it("greets without a name and leaves out a missing bike", async () => {
    rpc.mockResolvedValue({ data: { ...openView, first_name: null, bike: "" }, error: null });
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Your bill" })).toBeVisible();
    expect(screen.getByText("Job J-000042")).toBeVisible();
  });

  it("due with Stripe on: Pay for the balance, its copy and the privacy line", async () => {
    await renderPage();
    const payment = screen.getByRole("region", { name: "Payment" });
    expect(within(payment).getByRole("button", { name: "Pay $75.50" })).toBeVisible();
    expect(payment).toHaveTextContent(
      "Pay securely by card or PayNow with Stripe. You'll come back to this page.",
    );
    expect(within(payment).getByText(STRIPE_PRIVACY_LINE)).toBeVisible();
    expect(STRIPE_PRIVACY_LINE).toBe(
      "Payments are taken by Stripe on its own page, so Stripe's privacy policy applies to them; BICII never sees or keeps your card details.",
    );
    expect(checkBalanceAction).not.toHaveBeenCalled();
  });

  it("due with Stripe off: no Pay, the shop says how", async () => {
    stripeIsOn.mockReturnValue(false);
    await renderPage();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(STRIPE_PRIVACY_LINE)).toBeNull();
    expect(screen.getByText("The shop will tell you how to pay the balance.")).toBeVisible();
  });

  it("back from a Checkout left unfinished: says nothing was charged, then Pay", async () => {
    await renderPage(TOKEN, { balance: "cancelled" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Payment not finished. Nothing was charged. You can pay the balance below whenever you're ready.",
    );
    expect(screen.getByRole("button", { name: "Pay $75.50" })).toBeVisible();
    expect(checkBalanceAction).not.toHaveBeenCalled();
  });

  it("back from Stripe while still due: one check, Pay hidden while it runs", async () => {
    window.history.replaceState(null, "", `/pay/${TOKEN}?balance=returned`);
    await renderPage(TOKEN, { balance: "returned" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thanks. We're confirming your payment with Stripe…",
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(checkBalanceAction).toHaveBeenCalledWith({ token: TOKEN });
  });

  it.each([
    [
      "processing",
      {},
      [
        "Your payment is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again.",
      ],
    ],
    ["too_small", { balance_due: "0.30" }, ["Less than $0.50 is left; pay it at the shop."]],
    ["nothing_due", { balance_due: 0 }, ["Nothing is left to pay. Thank you."]],
    [
      "nothing_due",
      { balance_due: 0, paid_ahead: 20 },
      [
        "Nothing is left to pay. Thank you.",
        "You have paid more than the bill; the shop will sort out the difference.",
      ],
    ],
    ["too_large", {}, ["This bill is too large to pay online; pay it at the shop."]],
  ])("%s: says so, with no Pay", async (payment, over, sentences) => {
    rpc.mockResolvedValue({ data: { ...openView, ...over, payment }, error: null });
    await renderPage(TOKEN, { balance: "returned" });
    const payments = screen.getByRole("region", { name: "Payment" });
    expect(
      within(payments)
        .getAllByRole("paragraph")
        .map((p) => p.textContent),
    ).toEqual(sentences);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(STRIPE_PRIVACY_LINE)).toBeNull();
    // Not due: no check at Stripe on the way back.
    expect(checkBalanceAction).not.toHaveBeenCalled();
  });
});
