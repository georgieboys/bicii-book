/**
 * callAction (src/lib/call-action.ts; audit U1-1): a Server Action that
 * never answered becomes an ordinary refusal the sheet can show, with the
 * form's typed values; Next's own redirect and notFound still propagate.
 */
import { describe, expect, it } from "vitest";

import { callAction, UNREACHABLE } from "@/lib/call-action";

describe("callAction", () => {
  it("passes an answer through untouched", async () => {
    await expect(callAction(async () => ({ ok: true as const, data: 1 }))).resolves.toEqual({
      ok: true,
      data: 1,
    });
  });

  it("turns a failed request into a refusal, keeping the form's values but no secrets", async () => {
    const form = new FormData();
    form.set("note", "Brake bleed");
    form.set("pin", "1234");
    const result = await callAction(async () => {
      throw new TypeError("Failed to fetch");
    }, form);
    expect(result).toEqual({ ok: false, error: UNREACHABLE, values: { note: "Brake bleed" } });
  });

  it("lets Next's control flow through", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/;307;",
    });
    await expect(
      callAction(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
  });
});
