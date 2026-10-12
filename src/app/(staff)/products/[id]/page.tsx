import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdjustStockButton } from "@/components/domain/adjust-stock-sheet";
import { ArchiveControl } from "@/components/domain/archive-control";
import { HistoryList, MovementList } from "@/components/domain/movement-list";
import { NoActiveLocation } from "@/components/domain/no-active-location";
import { PhotoGrid } from "@/components/domain/photo-grid";
import { ConsignmentItemRow } from "@/components/domain/consignment-item-row";
import { HeaderPrintLabel, LabelsCard } from "@/components/domain/labels-card";
import { EditProductButton } from "@/components/domain/product-sheet";
import { PUBLIC_PREVIEW_ID } from "@/components/domain/public-preview";
import { PublicationControls } from "@/components/domain/publication-card";
import { ProductPurchasingCard } from "@/components/domain/purchasing/product-purchasing-card";
import { RecordSaleButton } from "@/components/domain/record-sale-sheet";
import { OnlineCard } from "@/components/domain/shopify/online-card";
import { ShortId } from "@/components/domain/short-id";
import { SplitToUniqueButton } from "@/components/domain/split-to-unique-sheet";
import { StockBadge } from "@/components/domain/stock-badge";
import { StockTransferButton } from "@/components/domain/stock-transfer-sheet";
import { AddUnitButton } from "@/components/domain/unit-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ChevronRightIcon } from "@/components/ui/icons";
import { RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { hasPermission } from "@/lib/auth/permissions";
import { reconciliationHref } from "@/lib/reconciliation";
import { requireStaff } from "@/lib/auth/session";
import { CONSIGNED_STOCK_NOTE, consignmentStatusPill } from "@/lib/consignment";
import { consignmentsForProduct } from "@/lib/domain/consignment";
import { getProduct, listLocations, listProductCategories } from "@/lib/domain/inventory";
import { getLabelContext, resolvePrintPreset } from "@/lib/domain/labels";
import { getProductOnline } from "@/lib/domain/shopify";
import { shopifyConnection } from "@/lib/integrations/shopify/client";
import { getProductPurchasing } from "@/lib/domain/purchasing";
import {
  publicationLabel,
  publicationTone,
  signedQuantity,
  unitStatusLabel,
  unitStatusTone,
} from "@/lib/inventory";
import { describeProductEvent } from "@/lib/inventory-history";
import { formatMoney } from "@/lib/money";
import { parsePrintParams } from "@/lib/printing/print-sheet";
import { qrUrl } from "@/lib/qr";
import { offlineReason, publishBlockedReason, relativeAgo } from "@/lib/shopify";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Product" };

const plain = (n: number) => signedQuantity(n).replace(/^\+/, "");

/**
 * One product (SPEC §11, §12, §21): its P- number large, name, SKU, brand,
 * category and publication; stock by location with the total (a low-stock
 * note at or below the reorder point, "recount needed" for a location
 * below zero, D23); for a unique product its units; the selling price
 * (public.selling_prices) and, only for view_costs holders, cost, expected
 * yield and Cult Commons (the DTO has none otherwise); photos (internal or
 * public, never customer); recent movements; history; archive. Adjust
 * stock needs adjust_stock, Transfer, Edit details, Add unit and Archive
 * need manage_inventory. The publication card (D26) shows the status, the
 * manual moves (manage_inventory), what publishing needs, the QR URL and
 * what the public sees; "Split off as unique item" (D28) needs both
 * adjust_stock and manage_inventory and is offered on counted products.
 * Phase 6: Sell (any staff, D48) on an active counted product with stock,
 * shop-owned or consigned (its oldest consignment with stock first, D45).
 * Phase 8: Print label (any staff) in the header of a counted product and
 * the Labels card (D56–D59); a unique product's labels are its units'
 * (D57). `?print=1&qty=N&reprint={job}` opens the print sheet preset.
 * Phase 10: the "Online (Shopify)" card (every staff member sees the sync
 * status; manage_inventory switches Publish online and runs Sync now;
 * D84, D86).
 */
export default async function ProductPage({ params, searchParams }: PageProps<"/products/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewCosts = hasPermission(staff, "view_costs");
  const manage = hasPermission(staff, "manage_inventory");
  const canAdjust = hasPermission(staff, "adjust_stock");
  const supabase = await createClient();
  const [product, locations, categories, purchasing] = await Promise.all([
    getProduct(supabase, id, { viewCosts }),
    listLocations(supabase),
    manage ? listProductCategories(supabase) : Promise.resolve([]),
    // Purchasing (Phase 7): suppliers and orders for this product.
    getProductPurchasing(supabase, id, staff),
  ]);
  if (!product) notFound();
  // D50: consigned stock moves only through intake, sale, restock, a job,
  // return to the consignor and transfers.
  const consigned = product.ownershipType === "consignment";
  const [qr, consignments, labels, preset, online] = await Promise.all([
    qrUrl(product.shortId),
    consigned ? consignmentsForProduct(supabase, product.id) : Promise.resolve([]),
    getLabelContext(supabase, { kind: "product", entityId: product.id }),
    searchParams.then((sp) =>
      resolvePrintPreset(supabase, "product", product.id, parsePrintParams(sp)),
    ),
    getProductOnline(supabase, product.id),
  ]);

  const archived = product.archivedAt !== null;
  const counted = product.trackingType === "quantity";
  const sellable =
    counted &&
    !archived &&
    product.active &&
    product.ownershipType !== "customer_owned" &&
    product.stock.some((s) => s.onHand > 0);
  const sheetStock = product.stock.map((s) => ({
    locationId: s.locationId,
    name: s.name,
    active: s.active,
    onHand: s.onHand,
  }));
  const negative = product.stock.filter((s) => s.onHand < 0);
  const others = [product.brand, product.category?.name].filter((v): v is string => !!v);
  const meta = product.sku ? [product.sku, ...others] : others;
  const money = (v: string | null | undefined) =>
    v === null || v === undefined ? "Not set" : formatMoney(v, product.currency);

  return (
    <>
      <header className="flex flex-col gap-4 pt-6 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShortId value={product.shortId} large />
            <StatusPill status={publicationTone(product.publicationStatus)}>
              {publicationLabel(product.publicationStatus)}
            </StatusPill>
            {archived ? <Badge tone="waiting">Archived</Badge> : null}
            {!product.active ? <Badge>Inactive</Badge> : null}
          </div>
          <h1 className="text-3xl break-words sm:text-4xl">{product.name}</h1>
          {meta.length > 0 ? (
            <p className="text-dust-700">
              {product.sku ? <span className="font-mono">{product.sku}</span> : null}
              {product.sku && others.length > 0 ? " · " : null}
              {others.join(" · ")}
            </p>
          ) : null}
          <p className="text-sm text-dust-500">
            {counted ? "Counted by quantity" : "Unique: each item has its own U- number"}
          </p>
        </div>
        {manage || sellable || counted ? (
          <div className="flex flex-wrap items-center gap-2">
            {counted ? (
              <HeaderPrintLabel
                kind="product"
                entityId={product.id}
                shortId={product.shortId}
                ctx={labels}
                preset={preset}
              />
            ) : null}
            {sellable ? (
              <RecordSaleButton
                label="Sell"
                viewCosts={viewCosts}
                preset={{ q: product.shortId, productId: product.id }}
              />
            ) : null}
            {manage ? (
              <EditProductButton
                product={{
                  id: product.id,
                  name: product.name,
                  sku: product.sku,
                  brand: product.brand,
                  categoryId: product.category?.id ?? null,
                  description: product.description,
                  defaultSalePrice: product.defaultSalePrice,
                  ...(viewCosts ? { cost: product.cost ?? null } : {}),
                  reorderPoint: product.reorderPoint,
                  active: product.active,
                  trackingType: product.trackingType,
                }}
                categories={
                  // An archived category stays choosable for a product
                  // already filed under it, so saving keeps it.
                  product.category && !categories.some((c) => c.id === product.category?.id)
                    ? [
                        ...categories,
                        { id: product.category.id, name: `${product.category.name} (archived)` },
                      ]
                    : categories
                }
                viewCosts={viewCosts}
              />
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Stock"
          actions={
            counted && !archived && (canAdjust || manage) ? (
              <>
                {canAdjust && manage && !consigned ? (
                  <SplitToUniqueButton
                    sourceProductId={product.id}
                    productName={product.name}
                    defaultSalePrice={product.defaultSalePrice}
                    stock={sheetStock}
                  />
                ) : null}
                {canAdjust && !consigned ? (
                  <AdjustStockButton
                    productId={product.id}
                    productName={product.name}
                    stock={sheetStock}
                    defaultLocationId={locations.defaultLocationId}
                    viewCosts={viewCosts}
                  />
                ) : null}
                {manage ? (
                  <StockTransferButton
                    subject={{
                      kind: "product",
                      productId: product.id,
                      name: product.name,
                      stock: sheetStock,
                    }}
                  />
                ) : null}
              </>
            ) : null
          }
        >
          <dl aria-label="Stock by location" className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            {product.stock.map((s) => (
              <div key={s.locationId} className="contents">
                <dt className={s.active ? undefined : "text-dust-500"}>
                  {s.name}
                  {s.active ? "" : " (inactive)"}
                </dt>
                <dd
                  className={
                    s.onHand < 0
                      ? "text-right font-semibold text-danger-deep tabular-nums"
                      : "text-right tabular-nums"
                  }
                >
                  {plain(s.onHand)}
                </dd>
              </div>
            ))}
            <div className="contents">
              <dt className="border-t border-hairline pt-2 font-semibold">Total</dt>
              <dd className="border-t border-hairline pt-2 text-right font-bold tabular-nums">
                {plain(product.onHand)}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StockBadge
              onHand={product.onHand}
              reorderPoint={product.reorderPoint}
              negativeLocations={product.negativeLocations}
              unique={!counted}
              availableUnits={product.availableUnits}
            />
            {!counted && product.heldUnits > 0 ? (
              <Badge tone="waiting">{product.heldUnits} on a job</Badge>
            ) : null}
          </div>
          {negative.length > 0 ? (
            <p className="mt-3 text-sm text-danger-deep">
              Recount needed at {negative.map((s) => s.name).join(" and ")}: parts used on jobs took
              the count below zero.
            </p>
          ) : null}
          {counted && product.low && negative.length === 0 && product.reorderPoint !== null ? (
            <p className="mt-3 text-sm text-waiting-deep">
              Low stock: at or below the reorder point of {product.reorderPoint}.
            </p>
          ) : null}
          {consigned ? <p className="mt-3 text-sm text-dust-700">{CONSIGNED_STOCK_NOTE}</p> : null}
          {counted && locations.defaultLocationId === null ? (
            <p className="mt-3 text-sm text-dust-700">
              <NoActiveLocation />
            </p>
          ) : null}
          {/* Phase 9 (D106): this product's records against the movement ledger. */}
          <Link
            href={reconciliationHref({ all: true, productId: product.id })}
            className="mt-3 inline-flex min-h-tap items-center text-sm font-semibold underline"
          >
            Check against the ledger
          </Link>
        </Card>

        <Card title="Prices">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            <dt>Selling price</dt>
            <dd className="text-right font-semibold tabular-nums">{money(product.salePrice)}</dd>
          </dl>
          {viewCosts ? (
            <section aria-labelledby="cost-and-yield" className="mt-4 flex flex-col gap-2">
              <h3
                id="cost-and-yield"
                className="font-display text-xs font-bold tracking-wide uppercase"
              >
                Cost and yield (staff with cost access only)
              </h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
                <dt>Cost</dt>
                <dd className="text-right">{money(product.cost)}</dd>
                <dt>Expected yield</dt>
                <dd className="text-right">{money(product.expectedYield)}</dd>
                <dt>Cult Commons share</dt>
                <dd className="text-right">{money(product.expectedCultCommons)}</dd>
              </dl>
              {product.cost === null && !consigned ? (
                <p className="text-sm text-waiting-deep">
                  No cost yet: this product can&apos;t go on a job until it has one.
                </p>
              ) : null}
            </section>
          ) : null}
        </Card>
      </div>

      {!counted ? (
        <Card
          title="Units"
          actions={
            manage && !archived && !consigned ? (
              <AddUnitButton
                productId={product.id}
                locations={locations.locations}
                defaultLocationId={locations.defaultLocationId}
                viewCosts={viewCosts}
              />
            ) : null
          }
        >
          {product.units.length === 0 ? (
            <p className="text-dust-700">
              No units yet.{manage && !consigned ? " Add the item itself with Add unit." : ""}
            </p>
          ) : (
            <ul aria-label="Units" className="-mx-2 flex flex-col">
              {product.units.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/units/${u.id}`}
                    className="flex min-h-tap flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2 hover:bg-dust-100"
                  >
                    <ShortId value={u.shortId} />
                    <StatusPill status={unitStatusTone(u.status)}>
                      {unitStatusLabel(u.status)}
                    </StatusPill>
                    <span className="flex min-w-24 flex-1 flex-col text-sm">
                      <span>{u.location.name}</span>
                      {u.serialNumber ? (
                        <span className="truncate font-mono text-dust-500">
                          S/N {u.serialNumber}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm tabular-nums">{money(u.salePrice)}</span>
                    <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {consigned ? (
        <Card title="Consignments" eyebrow="Consigned stock">
          {consignments.length === 0 ? (
            <p className="text-dust-700">No consignment on this product.</p>
          ) : (
            <RowList label="Consignments">
              {consignments.map((c) => (
                <ConsignmentItemRow
                  key={c.id}
                  href={`/consignment/items/${c.id}`}
                  shortId={c.shortId}
                  name={c.consignorName}
                  pill={consignmentStatusPill(c.status, null)}
                  details={[]}
                />
              ))}
            </RowList>
          )}
        </Card>
      ) : null}

      <LabelsCard
        kind="product"
        entityId={product.id}
        shortId={product.shortId}
        ctx={labels}
        isAdmin={staff.role === "admin"}
        publicPreviewId={PUBLIC_PREVIEW_ID}
        units={product.units.map((u) => ({ id: u.id, shortId: u.shortId }))}
      />
      {/* Purchasing (Phase 7): shop-owned counted products are bought on purchase orders (D62). */}
      {counted && product.ownershipType === "shop_owned" ? (
        <ProductPurchasingCard
          product={{ id: product.id, name: product.name, shortId: product.shortId }}
          purchasing={purchasing}
          canManage={hasPermission(staff, "manage_purchasing") && !archived}
        />
      ) : null}

      <Card title="Publication">
        <PublicationControls
          productId={product.id}
          status={product.publicationStatus}
          trackingType={product.trackingType}
          availableUnits={product.availableUnits}
          requirements={product.requirements}
          qrUrl={qr}
          isAdmin={staff.role === "admin"}
          preview={product.publicPreview}
          canManage={manage}
        />
      </Card>

      <OnlineCard
        productId={product.id}
        online={online}
        syncedAgo={online.lastPushedAt ? relativeAgo(online.lastPushedAt) : null}
        blockedReason={publishBlockedReason({
          canManage: manage,
          publishOnline: online.publishOnline,
          publicationStatus: product.publicationStatus,
          ownershipType: product.ownershipType,
          archived,
          // A unique product's online price is its oldest unit's (D81): the
          // database decides; a counted one needs its selling price.
          hasPrice: !counted || product.salePrice !== null,
        })}
        offlineReason={offlineReason({
          active: product.active,
          archived,
          ownershipType: product.ownershipType,
          publicationStatus: product.publicationStatus,
          trackingType: product.trackingType,
        })}
        canManage={manage}
        fakeMode={shopifyConnection().mode === "fake"}
      />

      <Card title="Photos">
        <PhotoGrid
          target={{ entityType: "product", entityId: product.id }}
          photos={product.photos}
          canAdd={!archived}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Recent movements"
          actions={
            <Link
              href={`/inventory/movements?product=${product.id}`}
              className="inline-flex min-h-tap items-center text-sm font-semibold underline underline-offset-4"
            >
              All movements
            </Link>
          }
        >
          {product.movements.length === 0 ? (
            <p className="text-dust-700">No stock has moved yet.</p>
          ) : (
            <MovementList movements={product.movements} showProduct={false} />
          )}
        </Card>
        <Card title="History">
          <HistoryList
            entries={product.history}
            describe={(e) =>
              describeProductEvent(e.type, e.payload, { currency: product.currency })
            }
          />
        </Card>
      </div>

      {product.description ? (
        <Card title="Description">
          <p className="whitespace-pre-line text-dust-700">{product.description}</p>
        </Card>
      ) : null}

      {manage ? (
        <Card title="Archive">
          <ArchiveControl
            kind="product"
            id={product.id}
            name={product.shortId}
            archived={archived}
          />
        </Card>
      ) : null}
    </>
  );
}
