import type { Metadata } from "next";

import { NewProductButton } from "@/components/domain/product-sheet";
import { SearchField } from "@/components/domain/search-field";
import { ShortId } from "@/components/domain/short-id";
import { StockBadge } from "@/components/domain/stock-badge";
import { LinkSegments } from "@/components/domain/workshop-board";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BoxIcon, ChevronRightIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import {
  listLocations,
  listProductCategories,
  listProducts,
  type ProductFilter,
} from "@/lib/domain/inventory";
import { publicationLabel, publicationTone } from "@/lib/inventory";
import { canManagePurchasing } from "@/lib/purchasing";
import { readQuery, withParam } from "@/lib/search-params";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Inventory" };

const FILTERS: { key: ProductFilter; text: string }[] = [
  { key: "all", text: "All" },
  { key: "low", text: "Low stock" },
  { key: "archived", text: "Archived" },
];

const readFilter = (value: string | string[] | undefined): ProductFilter => {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "low" || v === "archived" ? v : "all";
};

/**
 * Inventory (SPEC §11, §21): search products by P- number, SKU, name or
 * brand; with nothing typed, the most recently updated. Filters All · Low
 * stock (at or below the reorder point, or below zero anywhere, D23) ·
 * Archived, kept with the query in the URL. Each row: name, P- number,
 * SKU, its stock as a badge and, when public or sold, the publication.
 */
export default async function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  const staff = await requireStaff();
  const params = await searchParams;
  const q = readQuery(params.q);
  const filter = readFilter(params.filter);
  const manage = hasPermission(staff, "manage_inventory");
  const viewCosts = hasPermission(staff, "view_costs");
  const supabase = await createClient();
  const [{ items: products, more }, categories, locations] = await Promise.all([
    listProducts(supabase, { q, filter }),
    manage ? listProductCategories(supabase) : Promise.resolve([]),
    manage ? listLocations(supabase) : Promise.resolve(null),
  ]);

  const newButton =
    manage && locations ? (
      <NewProductButton
        categories={categories}
        locations={locations.locations}
        defaultLocationId={locations.defaultLocationId}
        viewCosts={viewCosts}
      />
    ) : null;

  const heading = q
    ? more
      ? `First ${products.length} matches`
      : `${products.length} ${products.length === 1 ? "match" : "matches"}`
    : filter === "low"
      ? "Low stock"
      : filter === "archived"
        ? "Archived products"
        : "Recently updated";

  return (
    <>
      <PageHeader
        title="Inventory"
        actions={
          <>
            {/* The primary action first (U1-7); the two read-only reports after it. */}
            {newButton}
            <ButtonLink href="/inventory/movements" variant="outline">
              Movements
            </ButtonLink>
            {/* Phase 9 (D106): the ledger against the unit records, read only. */}
            <ButtonLink href="/reports/reconciliation" variant="outline">
              Reconcile stock
            </ButtonLink>
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <SearchField
          label="Search products"
          hint="P- number, SKU, name or brand"
          placeholder="Search products"
        />
        <LinkSegments
          label="Which products"
          options={FILTERS.map((f) => ({
            key: f.key,
            text: f.text,
            href: `/inventory${withParam(
              f.key === "all" ? "" : new URLSearchParams({ filter: f.key }),
              "q",
              q,
            )}`,
            current: f.key === filter,
          }))}
        />
      </div>
      <section aria-labelledby="product-results" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="product-results" className="eyebrow text-dust-500">
            {heading}
          </h2>
          {/* Purchasing (Phase 7): a draft order from what is low (D66). */}
          {filter === "low" && !q && canManagePurchasing(staff) ? (
            <ButtonLink href="/purchasing/reorder" variant="outline" size="sm">
              Reorder
            </ButtonLink>
          ) : null}
        </div>
        {more && q ? (
          <p className="text-sm text-dust-700">
            There are more. Add more of the P- number, SKU or name to narrow it down.
          </p>
        ) : null}
        {products.length === 0 ? (
          <EmptyState
            icon={<BoxIcon />}
            title={
              q
                ? `No product matches “${q}”`
                : filter === "low"
                  ? "Nothing is low"
                  : filter === "archived"
                    ? "No archived products"
                    : "No products yet"
            }
            description={
              q
                ? "Try the P- number from its label, the SKU, or a word of the name or brand."
                : filter === "low"
                  ? "Counted products at or below their reorder point, or below zero anywhere, appear here."
                  : filter === "archived"
                    ? "Products you archive appear here, with their history intact."
                    : manage
                      ? "Add the first product with New product: counted stock like tubes and pads, or a unique item like a complete bike. Then record its opening stock with Adjust stock."
                      : "Someone with inventory access adds products; they appear here."
            }
            action={!q && filter === "all" ? newButton : undefined}
          />
        ) : (
          <RowList label="Products">
            {products.map((p) => (
              <RowLink key={p.id} href={`/products/${p.id}`}>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="line-clamp-2 font-medium break-words">{p.name}</span>
                    {p.archived ? <Badge>Archived</Badge> : null}
                    {!p.active && !p.archived ? <Badge>Inactive</Badge> : null}
                    {p.publicationStatus === "public" || p.publicationStatus === "sold" ? (
                      <StatusPill status={publicationTone(p.publicationStatus)}>
                        {publicationLabel(p.publicationStatus)}
                      </StatusPill>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-dust-500">
                    <ShortId value={p.shortId} />
                    {p.sku ? <span className="font-mono">{p.sku}</span> : null}
                    <StockBadge
                      onHand={p.onHand}
                      reorderPoint={p.reorderPoint}
                      negativeLocations={p.negativeLocations}
                      unique={p.trackingType === "unique"}
                      availableUnits={p.availableUnits}
                    />
                  </span>
                </span>
                <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
              </RowLink>
            ))}
          </RowList>
        )}
      </section>
    </>
  );
}
