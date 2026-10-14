import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { CopyText } from "@/components/domain/copy-text";
import { ShopifySettingsForm } from "@/components/domain/shopify/settings-form";
import { StatTile } from "@/components/domain/today/stat-tile";
import { Card } from "@/components/ui/card";
import { AlertIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { requireAdmin } from "@/lib/auth/session";
import { getShopifyOverview } from "@/lib/domain/shopify";
import { runbookHref } from "@/lib/docs-links";
import { getServerEnv } from "@/lib/env";
import { shopifyConnection } from "@/lib/integrations/shopify/client";
import { connectionLabel, connectionTone, TEST_ORDERS_WARNING } from "@/lib/shopify";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Shopify" };

/** The address Shopify posts webhooks to, from this request's host. */
async function webhookUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}/api/shopify/webhooks`;
}

/**
 * Shopify (admins only, a real 403 for anyone else: no loading.tsx under
 * /shopify, so the guard runs before anything streams; SPEC §17, §26;
 * PLAN D83, D84, D86, D89; RUNBOOK "Shopify").
 *
 *   - Connection: Live / Test (fake) / Not connected, the shop domain, the
 *     pinned API version and the webhook address to give Shopify; whether
 *     the webhook secret is set (never its value).
 *   - Settings: online location, storefront address, test orders.
 *   - Tiles to the lists: Needs attention, Waiting retries, products online
 *     by sync status, events in the last 24 hours.
 *   - A warning while test orders are recorded as sales (D89).
 */
export default async function ShopifyPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [overview, url] = await Promise.all([getShopifyOverview(supabase), webhookUrl()]);
  const connection = shopifyConnection();
  const secretSet = Boolean(getServerEnv().SHOPIFY_WEBHOOK_SECRET);
  const { productsByStatus: byStatus } = overview;
  const online = byStatus.synced + byStatus.pending + byStatus.error;

  return (
    <>
      <PageHeader
        title="Shopify"
        description="Online sales come in from Shopify; BICII sends prices and stock out. Problems wait in the queue with what to do."
      />

      {overview.settings.acceptTestOrders ? (
        <div
          role="note"
          className="mb-6 flex items-start gap-3 rounded-2xl bg-waiting-soft p-4 text-waiting-deep"
        >
          <AlertIcon className="mt-0.5 size-5 shrink-0" />
          <p>
            <strong>Shopify test orders are recorded as sales.</strong> {TEST_ORDERS_WARNING} Switch
            it off below before the shop goes live.
          </p>
        </div>
      ) : null}

      <section
        aria-label="Shopify at a glance"
        className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <StatTile
          label="Needs attention"
          value={overview.needsAttention}
          tone={overview.needsAttention > 0 ? "danger" : "neutral"}
          href="/shopify/queue"
          hint="Orders and syncs a person must fix"
        />
        <StatTile
          label="Waiting retries"
          value={overview.waiting}
          tone={overview.waiting > 0 ? "waiting" : "neutral"}
          href="/shopify/queue?view=waiting"
          hint="Retried automatically"
        />
        <StatTile
          label="Products online"
          value={online}
          href="/shopify/products"
          hint={`${byStatus.synced} synced · ${byStatus.pending} pending · ${byStatus.error} failed`}
        />
        <StatTile
          label="Events, last 24 h"
          value={overview.eventsLast24h}
          href="/shopify/events"
          hint="Webhooks received"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Connection">
          <dl className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <dt className="text-sm text-dust-500">Status</dt>
              <dd>
                <StatusPill status={connectionTone(connection.mode)}>
                  {connectionLabel(connection.mode)}
                </StatusPill>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-dust-500">Shop</dt>
              <dd className="font-mono text-sm break-all">
                {connection.shopDomain ?? "Not configured"}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-dust-500">API version</dt>
              <dd className="font-mono text-sm">{connection.apiVersion}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-dust-500">Webhook address</dt>
              <dd>
                <CopyText value={url} label="Webhook address" />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-dust-500">Webhook secret</dt>
              <dd className="text-sm">
                {secretSet ? "Set" : "Not set: Shopify deliveries are refused until it is"}
              </dd>
            </div>
          </dl>
          {connection.mode === "fake" ? (
            <p className="mt-3 text-sm text-dust-700">
              Test mode: BICII talks to a pretend Shopify inside the app. Nothing reaches a real
              store.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-dust-700">
            Setup and recovery are in the{" "}
            <Link
              href={runbookHref("shopify")}
              className="font-semibold underline underline-offset-4"
            >
              runbook
            </Link>
            .
          </p>
        </Card>

        <Card title="Settings">
          <ShopifySettingsForm settings={overview.settings} locations={overview.locations} />
        </Card>
      </div>

      <nav aria-label="Shopify lists" className="mt-6 flex flex-wrap gap-2">
        {[
          { href: "/shopify/queue", text: "Queue" },
          { href: "/shopify/products", text: "Products" },
          { href: "/shopify/events", text: "Events" },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="inline-flex min-h-tap items-center rounded-full border-2 border-ink px-4 font-display text-xs font-bold tracking-wide uppercase hover:bg-dust-100"
          >
            {l.text}
          </Link>
        ))}
      </nav>
    </>
  );
}
