import { z } from "zod";

/**
 * Environment configuration, validated with zod at the trust boundary
 * (ADR-001 A1). Parsed lazily on first use and memoised, so a missing
 * variable fails loudly where it is needed instead of at import time (which
 * would break `next build` for pages that never touch it).
 *
 * Every variable here is documented in `.env.example`. Never commit values.
 */

const url = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });
const nonEmpty = z.string().trim().min(1, { error: "must not be empty" });

/** Exposed to the browser: names must start with NEXT_PUBLIC_. */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  /**
   * An extra QR base the scanner accepts (scanBases, src/lib/qr.ts). Not
   * the printed or displayed base: that is shop_settings.public_site_url
   * (PLAN D9, ADR-017).
   */
  NEXT_PUBLIC_PUBLIC_SITE_URL: url.transform((v) => v.replace(/\/+$/, "")),
});

/** Server only. Never import the result into a Client Component. */
export const serverEnvSchema = z
  .object({
    /**
     * Not used by the app (it never connects to Postgres directly). Listed so
     * a malformed value is reported; the scripts and tests read it from the
     * shell, not from .env.local (.env.example "Tooling").
     */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, { error: "must be a postgres:// connection string" })
      .optional(),
    /**
     * Service role (bypasses RLS): src/lib/admin/** and src/lib/integrations/**
     * only; never in a client bundle. Optional so tooling and the build run
     * without it, but every deployment needs it: every staff sign-in counts
     * its attempt with it first (PLAN D72), so without it, or with a wrong
     * one, nobody can sign in; inviting staff needs it too.
     */
    SUPABASE_SERVICE_ROLE_KEY: nonEmpty.optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    /**
     * Raises every sign-in limit of the Admin's own (PLAN D72) by this
     * factor. Tests only (Playwright sets 1000); 1 everywhere else.
     */
    SIGN_IN_LIMIT_MULTIPLIER: z.coerce
      .number({ error: "must be a whole number from 1 to 100000" })
      .int({ error: "must be a whole number from 1 to 100000" })
      .min(1, { error: "must be a whole number from 1 to 100000" })
      .max(100_000, { error: "must be a whole number from 1 to 100000" })
      .default(1),
    /** Phase 10 (RUNBOOK "Shopify"): the shop's own myshopify.com domain. */
    SHOPIFY_SHOP_DOMAIN: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, {
        error: "must be the shop's <name>.myshopify.com domain, lower case",
      })
      .optional(),
    /** The custom app's Admin API access token (live adapter). Secret. */
    SHOPIFY_ADMIN_TOKEN: nonEmpty.optional(),
    /** The webhook signing secret (HMAC on /api/shopify/webhooks). Secret. */
    SHOPIFY_WEBHOOK_SECRET: nonEmpty.optional(),
    /**
     * 'fake' = the in-memory Shopify (local development and E2E only; never
     * production); 'live' or unset = the GraphQL adapter when the domain and
     * token are set, else Shopify is off.
     */
    SHOPIFY_ADAPTER: z.enum(["live", "fake"]).optional(),
    /**
     * 'true' only when a Preview deployment's SHOPIFY_* variables belong to a
     * separate Shopify development store (RUNBOOK "Vercel environment setup").
     * Without it the live adapter is off in Preview (VERCEL_ENV=preview), so
     * a preview build on the staging database can never push into the live
     * store (its handles bicii-<short id> collide with production's).
     */
    SHOPIFY_ALLOW_PREVIEW: z.enum(["true"]).optional(),
    /** Bearer secret of /api/cron/integrations (the Vercel cron sends it). Secret. */
    CRON_SECRET: nonEmpty.optional(),
    /**
     * Phase 13 step 3 (D144): Resend API key for quote emails the Admin sends
     * itself. With EMAIL_FROM; without both, quotes go by WhatsApp or a
     * copied link only. Secret.
     */
    RESEND_API_KEY: nonEmpty.optional(),
    /** The quote emails' sender, "BICII <workshop@example.com>", on a domain Resend has verified. */
    EMAIL_FROM: z
      .string()
      .trim()
      .regex(/^(?:[^<>@]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/, {
        error: 'must be an address, or a name and an address like "BICII <workshop@example.com>"',
      })
      .optional(),
    /**
     * Phase 14 (RUNBOOK "Stripe payments"): a secret or restricted key,
     * sk_/rk_, test or live. Secret. Its shape and mode are checked by
     * stripeConfig (src/lib/integrations/stripe/client.ts), never here: a
     * wrong one turns Stripe off with a reason and never stops the app (D157c).
     */
    STRIPE_SECRET_KEY: nonEmpty.optional(),
    /** The webhook endpoint's signing secret (whsec_…), checked on /api/stripe/webhooks. Secret. */
    STRIPE_WEBHOOK_SECRET: nonEmpty.optional(),
    /**
     * 'fake' = the in-memory Stripe (local development, CI, E2E; never
     * production). Unset = the key decides.
     */
    STRIPE_ADAPTER: z.enum(["fake"]).optional(),
    /**
     * The Admin's own origin, e.g. https://admin.example.com (no path):
     * where Stripe sends customers back (D157b). Not secret. Never derived
     * from the request's Host.
     */
    ADMIN_ORIGIN: nonEmpty.optional(),
    /**
     * 'true' where Supabase Storage resizes images (the hosted project, on
     * the Pro plan): photo grids then load a 480 px rendition instead of
     * the 2048 px original. Unset locally and in E2E: the devstack's
     * Storage has image transformation off, so grids keep the original.
     */
    STORAGE_IMAGE_TRANSFORMS: z.enum(["true"]).optional(),
    /** Set by Vercel (production | preview | development); read to refuse the fakes in production and by stripeConfig. */
    VERCEL_ENV: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SHOPIFY_ADAPTER === "fake" && env.SHOPIFY_ADMIN_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["SHOPIFY_ADAPTER"],
        message: "fake cannot be combined with SHOPIFY_ADMIN_TOKEN; unset one of them",
      });
    }
    if (env.SHOPIFY_ADAPTER === "fake" && env.VERCEL_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["SHOPIFY_ADAPTER"],
        message: "the fake Shopify must never run in production",
      });
    }
    // Stripe (D157): only the dangerous combinations are errors. A malformed
    // or wrong-mode key, webhook secret or ADMIN_ORIGIN turns Stripe off with
    // a reason instead (stripeConfig), so a payments typo never breaks
    // getServerEnv() and, with it, staff sign-in (D72).
    if (env.STRIPE_ADAPTER === "fake" && env.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_ADAPTER"],
        message: "fake cannot be combined with STRIPE_SECRET_KEY; unset one of them",
      });
    }
    if (env.STRIPE_ADAPTER === "fake" && env.VERCEL_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_ADAPTER"],
        message: "the fake Stripe must never run in production",
      });
    }
    if (env.SHOPIFY_ADAPTER === "live") {
      for (const key of ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_TOKEN"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "is required when SHOPIFY_ADAPTER=live",
          });
        }
      }
    }
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

type Source = Record<string, string | undefined>;

export class EnvError extends Error {
  constructor(scope: "public" | "server", issues: z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    super(
      `Invalid ${scope} environment configuration:\n${lines.join("\n")}\n` +
        "Set these in .env.local (see .env.example for every variable).",
    );
    this.name = "EnvError";
  }
}

function blankToUndefined(source: Source): Source {
  return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]));
}

export function parsePublicEnv(source: Source): PublicEnv {
  const result = publicEnvSchema.safeParse(blankToUndefined(source));
  if (!result.success) throw new EnvError("public", result.error.issues);
  return result.data;
}

export function parseServerEnv(source: Source): ServerEnv {
  const result = serverEnvSchema.safeParse(blankToUndefined(source));
  if (!result.success) throw new EnvError("server", result.error.issues);
  return result.data;
}

let publicEnv: PublicEnv | undefined;
let serverEnv: ServerEnv | undefined;

/**
 * Public env. Each variable is referenced by its literal name so Next.js
 * inlines it into client bundles at build time; `process.env[name]` would not.
 */
export function getPublicEnv(): PublicEnv {
  publicEnv ??= parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_PUBLIC_SITE_URL,
  });
  return publicEnv;
}

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() was called in the browser; server env is server-only.");
  }
  serverEnv ??= parseServerEnv(process.env);
  return serverEnv;
}

/** Test hook: forget memoised values so a test can change process.env. */
export function resetEnvCache(): void {
  publicEnv = undefined;
  serverEnv = undefined;
}
