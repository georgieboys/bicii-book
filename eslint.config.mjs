import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVICE_ROLE_ALLOWED = [
  "src/lib/admin/**",
  "src/lib/integrations/**",
  "src/lib/supabase/service.ts",
];
const SERVICE_MESSAGE =
  "The service-role client bypasses RLS. Import it only in src/lib/admin/** or src/lib/integrations/**.";
const SERVICE_IMPORT_PATTERN = {
  group: ["@/lib/supabase/service", "**/supabase/service", "**/supabase/service.ts"],
  message: SERVICE_MESSAGE,
};
// An esquery regex cannot contain "/", so "." stands for it.
const SERVICE_DYNAMIC_IMPORT = {
  selector: "ImportExpression[source.value=/supabase.service/]",
  message: SERVICE_MESSAGE,
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The service-role Supabase client bypasses RLS (ADR-001 A5). Only the
  // Auth-admin wrappers and integration workers may reach it: not by a
  // static import, a dynamic import(), a sibling "./service" import, or by
  // reading SUPABASE_SERVICE_ROLE_KEY to build a client of their own
  // (tests/unit/eslint-service-role.test.ts).
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs}"],
    ignores: SERVICE_ROLE_ALLOWED,
    rules: {
      "no-restricted-imports": ["error", { patterns: [SERVICE_IMPORT_PATTERN] }],
      "no-restricted-syntax": ["error", SERVICE_DYNAMIC_IMPORT],
    },
  },
  {
    files: ["src/lib/supabase/**"],
    ignores: ["src/lib/supabase/service.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            SERVICE_IMPORT_PATTERN,
            { ...SERVICE_IMPORT_PATTERN, group: ["./service", "./service.ts"] },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...SERVICE_ROLE_ALLOWED, "src/lib/env.ts"],
    rules: {
      // Replaces the first block's no-restricted-syntax for src/, so it
      // repeats the dynamic import entry.
      "no-restricted-syntax": [
        "error",
        SERVICE_DYNAMIC_IMPORT,
        ...[
          "MemberExpression[property.name='SUPABASE_SERVICE_ROLE_KEY']",
          "MemberExpression[property.value='SUPABASE_SERVICE_ROLE_KEY']",
          "ObjectPattern > Property[key.name='SUPABASE_SERVICE_ROLE_KEY']",
        ].map((selector) => ({
          selector,
          message:
            "SUPABASE_SERVICE_ROLE_KEY bypasses RLS. Read it only in src/lib/supabase/service.ts, src/lib/admin/** or src/lib/integrations/**.",
        })),
      ],
    },
  },
  // Record ids are any UUID Postgres accepts (src/lib/uuid.ts UUID_RE).
  // z.uuid() also demands an RFC 4122 version and variant, so it refuses
  // ids made in SQL (D162's production run made 23 such consignment items,
  // whose forms then failed with no field to fix).
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "z",
          property: "uuid",
          message:
            "Use z.guid(): record ids are any UUID Postgres accepts; z.uuid() refuses ids made in SQL.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated test output
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
