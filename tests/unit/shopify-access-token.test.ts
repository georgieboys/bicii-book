// @vitest-environment node
/**
 * The client credentials grant for a Dev Dashboard app (ADR-020
 * amendment): the request Shopify documents, the 24-hour token cached and
 * renewed 10 minutes early, one shared request for concurrent callers, the
 * error mapping (D87), and the adapter fetching a new token once after a
 * 401.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { clientCredentialsAccessToken } = await import("@/lib/integrations/shopify/access-token");
const { createGraphqlShopifyAdmin } = await import("@/lib/integrations/shopify/graphql-admin");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function tokenSource(...responses: (Response | Error)[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  let clock = 1_000_000;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init! });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  });
  const source = clientCredentialsAccessToken({
    shopDomain: "bicii-test.myshopify.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock,
    timeoutMs: 50,
  });
  return { source, sent, advance: (ms: number) => (clock += ms) };
}

describe("Shopify access token from the client ID and secret", () => {
  it("posts the client credentials grant and caches the token until 10 minutes before expiry", async () => {
    const { source, sent, advance } = tokenSource(
      json({ access_token: "tok-1", scope: "write_products", expires_in: 86399 }),
      json({ access_token: "tok-2", scope: "write_products", expires_in: 86399 }),
    );
    expect(await source.get()).toBe("tok-1");
    expect(sent[0].url).toBe("https://bicii-test.myshopify.com/admin/oauth/access_token");
    expect(sent[0].init.method).toBe("POST");
    expect((sent[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(String(sent[0].init.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
    });

    advance((86399 - 601) * 1000);
    expect(await source.get()).toBe("tok-1");
    expect(sent).toHaveLength(1);
    advance(2000);
    expect(await source.get()).toBe("tok-2");
    expect(sent).toHaveLength(2);
  });

  it("shares one request between concurrent callers and fetches again after invalidate", async () => {
    const { source, sent } = tokenSource(
      json({ access_token: "tok-1", expires_in: 86399 }),
      json({ access_token: "tok-2", expires_in: 86399 }),
    );
    expect(await Promise.all([source.get(), source.get()])).toEqual(["tok-1", "tok-1"]);
    expect(sent).toHaveLength(1);
    source.invalidate();
    expect(await source.get()).toBe("tok-2");
  });

  it("maps refusals to auth failures and outages to retriable errors", async () => {
    const cases: [Response | Error, string, boolean][] = [
      [json({ error: "invalid_client" }, 400), "shopify_auth_failed", false],
      [json({ error: "shop_not_permitted" }, 401), "shopify_auth_failed", false],
      [new Response("", { status: 429 }), "shopify_throttled", true],
      [new Response("", { status: 503 }), "shopify_unavailable", true],
      [new TypeError("fetch failed"), "shopify_unavailable", true],
      [json({ scope: "x" }), "shopify_bad_response", true],
    ];
    for (const [response, code, retriable] of cases) {
      const { source } = tokenSource(response);
      await expect(source.get()).rejects.toMatchObject({ code, retriable });
    }
  });

  it("the adapter fetches a new token once when Shopify refuses the cached one", async () => {
    const calls: { url: string; token: string | null }[] = [];
    const responses = [
      json({ access_token: "old", expires_in: 86399 }),
      new Response("", { status: 401 }),
      json({ access_token: "new", expires_in: 86399 }),
      json({ data: { locations: { nodes: [] } } }),
    ];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), token: headers["X-Shopify-Access-Token"] ?? null });
      return responses.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const admin = createGraphqlShopifyAdmin({
      shopDomain: "bicii-test.myshopify.com",
      accessToken: clientCredentialsAccessToken({
        shopDomain: "bicii-test.myshopify.com",
        clientId: "id",
        clientSecret: "secret",
        fetch,
      }),
      fetch,
      timeoutMs: 50,
    });
    await admin.primaryLocationId().catch(() => undefined);
    expect(calls.map((c) => [c.url.split("/admin/")[1], c.token])).toEqual([
      ["oauth/access_token", null],
      [expect.stringMatching(/graphql\.json$/), "old"],
      ["oauth/access_token", null],
      [expect.stringMatching(/graphql\.json$/), "new"],
    ]);
  });
});
