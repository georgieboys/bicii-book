import "server-only";

import { adminOrigin } from "@/lib/admin-origin";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { StripeOffReason } from "@/lib/payments";

import { STRIPE_API_VERSION } from "./config";
import { createFakeStripeGateway, type FakeStripeGateway } from "./fake-gateway";
import type { StripeGateway } from "./gateway";
import { createHttpStripeGateway } from "./http-gateway";

/**
 * Whether Stripe is on, and which Stripe the app talks to (D157; RUNBOOK
 * "Stripe payments"). Stripe is on only when every variable it needs is
 * present, well-formed and right for this deployment; otherwise it is off
 * with a reason Settings can word (src/lib/payments.ts). A wrong value
 * never stops the app: env.ts only refuses the fake with a key or in
 * production.
 *
 * Rules, first match wins:
 *   1. VERCEL_ENV=preview                     -> off preview (no staging database, D157b)
 *   2. STRIPE_ADAPTER=fake                    -> the fake, livemode false; go to 6
 *   3. no STRIPE_SECRET_KEY                   -> off not_configured
 *   4. sk_/rk_ live or test key               -> live or test; else off key_invalid
 *   5. a test key in production               -> off test_key_in_production;
 *      a live key outside production          -> off live_key_outside_production
 *   6. STRIPE_WEBHOOK_SECRET missing          -> off webhook_secret_missing;
 *      not whsec_…                            -> off webhook_secret_invalid
 *   7. no SUPABASE_SERVICE_ROLE_KEY           -> off service_role_missing
 *   8. ADMIN_ORIGIN not an https origin (http only for localhost or
 *      127.0.0.1) with no path, search or hash, or in production a
 *      loopback host (localhost, 127.0.0.1, ::1: Checkout would send
 *      paying customers to their own machine) -> off origin_invalid
 *   9. on
 */

export type StripeConfig =
  | { state: "off"; reason: StripeOffReason }
  | {
      state: "on";
      mode: "live" | "test" | "fake";
      livemode: boolean;
      /** The Admin's origin (ADMIN_ORIGIN), where Stripe returns customers. */
      origin: string;
      webhookSecret: string;
      /** Null for the fake. */
      secretKey: string | null;
    };

type ConfigEnv = Pick<
  ServerEnv,
  | "VERCEL_ENV"
  | "STRIPE_ADAPTER"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "ADMIN_ORIGIN"
>;

const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9]+$/;
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{8,}$/;

/** Pure: the rules above over the parsed server environment. */
export function stripeConfig(env: ConfigEnv): StripeConfig {
  const off = (reason: StripeOffReason): StripeConfig => ({ state: "off", reason });
  if (env.VERCEL_ENV === "preview") return off("preview");

  let mode: "live" | "test" | "fake";
  let secretKey: string | null = null;
  if (env.STRIPE_ADAPTER === "fake") {
    mode = "fake";
  } else {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) return off("not_configured");
    if (LIVE_KEY.test(key)) mode = "live";
    else if (TEST_KEY.test(key)) mode = "test";
    else return off("key_invalid");
    const production = env.VERCEL_ENV === "production";
    if (production && mode === "test") return off("test_key_in_production");
    if (!production && mode === "live") return off("live_key_outside_production");
    secretKey = key;
  }

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return off("webhook_secret_missing");
  if (!WEBHOOK_SECRET.test(webhookSecret)) return off("webhook_secret_invalid");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return off("service_role_missing");
  const origin = adminOrigin(env.ADMIN_ORIGIN, env.VERCEL_ENV === "production");
  if (!origin) return off("origin_invalid");

  return { state: "on", mode, livemode: mode === "live", origin, webhookSecret, secretKey };
}

const FAKE_KEY = Symbol.for("bicii.stripe.fake-gateway");
type GlobalWithFake = typeof globalThis & { [FAKE_KEY]?: FakeStripeGateway };

/** The process-wide fake (survives module reloads in development). */
export function processFakeStripeGateway(): FakeStripeGateway {
  const g = globalThis as GlobalWithFake;
  g[FAKE_KEY] ??= createFakeStripeGateway();
  return g[FAKE_KEY];
}

let live: { key: string; gateway: StripeGateway } | undefined;
let loggedOff: StripeOffReason | undefined;

/** The gateway when Stripe is on, else null (logged once per process and reason). */
export function getStripeGateway(): StripeGateway | null {
  const config = stripeConfig(getServerEnv());
  if (config.state === "off") {
    if (loggedOff !== config.reason) {
      loggedOff = config.reason;
      logger.warn({ integration: "stripe", reason: config.reason }, "stripe off");
    }
    return null;
  }
  if (config.mode === "fake" || !config.secretKey) return processFakeStripeGateway();
  if (live?.key !== config.secretKey) {
    live = {
      key: config.secretKey,
      gateway: createHttpStripeGateway({
        secretKey: config.secretKey,
        livemode: config.livemode,
      }),
    };
  }
  return live.gateway;
}

export type StripeConnection = {
  state: "on" | "off";
  mode: "live" | "test" | "fake" | null;
  reason: StripeOffReason | null;
  apiVersion: string;
  origin: string | null;
  /** What to paste into Stripe's Dashboard as the endpoint URL. */
  webhookEndpoint: string | null;
};

/**
 * Whether customers can pay online now, for the quote and job pages: never
 * throws. A server environment that does not parse (getServerEnv throws an
 * EnvError) turns payments off for the page, logged by the error's name
 * only, so the customer can still see and answer the quote (D157c).
 */
export function stripeIsOn(): boolean {
  try {
    return stripeConnection().state === "on";
  } catch (error) {
    logger.error(
      { integration: "stripe", error: error instanceof Error ? error.name : "unknown" },
      "stripe state unreadable",
    );
    return false;
  }
}

/** What Settings shows (never a key or a secret). */
export function stripeConnection(): StripeConnection {
  const config = stripeConfig(getServerEnv());
  if (config.state === "off") {
    return {
      state: "off",
      mode: null,
      reason: config.reason,
      apiVersion: STRIPE_API_VERSION,
      origin: null,
      webhookEndpoint: null,
    };
  }
  return {
    state: "on",
    mode: config.mode,
    reason: null,
    apiVersion: STRIPE_API_VERSION,
    origin: config.origin,
    webhookEndpoint: `${config.origin}/api/stripe/webhooks`,
  };
}
