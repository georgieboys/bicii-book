// @vitest-environment node
/**
 * Labels printed on 2026-10-28 with the Admin's old alias as the QR base
 * (R-013): scanned, they go to the public site's item page rather than the
 * staff sign-in. Run through Next's own custom-route matcher.
 */
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

async function responseFor(url: string) {
  return unstable_getResponseFromNextConfig({ url, nextConfig });
}

describe("the old alias's label URLs", () => {
  it("go to the public site's item page, permanently", async () => {
    const response = await responseFor("https://bicii-book.vercel.app/q/P-000123");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://bicii.sg/q/P-000123");
  });

  it("only /q, and only on that host", async () => {
    for (const url of [
      "https://bicii-book.vercel.app/login",
      "https://admin.example.com/q/P-000123",
    ]) {
      const response = await responseFor(url);
      expect(response.status, url).not.toBe(308);
      expect(response.headers.get("location"), url).toBeNull();
    }
  });
});
