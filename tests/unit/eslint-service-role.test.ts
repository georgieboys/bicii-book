// @vitest-environment node
// eslint.config.mjs confines the service-role client (it bypasses RLS) to
// src/lib/admin/** and src/lib/integrations/**. These snippets are the ways
// round a static-import rule; each must be one lint error, and the allowed
// places must stay clean.
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd: root });

/** The ids of the confinement rules' errors for `code` linted as `file`. */
async function confinementErrors(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
    .map((m) => m.ruleId!);
}

describe("service-role confinement (eslint.config.mjs)", () => {
  it("refuses a static import outside the allowed places", async () => {
    expect(
      await confinementErrors(
        'import { createServiceClient } from "@/lib/supabase/service";\nexport const c = createServiceClient;\n',
        "src/lib/domain/x.ts",
      ),
    ).toEqual(["no-restricted-imports"]);
  });

  it("refuses a dynamic import()", async () => {
    expect(
      await confinementErrors(
        'export async function f() {\n  const { createServiceClient } = await import("@/lib/supabase/service");\n  return createServiceClient;\n}\n',
        "src/lib/domain/x.ts",
      ),
    ).toEqual(["no-restricted-syntax"]);
  });

  it('refuses a sibling "./service" import from src/lib/supabase/', async () => {
    expect(
      await confinementErrors(
        'import { createServiceClient } from "./service";\nexport const c = createServiceClient;\n',
        "src/lib/supabase/x.ts",
      ),
    ).toEqual(["no-restricted-imports"]);
  });

  it("refuses reading SUPABASE_SERVICE_ROLE_KEY, by property or by destructuring", async () => {
    expect(
      await confinementErrors(
        'import { getServerEnv } from "@/lib/env";\nexport const k = getServerEnv().SUPABASE_SERVICE_ROLE_KEY;\n',
        "src/lib/domain/x.ts",
      ),
    ).toEqual(["no-restricted-syntax"]);
    expect(
      await confinementErrors(
        'import { getServerEnv } from "@/lib/env";\nconst { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();\nexport const k = SUPABASE_SERVICE_ROLE_KEY;\n',
        "src/app/x.ts",
      ),
    ).toEqual(["no-restricted-syntax"]);
  });

  it("allows all of it in src/lib/admin/** and src/lib/integrations/**", async () => {
    const code =
      'import { getServerEnv } from "@/lib/env";\nimport { createServiceClient } from "@/lib/supabase/service";\nconst { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();\nexport async function f() {\n  await import("@/lib/supabase/service");\n  return [createServiceClient, SUPABASE_SERVICE_ROLE_KEY];\n}\n';
    expect(await confinementErrors(code, "src/lib/admin/x.ts")).toEqual([]);
    expect(await confinementErrors(code, "src/lib/integrations/x.ts")).toEqual([]);
  });
});
