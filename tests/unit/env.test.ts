import { describe, expect, it } from "vitest";
import { EnvError, customerSignInUrl, parsePublicEnv, parseServerEnv } from "@/lib/env";

const validPublic = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  NEXT_PUBLIC_PUBLIC_SITE_URL: "https://bicii.vercel.app/",
};

describe("env", () => {
  it("parses a valid public env and trims the site URL's trailing slash", () => {
    expect(parsePublicEnv(validPublic).NEXT_PUBLIC_PUBLIC_SITE_URL).toBe(
      "https://bicii.vercel.app",
    );
  });

  it("points customers at the public site's own sign-in (R-039)", () => {
    expect(customerSignInUrl(parsePublicEnv(validPublic))).toBe("https://bicii.vercel.app/sign-in");
  });

  it("names every missing or invalid variable and points at .env.example", () => {
    let error: unknown;
    try {
      parsePublicEnv({
        ...validPublic,
        NEXT_PUBLIC_SUPABASE_URL: "not a url",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as Error).message;
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(message).toContain(".env.example");
  });

  it("applies server defaults and validates the database URL", () => {
    expect(parseServerEnv({}).LOG_LEVEL).toBe("info");
    expect(parseServerEnv({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" }).DATABASE_URL).toBe(
      "postgres://u:p@127.0.0.1:5432/db",
    );
    expect(() => parseServerEnv({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
    expect(() => parseServerEnv({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  it("the sign-in limit multiplier defaults to 1 and takes whole numbers from 1 (PLAN D72)", () => {
    expect(parseServerEnv({}).SIGN_IN_LIMIT_MULTIPLIER).toBe(1);
    expect(parseServerEnv({ SIGN_IN_LIMIT_MULTIPLIER: "" }).SIGN_IN_LIMIT_MULTIPLIER).toBe(1);
    expect(parseServerEnv({ SIGN_IN_LIMIT_MULTIPLIER: "1000" }).SIGN_IN_LIMIT_MULTIPLIER).toBe(
      1000,
    );
    for (const bad of ["0", "-1", "1.5", "lots", "100001"]) {
      expect(() => parseServerEnv({ SIGN_IN_LIMIT_MULTIPLIER: bad })).toThrow(
        /SIGN_IN_LIMIT_MULTIPLIER/,
      );
    }
  });

  it("ignores the multiplier in production, so a stray value cannot switch the limits off", () => {
    const env = { SIGN_IN_LIMIT_MULTIPLIER: "100000" };
    expect(parseServerEnv({ ...env, VERCEL_ENV: "production" }).SIGN_IN_LIMIT_MULTIPLIER).toBe(1);
    expect(parseServerEnv({ ...env, VERCEL_ENV: "preview" }).SIGN_IN_LIMIT_MULTIPLIER).toBe(100000);
  });
});

describe("Shopify and cron variables (Phase 10)", () => {
  const TOKEN = "shpat_placeholder";

  it("accepts nothing at all (Shopify off) and a lower-case myshopify.com domain", () => {
    expect(parseServerEnv({}).SHOPIFY_ADAPTER).toBeUndefined();
    expect(
      parseServerEnv({ SHOPIFY_SHOP_DOMAIN: "bicii-test.myshopify.com" }).SHOPIFY_SHOP_DOMAIN,
    ).toBe("bicii-test.myshopify.com");
  });

  it("refuses a shop domain that is not <name>.myshopify.com", () => {
    for (const domain of [
      "https://bicii.myshopify.com",
      "Bicii.myshopify.com",
      "bicii.com",
      "-bicii.myshopify.com",
      "bicii.myshopify.com/admin",
    ]) {
      expect(() => parseServerEnv({ SHOPIFY_SHOP_DOMAIN: domain })).toThrow(/SHOPIFY_SHOP_DOMAIN/);
    }
  });

  it("accepts fake for local development and E2E", () => {
    const env = parseServerEnv({
      SHOPIFY_ADAPTER: "fake",
      SHOPIFY_SHOP_DOMAIN: "bicii-test.myshopify.com",
      SHOPIFY_WEBHOOK_SECRET: "s",
      CRON_SECRET: "c",
    });
    expect(env.SHOPIFY_ADAPTER).toBe("fake");
    expect(env.CRON_SECRET).toBe("c");
  });

  it("refuses fake together with an Admin token", () => {
    expect(() => parseServerEnv({ SHOPIFY_ADAPTER: "fake", SHOPIFY_ADMIN_TOKEN: TOKEN })).toThrow(
      /SHOPIFY_ADAPTER: fake cannot be combined with SHOPIFY_ADMIN_TOKEN/,
    );
  });

  it("refuses fake in Vercel production, not in preview", () => {
    expect(() => parseServerEnv({ SHOPIFY_ADAPTER: "fake", VERCEL_ENV: "production" })).toThrow(
      /must never run in production/,
    );
    expect(parseServerEnv({ SHOPIFY_ADAPTER: "fake", VERCEL_ENV: "preview" }).SHOPIFY_ADAPTER).toBe(
      "fake",
    );
  });

  it("requires the domain and token for live", () => {
    let message = "";
    try {
      parseServerEnv({ SHOPIFY_ADAPTER: "live" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SHOPIFY_SHOP_DOMAIN: is required when SHOPIFY_ADAPTER=live");
    expect(message).toContain("SHOPIFY_ADMIN_TOKEN: is required when SHOPIFY_ADAPTER=live");
    expect(
      parseServerEnv({
        SHOPIFY_ADAPTER: "live",
        SHOPIFY_SHOP_DOMAIN: "bicii.myshopify.com",
        SHOPIFY_ADMIN_TOKEN: TOKEN,
      }).SHOPIFY_ADAPTER,
    ).toBe("live");
  });

  it("refuses an unknown adapter and treats blank values as unset", () => {
    expect(() => parseServerEnv({ SHOPIFY_ADAPTER: "mock" })).toThrow(/SHOPIFY_ADAPTER/);
    expect(parseServerEnv({ SHOPIFY_ADAPTER: "", CRON_SECRET: "" })).toMatchObject({
      SHOPIFY_ADAPTER: undefined,
      CRON_SECRET: undefined,
    });
  });
});

describe("quote email variables (Phase 13 step 3, D144)", () => {
  it("are optional, and blank is unset", () => {
    for (const source of [{}, { RESEND_API_KEY: "", EMAIL_FROM: "" }]) {
      const env = parseServerEnv(source);
      expect(env.RESEND_API_KEY).toBeUndefined();
      expect(env.EMAIL_FROM).toBeUndefined();
    }
  });

  it("take an address, or a name and an address, as the sender", () => {
    for (const from of ["workshop@example.com", "BICII <workshop@example.com>"]) {
      expect(parseServerEnv({ EMAIL_FROM: from }).EMAIL_FROM).toBe(from);
    }
    for (const from of ["workshop", "BICII <workshop>", "a@b", "<a@b.c", "x y@b.c"]) {
      expect(() => parseServerEnv({ EMAIL_FROM: from }), from).toThrow(/EMAIL_FROM/);
    }
  });
});

describe("Stripe variables (Phase 14)", () => {
  const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_ADAPTER", "ADMIN_ORIGIN"];

  it("are all optional, and blank is unset", () => {
    for (const source of [{}, Object.fromEntries(KEYS.map((k) => [k, ""]))]) {
      const env = parseServerEnv(source);
      for (const key of KEYS) expect(env[key as keyof typeof env]).toBeUndefined();
    }
  });

  it("accept the fake for local development, CI and E2E", () => {
    expect(
      parseServerEnv({ STRIPE_ADAPTER: "fake", STRIPE_WEBHOOK_SECRET: "whsec_x" }).STRIPE_ADAPTER,
    ).toBe("fake");
    expect(() => parseServerEnv({ STRIPE_ADAPTER: "live" })).toThrow(/STRIPE_ADAPTER/);
  });

  it("refuse the fake together with a key", () => {
    expect(() =>
      parseServerEnv({ STRIPE_ADAPTER: "fake", STRIPE_SECRET_KEY: "sk_test_abc" }),
    ).toThrow(/STRIPE_ADAPTER: fake cannot be combined with STRIPE_SECRET_KEY/);
  });

  it("refuse the fake in Vercel production, not in preview", () => {
    expect(() => parseServerEnv({ STRIPE_ADAPTER: "fake", VERCEL_ENV: "production" })).toThrow(
      /the fake Stripe must never run in production/,
    );
    expect(parseServerEnv({ STRIPE_ADAPTER: "fake", VERCEL_ENV: "preview" }).STRIPE_ADAPTER).toBe(
      "fake",
    );
  });

  it("parse a malformed key, a live key outside production and a malformed origin (soft: stripeConfig turns Stripe off)", () => {
    const env = parseServerEnv({
      STRIPE_SECRET_KEY: "not-a-key",
      STRIPE_WEBHOOK_SECRET: "nope",
      ADMIN_ORIGIN: "admin.example.com/path",
    });
    expect(env.STRIPE_SECRET_KEY).toBe("not-a-key");
    expect(env.ADMIN_ORIGIN).toBe("admin.example.com/path");
    expect(
      parseServerEnv({ STRIPE_SECRET_KEY: "sk_live_abc", VERCEL_ENV: "preview" }).STRIPE_SECRET_KEY,
    ).toBe("sk_live_abc");
    expect(
      parseServerEnv({ STRIPE_SECRET_KEY: "sk_test_abc", VERCEL_ENV: "production" }),
    ).toBeTruthy();
  });
});
