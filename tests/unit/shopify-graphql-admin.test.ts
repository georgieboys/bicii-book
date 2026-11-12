// @vitest-environment node
/**
 * The live Shopify adapter against a mocked fetch (D83, D84, D87): the
 * pinned version and token, the GraphQL documents BICII sends and how
 * every failure maps to a retriable or a person-must-act error. The real
 * schema is verified on a development store before go-live (RUNBOOK).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ShopifyError } = await import("@/lib/integrations/shopify/admin");
const { SHOPIFY_API_VERSION } = await import("@/lib/integrations/shopify/config");
const { createGraphqlShopifyAdmin } = await import("@/lib/integrations/shopify/graphql-admin");

type Sent = {
  url: string;
  init: RequestInit;
  body: { query: string; variables: Record<string, unknown> };
};

function adminWith(...responses: (Response | Error | (() => Promise<Response>))[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  });
  const admin = createGraphqlShopifyAdmin({
    shopDomain: "bicii-test.myshopify.com",
    accessToken: "shpat_test_token",
    fetch: fetch as unknown as typeof globalThis.fetch,
    timeoutMs: 50,
  });
  return { admin, sent, fetch };
}

const ok = (data: unknown) => Response.json({ data });

const PRODUCT = "gid://shopify/Product/9000000032";
const VARIANT = "gid://shopify/ProductVariant/9100000032";
const ITEM = "gid://shopify/InventoryItem/9200000032";
const LOCATION = "gid://shopify/Location/9300000001";

const productSetOk = () =>
  ok({
    productSet: {
      product: { id: PRODUCT, variants: { nodes: [{ id: VARIANT, inventoryItem: { id: ITEM } }] } },
      userErrors: [],
    },
  });

const INPUT = {
  handle: "bicii-p-000032",
  title: "Stack sync stickers",
  descriptionHtml: "<p>Hi</p>",
  vendor: "BICII",
  status: "ACTIVE" as const,
  sku: "P-000032",
  price: "12.00",
  imageUrls: ["https://x.example/a.jpg"],
};

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as InstanceType<typeof ShopifyError>;
  }
  throw new Error("expected a rejection");
}

describe("createGraphqlShopifyAdmin", () => {
  it("posts to the pinned API version with the access token", async () => {
    const { admin, sent } = adminWith(productSetOk());
    expect(admin.mode).toBe("live");
    expect(admin.apiVersion).toBe(SHOPIFY_API_VERSION);
    await admin.upsertProduct(INPUT, null);
    expect(sent[0].url).toBe(
      `https://bicii-test.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    );
    const headers = sent[0].init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe("shpat_test_token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates with productSet by handle and updates by id, one default variant", async () => {
    const { admin, sent } = adminWith(productSetOk(), productSetOk());
    expect(await admin.upsertProduct(INPUT, null)).toEqual({
      productId: PRODUCT,
      variantId: VARIANT,
      inventoryItemId: ITEM,
    });
    await admin.upsertProduct({ ...INPUT, status: "DRAFT" }, { productId: PRODUCT });
    expect(sent[0].body.query).toContain("productSet(");
    expect(sent[0].body.query).toContain("synchronous: true");
    expect(sent[0].body.variables.identifier).toEqual({ handle: "bicii-p-000032" });
    expect(sent[1].body.variables.identifier).toEqual({ id: PRODUCT });
    const input = sent[0].body.variables.input as Record<string, unknown>;
    expect(input).toMatchObject({
      handle: "bicii-p-000032",
      title: "Stack sync stickers",
      vendor: "BICII",
      status: "ACTIVE",
      descriptionHtml: "<p>Hi</p>",
      files: [{ originalSource: "https://x.example/a.jpg", contentType: "IMAGE" }],
    });
    expect(input.variants).toEqual([
      {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        inventoryItem: { tracked: true, sku: "P-000032" },
        price: "12.00",
      },
    ]);
    expect((sent[1].body.variables.input as { status: string }).status).toBe("DRAFT");
  });

  it("leaves the price out when there is none (unpublishing)", async () => {
    const { admin, sent } = adminWith(productSetOk());
    await admin.upsertProduct({ ...INPUT, price: null, status: "DRAFT" }, { productId: PRODUCT });
    const [variant] = (sent[0].body.variables.input as { variants: Record<string, unknown>[] })
      .variants;
    expect(variant).not.toHaveProperty("price");
  });

  it("updates a Shopify-made variant's price only", async () => {
    const { admin, sent } = adminWith(
      ok({
        productVariantsBulkUpdate: {
          productVariants: [{ id: VARIANT, inventoryItem: { id: ITEM } }],
          userErrors: [],
        },
      }),
    );
    expect(
      await admin.updateVariantPrice({ productId: PRODUCT, variantId: VARIANT, price: "12.00" }),
    ).toEqual({
      inventoryItemId: ITEM,
    });
    expect(sent[0].body.query).toContain("productVariantsBulkUpdate(");
    expect(sent[0].body.query).not.toContain("productSet");
    expect(sent[0].body.variables).toEqual({
      productId: PRODUCT,
      variants: [{ id: VARIANT, price: "12.00" }],
    });
  });

  it("sets the absolute available quantity with the compare quantity, or without one", async () => {
    const set = () =>
      ok({
        inventorySetQuantities: {
          inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
          userErrors: [],
        },
      });
    const { admin, sent } = adminWith(set(), set());
    const args = {
      inventoryItemId: ITEM,
      locationId: LOCATION,
      quantity: 48,
      compareQuantity: 50,
      idempotencyKey: "0b1c2d3e-0000-4000-8000-000000000001",
      reference: "bicii-p-000032",
    };
    await admin.setAvailableQuantity(args);
    await admin.setAvailableQuantity({ ...args, compareQuantity: null });
    expect(sent[0].body.query).toContain("inventorySetQuantities(");
    expect(sent[0].body.query).toContain("@idempotent(key: $idempotencyKey)");
    expect(sent[0].body.variables).toEqual({
      idempotencyKey: "0b1c2d3e-0000-4000-8000-000000000001",
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: "bicii://products/bicii-p-000032",
        quantities: [
          { inventoryItemId: ITEM, locationId: LOCATION, quantity: 48, changeFromQuantity: 50 },
        ],
      },
    });
    expect(
      (sent[1].body.variables.input as { quantities: { changeFromQuantity: unknown }[] })
        .quantities[0].changeFromQuantity,
    ).toBeNull();
  });

  it("maps a stale compare quantity to shopify_quantity_changed (retriable)", async () => {
    const { admin } = adminWith(
      ok({
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [
            {
              field: ["input"],
              message: "The quantity changed",
              code: "CHANGE_FROM_QUANTITY_STALE",
            },
          ],
        },
      }),
    );
    const e = await caught(
      admin.setAvailableQuantity({
        inventoryItemId: ITEM,
        locationId: LOCATION,
        quantity: 1,
        compareQuantity: 2,
        idempotencyKey: "k",
        reference: "r",
      }),
    );
    expect(e).toBeInstanceOf(ShopifyError);
    expect(e.code).toBe("shopify_quantity_changed");
    expect(e.retriable).toBe(true);
  });

  it("maps userErrors to a non-retriable error carrying Shopify's messages", async () => {
    const { admin } = adminWith(
      ok({
        productSet: {
          product: null,
          userErrors: [
            { field: ["handle"], message: "Handle has already been taken", code: "TAKEN" },
            { field: null, message: "Title is too long", code: null },
          ],
        },
      }),
    );
    const e = await caught(admin.upsertProduct(INPUT, null));
    expect(e.code).toBe("shopify_user_error");
    expect(e.retriable).toBe(false);
    expect(e.userMessage).toBe(
      "Shopify refused the change: Handle has already been taken; Title is too long",
    );
  });

  it("treats 429, THROTTLED, 5xx, network errors and timeouts as retriable", async () => {
    const throttled = Response.json({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    });
    const hang = () =>
      new Promise<Response>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
          5,
        ),
      );
    const { admin } = adminWith(
      new Response("slow down", { status: 429 }),
      throttled,
      new Response("oops", { status: 502 }),
      new TypeError("fetch failed"),
      hang,
    );
    const expected = [
      "shopify_throttled",
      "shopify_throttled",
      "shopify_unavailable",
      "shopify_unavailable",
      "shopify_unavailable",
    ];
    for (const code of expected) {
      const e = await caught(admin.primaryLocationId());
      expect(e.code).toBe(code);
      expect(e.retriable).toBe(true);
    }
  });

  it("aborts a call that takes longer than the timeout", async () => {
    const slow = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const admin = createGraphqlShopifyAdmin({
      shopDomain: "bicii-test.myshopify.com",
      accessToken: "t",
      fetch: slow as unknown as typeof globalThis.fetch,
      timeoutMs: 10,
    });
    const e = await caught(admin.primaryLocationId());
    expect(e.code).toBe("shopify_unavailable");
    expect(e.retriable).toBe(true);
  });

  it("maps 401 and 403 to shopify_auth_failed (a person must fix the token)", async () => {
    const { admin } = adminWith(
      new Response("", { status: 401 }),
      new Response("", { status: 403 }),
    );
    for (let i = 0; i < 2; i++) {
      const e = await caught(admin.upsertProduct(INPUT, null));
      expect(e.code).toBe("shopify_auth_failed");
      expect(e.retriable).toBe(false);
      expect(e.userMessage).toBe(
        "Shopify refused the access token. Check the Shopify app settings.",
      );
    }
  });

  it("maps unexpected shapes to shopify_bad_response (retriable)", async () => {
    const { admin } = adminWith(
      new Response("not json", { status: 200 }),
      Response.json({
        data: { productSet: { product: { id: PRODUCT, variants: { nodes: [] } }, userErrors: [] } },
      }),
      Response.json({
        errors: [{ message: "Field 'x' doesn't exist", extensions: { code: "undefinedField" } }],
      }),
    );
    for (let i = 0; i < 3; i++) {
      const e = await caught(admin.upsertProduct(INPUT, null));
      expect(e.code).toBe("shopify_bad_response");
      expect(e.retriable).toBe(true);
    }
  });

  it("publishes to the Online Store publication, looking it up once", async () => {
    const PUBLICATION = "gid://shopify/Publication/1001";
    const { admin, sent } = adminWith(
      ok({
        publications: {
          nodes: [
            { id: "gid://shopify/Publication/1000", name: "Point of Sale" },
            { id: PUBLICATION, name: "Online Store" },
          ],
        },
      }),
      ok({ publishablePublish: { userErrors: [] } }),
      ok({ publishablePublish: { userErrors: [] } }),
    );
    await admin.publishToOnlineStore(PRODUCT);
    await admin.publishToOnlineStore(PRODUCT);
    expect(sent.map((s) => s.body.query.match(/(query|mutation) (\w+)/)?.[2])).toEqual([
      "BiciiPublications",
      "BiciiPublish",
      "BiciiPublish",
    ]);
    expect(sent[1].body.variables).toEqual({
      id: PRODUCT,
      input: [{ publicationId: PUBLICATION }],
    });
  });

  it("refuses publishing when the store has no Online Store channel, and maps userErrors", async () => {
    const none = adminWith(
      ok({ publications: { nodes: [{ id: "gid://shopify/Publication/1000", name: "Shop" }] } }),
    );
    const missing = await caught(none.admin.publishToOnlineStore(PRODUCT));
    expect(missing).toMatchObject({ code: "shopify_user_error", retriable: false });
    expect(missing.userMessage).toContain("Online Store sales channel");

    const refused = adminWith(
      ok({
        publications: { nodes: [{ id: "gid://shopify/Publication/1001", name: "Online Store" }] },
      }),
      ok({ publishablePublish: { userErrors: [{ field: ["id"], message: "Product not found" }] } }),
    );
    const e = await caught(refused.admin.publishToOnlineStore(PRODUCT));
    expect(e).toMatchObject({ code: "shopify_user_error", retriable: false });
  });

  it("maps a missing publications scope to an access refusal naming the scopes", async () => {
    // Shopify's exact answer without read_publications (live store, 2026-11-13).
    const { admin } = adminWith(
      Response.json({
        errors: [
          {
            message:
              "Access denied for publications field. Required access: `read_publications` access scope.",
            extensions: { code: "ACCESS_DENIED" },
            path: ["publications"],
          },
        ],
        data: null,
      }),
    );
    const e = await caught(admin.publishToOnlineStore(PRODUCT));
    expect(e).toMatchObject({ code: "shopify_auth_failed", retriable: false });
    expect(e.userMessage).toContain("publications");
  });

  it("returns the first active location", async () => {
    const { admin } = adminWith(
      ok({
        locations: {
          nodes: [
            { id: "gid://shopify/Location/1", isActive: false },
            { id: LOCATION, isActive: true },
          ],
        },
      }),
      ok({ locations: { nodes: [{ id: "gid://shopify/Location/1", isActive: false }] } }),
    );
    expect(await admin.primaryLocationId()).toBe(LOCATION);
    const e = await caught(admin.primaryLocationId());
    expect(e.code).toBe("shopify_user_error");
    expect(e.retriable).toBe(false);
  });
});
