import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISPOSITION_LABELS,
  EXCEPTION_SECTIONS,
  ISSUE_CODES,
  ISSUE_SENTENCES,
  STOCK_ISSUE_CODES,
  UNIT_ISSUE_CODES,
  alertDaysLabel,
  dispositionLabel,
  exceptionTotal,
  exceptionsCappedNote,
  groupExceptions,
  isIssueCode,
  issueSentence,
  parseReconciliationParams,
  reconciliationExportParams,
  reconciliationHref,
  splitIssues,
  unitStatusLabel,
} from "@/lib/reconciliation";

/**
 * Stock reconciliation and exceptions in words (Phase 9 step 4; PLAN
 * D106–D108). The issue codes are decided in the database; these tests
 * read the step 3 migrations so the app's mirror of the codes can never
 * drift from what the views emit.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const read = (name: string) => readFileSync(path.join(MIGRATIONS, name), "utf8");

/** The codes of each `case … end::text as issue` expression in a migration, in order. */
function issueCases(sql: string): string[][] {
  const out: string[][] = [];
  const end = /end::text as issue\b/g;
  for (let m = end.exec(sql); m; m = end.exec(sql)) {
    const before = sql.slice(0, m.index);
    const starts = [...before.matchAll(/(?:select )?case\s*\n\s*when\b/g)];
    const start = starts.at(-1)!.index!;
    const span = before.slice(start);
    out.push([...span.matchAll(/then\s+'([a-z_]+)'/g)].map((x) => x[1]));
  }
  return out;
}

describe("issue codes mirror the step 3 views (D106, D107)", () => {
  it("UNIT_ISSUE_CODES and STOCK_ISSUE_CODES are exactly what the reconciliation views emit, in order", () => {
    const cases = issueCases(read("20261006001200_stock_reconciliation.sql"));
    expect(cases).toEqual([[...UNIT_ISSUE_CODES], [...STOCK_ISSUE_CODES]]);
  });

  it("the exceptions view raises unsettled_consignment as its own issue", () => {
    const sql = read("20261006001300_operational_exceptions.sql");
    expect(sql).toContain("'unsettled_consignment'::text");
    expect(ISSUE_CODES).toContain("unsettled_consignment");
  });

  it("every code has a sentence, and nothing else does", () => {
    expect(Object.keys(ISSUE_SENTENCES).sort()).toEqual([...ISSUE_CODES].sort());
    for (const code of ISSUE_CODES) {
      expect(ISSUE_SENTENCES[code], code).toMatch(/^[A-Z].+\.$/);
      expect(issueSentence(code), code).toBeTruthy();
    }
    expect(new Set(ISSUE_CODES).size).toBe(ISSUE_CODES.length);
  });

  it("words the issues as the brief says", () => {
    expect(issueSentence("location_mismatch")).toBe(
      "The item's location does not match where the ledger last moved it.",
    );
    expect(issueSentence("negative_on_hand")).toBe("The ledger shows fewer than zero on hand.");
    expect(issueSentence("unsettled_consignment", 45)).toBe(
      "Sold 45 days ago and not fully paid to the consignor.",
    );
    expect(issueSentence("unsettled_consignment", 1)).toBe(
      "Sold 1 day ago and not fully paid to the consignor.",
    );
  });

  it("returns null for a code this build does not know, so the database's detail shows instead", () => {
    expect(issueSentence("some_later_issue")).toBeNull();
    expect(issueSentence(null)).toBeNull();
    expect(isIssueCode("toString")).toBe(false);
    expect(isIssueCode("sold_without_sale")).toBe(true);
  });
});

describe("dispositions and statuses", () => {
  it("names every disposition the unit view derives", () => {
    const sql = read("20261006001200_stock_reconciliation.sql");
    const derived = [...sql.matchAll(/then '([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((c) => !(ISSUE_CODES as readonly string[]).includes(c));
    for (const d of new Set([...derived, "none"])) {
      expect(DISPOSITION_LABELS[d], d).toBeTruthy();
    }
  });

  it("adds the S- or J- reference when there is one; an unknown disposition reads as it is", () => {
    expect(dispositionLabel("sold_by_sale", "S-000012")).toBe("Sold · S-000012");
    expect(dispositionLabel("in_stock", null)).toBe("In stock");
    expect(dispositionLabel("mystery", null)).toBe("mystery");
    expect(unitStatusLabel("held_for_customer")).toBe("On a job");
    expect(unitStatusLabel("unknown_status")).toBe("unknown_status");
  });

  it("splits rows with an issue from the rest, keeping their order", () => {
    const rows = [{ issue: "a" }, { issue: null }, { issue: "b" }];
    expect(splitIssues(rows)).toEqual({
      issues: [{ issue: "a" }, { issue: "b" }],
      clear: [{ issue: null }],
    });
  });
});

describe("the reconciliation URL", () => {
  const product = "c2000000-0000-4000-8000-000000000001";

  it("defaults to problems only for every product", () => {
    expect(parseReconciliationParams({})).toEqual({ all: false, productId: null });
    expect(reconciliationHref()).toBe("/reports/reconciliation");
  });

  it("keeps all=1 and a valid product; ignores anything else", () => {
    expect(parseReconciliationParams({ all: "1", product })).toEqual({
      all: true,
      productId: product,
    });
    expect(parseReconciliationParams({ all: "yes", product: "P-000001" })).toEqual({
      all: false,
      productId: null,
    });
    expect(parseReconciliationParams({ all: ["1", "0"], product: [product] }).all).toBe(true);
    expect(reconciliationHref({ all: true, productId: product })).toBe(
      `/reports/reconciliation?all=1&product=${product}`,
    );
    expect(reconciliationExportParams({ all: false, productId: product })).toEqual({ product });
    expect(reconciliationExportParams({ all: true, productId: null })).toEqual({ all: "1" });
  });
});

describe("the exceptions page", () => {
  const row = (kind: string) => ({ kind });

  it("groups by section in the page's order, drops empty sections and keeps unknown kinds last", () => {
    const groups = groupExceptions([
      row("overdue_job"),
      row("unsettled_consignment"),
      row("purchase_overdue"),
      row("negative_stock"),
      row("negative_stock"),
    ]);
    expect(groups.map((g) => [g.title, g.rows.length])).toEqual([
      ["Stock below zero", 2],
      ["Unsettled consignments", 1],
      ["Overdue jobs", 1],
      ["Other", 1],
    ]);
  });

  it("orders the sections as the brief lists them, every Phase 5, 9, 10 and 14 kind in one", () => {
    // Phase 14's customer payments sit with the other integration (D159b).
    expect(EXCEPTION_SECTIONS.slice(0, 6).map((s) => s.title)).toEqual([
      "Stock below zero",
      "Items in an impossible state",
      "Shopify needs attention",
      "Customer payments",
      "Lines in another currency",
      "Unsettled consignments",
    ]);
    const kinds = EXCEPTION_SECTIONS.flatMap((s) => [...s.kinds]).sort();
    expect(kinds).toEqual(
      [
        "overdue_job",
        "uncollected_job",
        "negative_stock",
        "unit_hold_stale",
        "currency_mismatch",
        "unit_state_mismatch",
        "unsettled_consignment",
        "integration_failed",
        "payment_attention",
        "stripe_attention",
      ].sort(),
    );
  });

  it("counts and says when the list holds fewer than the counts", () => {
    expect(exceptionTotal([{ count: 3 }, { count: 0 }, { count: 4 }])).toBe(7);
    expect(exceptionTotal([])).toBe(0);
    expect(exceptionsCappedNote(200, 200)).toBeNull();
    expect(exceptionsCappedNote(200, 245)).toMatch(/^Showing the 200 most urgent of 245\./);
  });

  it("words the threshold", () => {
    expect(alertDaysLabel(30)).toBe("Alert unsettled consignments after 30 days");
    expect(alertDaysLabel(1)).toBe("Alert unsettled consignments after 1 day");
  });
});
