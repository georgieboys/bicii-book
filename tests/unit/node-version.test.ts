// @vitest-environment node
// One Node major everywhere: CI reads .nvmrc, Vercel reads package.json
// engines (an open range lets it pick a newer major than CI tests).
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("Node version pin", () => {
  it("package.json engines.node is the exact major in .nvmrc", () => {
    const nvmrc = read(".nvmrc").trim();
    expect(nvmrc).toMatch(/^\d+$/);
    const engines = (JSON.parse(read("package.json")) as { engines?: { node?: string } }).engines;
    expect(engines?.node).toBe(`${nvmrc}.x`);
  });
});
