// @vitest-environment node
// The devstack and test harness refuse any database not on this machine
// (scripts/devstack/config.mjs assertLocalDatabase): db:reset, db:migrate,
// the DB tests and Playwright drop, rebuild or write the database they are
// pointed at, and they read only the shell environment.
import { describe, expect, it } from "vitest";

import { assertLocalDatabase } from "../../scripts/devstack/config.mjs";

const OVERRIDE = { BICII_ALLOW_REMOTE_DB: "1" };

describe("assertLocalDatabase", () => {
  it.each([
    "postgres://postgres:postgres@127.0.0.1:5432/bicii_dev",
    "postgres://postgres:postgres@localhost:5432/postgres",
    "postgres://postgres:postgres@[::1]:5432/bicii_dev",
    "postgres:///bicii_dev?host=/var/run/postgresql",
  ])("allows %s", (url) => {
    expect(() => assertLocalDatabase(url, {})).not.toThrow();
  });

  it("refuses another host unless BICII_ALLOW_REMOTE_DB=1, and redacts the password", () => {
    const url = "postgres://u:secret-pw@db.example.invalid:5432/db";
    expect(() => assertLocalDatabase(url, {})).toThrow(/not a local database/);
    expect(() => assertLocalDatabase(url, {})).toThrow(/u:\*\*\*@db\.example\.invalid/);
    expect(() => assertLocalDatabase(url, {})).not.toThrow(/secret-pw/);
    expect(() => assertLocalDatabase(url, OVERRIDE)).not.toThrow();
  });

  it("refuses a ?host= that points elsewhere even when the authority is loopback", () => {
    expect(() =>
      assertLocalDatabase("postgres://u:p@127.0.0.1:5432/db?host=db.example.invalid", {}),
    ).toThrow(/not a local database/);
  });

  it.each([
    "postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
    "postgres://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres",
    "postgres://u:p@DB.ABCDEFGHIJKLMNOP.SUPABASE.CO:6543/postgres",
  ])("always refuses a hosted Supabase address, override or not: %s", (url) => {
    expect(() => assertLocalDatabase(url, {})).toThrow(/hosted Supabase/);
    expect(() => assertLocalDatabase(url, OVERRIDE)).toThrow(/hosted Supabase/);
  });
});
