// @vitest-environment node
/**
 * The Stripe webhook route module (ADR-025): Node runtime, a literal 30 s
 * budget (store and apply run before the answer, no after()), and nothing
 * exported but POST and its segment config.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("src/app/api/stripe/webhooks/route.ts", () => {
  it("runs on Node with a 30 s budget and exports only POST", async () => {
    vi.doMock("@/lib/integrations/stripe/webhooks", () => ({
      handleStripeWebhook: async () => new Response("stripe"),
    }));
    const route = await import("@/app/api/stripe/webhooks/route");
    expect(Object.keys(route).sort()).toEqual(["POST", "maxDuration", "runtime"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(30);
    const res = await route.POST(
      new Request("http://localhost/api/stripe/webhooks", { method: "POST" }),
    );
    expect(await res.text()).toBe("stripe");
  });
});
