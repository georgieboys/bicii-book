// @vitest-environment node
/**
 * The job's payment Server Actions for Phase 14 step 3 (D156, D161;
 * step3-critique C9, C20): sending a payment link (any staff member,
 * Stripe on, the link built from ADMIN_ORIGIN and never logged, the email
 * keyed by the link id, the replaced link's open Checkout expired);
 * recording a counter payment (admins only, works with Stripe off, the
 * job's stale open Checkouts expired whenever the RPC reports any, a
 * replay included); voiding one (admins only, nothing expired). staffAction is
 * replaced by a stand-in that keeps its schema and options, so the zod
 * rules and the admin flag are checked here; the RPCs are the domain
 * functions' (tests/db for their rules).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("server-only", () => ({}));

const refresh = vi.fn();
vi.mock("next/cache", () => ({ refresh: () => refresh() }));

const options: Record<string, unknown> = {};
const info = vi.fn();
const log = { info, warn: vi.fn(), error: vi.fn() };
vi.mock("@/lib/actions", () => ({
  ActionError: class ActionError extends Error {},
  staffAction: (
    schema: z.ZodType,
    opts: { name: string },
    handler: (input: unknown, ctx: unknown) => unknown,
  ) => {
    options[opts.name] = opts;
    return async (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: "Check the highlighted fields.", issues: parsed.error.issues };
      }
      try {
        return {
          ok: true,
          data: await handler(parsed.data, {
            supabase: { client: "staff" },
            correlationId: "corr-1",
            log,
          }),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
  },
}));

const sendBalanceLink = vi.fn();
const recordCounterPayment = vi.fn();
const voidCounterPayment = vi.fn();
vi.mock("@/lib/domain/payments", () => ({
  sendBalanceLink: (...a: unknown[]) => sendBalanceLink(...a),
  recordCounterPayment: (...a: unknown[]) => recordCounterPayment(...a),
  voidCounterPayment: (...a: unknown[]) => voidCounterPayment(...a),
}));
const getQuoteRecipient = vi.fn();
vi.mock("@/lib/domain/indent", () => ({
  getQuoteRecipient: (...a: unknown[]) => getQuoteRecipient(...a),
}));
const balanceEmailEnabled = vi.fn();
const sendBalanceEmail = vi.fn();
vi.mock("@/lib/integrations/email/balance", () => ({
  balanceEmailEnabled: () => balanceEmailEnabled(),
  sendBalanceEmail: (...a: unknown[]) => sendBalanceEmail(...a),
}));
const expireOpenCheckouts = vi.fn();
vi.mock("@/lib/integrations/stripe/checkout", () => ({
  expireOpenCheckouts: (...a: unknown[]) => expireOpenCheckouts(...a),
  refreshPaymentFromStripe: vi.fn(),
}));
const stripeConnection = vi.fn();
vi.mock("@/lib/integrations/stripe/client", () => ({
  stripeConnection: () => stripeConnection(),
}));
const deps = { marker: "deps" };
vi.mock("@/lib/integrations/stripe/deps", () => ({ defaultStripeDeps: () => deps }));
vi.mock("@/lib/integrations/stripe/limits", () => ({ noteStripeCheck: vi.fn() }));

// Called with raw (form-like) input, as a browser would: the schema decides.
type Loose = (input: unknown) => Promise<unknown>;
const actions = await import("@/app/(staff)/jobs/payment-actions");
const sendBalanceLinkAction = actions.sendBalanceLinkAction as unknown as Loose;
const recordCounterPaymentAction = actions.recordCounterPaymentAction as unknown as Loose;
const voidCounterPaymentAction = actions.voidCounterPaymentAction as unknown as Loose;

const JOB = "66666666-7777-4888-9999-000000000000";
const LINK = "33333333-4444-4555-8666-000000000001";
const OLD_LINK = "33333333-4444-4555-8666-000000000000";
const QUOTE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const COUNTER = "22222222-3333-4444-8555-000000000001";
const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";
const ORIGIN = "https://admin.bicii.test";

const ON = { state: "on", origin: ORIGIN };
const SENT = {
  linkId: LINK,
  token: TOKEN,
  amount: "180.00",
  expiresAt: "2026-10-24T02:00:00Z",
  replacedLinkId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  stripeConnection.mockReturnValue(ON);
  sendBalanceLink.mockResolvedValue(SENT);
  balanceEmailEnabled.mockReturnValue(true);
  getQuoteRecipient.mockResolvedValue({
    jobNumber: "J-000123",
    firstName: "Priya",
    email: "priya@example.test",
  });
  sendBalanceEmail.mockResolvedValue({ ok: true, id: "em_1" });
  expireOpenCheckouts.mockResolvedValue({ expired: 0, paid: 0, failed: 0 });
});

const linkInput = { linkId: LINK, workOrderId: JOB, channel: "whatsapp", validDays: "7" };

describe("sendBalanceLinkAction (D156)", () => {
  it("is for any active staff member: no role or permission", () => {
    expect(options["payments.send_balance_link"]).toEqual({ name: "payments.send_balance_link" });
  });

  it("returns the link from ADMIN_ORIGIN, shown once, and refreshes the job", async () => {
    await expect(sendBalanceLinkAction(linkInput)).resolves.toEqual({
      ok: true,
      data: {
        link: `${ORIGIN}/pay/${TOKEN}`,
        amount: "180.00",
        validDays: 7,
        expiresAt: "2026-10-24T02:00:00Z",
        emailedTo: null,
        emailFailed: false,
        checkoutNote: null,
      },
    });
    expect(sendBalanceLink).toHaveBeenCalledWith(
      { client: "staff" },
      { linkId: LINK, workOrderId: JOB, channel: "whatsapp", validDays: 7 },
    );
    expect(sendBalanceEmail).not.toHaveBeenCalled();
    // Nothing was replaced, so nothing is expired.
    expect(expireOpenCheckouts).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("is refused while Stripe is off, or its state is unreadable, before anything is sent", async () => {
    for (const off of [
      () => stripeConnection.mockReturnValue({ state: "off", origin: null }),
      () =>
        stripeConnection.mockImplementation(() => {
          throw new Error("EnvError");
        }),
    ]) {
      off();
      await expect(sendBalanceLinkAction(linkInput)).resolves.toEqual({
        ok: false,
        error:
          "Stripe isn't set up, so the customer can't pay online. Take the payment at the counter.",
      });
    }
    expect(sendBalanceLink).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("by email: refused when email is off or the customer has no address, else emailed", async () => {
    const byEmail = { ...linkInput, channel: "email" };
    balanceEmailEnabled.mockReturnValue(false);
    await expect(sendBalanceLinkAction(byEmail)).resolves.toMatchObject({
      ok: false,
      error: "Email isn't set up yet. Send by WhatsApp or copy the link.",
    });
    balanceEmailEnabled.mockReturnValue(true);
    getQuoteRecipient.mockResolvedValueOnce({ jobNumber: "J-1", firstName: null, email: null });
    await expect(sendBalanceLinkAction(byEmail)).resolves.toMatchObject({
      ok: false,
      error: "The customer has no email address. Add one, or send by WhatsApp or copy the link.",
    });
    expect(sendBalanceLink).not.toHaveBeenCalled();

    const result = await sendBalanceLinkAction(byEmail);
    expect(result).toMatchObject({
      ok: true,
      data: { emailedTo: "priya@example.test", emailFailed: false },
    });
    expect(sendBalanceEmail).toHaveBeenCalledWith({
      linkId: LINK,
      to: "priya@example.test",
      firstName: "Priya",
      jobNumber: "J-000123",
      amount: "$180.00",
      link: `${ORIGIN}/pay/${TOKEN}`,
      days: 7,
    });
  });

  it("a failed email keeps the link: staff copy it instead", async () => {
    sendBalanceEmail.mockResolvedValue({ ok: false, reason: "unavailable" });
    await expect(sendBalanceLinkAction({ ...linkInput, channel: "email" })).resolves.toMatchObject({
      ok: true,
      data: { link: `${ORIGIN}/pay/${TOKEN}`, emailedTo: null, emailFailed: true },
    });
  });

  it("a replaced link's open Checkout is expired (balance only, no quote), and said when it was not", async () => {
    sendBalanceLink.mockResolvedValue({ ...SENT, replacedLinkId: OLD_LINK });
    await expect(sendBalanceLinkAction(linkInput)).resolves.toMatchObject({
      ok: true,
      data: { checkoutNote: null },
    });
    expect(expireOpenCheckouts).toHaveBeenCalledWith(JOB, { deps });

    expireOpenCheckouts.mockResolvedValue({ expired: 0, paid: 0, failed: 1 });
    await expect(sendBalanceLinkAction(linkInput)).resolves.toMatchObject({
      data: {
        checkoutNote: "The earlier link's payment page may still be open; use Check with Stripe.",
      },
    });
    expireOpenCheckouts.mockResolvedValue({ expired: 0, paid: 1, failed: 0 });
    await expect(sendBalanceLinkAction(linkInput)).resolves.toMatchObject({
      data: {
        checkoutNote:
          "A payment on the earlier link has just gone through. The new link asks only what is left; check the card.",
      },
    });
  });

  it("never logs the link or its token", async () => {
    sendBalanceLink.mockResolvedValue({ ...SENT, replacedLinkId: OLD_LINK });
    await sendBalanceLinkAction(linkInput);
    expect(info).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
  });

  it("validates its input: the channel and 1 to 30 days", async () => {
    for (const bad of [
      { ...linkInput, channel: "sms" },
      { ...linkInput, validDays: "0" },
      { ...linkInput, validDays: "31" },
      { ...linkInput, linkId: "x" },
    ]) {
      await expect(sendBalanceLinkAction(bad)).resolves.toMatchObject({ ok: false });
    }
    expect(sendBalanceLink).not.toHaveBeenCalled();
  });
});

const counterInput = {
  id: COUNTER,
  workOrderId: JOB,
  quoteId: null,
  amount: "3800",
  method: "cash",
  receivedAt: null,
  reference: "  ",
  note: "",
};

describe("recordCounterPaymentAction (D161)", () => {
  beforeEach(() => {
    recordCounterPayment.mockResolvedValue({
      counterPaymentId: COUNTER,
      replayed: false,
      openCheckouts: 0,
    });
  });

  it("is for an active admin only (D161a)", () => {
    expect(options["payments.record_counter_payment"]).toEqual({
      name: "payments.record_counter_payment",
      admin: true,
    });
  });

  it("records towards the bill with the amount as money and blanks as null, with Stripe off too", async () => {
    stripeConnection.mockReturnValue({ state: "off", origin: null });
    await expect(recordCounterPaymentAction(counterInput)).resolves.toEqual({
      ok: true,
      data: { replayed: false, checkoutNote: null },
    });
    expect(recordCounterPayment).toHaveBeenCalledWith(
      { client: "staff" },
      {
        id: COUNTER,
        workOrderId: JOB,
        quoteId: null,
        amount: "3800.00",
        method: "cash",
        receivedAt: null,
        reference: null,
        note: null,
      },
    );
    expect(expireOpenCheckouts).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("a deposit carries its quote and a past day's instant", async () => {
    await recordCounterPaymentAction({
      ...counterInput,
      quoteId: QUOTE,
      amount: "300.00",
      method: "paynow",
      receivedAt: "2026-10-12T04:00:00.000Z",
      reference: "PN-1",
    });
    expect(recordCounterPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        quoteId: QUOTE,
        amount: "300.00",
        method: "paynow",
        receivedAt: "2026-10-12T04:00:00.000Z",
        reference: "PN-1",
      }),
    );
  });

  it("expires the stale open Checkouts after a real record, for that quote's deposit and any balance", async () => {
    recordCounterPayment.mockResolvedValue({
      counterPaymentId: COUNTER,
      replayed: false,
      openCheckouts: 2,
    });
    expireOpenCheckouts.mockResolvedValue({ expired: 2, paid: 0, failed: 0 });
    await expect(
      recordCounterPaymentAction({ ...counterInput, quoteId: QUOTE, amount: "300" }),
    ).resolves.toEqual({ ok: true, data: { replayed: false, checkoutNote: null } });
    expect(expireOpenCheckouts).toHaveBeenCalledWith(JOB, { quoteId: QUOTE, deps });
  });

  it("says when one was paid meanwhile, or may still be open (Stripe off or not reached)", async () => {
    recordCounterPayment.mockResolvedValue({
      counterPaymentId: COUNTER,
      replayed: false,
      openCheckouts: 1,
    });
    expireOpenCheckouts.mockResolvedValue({ expired: 0, paid: 1, failed: 0 });
    await expect(recordCounterPaymentAction(counterInput)).resolves.toMatchObject({
      data: {
        checkoutNote:
          "An online payment for this job has just gone through; refund it in Stripe or record the counter money as given back.",
      },
    });
    for (const result of [
      { expired: 0, paid: 0, failed: 1 },
      // Stripe off: nothing could be expired.
      { expired: 0, paid: 0, failed: 0 },
    ]) {
      expireOpenCheckouts.mockResolvedValue(result);
      await expect(recordCounterPaymentAction(counterInput)).resolves.toMatchObject({
        data: {
          checkoutNote:
            "An online payment page may still be open for this job; use Check with Stripe.",
        },
      });
    }
  });

  it("a replay still expires the open Checkouts the RPC reports (the first expiry may not have finished)", async () => {
    // The first submission committed but its expiry failed or was cut off;
    // the admin retries from the same sheet (same id, same values).
    recordCounterPayment.mockResolvedValue({
      counterPaymentId: COUNTER,
      replayed: true,
      openCheckouts: 3,
    });
    expireOpenCheckouts.mockResolvedValue({ expired: 2, paid: 0, failed: 1 });
    await expect(recordCounterPaymentAction(counterInput)).resolves.toEqual({
      ok: true,
      data: {
        replayed: true,
        checkoutNote:
          "An online payment page may still be open for this job; use Check with Stripe.",
      },
    });
    expect(expireOpenCheckouts).toHaveBeenCalledWith(JOB, { quoteId: null, deps });
  });

  it("a replay with nothing open expires nothing", async () => {
    recordCounterPayment.mockResolvedValue({
      counterPaymentId: COUNTER,
      replayed: true,
      openCheckouts: 0,
    });
    await expect(recordCounterPaymentAction(counterInput)).resolves.toEqual({
      ok: true,
      data: { replayed: true, checkoutNote: null },
    });
    expect(expireOpenCheckouts).not.toHaveBeenCalled();
  });

  it("validates its input before the RPC", async () => {
    for (const bad of [
      { ...counterInput, amount: "" },
      { ...counterInput, amount: "0" },
      { ...counterInput, amount: "-5" },
      { ...counterInput, amount: "1000000" },
      { ...counterInput, amount: "abc" },
      { ...counterInput, method: "stripe" },
      { ...counterInput, quoteId: "not-a-uuid" },
      { ...counterInput, receivedAt: "yesterday" },
      { ...counterInput, reference: "r".repeat(201) },
      { ...counterInput, note: "n".repeat(2001) },
    ]) {
      await expect(recordCounterPaymentAction(bad), JSON.stringify(bad)).resolves.toMatchObject({
        ok: false,
      });
    }
    expect(recordCounterPayment).not.toHaveBeenCalled();
    await expect(
      recordCounterPaymentAction({ ...counterInput, amount: "999999.99" }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("voidCounterPaymentAction (D161d)", () => {
  beforeEach(() => voidCounterPayment.mockResolvedValue({ replayed: false }));

  it("is for an active admin only", () => {
    expect(options["payments.void_counter_payment"]).toEqual({
      name: "payments.void_counter_payment",
      admin: true,
    });
  });

  it("voids with its kind and the trimmed reason, refreshes, and expires nothing", async () => {
    for (const kind of ["recorded_in_error", "given_back"]) {
      await expect(
        voidCounterPaymentAction({ counterPaymentId: COUNTER, kind, reason: "  Typo  " }),
      ).resolves.toEqual({ ok: true, data: { replayed: false } });
      expect(voidCounterPayment).toHaveBeenLastCalledWith(
        { client: "staff" },
        { counterPaymentId: COUNTER, kind, reason: "Typo" },
      );
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(expireOpenCheckouts).not.toHaveBeenCalled();
  });

  it("needs a kind and a reason", async () => {
    for (const bad of [
      { counterPaymentId: COUNTER, kind: "refunded", reason: "x" },
      { counterPaymentId: COUNTER, kind: "given_back", reason: "   " },
      { counterPaymentId: COUNTER, kind: "given_back", reason: "r".repeat(501) },
    ]) {
      await expect(voidCounterPaymentAction(bad)).resolves.toMatchObject({ ok: false });
    }
    expect(voidCounterPayment).not.toHaveBeenCalled();
  });
});
