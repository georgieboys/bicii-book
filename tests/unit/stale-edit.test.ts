// @vitest-environment node
/**
 * Edit sheets refuse a stale save (audit A-11). updateProduct, updateUnit
 * and updateCustomer write every field the sheet shows, so each update is
 * filtered on the updated_at the sheet opened with: when no row comes back
 * but the row still exists, it changed since the sheet opened and the save
 * is refused (STALE_EDIT) instead of reverting the newer values; when the
 * row is gone, the not-found message stays. The schemas require the hidden
 * expectedUpdatedAt.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const refresh = vi.fn();
vi.mock("next/cache", () => ({ refresh: () => refresh() }));

const { updateProduct, updateUnit } = await import("@/lib/domain/inventory");
const { updateCustomer } = await import("@/lib/domain/customers");
const { DomainError, STALE_EDIT, STALE_EDIT_CODE, isStaleEdit, staleEdit } =
  await import("@/lib/domain/errors");
const { refreshWhenStale } = await import("@/lib/stale-edit");
const { isStaleRefusal } = await import("@/lib/stale-edit-toast");
const { updateProductSchema, updateUnitSchema } = await import("@/lib/inventory-forms");
import type { ServerSupabase } from "@/lib/supabase/server";

const ID = "d0000000-0000-4000-8000-000000000144";
const OPENED = "2026-11-22T02:00:00.123456+00:00";

type Result = { data: unknown; error: { code: string; message: string } | null };

/**
 * A client whose update resolves to `updated` and whose follow-up read
 * resolves to `existing`, recording every call per query.
 */
function supabaseWith(table: string, updated: Result, existing: Result) {
  const queries: { kind: "update" | "select"; calls: unknown[][] }[] = [];
  const client = {
    from(name: string) {
      if (name !== table) throw new Error(`unexpected table ${name}`);
      const calls: unknown[][] = [];
      let kind: "update" | "select" = "select";
      const builder: Record<string, unknown> = {};
      for (const m of ["update", "select", "eq", "maybeSingle"]) {
        builder[m] = (...args: unknown[]) => {
          if (m === "update") kind = "update";
          calls.push([m, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => unknown) => {
        queries.push({ kind, calls });
        return resolve(kind === "update" ? updated : existing);
      };
      return builder;
    },
  };
  return { supabase: client as unknown as ServerSupabase, queries };
}

const PRODUCT = {
  name: "Marin frame",
  sku: null,
  brand: "Marin",
  categoryId: null,
  description: null,
  salePrice: "470.00",
  cost: null,
  reorderPoint: null,
  active: true,
  frameGrade: null,
};
const UNIT = {
  serialNumber: "WTU123",
  condition: null,
  salePrice: null,
  cost: null,
  internalNotes: null,
};
const CUSTOMER = {
  firstName: "Ana",
  lastName: null,
  displayName: null,
  email: null,
  phone: null,
  internalNotes: null,
};

const cases = [
  {
    name: "updateProduct",
    table: "products",
    notFound: "That product no longer exists. Refresh and try again.",
    run: (s: ServerSupabase) => updateProduct(s, ID, PRODUCT, OPENED),
  },
  {
    name: "updateUnit",
    table: "inventory_units",
    notFound: "That unit no longer exists. Refresh and try again.",
    run: (s: ServerSupabase) => updateUnit(s, ID, UNIT, OPENED),
  },
  {
    name: "updateCustomer",
    table: "customers",
    notFound: "That customer no longer exists. Refresh and try again.",
    run: (s: ServerSupabase) => updateCustomer(s, ID, CUSTOMER, OPENED),
  },
];

describe.each(cases)("$name (audit A-11)", ({ table, notFound, run }) => {
  it("updates only the row still at the updated_at the sheet opened with", async () => {
    const { supabase, queries } = supabaseWith(
      table,
      { data: { id: ID }, error: null },
      { data: null, error: null },
    );
    await expect(run(supabase)).resolves.toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(queries[0].kind).toBe("update");
    expect(queries[0].calls).toContainEqual(["eq", "id", ID]);
    expect(queries[0].calls).toContainEqual(["eq", "updated_at", OPENED]);
  });

  it("refuses a stale sheet when the row changed since it opened", async () => {
    const { supabase, queries } = supabaseWith(
      table,
      { data: null, error: null },
      { data: { id: ID }, error: null },
    );
    const err = await run(supabase).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toBe(STALE_EDIT);
    expect((err as InstanceType<typeof DomainError>).code).toBe(STALE_EDIT_CODE);
    expect(isStaleEdit(err)).toBe(true);
    // The old text ("Close the sheet and open it again") could not work.
    expect(STALE_EDIT).not.toMatch(/close the sheet/i);
    expect(queries[1]).toEqual({
      kind: "select",
      calls: [["select", "id"], ["eq", "id", ID], ["maybeSingle"]],
    });
  });

  it("still says not found when the row is gone", async () => {
    const { supabase } = supabaseWith(
      table,
      { data: null, error: null },
      { data: null, error: null },
    );
    await expect(run(supabase)).rejects.toThrow(notFound);
  });
});

describe("edit schemas carry the sheet's updated_at", () => {
  it("require expectedUpdatedAt and pass it through unchanged", () => {
    const product = { id: ID, name: "Marin frame", salePrice: "470" };
    expect(updateProductSchema.safeParse(product).success).toBe(false);
    expect(
      updateProductSchema.parse({ ...product, expectedUpdatedAt: OPENED }).expectedUpdatedAt,
    ).toBe(OPENED);
    expect(updateUnitSchema.safeParse({ id: ID }).success).toBe(false);
    expect(updateUnitSchema.parse({ id: ID, expectedUpdatedAt: OPENED }).expectedUpdatedAt).toBe(
      OPENED,
    );
    expect(updateUnitSchema.safeParse({ id: ID, expectedUpdatedAt: "" }).success).toBe(false);
  });
});

describe("a stale refusal re-reads the page", () => {
  it("refreshes before the refusal goes back, and only for a stale refusal", async () => {
    refresh.mockReset();
    await expect(refreshWhenStale(async () => "saved")).resolves.toBe("saved");
    expect(refresh).not.toHaveBeenCalled();

    const other = new DomainError("That product no longer exists.");
    await expect(refreshWhenStale(() => Promise.reject(other))).rejects.toBe(other);
    expect(refresh).not.toHaveBeenCalled();

    const stale = staleEdit();
    await expect(refreshWhenStale(() => Promise.reject(stale))).rejects.toBe(stale);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("is recognised by the sheets from its code, not its wording", () => {
    expect(isStaleRefusal({ ok: false, error: "anything", code: STALE_EDIT_CODE })).toBe(true);
    expect(isStaleRefusal({ ok: false, error: STALE_EDIT })).toBe(false);
    expect(isStaleRefusal({ ok: true, data: null })).toBe(false);
  });
});
