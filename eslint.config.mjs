import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The service-role Supabase client bypasses RLS (ADR-001 A5). Only the
  // Auth-admin wrappers and integration workers may import it.
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs}"],
    ignores: ["src/lib/admin/**", "src/lib/integrations/**", "src/lib/supabase/service.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase/service", "**/supabase/service", "**/supabase/service.ts"],
              message:
                "The service-role client bypasses RLS. Import it only in src/lib/admin/** or src/lib/integrations/**.",
            },
          ],
        },
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
