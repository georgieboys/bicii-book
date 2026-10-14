// @vitest-environment node
/**
 * When Stripe is on, and why it is off (D157b, c; RUNBOOK "Stripe
 * payments"): the full stripeConfig matrix, first match wins. A wrong value
 * turns Stripe off with a reason; it never throws.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { stripeConfig } = await import("@/lib/integrations/stripe/client");
const { stripeCheckBucket, STRIPE_CHECK_LIMIT } = await import("@/lib/integrations/stripe/config");
const { STRIPE_OFF_REASON_CODES } = await import("@/lib/payments");

const TEST_KEY = "rk_test_NotARealKey123";
const LIVE_KEY = "sk_live_NotARealKey456";
const WHSEC = "whsec_NotARealSecret1";

/** Everything Stripe needs, in test mode, locally. */
const ON = {
  STRIPE_SECRET_KEY: TEST_KEY,
  STRIPE_WEBHOOK_SECRET: WHSEC,
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  ADMIN_ORIGIN: "http://localhost:3000",
} as const;

type Env = Parameters<typeof stripeConfig>[0];
const config = (env: Env) => stripeConfig(env);

describe("stripeConfig", () => {
  it("is on in test mode locally with a test key, and live in production with a live key", () => {
    expect(config(ON)).toEqual({
      state: "on",
      mode: "test",
      livemode: false,
      origin: "http://localhost:3000",
      webhookSecret: WHSEC,
      secretKey: TEST_KEY,
    });
    expect(
      config({
        ...ON,
        STRIPE_SECRET_KEY: LIVE_KEY,
        VERCEL_ENV: "production",
        ADMIN_ORIGIN: "https://admin.example.com",
      }),
    ).toEqual({
      state: "on",
      mode: "live",
      livemode: true,
      origin: "https://admin.example.com",
      webhookSecret: WHSEC,
      secretKey: LIVE_KEY,
    });
    // Restricted and secret keys alike; development (vercel dev) is not production.
    expect(
      config({ ...ON, STRIPE_SECRET_KEY: "sk_test_abc", VERCEL_ENV: "development" }),
    ).toMatchObject({ state: "on", mode: "test" });
  });

  it("is the fake with livemode false and no key", () => {
    const { STRIPE_SECRET_KEY: _key, ...rest } = ON;
    void _key;
    expect(config({ ...rest, STRIPE_ADAPTER: "fake" })).toEqual({
      state: "on",
      mode: "fake",
      livemode: false,
      origin: "http://localhost:3000",
      webhookSecret: WHSEC,
      secretKey: null,
    });
  });

  it.each<[string, Env, string]>([
    ["preview, even with everything set", { ...ON, VERCEL_ENV: "preview" }, "preview"],
    ["preview with the fake", { ...ON, STRIPE_ADAPTER: "fake", VERCEL_ENV: "preview" }, "preview"],
    ["nothing set", {}, "not_configured"],
    ["no key", { ...ON, STRIPE_SECRET_KEY: undefined }, "not_configured"],
    ["a publishable key", { ...ON, STRIPE_SECRET_KEY: "pk_test_abc" }, "key_invalid"],
    ["a key with spaces", { ...ON, STRIPE_SECRET_KEY: "sk_test_ab c" }, "key_invalid"],
    ["an unknown mode", { ...ON, STRIPE_SECRET_KEY: "sk_prod_abc" }, "key_invalid"],
    [
      "a test key in production",
      { ...ON, VERCEL_ENV: "production", ADMIN_ORIGIN: "https://admin.example.com" },
      "test_key_in_production",
    ],
    ["a live key locally", { ...ON, STRIPE_SECRET_KEY: LIVE_KEY }, "live_key_outside_production"],
    [
      "a live key in development",
      { ...ON, STRIPE_SECRET_KEY: LIVE_KEY, VERCEL_ENV: "development" },
      "live_key_outside_production",
    ],
    ["no webhook secret", { ...ON, STRIPE_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
    [
      "no webhook secret with the fake",
      {
        ...ON,
        STRIPE_SECRET_KEY: undefined,
        STRIPE_ADAPTER: "fake",
        STRIPE_WEBHOOK_SECRET: undefined,
      },
      "webhook_secret_missing",
    ],
    [
      "a webhook secret without whsec_",
      { ...ON, STRIPE_WEBHOOK_SECRET: "abcdefghijk" },
      "webhook_secret_invalid",
    ],
    [
      "a short webhook secret",
      { ...ON, STRIPE_WEBHOOK_SECRET: "whsec_abc" },
      "webhook_secret_invalid",
    ],
    [
      "no service role key",
      { ...ON, SUPABASE_SERVICE_ROLE_KEY: undefined },
      "service_role_missing",
    ],
    ["no origin", { ...ON, ADMIN_ORIGIN: undefined }, "origin_invalid"],
    [
      "an origin with a path",
      { ...ON, ADMIN_ORIGIN: "https://admin.example.com/app" },
      "origin_invalid",
    ],
    [
      "an origin with a query",
      { ...ON, ADMIN_ORIGIN: "https://admin.example.com/?a=1" },
      "origin_invalid",
    ],
    [
      "an origin with a hash",
      { ...ON, ADMIN_ORIGIN: "https://admin.example.com/#x" },
      "origin_invalid",
    ],
    [
      "http other than localhost",
      { ...ON, ADMIN_ORIGIN: "http://admin.example.com" },
      "origin_invalid",
    ],
    ["not a URL", { ...ON, ADMIN_ORIGIN: "admin.example.com" }, "origin_invalid"],
    ["another scheme", { ...ON, ADMIN_ORIGIN: "ftp://localhost" }, "origin_invalid"],
    [
      "credentials in the origin",
      { ...ON, ADMIN_ORIGIN: "https://u:p@admin.example.com" },
      "origin_invalid",
    ],
  ])("is off for %s", (_name, env, reason) => {
    expect(config(env)).toEqual({ state: "off", reason });
  });

  it("accepts https origins with a trailing slash, and http on 127.0.0.1", () => {
    expect(config({ ...ON, ADMIN_ORIGIN: "https://admin.example.com/" })).toMatchObject({
      origin: "https://admin.example.com",
    });
    expect(config({ ...ON, ADMIN_ORIGIN: "http://127.0.0.1:3100" })).toMatchObject({
      origin: "http://127.0.0.1:3100",
    });
  });

  it("checks in the order the reasons are listed (first match wins)", () => {
    // Each step's fix uncovers the next reason, in STRIPE_OFF_REASON_CODES order.
    const steps: Array<[Env, string]> = [
      [{ VERCEL_ENV: "preview" }, "preview"],
      [{}, "not_configured"],
      [{ STRIPE_SECRET_KEY: "nope" }, "key_invalid"],
      [{ STRIPE_SECRET_KEY: TEST_KEY, VERCEL_ENV: "production" }, "test_key_in_production"],
      [{ STRIPE_SECRET_KEY: LIVE_KEY }, "live_key_outside_production"],
      [{ STRIPE_SECRET_KEY: TEST_KEY }, "webhook_secret_missing"],
      [{ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: "bad" }, "webhook_secret_invalid"],
      [{ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: WHSEC }, "service_role_missing"],
      [
        {
          STRIPE_SECRET_KEY: TEST_KEY,
          STRIPE_WEBHOOK_SECRET: WHSEC,
          SUPABASE_SERVICE_ROLE_KEY: "s",
        },
        "origin_invalid",
      ],
    ];
    expect(steps.map(([env]) => (config(env) as { reason: string }).reason)).toEqual([
      ...STRIPE_OFF_REASON_CODES,
    ]);
  });

  it("never puts a key or secret into an off result", () => {
    const off = config({ ...ON, ADMIN_ORIGIN: "nope" });
    expect(JSON.stringify(off)).not.toContain(TEST_KEY);
    expect(JSON.stringify(off)).not.toContain(WHSEC);
  });
});

describe("stripeCheckBucket", () => {
  it("is a salted digest per payment, never the id in clear", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const bucket = stripeCheckBucket(id);
    expect(bucket).toMatch(/^stripe-check:payment:[0-9a-f]{64}$/);
    expect(bucket).not.toContain(id);
    expect(bucket).not.toContain(id.replace(/-/g, ""));
    expect(stripeCheckBucket(id)).toBe(bucket);
    expect(stripeCheckBucket(`${id.slice(0, -1)}6`)).not.toBe(bucket);
    expect(STRIPE_CHECK_LIMIT).toBe(6);
  });
});
