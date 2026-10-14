import "server-only";

import type { Logger } from "pino";

import { getServerEnv } from "@/lib/env";
import { child } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/service";

import type { ServiceSupabase } from "../shopify/deps";
import { getStripeGateway, stripeConfig, type StripeConfig } from "./client";
import type { StripeGateway } from "./gateway";

/**
 * What the Stripe flows need, passed in (never imported), so the unit
 * tests stub the RPCs, the gateway and the clock: the service-role client
 * (the only way they reach the database: the service-role RPCs of
 * DATA-MODEL §16; null without SUPABASE_SERVICE_ROLE_KEY), the gateway
 * (null while Stripe is off), the configuration, a logger bound to the
 * correlation id and the clock.
 */
export type StripeDeps = {
  supabase: ServiceSupabase | null;
  gateway: StripeGateway | null;
  config: StripeConfig;
  log: Logger;
  now: () => number;
};

export function defaultStripeDeps(correlationId: string): StripeDeps {
  const env = getServerEnv();
  return {
    supabase: env.SUPABASE_SERVICE_ROLE_KEY ? createServiceClient({ correlationId }) : null,
    gateway: getStripeGateway(),
    config: stripeConfig(env),
    log: child(correlationId, { integration: "stripe" }),
    now: Date.now,
  };
}
