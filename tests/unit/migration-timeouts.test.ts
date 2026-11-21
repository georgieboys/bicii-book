// @vitest-environment node
// Every new migration fails fast instead of queueing behind a lock during
// shop hours: its first two statements are `set local lock_timeout` and
// `set local statement_timeout` (docs/ENGINEERING.md, Migrations). Files up
// to 20261122001100_audit_public_bucket.sql were applied before the rule and are
// never edited.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const dir = path.resolve(__dirname, "../../supabase/migrations");
const LAST_BEFORE_RULE = "20261122001100_audit_public_bucket.sql";
const LOCK = /^set local lock_timeout = '\d+m?s'$/;
const STATEMENT = /^set local statement_timeout = '\d+m?s'$/;

/** The file's first two statements, comments removed, whitespace folded, lower case. */
function leadingStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((s) => s !== "")
    .slice(0, 2);
}

function hasHeader(sql: string): boolean {
  const [first = "", second = ""] = leadingStatements(sql);
  return LOCK.test(first) && STATEMENT.test(second);
}

describe("migration timeouts", () => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const newer = files.filter((f) => f > LAST_BEFORE_RULE);

  it("the cut-off is a migration file name (the rule applies to files sorting after it)", () => {
    expect(LAST_BEFORE_RULE).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("every migration after the cut-off starts with set local lock_timeout and statement_timeout", () => {
    const missing = newer.filter((f) => !hasHeader(readFileSync(path.join(dir, f), "utf8")));
    expect(missing).toEqual([]);
  });

  it("the check accepts the header after comments and refuses a file without it", () => {
    expect(
      hasHeader(
        "-- why\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';\ncreate table t ();",
      ),
    ).toBe(true);
    expect(hasHeader("create table t ();")).toBe(false);
    expect(hasHeader("set local lock_timeout = '5s';\ncreate table t ();")).toBe(false);
  });
});
