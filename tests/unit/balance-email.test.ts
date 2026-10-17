// @vitest-environment node
/**
 * The payment link email (src/lib/integrations/email/balance.ts; D156):
 * on only with RESEND_API_KEY and EMAIL_FROM (the quote emails' switch);
 * keyed by the link id so a retried send is one email; a failure is
 * logged with the link id and Resend's status only, never the address,
 * the amount or the link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const env = vi.fn();
vi.mock("@/lib/env", () => ({ getServerEnv: () => env() }));
const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));
const sendEmail = vi.fn();
vi.mock("@/lib/integrations/email/resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/email/resend")>()),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

const { balanceEmailEnabled, sendBalanceEmail } = await import("@/lib/integrations/email/balance");

const LINK_ID = "33333333-4444-4555-8666-000000000001";
const input = {
  linkId: LINK_ID,
  to: "priya@example.test",
  firstName: "Priya",
  jobNumber: "J-000123",
  amount: "$180.00",
  link: "https://admin.bicii.test/pay/SECRETTOKEN",
  days: 7,
};

beforeEach(() => {
  vi.clearAllMocks();
  env.mockReturnValue({ RESEND_API_KEY: "re_test", EMAIL_FROM: "BICII <shop@bicii.test>" });
  sendEmail.mockResolvedValue({ ok: true, id: "em_1" });
});

describe("sendBalanceEmail", () => {
  it("is on only with both variables", () => {
    expect(balanceEmailEnabled()).toBe(true);
    env.mockReturnValue({ RESEND_API_KEY: "re_test" });
    expect(balanceEmailEnabled()).toBe(false);
  });

  it("sends the bill email keyed by the link id", async () => {
    await expect(sendBalanceEmail(input)).resolves.toEqual({ ok: true, id: "em_1" });
    expect(sendEmail).toHaveBeenCalledWith(
      { apiKey: "re_test", from: "BICII <shop@bicii.test>" },
      expect.objectContaining({
        to: "priya@example.test",
        subject: "Your bill from BICII (job J-000123)",
        idempotencyKey: `balance-${LINK_ID}`,
      }),
    );
    expect(sendEmail.mock.calls[0][1].text).toContain(input.link);
  });

  it("off: nothing is sent", async () => {
    env.mockReturnValue({});
    await expect(sendBalanceEmail(input)).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failure is logged by link id and status only", async () => {
    sendEmail.mockResolvedValue({ ok: false, reason: "rejected", status: 422 });
    await expect(sendBalanceEmail(input)).resolves.toMatchObject({ ok: false });
    expect(warn).toHaveBeenCalledWith(
      { linkId: LINK_ID, reason: "rejected", status: 422 },
      "payment link email not sent",
    );
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["SECRETTOKEN", "priya@example.test", "$180.00"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
