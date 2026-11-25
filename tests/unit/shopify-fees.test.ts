// @vitest-environment node
/**
 * D274: Shopify Payments fees. The live adapter's order read (the query,
 * an unknown order, a refusal that names orders access, C3), the fake's
 * seedable orders, and the sweep and the read after sale_recorded: what
 * each outcome counts, a refusal stopping the run, a failure noted for the
 * backoff, a test order recorded without a read, and nothing at all while
 * Shopify is off. Postgres does the money (tests/db/shopify-fees.test.ts).
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SHOPIFY_MESSAGES, ShopifyError } = await import("@/lib/integrations/shopify/admin");
const { createGraphqlShopifyAdmin, ORDER_FEES_QUERY } =
  await import("@/lib/integrations/shopify/graphql-admin");
const { createFakeShopifyAdmin } = await import("@/lib/integrations/shopify/fake-admin");
const { readFeeAfterSale, readShopifyFee, sweepShopifyFees } =
  await import("@/lib/integrations/shopify/fees");

const log = pino({ level: "silent" });
const ORDER = "gid://shopify/Order/7000001001";

function liveWith(...responses: Response[]) {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)));
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return next;
  });
  const admin = createGraphqlShopifyAdmin({
    shopDomain: "bicii-test.myshopify.com",
    accessToken: "shpat_test_token",
    fetch: fetch as unknown as typeof globalThis.fetch,
    timeoutMs: 50,
  });
  return { admin, sent };
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as InstanceType<typeof ShopifyError>;
  }
  throw new Error("expected a rejection");
}

describe("the live adapter's order fee read (D274)", () => {
  it("asks for the order's transactions with their fees and returns the node as Shopify sent it", async () => {
    const node = {
      id: ORDER,
      transactions: [
        {
          id: "gid://shopify/OrderTransaction/1",
          kind: "SALE",
          status: "SUCCESS",
          test: false,
          gateway: "shopify_payments",
          amountSet: { shopMoney: { amount: "95.00", currencyCode: "SGD" } },
          fees: [
            {
              type: "processing",
              amount: { amount: "3.20", currencyCode: "SGD" },
              taxAmount: { amount: "0.29", currencyCode: "SGD" },
            },
          ],
        },
      ],
    };
    const { admin, sent } = liveWith(Response.json({ data: { order: node } }));
    expect(await admin.orderTransactionFees(ORDER)).toEqual({ raw: node });
    expect(sent[0]).toEqual({ query: ORDER_FEES_QUERY, variables: { id: ORDER } });
    expect(ORDER_FEES_QUERY).toMatch(/fees \{[\s\S]*taxAmount/);
    // Customer and receipt data are never asked for.
    expect(ORDER_FEES_QUERY).not.toMatch(/receiptJson|customer|email/);
  });

  it("an unknown order is null; a shape without transactions is a bad response", async () => {
    const { admin } = liveWith(
      Response.json({ data: { order: null } }),
      Response.json({ data: { order: { id: ORDER } } }),
    );
    expect(await admin.orderTransactionFees(ORDER)).toEqual({ raw: null });
    expect((await caught(admin.orderTransactionFees(ORDER))).code).toBe("shopify_bad_response");
  });

  it("a 403 or ACCESS_DENIED says orders access is missing (C3); a 401 is still the token", async () => {
    const { admin } = liveWith(
      new Response("", { status: 403 }),
      Response.json({
        errors: [
          {
            message: "Access denied for order field. Required access: `read_orders` access scope.",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
        data: null,
      }),
      new Response("", { status: 401 }),
    );
    for (let i = 0; i < 2; i++) {
      const e = await caught(admin.orderTransactionFees(ORDER));
      expect(e).toMatchObject({ code: "shopify_auth_failed", retriable: false });
      expect(e.userMessage).toBe(SHOPIFY_MESSAGES.ordersAccessDenied);
      expect(e.userMessage).toContain("read_orders");
      expect(e.userMessage).toContain("read_all_orders");
    }
    expect((await caught(admin.orderTransactionFees(ORDER))).userMessage).toBe(
      SHOPIFY_MESSAGES.authFailed,
    );
    // The general refusal names orders too.
    expect(SHOPIFY_MESSAGES.accessDenied).toContain("orders");
  });
});

describe("the fake's orders (D274)", () => {
  it("returns a seeded order's transactions in the live shape, null for a missing one, none for an unseeded one", async () => {
    const fake = createFakeShopifyAdmin();
    fake.seedOrderTransactions(ORDER, [
      { amount: "95.00", fees: [{ amount: "3.20", taxAmount: "0.29" }] },
      { kind: "REFUND", amount: "5.00" },
    ]);
    const { raw } = await fake.orderTransactionFees(ORDER);
    expect(raw).toMatchObject({
      id: ORDER,
      transactions: [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "shopify_payments",
          test: false,
          amountSet: { shopMoney: { amount: "95.00", currencyCode: "SGD" } },
          fees: [
            {
              amount: { amount: "3.20", currencyCode: "SGD" },
              taxAmount: { amount: "0.29", currencyCode: "SGD" },
            },
          ],
        },
        { kind: "REFUND", fees: [] },
      ],
    });
    fake.seedOrderTransactions("gid://shopify/Order/2", null);
    expect(await fake.orderTransactionFees("gid://shopify/Order/2")).toEqual({ raw: null });
    expect(await fake.orderTransactionFees("gid://shopify/Order/3")).toEqual({
      raw: { id: "gid://shopify/Order/3", transactions: [] },
    });
    expect(fake.calls.filter((c) => c.kind === "orderFees").map((c) => c.orderId)).toEqual([
      ORDER,
      "gid://shopify/Order/2",
      "gid://shopify/Order/3",
    ]);
    fake.failNext(
      new ShopifyError("shopify_auth_failed", false, SHOPIFY_MESSAGES.ordersAccessDenied),
      "orderFees",
    );
    expect((await caught(fake.orderTransactionFees(ORDER))).code).toBe("shopify_auth_failed");
    fake.reset();
    expect(await fake.orderTransactionFees(ORDER)).toEqual({
      raw: { id: ORDER, transactions: [] },
    });
  });
});

type Due = { sale_id: string; shopify_order_id: string; test_order: boolean };

/** Deps whose RPCs answer from `outcomes` (record_shopify_fee_read by sale id). */
function depsWith(
  due: Due[],
  outcomes: Record<string, string | { code: string }>,
  admin = createFakeShopifyAdmin(),
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "shopify_fees_due") {
      const only = args.p_sale_id as string | undefined;
      return { data: only ? due.filter((d) => d.sale_id === only) : due, error: null };
    }
    if (name === "record_shopify_fee_read") {
      const o = outcomes[args.p_sale_id as string];
      if (typeof o === "object") return { data: null, error: o };
      return { data: o ?? "shopify_fee_recorded", error: null };
    }
    return { data: null, error: null };
  });
  return {
    deps: { supabase: { rpc } as never, admin, log, publicStorageBase: "http://x" },
    calls,
    admin,
  };
}

const row = (n: number, test = false): Due => ({
  sale_id: `sale-${n}`,
  shopify_order_id: `gid://shopify/Order/${n}`,
  test_order: test,
});

describe("the Shopify fee sweep (D274)", () => {
  it("is off (null, no database call) while Shopify is off", async () => {
    const { deps, calls } = depsWith([row(1)], {});
    expect(
      await sweepShopifyFees({ ...deps, admin: null }, { max: 5, deadlineMs: Date.now() + 1000 }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads each due sale's order and records it; counts recorded, pending and needing attention", async () => {
    const { deps, calls, admin } = depsWith([row(1), row(2), row(3), row(4, true)], {
      "sale-1": "shopify_fee_recorded",
      "sale-2": "shopify_fee_pending",
      "sale-3": "shopify_fee_currency_mismatch",
      "sale-4": "shopify_fee_test_order",
    });
    admin.seedOrderTransactions("gid://shopify/Order/1", [
      { amount: "95.00", fees: [{ amount: "3.20" }] },
    ]);
    const summary = await sweepShopifyFees(deps, { max: 5, deadlineMs: Date.now() + 10_000 });
    expect(summary).toEqual({ recorded: 2, pending: 1, failed: 1, permission: false });
    expect(calls[0]).toEqual({ name: "shopify_fees_due", args: { max_rows: 5 } });
    const records = calls.filter((c) => c.name === "record_shopify_fee_read");
    expect(records.map((c) => c.args.p_sale_id)).toEqual(["sale-1", "sale-2", "sale-3", "sale-4"]);
    expect(records[0].args).toMatchObject({
      p_api_version: "2026-10",
      p_read: {
        id: "gid://shopify/Order/1",
        transactions: [expect.objectContaining({ kind: "SALE" })],
      },
    });
    // A test order is recorded without asking Shopify.
    expect(records[3].args.p_read).toBeNull();
    expect(admin.calls.filter((c) => c.kind === "orderFees")).toHaveLength(3);
    // An attention outcome is counted by the RPC itself, not noted again.
    expect(calls.some((c) => c.name === "note_shopify_fee_read_failed")).toBe(false);
  });

  it("a refusal (no orders access) is noted and stops the run; other failures are noted and the run goes on", async () => {
    const admin = createFakeShopifyAdmin();
    admin.seedOrderTransactions("gid://shopify/Order/1", null);
    const { deps, calls } = depsWith(
      [row(1), row(2), row(3), row(4)],
      { "sale-2": { code: "XX000" } },
      admin,
    );
    // Sale 1: Shopify has no such order; sale 2: the database fails; sale 3: refused.
    const failing = admin.orderTransactionFees.bind(admin);
    admin.orderTransactionFees = vi.fn(async (id: string) => {
      if (id === "gid://shopify/Order/3") {
        throw new ShopifyError("shopify_auth_failed", false, SHOPIFY_MESSAGES.ordersAccessDenied);
      }
      return failing(id);
    });
    const summary = await sweepShopifyFees(deps, { max: 5, deadlineMs: Date.now() + 10_000 });
    expect(summary).toEqual({ recorded: 0, pending: 0, failed: 3, permission: true });
    expect(
      calls.filter((c) => c.name === "note_shopify_fee_read_failed").map((c) => c.args),
    ).toEqual([
      { p_sale_id: "sale-1", p_error: "shopify_order_not_found" },
      { p_sale_id: "sale-2", p_error: "database_error" },
      { p_sale_id: "sale-3", p_error: "shopify_auth_failed" },
    ]);
    expect(calls.some((c) => c.args.p_sale_id === "sale-4")).toBe(false);
  });

  it("starts no read past its deadline; a failing work list throws to the cron", async () => {
    let clock = 0;
    const { deps, calls } = depsWith([row(1), row(2)], {});
    deps.supabase = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        clock += 1_000;
        if (name === "shopify_fees_due") return { data: [row(1), row(2)], error: null };
        return { data: "shopify_fee_recorded", error: null };
      }),
    } as never;
    const summary = await sweepShopifyFees(deps, { max: 5, deadlineMs: 2_000, now: () => clock });
    expect(summary).toEqual({ recorded: 1, pending: 0, failed: 0, permission: false });
    const broken = {
      ...deps,
      supabase: { rpc: async () => ({ data: null, error: { code: "42501" } }) } as never,
    };
    await expect(sweepShopifyFees(broken, { max: 5, deadlineMs: 1e15 })).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("the read after sale_recorded reads that one sale, and never throws", async () => {
    const { deps, calls } = depsWith([row(7)], {});
    await readFeeAfterSale(deps, "sale-7");
    expect(calls.map((c) => c.name)).toEqual(["shopify_fees_due", "record_shopify_fee_read"]);
    expect(calls[0].args).toEqual({ max_rows: 1, p_sale_id: "sale-7" });
    const throwing = {
      ...deps,
      supabase: {
        rpc: async () => {
          throw new Error("network");
        },
      } as never,
    };
    await expect(readFeeAfterSale(throwing, "sale-7")).resolves.toBeUndefined();
    await expect(readFeeAfterSale({ ...deps, admin: null }, "sale-7")).resolves.toBeUndefined();
  });

  it("readShopifyFee: Shopify off fails as shopify_not_configured without a database call", async () => {
    const { deps, calls } = depsWith([], {});
    expect(
      await readShopifyFee(
        { ...deps, admin: null },
        { saleId: "s", orderId: ORDER, testOrder: false },
      ),
    ).toEqual({ kind: "failed", code: "shopify_not_configured" });
    expect(calls).toEqual([]);
  });
});
