/**
 * Links from screens to the runbook (src/lib/docs-links.ts): the
 * repository's current address, never the one it moved from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY_URL, runbookHref } from "@/lib/docs-links";

describe("runbookHref", () => {
  it("points at docs/RUNBOOK.md on main in georgieboys/bicii-book", () => {
    expect(REPOSITORY_URL).toBe("https://github.com/georgieboys/bicii-book");
    expect(runbookHref("stripe-payments")).toBe(
      "https://github.com/georgieboys/bicii-book/blob/main/docs/RUNBOOK.md#stripe-payments",
    );
  });

  it("links only to headings the runbook has", () => {
    const runbook = readFileSync(join(process.cwd(), "docs/RUNBOOK.md"), "utf8");
    const anchors = new Set(
      [...runbook.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s/g, "-"),
      ),
    );
    for (const anchor of ["stripe-payments", "shopify"]) expect(anchors, anchor).toContain(anchor);
  });
});
