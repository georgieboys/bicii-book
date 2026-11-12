import "server-only";

import { getServerEnv } from "@/lib/env";

import { clientCredentialsAccessToken } from "./access-token";
import type { ShopifyAdmin } from "./admin";
import { SHOPIFY_API_VERSION } from "./config";
import { createFakeShopifyAdmin, type FakeShopifyAdmin } from "./fake-admin";
import { createGraphqlShopifyAdmin } from "./graphql-admin";

/**
 * Which Shopify the app talks to (env.ts; RUNBOOK "Shopify"):
 *   SHOPIFY_ADAPTER=fake               -> the in-memory fake, one per server
 *                                         process (local development, E2E;
 *                                         env.ts refuses it in production)
 *   SHOPIFY_SHOP_DOMAIN + ADMIN_TOKEN, -> the live GraphQL adapter, except
 *   or + CLIENT_ID and CLIENT_SECRET     (the token exchanged, access-token.ts)
 *                                         in a Vercel Preview without
 *                                         SHOPIFY_ALLOW_PREVIEW=true (a
 *                                         separate development store): a
 *                                         preview on the staging database must
 *                                         never write to the live store
 *   otherwise                          -> null: Shopify is off, syncs fail
 *                                         retriably with shopify_not_configured
 */

/** False in a Vercel Preview unless its Shopify variables are a development store's. */
export function liveShopifyAllowed(env: {
  VERCEL_ENV?: string;
  SHOPIFY_ALLOW_PREVIEW?: "true";
}): boolean {
  return env.VERCEL_ENV !== "preview" || env.SHOPIFY_ALLOW_PREVIEW === "true";
}

const FAKE_KEY = Symbol.for("bicii.shopify.fake-admin");
type GlobalWithFake = typeof globalThis & { [FAKE_KEY]?: FakeShopifyAdmin };

/** The process-wide fake (survives module reloads in development). */
export function processFakeShopifyAdmin(): FakeShopifyAdmin {
  const g = globalThis as GlobalWithFake;
  g[FAKE_KEY] ??= createFakeShopifyAdmin();
  return g[FAKE_KEY];
}

let live: { key: string; admin: ShopifyAdmin } | undefined;

export function getShopifyAdmin(): ShopifyAdmin | null {
  const env = getServerEnv();
  if (env.SHOPIFY_ADAPTER === "fake") return processFakeShopifyAdmin();
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  if (!shopDomain || !liveShopifyAllowed(env)) return null;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!token && !(clientId && clientSecret)) return null;
  const key = token
    ? `${shopDomain}|token|${token}`
    : `${shopDomain}|client|${clientId}|${clientSecret}`;
  if (live?.key !== key) {
    live = {
      key,
      admin: createGraphqlShopifyAdmin({
        shopDomain,
        accessToken: token
          ? token
          : clientCredentialsAccessToken({
              shopDomain,
              clientId: clientId!,
              clientSecret: clientSecret!,
            }),
      }),
    };
  }
  return live.admin;
}

export type ShopifyConnection = {
  mode: "live" | "fake" | "off";
  shopDomain: string | null;
  /** The malformed SHOPIFY_SHOP_DOMAIN that switched Shopify off (R-097), else null. */
  shopDomainInvalid: string | null;
  apiVersion: string;
};

/** What the settings screen shows (never the token or the secret). */
export function shopifyConnection(): ShopifyConnection {
  const env = getServerEnv();
  const admin = getShopifyAdmin();
  return {
    mode: admin ? admin.mode : "off",
    shopDomain: env.SHOPIFY_SHOP_DOMAIN ?? null,
    shopDomainInvalid: env.SHOPIFY_SHOP_DOMAIN_INVALID,
    apiVersion: SHOPIFY_API_VERSION,
  };
}
