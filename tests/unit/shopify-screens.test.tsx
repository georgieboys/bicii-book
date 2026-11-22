import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const unlinkCustomerAction = vi.fn();
vi.mock("@/app/(staff)/shopify/actions", () => ({
  linkCustomerAction: vi.fn(),
  unlinkCustomerAction: (...args: unknown[]) => unlinkCustomerAction(...args),
}));
vi.mock("@/app/(staff)/customers/actions", () => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  searchCustomers: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { UnlinkCustomerButton } from "@/components/domain/shopify/link-customer-sheet";
import { JsonView } from "@/components/domain/shopify/json-view";
import { ToastProvider } from "@/components/ui/toast";
import { formatTime } from "@/lib/dates";
import {
  EVENT_OUTCOMES,
  EVENT_STATUSES,
  JOB_STATUSES,
  REJECTION_REASONS,
  SYNC_STATUSES,
  attemptText,
  connectionLabel,
  deliveredText,
  earlierSalesText,
  eventRowNote,
  eventStatusLabel,
  eventStatusTone,
  jobKindLabel,
  jobStatusLabel,
  jobTitle,
  offlineReason,
  jobStatusTone,
  outcomeText,
  parseUnmappedLines,
  publishBlockedReason,
  readEventFilter,
  readProductFilter,
  readQueueView,
  refundAmounts,
  rejectionText,
  relativeAgo,
  syncStatusLabel,
  syncStatusTone,
  topicLabel,
  unmappedLineTitle,
} from "@/lib/shopify";
import {
  dismissJobSchema,
  linkCustomerSchema,
  linkVariantSchema,
  publishOnlineSchema,
  shopifySettingsSchema,
  unlinkCustomerSchema,
} from "@/lib/shopify-forms";

/**
 * Phase 10 step 4: the words and tones of the Shopify screens (every
 * status, outcome and rejection reason has text), the queue's attempt
 * line in Singapore time, the unmapped lines read from an event's result,
 * the action schemas (a reason to dismiss, to link, and to change test
 * orders) and JsonView's wrap and show-all.
 */

const JOB = "e3000000-0000-4000-8000-000000000001";
const PRODUCT = "d1000000-0000-4000-8000-000000000004";

describe("status words and tones", () => {
  it("maps every product sync status to a word and the agreed tone", () => {
    for (const s of SYNC_STATUSES) expect(syncStatusLabel(s)).not.toBe("Unknown");
    expect(syncStatusTone("synced")).toBe("done");
    expect(syncStatusTone("pending")).toBe("progress");
    expect(syncStatusTone("error")).toBe("danger");
    expect(syncStatusTone("unpublished")).toBe("neutral");
    expect(syncStatusTone("not_synced")).toBe("neutral");
    expect(syncStatusLabel("synced")).toBe("Synced");
  });

  it("maps every job status to a word and the agreed tone", () => {
    for (const s of JOB_STATUSES) expect(jobStatusLabel(s)).not.toBe("Unknown");
    expect(jobStatusTone("needs_attention")).toBe("danger");
    expect(jobStatusTone("queued")).toBe("waiting");
    expect(jobStatusTone("running")).toBe("progress");
    expect(jobStatusTone("done")).toBe("done");
    expect(jobStatusTone("dismissed")).toBe("neutral");
  });

  it("maps every event status to a word; failed and rejected are danger", () => {
    for (const s of EVENT_STATUSES) expect(eventStatusLabel(s)).not.toBe("Unknown");
    expect(eventStatusTone("failed")).toBe("danger");
    expect(eventStatusTone("rejected")).toBe("danger");
    expect(eventStatusTone("processed")).toBe("done");
  });

  it("names the kind of a queue item and the topic of an event", () => {
    expect(jobKindLabel("shopify_event", "orders/paid")).toBe("Order");
    expect(jobKindLabel("shopify_event", "refunds/create")).toBe("Refund");
    expect(jobKindLabel("product_sync", null)).toBe("Product sync");
    expect(topicLabel("orders/paid")).toBe("Order paid");
    expect(topicLabel("refunds/create")).toBe("Refund");
    expect(topicLabel("products/update")).toBe("products/update");
    expect(connectionLabel("live")).toBe("Live");
    expect(connectionLabel("fake")).toBe("Test (fake)");
    expect(connectionLabel("off")).toBe("Not connected");
  });
});

describe("outcomes and rejection reasons", () => {
  it("words every rejection reason (D88)", () => {
    for (const r of REJECTION_REASONS) {
      expect(rejectionText(r)).toBeTruthy();
      expect(rejectionText(r)).not.toBe("Rejected");
    }
    expect(rejectionText("hmac_invalid")).toBe("Signature did not match");
    expect(rejectionText("shop_domain_mismatch")).toBe("Sent by a different shop");
    expect(rejectionText(null)).toBeNull();
  });

  it("words every outcome the processors store", () => {
    for (const o of EVENT_OUTCOMES) {
      const text = outcomeText(o, { saleNumber: "S-000123", result: { amount: 5 } });
      expect(text?.text, o).toBeTruthy();
      expect(text?.text, o).not.toMatch(/^Outcome:/);
    }
    expect(outcomeText(null)).toBeNull();
    expect(outcomeText("sale_recorded", { saleNumber: "S-000123" })?.text).toBe(
      "Recorded as sale S-000123",
    );
    expect(outcomeText("duplicate_order", { saleNumber: "S-000123" })?.text).toBe(
      "Already recorded from another delivery (S-000123)",
    );
    expect(outcomeText("dismissed", { resolutionReason: "Refunded in Shopify" })?.text).toBe(
      "Dismissed: Refunded in Shopify",
    );
  });

  it("says a refund moved no stock, and keeps shipping and excess apart (D7, D85)", () => {
    const plain = outcomeText("refund_recorded", {
      result: { amount: 5, shipping_refunded: 0, unallocated_refund: 0 },
    });
    expect(plain?.text).toBe(
      "Refund of $5.00 recorded; stock untouched — restock from the sale if the item came back",
    );
    expect(plain?.detail).toBeNull();
    const withShipping = outcomeText("refund_recorded", {
      result: { amount: 20, shipping_refunded: 10, unallocated_refund: 12.5 },
    });
    expect(withShipping?.detail).toBe(
      "Shipping refunded $10.00 and $2.50 not allocated to the sale are kept here only",
    );
    expect(
      refundAmounts({ amount: "5.00", unallocated_refund: "0", shipping_refunded: 3 }),
    ).toEqual({ amount: "5.00", shipping: "3.00", excess: "0.00" });
    expect(refundAmounts(null)).toEqual({ amount: null, shipping: null, excess: null });
  });

  it("notes an event's row in a few words", () => {
    const row = { status: "processed" as const, saleNumber: "S-000009", rejectionReason: null };
    expect(eventRowNote({ ...row, outcome: "sale_recorded" })).toBe("Recorded as S-000009");
    expect(eventRowNote({ ...row, outcome: "duplicate_order" })).toBe(
      "Already recorded (S-000009)",
    );
    expect(
      eventRowNote({
        status: "rejected",
        outcome: null,
        saleNumber: null,
        rejectionReason: "hmac_invalid",
      }),
    ).toBe("Signature did not match");
    for (const o of EVENT_OUTCOMES) expect(eventRowNote({ ...row, outcome: o }), o).toBeTruthy();
    expect(deliveredText(1)).toBeNull();
    expect(deliveredText(2)).toBe("Delivered 2×");
  });
});

describe("queue rows", () => {
  it("says the attempt and, while waiting, the next try in Singapore time", () => {
    const next = "2026-10-06T06:05:00Z";
    expect(
      attemptText({ attempts: 3, maxAttempts: 8, nextAttemptAt: next, status: "queued" }),
    ).toBe(`Attempt 3 of 8 · next try ${formatTime(next)}`);
    expect(formatTime(next)).toBe("2:05 pm");
    expect(
      attemptText({ attempts: 2, maxAttempts: 8, nextAttemptAt: next, status: "needs_attention" }),
    ).toBe("Attempt 2 of 8");
    expect(
      attemptText({ attempts: 0, maxAttempts: 8, nextAttemptAt: next, status: "needs_attention" }),
    ).toBe("Not tried yet");
  });

  it("reads the unmapped lines from an event's result, custom lines included", () => {
    const lines = parseUnmappedLines({
      unmapped_lines: [
        {
          line_item_id: "gid://shopify/LineItem/7100001002",
          title: "BICII cotton cap",
          variant_title: "Red",
          variant_gid: "gid://shopify/ProductVariant/9199999999",
          product_gid: "gid://shopify/Product/9099999999",
          quantity: 1,
        },
        {
          line_item_id: "7",
          title: "Gift wrap",
          variant_gid: null,
          product_gid: null,
          quantity: 2,
        },
        "not a line",
      ],
    });
    expect(lines).toEqual([
      {
        lineItemId: "gid://shopify/LineItem/7100001002",
        title: "BICII cotton cap",
        variantTitle: "Red",
        variantGid: "gid://shopify/ProductVariant/9199999999",
        productGid: "gid://shopify/Product/9099999999",
        quantity: 1,
      },
      {
        lineItemId: "7",
        title: "Gift wrap",
        variantTitle: null,
        variantGid: null,
        productGid: null,
        quantity: 2,
      },
    ]);
    expect(unmappedLineTitle(lines[0]!)).toBe("BICII cotton cap — Red");
    expect(parseUnmappedLines({})).toEqual([]);
    expect(parseUnmappedLines(null)).toEqual([]);
    expect(parseUnmappedLines({ unmapped_lines: "x" })).toEqual([]);
  });

  it("reads list filters from the URL with safe defaults", () => {
    expect(readQueueView(undefined)).toBe("attention");
    expect(readQueueView("recent")).toBe("recent");
    expect(readQueueView("bogus")).toBe("attention");
    expect(readProductFilter(["errors"])).toBe("errors");
    expect(readEventFilter("rejected")).toBe("rejected");
    expect(readEventFilter("pending")).toBe("all");
  });
});

describe("the Online card's rules", () => {
  const base = {
    canManage: true,
    publishOnline: false,
    publicationStatus: "public",
    ownershipType: "shop_owned",
    archived: false,
    hasPrice: true,
  };

  it("explains why Publish online cannot be switched on (D84, D86)", () => {
    expect(publishBlockedReason(base)).toBeNull();
    expect(publishBlockedReason({ ...base, canManage: false })).toBe("Needs Manage inventory");
    expect(publishBlockedReason({ ...base, publicationStatus: "internal_only" })).toBe(
      "Make the product public first.",
    );
    expect(publishBlockedReason({ ...base, ownershipType: "customer_owned" })).toBe(
      "Customer-owned items cannot be sold online.",
    );
    expect(publishBlockedReason({ ...base, archived: true })).toBe("Unarchive the product first.");
    expect(publishBlockedReason({ ...base, hasPrice: false })).toBe("Set a sale price first.");
    // Taking it offline is never blocked by the product's state.
    expect(
      publishBlockedReason({ ...base, publishOnline: true, publicationStatus: "internal_only" }),
    ).toBeNull();
  });

  it("says how long ago it synced", () => {
    const now = new Date("2026-10-06T06:00:00Z");
    expect(relativeAgo("2026-10-06T05:59:40Z", now)).toBe("just now");
    expect(relativeAgo("2026-10-06T05:57:00Z", now)).toBe("3 min ago");
    expect(relativeAgo("2026-10-06T03:00:00Z", now)).toBe("3 h ago");
    expect(relativeAgo("2026-10-05T05:00:00Z", now)).toBe("1 day ago");
    expect(relativeAgo("2026-10-07T06:00:00Z", now)).toBe("just now");
  });

  it("says how many earlier online sales a customer link shows (D86)", () => {
    expect(earlierSalesText(0)).toBe("No earlier online sale is waiting for this customer.");
    expect(earlierSalesText(1)).toMatch(/^1 earlier online sale shows/);
    expect(earlierSalesText(3)).toMatch(/^3 earlier online sales show/);
  });
});

describe("the Online card's offline reason (D84: private.shopify_effective_online)", () => {
  const listed = {
    active: true,
    archived: false,
    ownershipType: "shop_owned",
    publicationStatus: "public",
    trackingType: "quantity",
  };
  it("is null when the product is listed, a sold-out unique product included", () => {
    expect(offlineReason(listed)).toBeNull();
    expect(
      offlineReason({ ...listed, trackingType: "unique", publicationStatus: "sold" }),
    ).toBeNull();
  });
  it("names why it is not listed", () => {
    expect(offlineReason({ ...listed, publicationStatus: "unpublished" })).toMatch(
      /^Not listed: the product is not public/,
    );
    expect(offlineReason({ ...listed, publicationStatus: "sold" })).toMatch(/not public/);
    expect(offlineReason({ ...listed, archived: true })).toMatch(/archived/);
    expect(offlineReason({ ...listed, active: false })).toMatch(/inactive/);
    expect(offlineReason({ ...listed, ownershipType: "customer_owned" })).toMatch(/customer-owned/);
  });
});

describe("queue titles", () => {
  it("adds the kind unless the subject starts with it", () => {
    expect(jobTitle("shopify_event", "orders/paid", "#1042")).toBe("Order #1042");
    expect(jobTitle("shopify_event", "refunds/create", "Refund 7300000001 of #1001")).toBe(
      "Refund 7300000001 of #1001",
    );
    expect(jobTitle("product_sync", null, "P-000027 Bottle")).toBe("Product sync P-000027 Bottle");
  });
});

describe("action schemas", () => {
  it("needs a product id and a boolean to publish", () => {
    expect(publishOnlineSchema.safeParse({ productId: PRODUCT, publish: true }).success).toBe(true);
    expect(publishOnlineSchema.safeParse({ productId: "x", publish: true }).success).toBe(false);
    expect(publishOnlineSchema.safeParse({ productId: PRODUCT, publish: "yes" }).success).toBe(
      false,
    );
  });

  it("needs a reason to dismiss", () => {
    expect(dismissJobSchema.safeParse({ jobId: JOB, reason: "Refunded in Shopify" }).success).toBe(
      true,
    );
    const blank = dismissJobSchema.safeParse({ jobId: JOB, reason: "   " });
    expect(blank.success).toBe(false);
    expect(dismissJobSchema.safeParse({ jobId: JOB, reason: "x".repeat(501) }).success).toBe(false);
  });

  it("needs a product, both Shopify ids and a reason to link a variant", () => {
    const ok = {
      jobId: JOB,
      productId: PRODUCT,
      shopifyProductGid: "gid://shopify/Product/9700000001",
      shopifyVariantGid: "gid://shopify/ProductVariant/9800000001",
      reason: "Same musette",
    };
    expect(linkVariantSchema.safeParse(ok).success).toBe(true);
    expect(linkVariantSchema.safeParse({ ...ok, reason: "" }).success).toBe(false);
    expect(linkVariantSchema.safeParse({ ...ok, shopifyVariantGid: "" }).success).toBe(false);
    expect(
      linkVariantSchema.safeParse({ ...ok, shopifyVariantGid: "gid://shopify/Product/1" }).success,
    ).toBe(false);
  });

  it("needs a reason to link a customer, never just an email", () => {
    const ok = {
      eventId: JOB,
      customerId: PRODUCT,
      shopifyCustomerGid: "gid://shopify/Customer/7200000001",
      reason: "Confirmed by phone",
    };
    expect(linkCustomerSchema.safeParse(ok).success).toBe(true);
    expect(linkCustomerSchema.safeParse({ ...ok, reason: " " }).success).toBe(false);
    expect(
      linkCustomerSchema.safeParse({ ...ok, shopifyCustomerGid: "buyer@example.com" }).success,
    ).toBe(false);
  });

  it("needs a customer and a reason to unlink a customer (R-131)", () => {
    const ok = { customerId: PRODUCT, reason: "Shared family email; not the buyer" };
    expect(unlinkCustomerSchema.safeParse(ok).success).toBe(true);
    expect(unlinkCustomerSchema.safeParse({ ...ok, reason: "  " }).success).toBe(false);
    expect(unlinkCustomerSchema.safeParse({ ...ok, customerId: "x" }).success).toBe(false);
  });

  it("needs a reason only when the test-order switch changes (D89)", () => {
    const form = {
      onlineLocationId: PRODUCT,
      storefrontUrl: "https://shop.bicii.example/",
      wasAcceptingTestOrders: "false",
    };
    const same = shopifySettingsSchema.safeParse(form);
    expect(same.success).toBe(true);
    expect(same.data?.storefrontUrl).toBe("https://shop.bicii.example");
    expect(same.data?.acceptTestOrders).toBe(false);
    const changed = shopifySettingsSchema.safeParse({ ...form, acceptTestOrders: "on" });
    expect(changed.success).toBe(false);
    expect(changed.error?.issues[0]?.path).toEqual(["reason"]);
    expect(
      shopifySettingsSchema.safeParse({ ...form, acceptTestOrders: "on", reason: "Dev store" })
        .success,
    ).toBe(true);
    expect(
      shopifySettingsSchema.safeParse({ ...form, storefrontUrl: "http://shop.example" }).success,
    ).toBe(false);
    expect(
      shopifySettingsSchema.safeParse({ ...form, storefrontUrl: "" }).data?.storefrontUrl,
    ).toBe(null);
  });
});

describe("JsonView", () => {
  const json = JSON.stringify({ id: 1, line_items: [{ title: "Cap" }] }, null, 2);
  const view = () =>
    render(
      <ToastProvider>
        <JsonView json={json} />
      </ToastProvider>,
    );

  it("shows the JSON unwrapped and capped, then wraps and shows all on request", () => {
    view();
    const block = screen.getByLabelText("Payload");
    expect(block).toHaveTextContent('"title": "Cap"');
    expect(block).toHaveClass("whitespace-pre", "overflow-auto", "max-h-[60vh]");
    const wrap = screen.getByRole("button", { name: "Wrap lines" });
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(wrap);
    expect(block).toHaveClass("whitespace-pre-wrap");
    expect(screen.getByRole("button", { name: "Don't wrap" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(block).not.toHaveClass("max-h-[60vh]");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("copies the JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(writeText).toHaveBeenCalledWith(json);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});

describe("UnlinkCustomerButton (R-131: a wrong link can be undone)", () => {
  it("asks why, says what unlinking does, and sends the customer with the reason", async () => {
    unlinkCustomerAction.mockResolvedValue({ ok: true, data: { onlineSalesKept: 2 } });
    render(
      <ToastProvider>
        <UnlinkCustomerButton customerId={PRODUCT} customerLabel="Ana Lim" />
      </ToastProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unlink… Ana Lim from this Shopify customer" }),
    );
    expect(screen.getByText(/BICII will not match these two by email again/)).toBeInTheDocument();
    expect(screen.getByText(/stay on their record here/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Why is this link wrong/), {
      target: { value: "  Shared family email  " },
    });
    // The confirm button ignores presses for 400 ms after opening.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    });
    await waitFor(() => expect(unlinkCustomerAction).toHaveBeenCalledTimes(1));
    expect(unlinkCustomerAction).toHaveBeenCalledWith({
      customerId: PRODUCT,
      reason: "Shared family email",
    });
  });
});
