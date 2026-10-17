// @vitest-environment node
/**
 * The customer link pages' limits, as counted (src/lib/admin/link-throttle.ts):
 * the quote page's and the payment link page's buckets go to
 * public.note_sign_in_attempt with their own keys and window; past a
 * bucket's limit the attempt is refused; without the service key, on an
 * RPC error or a thrown request it fails open and logs the cause, never
 * the token or the address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
const env = { SIGN_IN_LIMIT_MULTIPLIER: 1, SUPABASE_SERVICE_ROLE_KEY: "service-key" as string };
vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));
const rpc = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }));
const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

const { noteBalanceAttempt } = await import("@/lib/admin/balance-throttle");
const { noteQuoteAttempt } = await import("@/lib/admin/quote-throttle");
import { BALANCE_LIMITS, balanceBuckets } from "@/lib/balance-limits";
import { QUOTE_LIMITS, quoteBuckets } from "@/lib/quote-limits";

const TOKEN = "BaLaNcEtOkEn0123456789abcdefghijklmnop-_xyz";

/** note_sign_in_attempt's answer: each bucket at `hits`. */
const answer = (hits: number) => async (_fn: string, args: { buckets: string[] }) => ({
  data: args.buckets.map((bucket_key) => ({ bucket_key, hit_count: hits })),
  error: null,
});

beforeEach(() => {
  rpc.mockReset();
  warn.mockReset();
  env.SIGN_IN_LIMIT_MULTIPLIER = 1;
  env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

function neverLogsTheTokenOrAddress() {
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain(TOKEN);
  expect(logged).not.toContain("203.0.113.9");
}

describe("noteBalanceAttempt", () => {
  it("counts the page's balance- buckets for this client and token over 5 minutes", async () => {
    rpc.mockImplementation(answer(1));
    await expect(noteBalanceAttempt("pay", TOKEN)).resolves.toBe("ok");
    expect(rpc).toHaveBeenCalledWith("note_sign_in_attempt", {
      buckets: balanceBuckets("pay", "203.0.113.9", TOKEN).map((b) => b.key),
      window_seconds: 300,
    });
  });

  it("refuses past a bucket's limit, scaled by the multiplier", async () => {
    rpc.mockImplementation(answer(BALANCE_LIMITS.view.client));
    await expect(noteBalanceAttempt("view", TOKEN)).resolves.toBe("ok");
    rpc.mockImplementation(answer(BALANCE_LIMITS.view.client + 1));
    await expect(noteBalanceAttempt("view", TOKEN)).resolves.toBe("limited");
    env.SIGN_IN_LIMIT_MULTIPLIER = 1000;
    await expect(noteBalanceAttempt("view", TOKEN)).resolves.toBe("ok");
  });

  it("fails open without the service key, on an RPC error and on a thrown request", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "";
    await expect(noteBalanceAttempt("pay", TOKEN)).resolves.toBe("ok");
    expect(rpc).not.toHaveBeenCalled();
    env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST301" } });
    await expect(noteBalanceAttempt("pay", TOKEN)).resolves.toBe("ok");
    rpc.mockRejectedValueOnce(new TypeError("fetch failed: service-key"));
    await expect(noteBalanceAttempt("pay", TOKEN)).resolves.toBe("ok");
    expect(warn.mock.calls).toEqual([
      [{ attempt: "pay", reason: "no_service_role_key" }, "balance limit not counted"],
      [{ attempt: "pay", reason: "rpc_error", code: "PGRST301" }, "balance limit not counted"],
      [
        { attempt: "pay", reason: "request_failed", error: "TypeError" },
        "balance limit not counted",
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("service-key");
    neverLogsTheTokenOrAddress();
  });
});

describe("noteQuoteAttempt (unchanged on the shared counter)", () => {
  it("counts the quote page's own buckets and logs as before", async () => {
    rpc.mockImplementation(answer(QUOTE_LIMITS.answer.token + 1));
    await expect(noteQuoteAttempt("answer", TOKEN)).resolves.toBe("limited");
    expect(rpc).toHaveBeenCalledWith("note_sign_in_attempt", {
      buckets: quoteBuckets("answer", "203.0.113.9", TOKEN).map((b) => b.key),
      window_seconds: 300,
    });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    await expect(noteQuoteAttempt("view", TOKEN)).resolves.toBe("ok");
    expect(warn).toHaveBeenCalledWith(
      { attempt: "view", reason: "rpc_error", code: "XX000" },
      "quote limit not counted",
    );
    neverLogsTheTokenOrAddress();
  });
});
