import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArchiveControl } from "@/components/domain/archive-control";
import { NewPurchaseOrderButton } from "@/components/domain/purchasing/purchase-order-sheet";
import { PurchaseOrderStatusPill } from "@/components/domain/purchasing/purchase-order-status-pill";
import {
  AddSupplierProductButton,
  EditSupplierProductButton,
} from "@/components/domain/purchasing/supplier-product-sheet";
import { EditSupplierButton } from "@/components/domain/purchasing/supplier-sheet";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ChevronRightIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { requireStaff } from "@/lib/auth/session";
import { formatDate } from "@/lib/dates";
import type { SupplierProductLink } from "@/lib/domain/suppliers";
import { getSupplier } from "@/lib/domain/suppliers";
import { formatMoney } from "@/lib/money";
import { mailtoHref, telHref } from "@/lib/people";
import { canManagePurchasing, formatExpected, leadTimeText, progressText } from "@/lib/purchasing";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Supplier" };

/** One product row's content (SKU, lead time, preferred, cost-visible last cost). */
function LinkSummary({ link }: { link: SupplierProductLink }) {
  const facts = [
    link.supplierSku ? `Their SKU ${link.supplierSku}` : null,
    link.leadDays !== null ? leadTimeText(link.leadDays) : null,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-words">{link.product.name}</span>
        <ShortId value={link.product.shortId} />
        {link.preferred ? <Badge tone="done">Preferred</Badge> : null}
      </span>
      {facts.length > 0 ? <span className="text-sm text-dust-500">{facts.join(" · ")}</span> : null}
      {link.costs ? (
        <span className="text-sm text-dust-700 tabular-nums">
          {link.costs.lastUnitCost !== null
            ? `Last cost ${formatMoney(link.costs.lastUnitCost, link.costs.currency)}${
                link.costs.lastReceivedAt
                  ? ` · received ${formatDate(link.costs.lastReceivedAt)}`
                  : ""
              }`
            : "Not received from them yet"}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One supplier (SPEC §14, §21): how to reach them (tap to call, email,
 * website), account reference and notes; the products they supply
 * (supplier SKU, lead time, preferred and, cost-visible staff only, the
 * last cost and when it was received, D60 D63); their orders with "New
 * order" preset to them; Edit and Archive for manage_purchasing.
 */
export default async function SupplierPage({ params }: PageProps<"/purchasing/suppliers/[id]">) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supplier = await getSupplier(await createClient(), id, staff);
  if (!supplier) notFound();
  const manage = canManagePurchasing(staff);
  const archived = supplier.archivedAt !== null;
  const tel = telHref(supplier.phone);
  const mailto = mailtoHref(supplier.email);
  const ref = { id: supplier.id, name: supplier.name };

  return (
    <>
      <PageHeader
        eyebrow="Supplier"
        title={supplier.name}
        description={supplier.contactName ? `Contact: ${supplier.contactName}` : undefined}
        actions={
          <>
            {archived ? <Badge tone="waiting">Archived</Badge> : null}
            {manage ? (
              <EditSupplierButton
                supplier={{
                  id: supplier.id,
                  name: supplier.name,
                  contactName: supplier.contactName,
                  email: supplier.email,
                  phone: supplier.phone,
                  website: supplier.website,
                  accountReference: supplier.accountReference,
                  notes: supplier.notes,
                }}
              />
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Contact">
          {supplier.phone || supplier.email || supplier.website ? (
            <ul
              aria-label="Contact"
              className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5"
            >
              {supplier.phone ? (
                <li>
                  {tel ? (
                    <a
                      href={tel}
                      className="flex min-h-tap flex-col px-4 py-2 focus-inset hover:bg-dust-100 sm:px-5"
                    >
                      <span className="eyebrow text-dust-500">Phone · tap to call</span>
                      <span className="text-lg font-medium tabular-nums">{supplier.phone}</span>
                    </a>
                  ) : (
                    <p className="px-4 py-2 sm:px-5">{supplier.phone}</p>
                  )}
                </li>
              ) : null}
              {supplier.email ? (
                <li>
                  {mailto ? (
                    <a
                      href={mailto}
                      className="flex min-h-tap flex-col px-4 py-2 break-all focus-inset hover:bg-dust-100 sm:px-5"
                    >
                      <span className="eyebrow text-dust-500">Email</span>
                      <span className="text-lg font-medium">{supplier.email}</span>
                    </a>
                  ) : (
                    <p className="px-4 py-2 sm:px-5">{supplier.email}</p>
                  )}
                </li>
              ) : null}
              {supplier.website ? (
                <li>
                  <a
                    href={supplier.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-tap flex-col px-4 py-2 break-all focus-inset hover:bg-dust-100 sm:px-5"
                  >
                    <span className="eyebrow text-dust-500">Website · opens in a new tab</span>
                    <span className="text-lg font-medium">
                      {supplier.website.replace(/^https?:\/\//i, "")}
                    </span>
                  </a>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-dust-700">No phone number, email or website on file.</p>
          )}
        </Card>
        <Card title="Account">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-dust-500">Our account</dt>
            <dd className="font-mono">{supplier.accountReference ?? "—"}</dd>
          </dl>
          {supplier.notes ? (
            <p className="mt-3 whitespace-pre-line text-dust-700">{supplier.notes}</p>
          ) : (
            <p className="mt-3 text-dust-500">
              No notes.{manage ? " Add ordering terms or delivery days with Edit." : ""}
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Products"
        actions={manage && !archived ? <AddSupplierProductButton supplier={ref} /> : null}
      >
        {supplier.products.length === 0 ? (
          <p className="text-dust-700">
            No products linked yet. Receiving an order links its products automatically
            {manage && !archived ? ", or add one with Add product" : ""}.
          </p>
        ) : (
          <ul
            aria-label={`Products from ${supplier.name}`}
            className="-mx-4 flex flex-col divide-y divide-hairline sm:-mx-5"
          >
            {supplier.products.map((link) => (
              <li key={link.product.id}>
                {manage && !archived ? (
                  <EditSupplierProductButton
                    supplier={ref}
                    product={{
                      id: link.product.id,
                      name: link.product.name,
                      shortId: link.product.shortId,
                    }}
                    link={{
                      supplierSku: link.supplierSku,
                      leadDays: link.leadDays,
                      preferred: link.preferred,
                    }}
                  >
                    <LinkSummary link={link} />
                    <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                  </EditSupplierProductButton>
                ) : (
                  <Link
                    href={`/products/${link.product.id}`}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 focus-inset hover:bg-dust-100 sm:px-5"
                  >
                    <LinkSummary link={link} />
                    <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Orders"
        actions={
          manage && !archived ? (
            <NewPurchaseOrderButton supplier={ref} variant="outline" size="sm" />
          ) : null
        }
      >
        {supplier.orders.items.length === 0 ? (
          <p className="text-dust-700">
            No orders from {supplier.name} yet.
            {manage && !archived ? " Start one with New order." : ""}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {supplier.orders.more ? (
              <p className="text-sm text-dust-700">
                Showing the newest {supplier.orders.items.length}. Search Purchasing for older ones.
              </p>
            ) : null}
            <RowList label={`Orders from ${supplier.name}`}>
              {supplier.orders.items.map((o) => (
                <RowLink key={o.id} href={`/purchasing/orders/${o.id}`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <ShortId value={o.poNumber} />
                      <PurchaseOrderStatusPill status={o.status} />
                      {o.overdue ? (
                        <Badge tone="danger" emphasis="solid">
                          Overdue
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-sm text-dust-500 tabular-nums">
                      {o.lineCount === 0 ? "No lines yet" : progressText(o, o.status)}
                      {o.expectedAt &&
                      !o.overdue &&
                      (o.status === "submitted" || o.status === "partially_received")
                        ? ` · expected ${formatExpected(o.expectedAt)}`
                        : ""}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                </RowLink>
              ))}
            </RowList>
          </div>
        )}
      </Card>

      {manage ? (
        <Card title="Archive">
          <ArchiveControl
            kind="supplier"
            id={supplier.id}
            name={supplier.name}
            archived={archived}
          />
        </Card>
      ) : null}
    </>
  );
}
