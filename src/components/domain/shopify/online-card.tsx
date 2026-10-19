"use client";

import { useOptimistic, useState, useTransition } from "react";

import { setPublishOnlineAction, syncNowAction } from "@/app/(staff)/inventory/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { ProductOnline } from "@/lib/domain/shopify";
import { syncStatusLabel, syncStatusTone } from "@/lib/shopify";
import { callAction } from "@/lib/call-action";

import { CopyText } from "../copy-text";

/**
 * The product page's "Online (Shopify)" card (Phase 10; SPEC §17; D84,
 * D86), for every active staff member:
 *
 *   - Publish online (a switch; useOptimistic, then a toast "Published
 *     online" / "Taken offline"), only for manage_inventory holders. When
 *     it cannot be switched on, the reason sits beside it (not public,
 *     customer-owned, archived, no price, or "Needs Manage inventory").
 *     The server action runs the one sync job the RPC returned. With the
 *     switch on but the product not public, active or unarchived, the
 *     description says why it is not listed (offlineReason) instead of
 *     "Listed on the Shopify store".
 *   - The sync status as a pill with words, when it last synced and the
 *     quantity Shopify was given at the online location.
 *   - A product linked to one made in Shopify (origin external) gets only
 *     price and stock from BICII, never a Buy-online link (D84).
 *   - On a failed sync, the human reason and Sync now (manage_inventory).
 *   - "Test Shopify" while the app talks to the in-memory fake.
 *   - Shopify details (collapsed): the product and variant ids, to copy.
 */
export function OnlineCard({
  productId,
  online,
  syncedAgo,
  blockedReason,
  offlineReason = null,
  canManage,
  fakeMode,
}: {
  productId: string;
  online: ProductOnline;
  /** "3 min ago", computed on the server (no clock difference on hydration). */
  syncedAgo: string | null;
  /** Why the switch is disabled (publishBlockedReason), or null. */
  blockedReason: string | null;
  /**
   * Why the product is not listed although Publish online is on (offlineReason:
   * not public, archived, inactive or customer-owned), or null when it is.
   */
  offlineReason?: string | null;
  canManage: boolean;
  fakeMode: boolean;
}) {
  const { toast } = useToast();
  const [optimistic, setOptimistic] = useOptimistic(online.publishOnline);
  const [pending, start] = useTransition();
  const [syncing, startSync] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) =>
    start(async () => {
      setError(null);
      setOptimistic(next);
      const result = await callAction(() => setPublishOnlineAction({ productId, publish: next }));
      if (!result.ok) {
        setError(result.error);
        toast({ title: "Not changed", description: result.error, tone: "error" });
        return;
      }
      toast({
        title: next ? "Published online" : "Taken offline",
        description: result.data.message ?? undefined,
        tone: result.data.syncStatus === "error" ? "error" : "success",
      });
    });

  const syncNow = () =>
    startSync(async () => {
      setError(null);
      const result = await callAction(() => syncNowAction({ productId }));
      if (!result.ok) {
        setError(result.error);
        toast({ title: "Sync not started", description: result.error, tone: "error" });
        return;
      }
      toast({
        title: result.data.title,
        description: result.data.description ?? undefined,
        tone: result.data.tone,
      });
    });

  const status = online.syncStatus;
  const canSync = canManage && (online.publishOnline || online.lastPushedAt !== null);
  const switchDisabled = pending || (!optimistic && blockedReason !== null) || !canManage;

  return (
    <Card
      title="Online (Shopify)"
      actions={fakeMode ? <Badge tone="waiting">Test Shopify</Badge> : null}
    >
      <div className="flex flex-col gap-3">
        <Switch
          label="Publish online"
          description={
            blockedReason ??
            (optimistic
              ? (offlineReason ?? "Listed on the Shopify store at its selling price.")
              : "Sell it on the Shopify store at its selling price.")
          }
          checked={optimistic}
          disabled={switchDisabled}
          onCheckedChange={toggle}
        />

        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-dust-500">Shopify</span>
            <StatusPill status={syncStatusTone(status)}>{syncStatusLabel(status)}</StatusPill>
            {syncedAgo ? <span className="text-sm text-dust-700">Synced {syncedAgo}</span> : null}
          </p>
          {online.lastPushedQuantity !== null ? (
            <p className="text-sm text-dust-700 tabular-nums">
              Online quantity {online.lastPushedQuantity}
              {online.onlineLocationName ? ` at ${online.onlineLocationName}` : ""}
            </p>
          ) : null}
          {online.origin === "external" ? (
            <p className="text-sm text-dust-700">
              Linked to a product made in Shopify: BICII sends price and stock only.
            </p>
          ) : null}
        </div>

        {status === "error" && online.lastError ? (
          <p className="text-sm font-medium text-danger-deep">{online.lastError}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {error}
          </p>
        ) : null}
        {canSync ? (
          <div>
            <Button
              variant={status === "error" ? "solid" : "outline"}
              size="sm"
              pending={syncing}
              pendingLabel="Syncing…"
              onClick={syncNow}
            >
              Sync now
            </Button>
          </div>
        ) : null}

        {online.shopifyProductId || online.shopifyVariantId ? (
          <details className="group rounded-xl border border-hairline">
            <summary className="flex min-h-tap cursor-pointer items-center px-3 font-medium">
              Shopify details
            </summary>
            <dl className="flex flex-col gap-3 px-3 pb-3">
              {online.shopifyProductId ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-dust-500">Product</dt>
                  <dd>
                    <CopyText value={online.shopifyProductId} label="Shopify product ID" />
                  </dd>
                </div>
              ) : null}
              {online.shopifyVariantId ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-dust-500">Variant</dt>
                  <dd>
                    <CopyText value={online.shopifyVariantId} label="Shopify variant ID" />
                  </dd>
                </div>
              ) : null}
            </dl>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
