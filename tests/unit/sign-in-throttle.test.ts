// @vitest-environment node
/**
 * The Admin's sign-in counting (src/lib/admin/sign-in-throttle.ts,
 * checkSignInAttempt) with a fake service client: the client's bucket is
 * counted alone first and the email's only while the client is under its
 * limit, so a client past its limit never adds to an email's counter;
 * either call's error is "unavailable".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));

const { checkSignInAttempt } = await import("@/lib/admin/sign-in-throttle");
import { SIGN_IN_LIMITS, SIGN_IN_WINDOW_SECONDS, signInBuckets } from "@/lib/auth/sign-in-limits";
import type { Database } from "@/lib/database.types";

const rpc = vi.fn();
const service = { rpc } as unknown as SupabaseClient<Database>;
const CLIENT = "203.0.113.9";
const EMAIL = "someone@example.com";
const [clientKey, emailKey] = signInBuckets("request", CLIENT, EMAIL).map((b) => b.key);

/** note_sign_in_attempt's answer: each bucket at the count `hitsFor` gives it. */
const answer =
  (hitsFor: (key: string) => number) => async (_fn: string, args: { buckets: string[] }) => ({
    data: args.buckets.map((bucket_key) => ({ bucket_key, hit_count: hitsFor(bucket_key) })),
    error: null,
  });

beforeEach(() => {
  rpc.mockReset();
});

describe("checkSignInAttempt", () => {
  it("counts the client's bucket, then the email's, and says ok under both limits", async () => {
    rpc.mockImplementation(answer(() => 1));
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL)).resolves.toEqual({
      throttle: "ok",
    });
    expect(rpc.mock.calls).toEqual([
      ["note_sign_in_attempt", { buckets: [clientKey], window_seconds: SIGN_IN_WINDOW_SECONDS }],
      ["note_sign_in_attempt", { buckets: [emailKey], window_seconds: SIGN_IN_WINDOW_SECONDS }],
    ]);
  });

  it("skips the email's bucket once the client is over its limit", async () => {
    rpc.mockImplementation(answer(() => SIGN_IN_LIMITS.request.client + 1));
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL)).resolves.toEqual({
      throttle: "limited",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toEqual({
      buckets: [clientKey],
      window_seconds: SIGN_IN_WINDOW_SECONDS,
    });
  });

  it("is limited when the email is over its limit and the client is not", async () => {
    rpc.mockImplementation(
      answer((key) => (key === emailKey ? SIGN_IN_LIMITS.request.email + 1 : 1)),
    );
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL)).resolves.toEqual({
      throttle: "limited",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("is unavailable when the client's count fails, without counting the email", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL)).resolves.toEqual({
      throttle: "unavailable",
      cause: { reason: "rpc_error", code: "42501", message: "denied" },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when the email's count fails", async () => {
    rpc
      .mockImplementationOnce(answer(() => 1))
      .mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL)).resolves.toEqual({
      throttle: "unavailable",
      cause: { reason: "rpc_error", code: "XX000", message: "boom" },
    });
  });

  it("raises the limits by the multiplier", async () => {
    rpc.mockImplementation(
      answer((key) => (key === clientKey ? SIGN_IN_LIMITS.request.client + 1 : 1)),
    );
    await expect(checkSignInAttempt(service, "request", CLIENT, EMAIL, 2)).resolves.toEqual({
      throttle: "ok",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
