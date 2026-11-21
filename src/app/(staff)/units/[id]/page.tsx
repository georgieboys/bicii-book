import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { HeaderPrintLabel, LabelsCard } from "@/components/domain/labels-card";
import { HistoryList, MovementList } from "@/components/domain/movement-list";
import { PhotoGrid } from "@/components/domain/photo-grid";
import { PUBLIC_PREVIEW_ID, PublicPreviewPanel } from "@/components/domain/public-preview";
import { QrLabelUrl } from "@/components/domain/qr-label-url";
import { RecordSaleButton } from "@/components/domain/record-sale-sheet";
import { RestockControl } from "@/components/domain/sale-controls";
import { ShortId } from "@/components/domain/short-id";
import { StockTransferButton } from "@/components/domain/stock-transfer-sheet";
import { EditUnitButton, WriteOffUnitControl } from "@/components/domain/unit-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { canViewConsignmentMoney, hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { CONSIGNED_STOCK_NOTE } from "@/lib/consignment";
import { consignmentForUnit } from "@/lib/domain/consignment";
import { formatDateTime } from "@/lib/dates";
import { getUnit, listLocations } from "@/lib/domain/inventory";
import { getLabelContext, resolvePrintPreset } from "@/lib/domain/labels";
import { saleForUnit } from "@/lib/domain/sales";
import { publicationLabel, unitStatusLabel, unitStatusTone } from "@/lib/inventory";
import { describeUnitEvent } from "@/lib/inventory-history";
import { formatMoney } from "@/lib/money";
import { parsePrintParams } from "@/lib/printing/print-sheet";
import { qrUrl } from "@/lib/qr";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Unit" };

const OWNERSHIP_LABELS: Record<string, string> = {
  shop_owned: "Shop owned",
  consignment: "Consigned",
  customer_owned: "Customer owned",
};

/**
 * One unique unit (SPEC §11, §21): its U- number large, the product, its
 * status, location, condition (public once published), serial and
 * ownership; the bike it is (B- link) and the job it is on (J- link: "On
 * job J-…" while held, "Sold on job J-…" once the job is completed, D25);
 * the selling price and, only for view_costs holders, cost, yield and Cult
 * Commons; photos (internal or public), movements and history. Edit
 * details and Transfer need manage_inventory (Transfer only while in
 * stock: available or reserved); Write off needs adjust_stock and is never
 * offered for a consigned unit (D50), which shows its Consignment card
 * instead (C- link, consignor, the agreed amount for money users, D48). Its QR URL
 * and what the public sees (read-only: publication is the product's).
 * Phase 6: Sell (any staff, D48) while it is available and shop-owned or
 * consigned; "Sold on S-…" when a sale sold it, with Restock for
 * adjust_stock holders (a consigned unit also needs manage_consignments,
 * D46). Phase 8: Print label (any staff) and the Labels card (D56–D59):
 * one label per unit, its U- QR, a linked bike's size and colour line
 * (D57); `?print=1&qty=N&reprint={job}` opens the print sheet preset.
 */
export default async function UnitPage({ params, searchParams }: PageProps<"/units/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewCosts = hasPermission(staff, "view_costs");
  const manage = hasPermission(staff, "manage_inventory");
  const canAdjust = hasPermission(staff, "adjust_stock");
  const supabase = await createClient();
  const [unit, locations] = await Promise.all([
    getUnit(supabase, id, { viewCosts }),
    listLocations(supabase),
  ]);
  if (!unit) notFound();
  // D50: consigned stock is never written off; D44: its consignment card.
  const consigned = unit.ownershipType === "consignment";
  const seesConsignmentMoney = canViewConsignmentMoney(staff);
  const [qr, consignment, sale, labels, preset] = await Promise.all([
    qrUrl(unit.shortId),
    consigned ? consignmentForUnit(supabase, unit.id) : Promise.resolve(null),
    unit.status === "sold" ? saleForUnit(supabase, unit.id) : Promise.resolve(null),
    getLabelContext(supabase, { kind: "unit", entityId: unit.id }),
    searchParams.then((sp) => resolvePrintPreset(supabase, "unit", unit.id, parsePrintParams(sp))),
  ]);
  const sellable =
    unit.status === "available" &&
    unit.archivedAt === null &&
    unit.ownershipType !== "customer_owned";
  const canRestock =
    sale !== null && canAdjust && (!consigned || hasPermission(staff, "manage_consignments"));

  const inStock = unit.status === "available" || unit.status === "reserved";
  const archived = unit.archivedAt !== null;
  const locationName = (lid: string) => locations.locations.find((l) => l.id === lid)?.name ?? null;
  const money = (v: string | null | undefined) =>
    v === null || v === undefined ? "Not set" : formatMoney(v, unit.product.currency);

  return (
    <>
      <header className="flex flex-col gap-4 pt-6 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShortId value={unit.shortId} large />
            <StatusPill status={unitStatusTone(unit.status)}>
              {unitStatusLabel(unit.status)}
            </StatusPill>
            {archived ? <Badge tone="waiting">Archived</Badge> : null}
          </div>
          <h1 className="text-3xl break-words sm:text-4xl">
            <Link
              href={`/products/${unit.product.id}`}
              className="underline-offset-4 hover:underline"
            >
              {unit.product.name}
            </Link>
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-dust-700">
            <Link
              href={`/products/${unit.product.id}`}
              className="underline-offset-2 hover:underline"
            >
              <ShortId value={unit.product.shortId} />
            </Link>
            {unit.product.sku ? <span className="font-mono">{unit.product.sku}</span> : null}
          </p>
          {unit.job ? (
            <p className="font-medium">
              <Link href={`/jobs/${unit.job.id}`} className="underline">
                {unit.status === "sold" ? "Sold on job" : "On job"} {unit.job.jobNumber}
              </Link>
            </p>
          ) : null}
          {sale ? (
            <p className="font-medium">
              <Link href={`/sales/${sale.saleId}`} className="underline">
                Sold on {sale.saleNumber}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HeaderPrintLabel
            kind="unit"
            entityId={unit.id}
            shortId={unit.shortId}
            ctx={labels}
            preset={preset}
          />
          {sellable ? (
            <RecordSaleButton
              label="Sell"
              viewCosts={viewCosts}
              preset={{ q: unit.shortId, unitId: unit.id }}
            />
          ) : null}
          {manage ? (
            <EditUnitButton
              unit={{
                id: unit.id,
                serialNumber: unit.serialNumber,
                condition: unit.condition,
                ownSalePrice: unit.ownSalePrice,
                ...(viewCosts ? { cost: unit.cost ?? null } : {}),
                internalNotes: unit.internalNotes,
                consigned,
                updatedAt: unit.updatedAt,
              }}
              viewCosts={viewCosts}
            />
          ) : null}
          {manage && inStock ? (
            <StockTransferButton
              subject={{
                kind: "unit",
                productId: unit.product.id,
                unitId: unit.id,
                name: `${unit.shortId} ${unit.product.name}`,
                fromLocationId: unit.location.id,
                locations: locations.locations.map((l) => ({
                  locationId: l.id,
                  name: l.name,
                  active: l.active,
                  onHand: l.id === unit.location.id ? 1 : 0,
                })),
              }}
            />
          ) : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-sm text-dust-500">Location</dt>
            <dd>{unit.location.name}</dd>
            <dt className="text-sm text-dust-500">Serial number</dt>
            <dd className={unit.serialNumber ? "font-mono break-all" : "text-dust-500"}>
              {unit.serialNumber ?? "—"}
            </dd>
            <dt className="text-sm text-dust-500">Condition</dt>
            <dd className={unit.condition ? "whitespace-pre-line" : "text-dust-500"}>
              {unit.condition ?? "—"}
            </dd>
            <dt className="text-sm text-dust-500">Ownership</dt>
            <dd>{OWNERSHIP_LABELS[unit.ownershipType] ?? unit.ownershipType}</dd>
            <dt className="text-sm text-dust-500">Bike</dt>
            <dd>
              {unit.bike ? (
                <Link
                  href={`/bikes/${unit.bike.id}`}
                  className="inline-flex flex-wrap items-center gap-2 underline"
                >
                  <ShortId value={unit.bike.shortId} />
                  {unit.bike.title}
                </Link>
              ) : (
                <span className="text-dust-500">—</span>
              )}
            </dd>
            {unit.soldAt ? (
              <>
                <dt className="text-sm text-dust-500">Sold</dt>
                <dd>
                  <time dateTime={unit.soldAt}>{formatDateTime(unit.soldAt)}</time>
                </dd>
              </>
            ) : null}
          </dl>
          {unit.internalNotes ? (
            <>
              <h3 className="mt-4 font-display text-xs font-bold tracking-wide uppercase">
                Internal notes
              </h3>
              <p className="mt-1 whitespace-pre-line text-dust-700">{unit.internalNotes}</p>
            </>
          ) : null}
        </Card>

        <Card title="Prices">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            <dt>Selling price</dt>
            <dd className="text-right font-semibold tabular-nums">{money(unit.salePrice)}</dd>
          </dl>
          {unit.ownSalePrice === null ? (
            <p className="mt-1 text-sm text-dust-500">The product&apos;s price.</p>
          ) : null}
          {viewCosts ? (
            <section aria-labelledby="unit-cost-and-yield" className="mt-4 flex flex-col gap-2">
              <h3
                id="unit-cost-and-yield"
                className="font-display text-xs font-bold tracking-wide uppercase"
              >
                Cost and yield (staff with cost access only)
              </h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
                <dt>Cost</dt>
                <dd className="text-right">
                  {money(unit.effectiveCost)}
                  {unit.cost === null && unit.effectiveCost !== null ? " (product's)" : ""}
                </dd>
                <dt>Expected yield</dt>
                <dd className="text-right">{money(unit.expectedYield)}</dd>
                <dt>Cult Commons share</dt>
                <dd className="text-right">{money(unit.expectedCultCommons)}</dd>
              </dl>
            </section>
          ) : null}
        </Card>
      </div>

      {consignment ? (
        <Card title="Consignment">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="text-sm text-dust-500">Consignment</dt>
            <dd>
              <Link
                href={`/consignment/items/${consignment.itemId}`}
                className="inline-flex items-center gap-2 underline"
              >
                <ShortId value={consignment.shortId} />
              </Link>
            </dd>
            <dt className="text-sm text-dust-500">Consignor</dt>
            <dd>
              <Link
                href={`/consignment/consignors/${consignment.consignor.id}`}
                className="underline"
              >
                {consignment.consignor.name}
              </Link>
            </dd>
            {seesConsignmentMoney && consignment.agreedAmountOwed !== null ? (
              <>
                <dt className="text-sm text-dust-500">Agreed amount owed</dt>
                <dd className="tabular-nums">
                  {formatMoney(consignment.agreedAmountOwed, consignment.currency)}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="mt-3 text-sm text-dust-700">{CONSIGNED_STOCK_NOTE}</p>
        </Card>
      ) : null}

      <LabelsCard
        kind="unit"
        entityId={unit.id}
        shortId={unit.shortId}
        ctx={labels}
        isAdmin={staff.role === "admin"}
        publicPreviewId={PUBLIC_PREVIEW_ID}
      />

      <Card title="Public listing">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-dust-700">
            {`Listing follows ${unit.product.shortId} (${publicationLabel(unit.product.publicationStatus)}).`}{" "}
            <Link href={`/products/${unit.product.id}`} className="font-medium underline">
              Change it there
            </Link>
            .
          </p>
          <QrLabelUrl value={qr} isAdmin={staff.role === "admin"} />
          <PublicPreviewPanel preview={unit.publicPreview} id={PUBLIC_PREVIEW_ID} />
        </div>
      </Card>

      <Card title="Photos">
        <PhotoGrid
          target={{ entityType: "inventory_unit", entityId: unit.id }}
          photos={unit.photos}
          canAdd={!archived}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Movements">
          {unit.movements.length === 0 ? (
            <p className="text-dust-700">No stock has moved yet.</p>
          ) : (
            <MovementList movements={unit.movements} showProduct={false} />
          )}
        </Card>
        <Card title="History">
          <HistoryList
            entries={unit.history}
            describe={(e) =>
              describeUnitEvent(e.type, e.payload, {
                currency: unit.product.currency,
                locationName,
              })
            }
          />
        </Card>
      </div>

      {sale && canRestock ? (
        <Card title="Restock">
          <p className="mb-3 text-dust-700">
            If {unit.shortId} came back, put it back into stock with a reason. The sale and any
            refund stay as they are.
          </p>
          <RestockControl
            unitId={unit.id}
            unitShortId={unit.shortId}
            saleLineId={sale.lineId}
            consigned={consigned}
            defaultLocationId={unit.location.id}
            locations={locations.locations
              .filter((l) => l.active)
              .map((l) => ({ id: l.id, name: l.name }))}
          />
        </Card>
      ) : null}

      {canAdjust && inStock && !consigned ? (
        <Card title="Write off">
          <p className="mb-3 text-dust-700">
            For a unit that is damaged beyond sale or lost. It leaves stock with the reason.
          </p>
          <WriteOffUnitControl unitId={unit.id} shortId={unit.shortId} />
        </Card>
      ) : null}
    </>
  );
}
