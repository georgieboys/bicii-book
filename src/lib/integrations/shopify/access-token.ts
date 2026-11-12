import "server-only";

import { SHOPIFY_MESSAGES, ShopifyError } from "./admin";
import { SHOPIFY_TIMEOUT_MS } from "./config";

/**
 * Admin API access tokens for an app made in Shopify's Dev Dashboard
 * (ADR-020 amendment, R-047). Shopify no longer lets a store create the
 * old admin-made custom app that shows a permanent `shpat_` token; a Dev
 * Dashboard app has a client ID and secret instead, and a server owned by
 * the store's own organization swaps them for a token with the client
 * credentials grant:
 *
 *   POST https://<shop>.myshopify.com/admin/oauth/access_token
 *   application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=…&client_secret=…
 *   -> { access_token, scope, expires_in: 86399 }
 *
 * The token lasts 24 hours. It is cached in the server process and
 * fetched again 10 minutes before it expires, or at once after Shopify
 * refuses it (`invalidate`). Concurrent callers share one request.
 *
 * Errors (D87): 400/401/403 -> shopify_auth_failed (the ID or secret is
 * wrong, the app is not installed or not in the store's organization: a
 * person must act); 429 -> throttled; 5xx, network errors and timeouts ->
 * unavailable (retriable); any other answer -> shopify_bad_response.
 */

export type AccessTokenSource = {
  /** A token valid now. */
  get(): Promise<string>;
  /** Forget the cached token after Shopify refused it. */
  invalidate(): void;
};

/** A fixed token (a legacy admin-made custom app's `shpat_` token). */
export function staticAccessToken(token: string): AccessTokenSource {
  return { get: async () => token, invalidate: () => {} };
}

export type ClientCredentialsOptions = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
};

/** Fetch again this long before Shopify's expiry. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export function clientCredentialsAccessToken({
  shopDomain,
  clientId,
  clientSecret,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = SHOPIFY_TIMEOUT_MS,
}: ClientCredentialsOptions): AccessTokenSource {
  const endpoint = `https://${shopDomain}/admin/oauth/access_token`;
  let cached: { token: string; refreshAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function request(): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      throw new ShopifyError(
        "shopify_unavailable",
        true,
        SHOPIFY_MESSAGES.unavailable,
        e instanceof Error ? `token: ${e.name}: ${e.message}` : "token: network error",
      );
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ShopifyError(
        "shopify_auth_failed",
        false,
        SHOPIFY_MESSAGES.authFailed,
        `token: HTTP ${res.status}`,
      );
    }
    if (res.status === 429) {
      throw new ShopifyError(
        "shopify_throttled",
        true,
        SHOPIFY_MESSAGES.throttled,
        "token: HTTP 429",
      );
    }
    if (res.status >= 500) {
      throw new ShopifyError(
        "shopify_unavailable",
        true,
        SHOPIFY_MESSAGES.unavailable,
        `token: HTTP ${res.status}`,
      );
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Falls through to the bad-response error below.
    }
    const token =
      res.ok && body && typeof body === "object" && "access_token" in body
        ? (body as { access_token: unknown }).access_token
        : null;
    if (typeof token !== "string" || token === "") {
      throw new ShopifyError(
        "shopify_bad_response",
        true,
        SHOPIFY_MESSAGES.badResponse,
        `token: HTTP ${res.status}, no access_token`,
      );
    }
    const expiresIn = (body as { expires_in?: unknown }).expires_in;
    const lifetimeMs =
      typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000;
    cached = { token, refreshAt: now() + Math.max(lifetimeMs - REFRESH_MARGIN_MS, 0) };
    return token;
  }

  return {
    async get() {
      if (cached && now() < cached.refreshAt) return cached.token;
      pending ??= request().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}
