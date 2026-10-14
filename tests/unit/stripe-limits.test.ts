// @vitest-environment node
/**
 * noteStripeCheck (Phase 14; src/lib/integrations/stripe/limits.ts): staff
 * "Check with Stripe" is counted per payment in note_sign_in_attempt's
 * counters under a hashed bucket, refused above STRIPE_CHECK_LIMIT in a
 * 5-minute window, and fails open (no service-role key, an RPC error, a
 * throw), since a read only asks Stripe for its own record. The env, the
 * service client and the logger are mocked; the bucket and the limit are
 * the real ones from config.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({
  value: { SIGN_IN_LIMIT_MULTIPLIER: 1, SUPABASE_SERVICE_ROLE_KEY: "service-role-test" } as Record<
    string,
    unknown
  >,
}));
const rpc = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn } }));

const { noteStripeCheck } = await import("@/lib/integrations/stripe/limits");
const { STRIPE_CHECK_LIMIT, stripeCheckBucket } = await import("@/lib/integrations/stripe/config");

const PAYMENT = "11111111-2222-4333-8444-555555555555";
const BUCKET = stripeCheckBucket(PAYMENT);

/** note_sign_in_attempt's answer: this payment's count, plus another bucket. */
const counted = (hits: number) => ({
  data: [
    { bucket_key: "stripe-check:payment:other", hit_count: 999 },
    { bucket_key: BUCKET, hit_count: hits },
  ],
  error: null,
});

beforeEach(() => {
  env.value = { SIGN_IN_LIMIT_MULTIPLIER: 1, SUPABASE_SERVICE_ROLE_KEY: "service-role-test" };
  rpc.mockReset();
  warn.mockReset();
});

describe("noteStripeCheck", () => {
  it("counts the hashed bucket in a 5-minute window, never the payment id in clear", async () => {
    rpc.mockResolvedValue(counted(1));
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("note_sign_in_attempt", {
      buckets: [BUCKET],
      window_seconds: 300,
    });
    expect(BUCKET).toMatch(/^stripe-check:payment:[0-9a-f]{64}$/);
    expect(BUCKET).not.toContain(PAYMENT);
  });

  it("is ok up to the limit, this check included, and limited above it", async () => {
    expect(STRIPE_CHECK_LIMIT).toBe(6);
    rpc.mockResolvedValue(counted(STRIPE_CHECK_LIMIT));
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
    rpc.mockResolvedValue(counted(STRIPE_CHECK_LIMIT + 1));
    expect(await noteStripeCheck(PAYMENT)).toBe("limited");
    // Another bucket's count is not this payment's.
    rpc.mockResolvedValue({ data: [{ bucket_key: "x", hit_count: 999 }], error: null });
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
  });

  it("the multiplier raises the limit (tests only)", async () => {
    env.value = { ...env.value, SIGN_IN_LIMIT_MULTIPLIER: 1000 };
    rpc.mockResolvedValue(counted(STRIPE_CHECK_LIMIT + 1));
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
  });

  it("fails open without the service-role key, and does not call the RPC", async () => {
    env.value = { ...env.value, SUPABASE_SERVICE_ROLE_KEY: undefined };
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
    expect(rpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_service_role_key" }),
      "stripe check not counted",
    );
  });

  it("fails open on an RPC error or no data, logging the code only", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "secret detail" } });
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
    expect(warn).toHaveBeenLastCalledWith(
      { paymentId: PAYMENT, reason: "rpc_error", code: "57014" },
      "stripe check not counted",
    );
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
  });

  it("fails open when the call throws, logging the error's class only", async () => {
    rpc.mockRejectedValue(new TypeError("fetch failed: https://example.invalid/?key=secret"));
    expect(await noteStripeCheck(PAYMENT)).toBe("ok");
    expect(warn).toHaveBeenLastCalledWith(
      { paymentId: PAYMENT, reason: "request_failed", error: "TypeError" },
      "stripe check not counted",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });
});
