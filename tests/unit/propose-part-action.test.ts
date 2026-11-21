// @vitest-environment node
/**
 * proposePartAction with a new product (D140; audit A-87): createProduct
 * and propose_part are two writes, so when the proposal is refused the
 * product this call inserted is archived again and the refusal still
 * reaches the sheet. A product the call only replayed (products_pkey, a
 * lost response) is left as it is. staffAction is a stand-in that keeps
 * the schema; the domain functions are mocked (tests/db for their rules).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("server-only", () => ({}));

const refresh = vi.fn();
vi.mock("next/cache", () => ({ refresh: () => refresh() }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const staff = {
  staffId: "s1",
  role: "manager",
  active: true,
  permissions: ["manage_inventory", "view_costs"],
};
vi.mock("@/lib/actions", () => ({
  ActionError: class ActionError extends Error {},
  staffAction: (
    schema: z.ZodType,
    _opts: { name: string },
    handler: (input: unknown, ctx: unknown) => unknown,
  ) => {
    return async (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { ok: false, error: "Check the highlighted fields." };
      try {
        return {
          ok: true,
          data: await handler(parsed.data, { supabase: { client: "staff" }, staff, log }),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
  },
}));
vi.mock("@/lib/admin-origin", () => ({ linkOrigin: vi.fn() }));
vi.mock("@/lib/integrations/email/quote", () => ({
  quoteEmailEnabled: vi.fn(),
  sendQuoteEmail: vi.fn(),
}));
vi.mock("@/lib/domain/suppliers", () => ({ listSuppliers: vi.fn() }));

const proposePart = vi.fn();
vi.mock("@/lib/domain/indent", () => ({
  proposePart: (...a: unknown[]) => proposePart(...a),
}));
const createProduct = vi.fn();
const setProductArchived = vi.fn();
vi.mock("@/lib/domain/inventory", () => ({
  createProduct: (...a: unknown[]) => createProduct(...a),
  setProductArchived: (...a: unknown[]) => setProductArchived(...a),
}));

const { proposePartAction } = await import("@/app/(staff)/jobs/indent-actions");
const propose = proposePartAction as unknown as (input: unknown) => Promise<unknown>;

const REQUEST = "11111111-2222-4333-8444-000000000001";
const JOB = "11111111-2222-4333-8444-000000000002";
const PRODUCT = "11111111-2222-4333-8444-000000000003";
const NOT_OPEN = "This job is not open.";

const newPart = {
  requestId: REQUEST,
  workOrderId: JOB,
  productId: "",
  newProductId: PRODUCT,
  newName: "Brake pad",
  newPrice: "20.00",
  quantity: "1",
  unitSalePrice: "",
  expectedUnitCost: "",
  supplierId: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  createProduct.mockResolvedValue({ id: PRODUCT, created: true });
  setProductArchived.mockResolvedValue(undefined);
  proposePart.mockResolvedValue(REQUEST);
});

describe("proposePartAction with a new product (A-87)", () => {
  it("creates the product, proposes it and leaves it active", async () => {
    await expect(propose(newPart)).resolves.toEqual({ ok: true, data: { id: REQUEST } });
    expect(proposePart).toHaveBeenCalledWith(
      { client: "staff" },
      expect.objectContaining({ productId: PRODUCT }),
    );
    expect(setProductArchived).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("archives the product it created when the proposal is refused, and says why", async () => {
    proposePart.mockRejectedValue(new Error(NOT_OPEN));
    await expect(propose(newPart)).resolves.toEqual({ ok: false, error: NOT_OPEN });
    expect(setProductArchived).toHaveBeenCalledWith({ client: "staff" }, PRODUCT, true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("leaves a replayed product alone when the proposal is refused", async () => {
    createProduct.mockResolvedValue({ id: PRODUCT, created: false });
    proposePart.mockRejectedValue(new Error(NOT_OPEN));
    await expect(propose(newPart)).resolves.toEqual({ ok: false, error: NOT_OPEN });
    expect(setProductArchived).not.toHaveBeenCalled();
  });

  it("still reports the refusal when archiving fails, and logs it", async () => {
    proposePart.mockRejectedValue(new Error(NOT_OPEN));
    setProductArchived.mockRejectedValue(new Error("unavailable"));
    await expect(propose(newPart)).resolves.toEqual({ ok: false, error: NOT_OPEN });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ productId: PRODUCT }),
      "indent.propose_part: archive failed",
    );
  });

  it("never archives an existing product the proposal names", async () => {
    proposePart.mockRejectedValue(new Error(NOT_OPEN));
    await expect(
      propose({ ...newPart, productId: PRODUCT, newProductId: "", newName: "", newPrice: "" }),
    ).resolves.toEqual({ ok: false, error: NOT_OPEN });
    expect(createProduct).not.toHaveBeenCalled();
    expect(setProductArchived).not.toHaveBeenCalled();
  });
});
