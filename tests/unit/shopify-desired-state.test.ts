// @vitest-environment node
/**
 * The desired Shopify state of one product (D81, D83, D84): built from
 * product_sync_state, never recomputing the price; the hash is stable under
 * key order and moves with everything pushed, the location and the API
 * version.
 */
import { describe, expect, it } from "vitest";

import {
  buildDesiredState,
  canonicalJson,
  descriptionToHtml,
  moneyText,
  type SyncState,
} from "@/lib/integrations/shopify/desired-state";

const BASE = "http://127.0.0.1:54321/storage/v1/object/public/media-public";
const OPTIONS = {
  publicStorageBase: BASE,
  apiVersion: "2026-10",
  locationId: "gid://shopify/Location/9300000001",
};

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    product_id: "d1000000-0000-4000-8000-000000000006",
    short_id: "P-000032",
    sku: null,
    name: "Stack sync stickers",
    description: "Line one.\n\nLine <two> & more",
    brand: "BICII",
    tracking_type: "quantity",
    ownership_type: "shop_owned",
    publication_status: "public",
    active: true,
    archived: false,
    sale_price: 12,
    currency: "SGD",
    publish_online: true,
    effective_online: true,
    available_quantity: 50,
    unit_price_conflicts: [],
    public_photo_paths: ["product/abc/def.jpg"],
    handle: "bicii-p-000032",
    shopify_origin: null,
    shopify_product_id: null,
    shopify_variant_id: null,
    shopify_inventory_item_id: null,
    shopify_location_id: null,
    online_location_name: "Shop floor",
    last_desired_hash: null,
    last_pushed_quantity: null,
    orders_in_flight: false,
    sync_status: "pending",
    frame_grade: null,
    ...overrides,
  } as SyncState;
}

describe("buildDesiredState", () => {
  it("builds a full productSet input for a BICII-created product", () => {
    const d = buildDesiredState(state(), OPTIONS);
    expect(d.mode).toBe("full");
    expect(d.problems).toEqual([]);
    expect(d.price).toBe("12.00");
    expect(d.quantity).toBe(50);
    expect(d.input).toEqual({
      handle: "bicii-p-000032",
      title: "Stack sync stickers",
      descriptionHtml: "<p>Line one.</p><p>Line &lt;two&gt; &amp; more</p>",
      vendor: "BICII",
      status: "ACTIVE",
      sku: "P-000032",
      price: "12.00",
      imageUrls: [`${BASE}/product/abc/def.jpg`],
      tags: [],
    });
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows a frame's grade in the title, a tag and the description's last paragraph (D260)", () => {
    const d = buildDesiredState(
      state({ name: "KHS Comp steel frame and fork", frame_grade: "B+" }),
      OPTIONS,
    );
    expect(d.input?.title).toBe("KHS Comp steel frame and fork · B+ frame");
    expect(d.input?.tags).toEqual(["Grade B+"]);
    expect(d.input?.descriptionHtml).toBe(
      "<p>Line one.</p><p>Line &lt;two&gt; &amp; more</p>" +
        "<p>Frame grade B+ (C to S++, S best): the frame itself, before any work done to it. Not a safety rating.</p>",
    );
    // Ungraded again: plain title, no tags (pushed as an empty list, so Shopify drops the old tag).
    const plain = buildDesiredState(state({ frame_grade: null }), OPTIONS);
    expect(plain.input?.title).toBe("Stack sync stickers");
    expect(plain.input?.tags).toEqual([]);
  });

  it("leaves a product made in Shopify alone whatever its grade (D84)", () => {
    const d = buildDesiredState(
      state({ shopify_origin: "external", handle: null, frame_grade: "S" }),
      OPTIONS,
    );
    expect(d.input).toBeNull();
  });

  it("passes the database price through unchanged (0 is a price, D24)", () => {
    expect(buildDesiredState(state({ sale_price: "1234.50" }), OPTIONS).price).toBe("1234.50");
    expect(buildDesiredState(state({ sale_price: 0.1 }), OPTIONS).price).toBe("0.10");
    const zero = buildDesiredState(state({ sale_price: 0 }), OPTIONS);
    expect(zero.price).toBe("0.00");
    expect(zero.problems).toEqual([]);
  });

  it("vendor falls back to BICII and the SKU to the short id", () => {
    const d = buildDesiredState(state({ brand: " ", sku: "PZ-28" }), OPTIONS);
    expect(d.input?.vendor).toBe("BICII");
    expect(d.input?.sku).toBe("PZ-28");
    expect(buildDesiredState(state({ brand: "Pirelli" }), OPTIONS).input?.vendor).toBe("Pirelli");
  });

  it("drafts at quantity 0 when the product is not effectively online", () => {
    const d = buildDesiredState(state({ effective_online: false, publish_online: false }), OPTIONS);
    expect(d.input?.status).toBe("DRAFT");
    expect(d.quantity).toBe(0);
  });

  it("is price and inventory only for a product made in Shopify", () => {
    const d = buildDesiredState(
      state({
        shopify_origin: "external",
        handle: null,
        shopify_product_id: "gid://shopify/Product/8800000001",
        shopify_variant_id: "gid://shopify/ProductVariant/8810000002",
      }),
      OPTIONS,
    );
    expect(d.mode).toBe("variant_only");
    expect(d.input).toBeNull();
    expect(d.price).toBe("12.00");
    expect(d.quantity).toBe(50);
  });

  it("refuses a live product without a price or with a unit priced differently", () => {
    expect(buildDesiredState(state({ sale_price: null }), OPTIONS).problems).toEqual([
      { code: "shopify_price_missing", message: "Set a sale price before publishing it online." },
    ]);
    expect(
      buildDesiredState(state({ unit_price_conflicts: ["U-000012", "U-000013"] }), OPTIONS)
        .problems,
    ).toEqual([
      {
        code: "shopify_unit_price_mismatch",
        message:
          "Unit U-000012 is priced differently from the product. Give units the product's price to sell them online.",
      },
    ]);
  });

  it("still drafts a product being unpublished whatever its prices", () => {
    const d = buildDesiredState(
      state({ effective_online: false, sale_price: null, unit_price_conflicts: ["U-000012"] }),
      OPTIONS,
    );
    expect(d.problems).toEqual([]);
    expect(d.price).toBeNull();
    expect(d.input?.price).toBeNull();
  });

  describe("hash", () => {
    const h = (s: SyncState, o = OPTIONS) => buildDesiredState(s, o).hash;

    it("is stable for the same state, whatever the key order", () => {
      const reversed = Object.fromEntries(Object.entries(state()).reverse()) as SyncState;
      expect(h(reversed)).toBe(h(state()));
      expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
        '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}',
      );
    });

    it("ignores what is not pushed (sync status, last hash, in-flight flag)", () => {
      expect(
        h(state({ sync_status: "error", last_desired_hash: "x", orders_in_flight: true })),
      ).toBe(h(state()));
    });

    it("changes with the price, quantity, photos, API version, location and mode", () => {
      const base = h(state());
      const variants = [
        h(state({ sale_price: 13 })),
        h(state({ available_quantity: 49 })),
        h(state({ public_photo_paths: [] })),
        h(state(), { ...OPTIONS, apiVersion: "2027-01" }),
        h(state(), { ...OPTIONS, locationId: "gid://shopify/Location/1" }),
        h(state({ shopify_origin: "external" })),
        h(state({ effective_online: false })),
        h(state({ frame_grade: "B" })),
      ];
      for (const v of variants) expect(v).not.toBe(base);
      expect(new Set(variants).size).toBe(variants.length);
    });
  });
});

describe("helpers", () => {
  it("moneyText keeps the exact two-decimal amount", () => {
    expect(moneyText(95)).toBe("95.00");
    expect(moneyText("95.5")).toBe("95.50");
    expect(moneyText(null)).toBeNull();
    expect(() => moneyText({})).toThrow(TypeError);
  });

  it("descriptionToHtml escapes and splits paragraphs", () => {
    expect(descriptionToHtml(null)).toBe("");
    expect(descriptionToHtml("a\nb\r\n\r\n\nc \"q\" 'x'")).toBe(
      "<p>a<br>b</p><p>c &quot;q&quot; &#39;x&#39;</p>",
    );
    expect(descriptionToHtml("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("encodes photo path segments", () => {
    const d = buildDesiredState(state({ public_photo_paths: ["product/a b/c#d.jpg"] }), OPTIONS);
    expect(d.input?.imageUrls).toEqual([`${BASE}/product/a%20b/c%23d.jpg`]);
  });
});
