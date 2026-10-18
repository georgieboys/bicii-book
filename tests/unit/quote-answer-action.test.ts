// @vitest-environment node
/**
 * answerQuoteAction's refusal (src/app/(customer)/quote/[token]/actions.ts;
 * audit 2026-10-18): a mapped business reason comes back as `code`; an
 * unmapped P0001, whose text is the raw database message, never does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/quote-throttle", () => ({ noteQuoteAttempt: async () => "ok" }));
vi.mock("@/lib/integrations/stripe/checkout", () => ({}));
vi.mock("@/lib/integrations/stripe/deps", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getCorrelationId: async () => "test" }));
vi.mock("@/lib/logger", () => ({ child: () => ({ error: () => {} }) }));
const rpc = vi.fn();
vi.mock("@/lib/supabase/anon", () => ({ createAnonClient: () => ({ rpc }) }));

const { answerQuoteAction } = await import("@/app/(customer)/quote/[token]/actions");

const input = {
  token: "A".repeat(43),
  decisions: [{ itemId: "00000000-0000-4000-8000-000000000001", approve: true }],
  name: "Chloe",
};

beforeEach(() => rpc.mockReset());

describe("answerQuoteAction refusals", () => {
  it("returns a mapped business reason as code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "quote_name_required" } });
    const result = await answerQuoteAction(input);
    expect(result).toMatchObject({ ok: false, code: "quote_name_required" });
  });

  it("never returns an unmapped P0001's database text", async () => {
    const message = "internal detail from a trigger";
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });
    const result = await answerQuoteAction(input);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("code", message);
    expect(JSON.stringify(result)).not.toContain(message);
  });
});
