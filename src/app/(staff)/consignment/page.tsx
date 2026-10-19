import type { Metadata } from "next";

import { NewConsignorButton } from "@/components/domain/consignor-sheet";
import { ReceiveItemButton } from "@/components/domain/consignment-intake-sheet";
import { ConsignmentItemRow } from "@/components/domain/consignment-item-row";
import { ArchivedFilter } from "@/components/domain/list-filter";
import { SearchField } from "@/components/domain/search-field";
import { LinkSegments } from "@/components/domain/workshop-board";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronRightIcon, TagIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { StatusPill } from "@/components/ui/status-pill";
import { canViewConsignmentMoney, hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import {
  ITEM_STATUS_FILTERS,
  consignmentStatusPill,
  outstandingLabel,
  outstandingTone,
  readItemStatusFilter,
  remainingLabel,
} from "@/lib/consignment";
import { listConsignmentItems, listConsignors } from "@/lib/domain/consignment";
import { formatMoney } from "@/lib/money";
import { readFlag, readQuery, withParam } from "@/lib/search-params";
import { createClient } from "@/lib/supabase/server";

import { loadIntakeContext } from "./intake-context";

export const metadata: Metadata = { title: "Consignment" };

/**
 * Consignment (SPEC §13, §21): consignors and the items they left with the
 * shop. Two views as links (`?view=consignors`, the default, and
 * `?view=items`), each a server query, so a view is a shareable URL.
 * Consignors: search, the archived filter, item counts and, for staff who
 * may see consignment money (D48), each consignor's balance. Items: a
 * status filter (For sale, Sold, Returned, All) and search. Every active
 * staff member can read it; Receive item and New consignor need
 * manage_consignments.
 */
export default async function ConsignmentPage({ searchParams }: PageProps<"/consignment">) {
  const staff = await requireStaff();
  const params = await searchParams;
  const view = params.view === "items" ? "items" : "consignors";
  const q = readQuery(params.q);
  const manage = hasPermission(staff, "manage_consignments");
  const money = canViewConsignmentMoney(staff);

  const tabs = (
    <LinkSegments
      label="Consignment views"
      options={[
        {
          key: "consignors",
          text: "Consignors",
          href: "/consignment",
          current: view === "consignors",
        },
        {
          key: "items",
          text: "Items",
          href: "/consignment?view=items",
          current: view === "items",
        },
      ]}
    />
  );

  return (
    <>
      <PageHeader title="Consignment" actions={manage ? <IntakeActions staff={staff} /> : null} />
      {tabs}
      {view === "consignors" ? (
        <ConsignorsView q={q} archived={readFlag(params.archived)} money={money} manage={manage} />
      ) : (
        <ItemsView q={q} status={readItemStatusFilter(params.status)} money={money} />
      )}
    </>
  );
}

/**
 * Receive item and New consignor. Their own async component, so the intake
 * sheet's context loads alongside the list below instead of before it
 * (audit E1-8): React renders sibling server components concurrently.
 */
async function IntakeActions({ staff }: { staff: Awaited<ReturnType<typeof requireStaff>> }) {
  const intake = await loadIntakeContext(await createClient(), staff);
  return (
    <>
      <ReceiveItemButton context={intake} />
      <NewConsignorButton />
    </>
  );
}

async function ConsignorsView({
  q,
  archived,
  money,
  manage,
}: {
  q: string;
  archived: boolean;
  money: boolean;
  manage: boolean;
}) {
  const { items: consignors, more } = await listConsignors(await createClient(), { q, archived });
  return (
    <>
      <div className="flex flex-col gap-3">
        <SearchField
          label="Search consignors"
          hint="Name, phone digits or email"
          placeholder="Search consignors"
        />
        <ArchivedFilter
          basePath="/consignment"
          q={q}
          archived={archived}
          label="Which consignors"
        />
      </div>
      <section aria-labelledby="consignor-results" className="flex flex-col gap-2">
        <h2 id="consignor-results" className="eyebrow text-dust-500">
          {q
            ? `${consignors.length} ${consignors.length === 1 ? "match" : "matches"}`
            : archived
              ? "Archived consignors"
              : "Consignors"}
        </h2>
        {more ? (
          <p className="text-sm text-dust-700">
            There are more. Search by name, phone number or email to narrow it down.
          </p>
        ) : null}
        {consignors.length === 0 ? (
          <EmptyState
            icon={<TagIcon />}
            title={
              q
                ? `No consignor matches “${q}”`
                : archived
                  ? "No archived consignors"
                  : "No consignors yet"
            }
            description={
              q
                ? "Try part of the name, the last digits of the phone number, or the email."
                : archived
                  ? "Consignors you archive appear here, with their items and payments intact."
                  : "A consignor is someone who leaves an item with the shop to sell for them."
            }
            action={manage && !archived && !q ? <NewConsignorButton /> : undefined}
          />
        ) : (
          <RowList label="Consignors">
            {consignors.map((c) => {
              // Who is still owed money is consignment money (D48): staff
              // without it see how many sold, as on the consignor page.
              const counts = [
                c.activeItems > 0 ? `${c.activeItems} for sale` : null,
                c.awaitingItems !== null
                  ? c.awaitingItems > 0
                    ? `${c.awaitingItems} awaiting payment`
                    : null
                  : c.soldItems > 0
                    ? `${c.soldItems} sold`
                    : null,
              ].filter(Boolean);
              return (
                <RowLink key={c.id} href={`/consignment/consignors/${c.id}`}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      {c.customer ? <Badge>Customer</Badge> : null}
                      {c.archived ? <Badge tone="waiting">Archived</Badge> : null}
                    </span>
                    <span className="truncate text-sm text-dust-500">
                      {counts.length > 0 ? counts.join(" · ") : "No items with the shop"}
                    </span>
                  </span>
                  {money && c.outstanding !== null ? (
                    <StatusPill status={outstandingTone(c.outstanding, c)}>
                      {outstandingLabel(c.outstanding, undefined, c)}
                    </StatusPill>
                  ) : null}
                  <ChevronRightIcon className="size-5 shrink-0 text-dust-500" />
                </RowLink>
              );
            })}
          </RowList>
        )}
      </section>
    </>
  );
}

async function ItemsView({
  q,
  status,
  money,
}: {
  q: string;
  status: ReturnType<typeof readItemStatusFilter>;
  money: boolean;
}) {
  const { items, more } = await listConsignmentItems(await createClient(), { status, q });
  const base = new URLSearchParams({ view: "items" });
  return (
    <>
      <div className="flex flex-col gap-3">
        <SearchField
          label="Search consignment items"
          hint="C- number, item name or consignor"
          placeholder="Search items"
        />
        <LinkSegments
          label="Item status"
          options={ITEM_STATUS_FILTERS.map((f) => {
            const p = new URLSearchParams(base);
            if (f.key !== "active") p.set("status", f.key);
            return {
              key: f.key,
              text: f.label,
              href: `/consignment${withParam(p, "q", q)}`,
              current: status === f.key,
            };
          })}
        />
      </div>
      <section aria-labelledby="item-results" className="flex flex-col gap-2">
        <h2 id="item-results" className="eyebrow text-dust-500">
          {q
            ? `${items.length} ${items.length === 1 ? "match" : "matches"}`
            : (ITEM_STATUS_FILTERS.find((f) => f.key === status)?.label ?? "Items")}
        </h2>
        {more ? (
          <p className="text-sm text-dust-700">
            Showing the latest {items.length}. Search by C- number, name or consignor to find an
            older one.
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            icon={<TagIcon />}
            title={q ? `No item matches “${q}”` : "No items here"}
            description={
              q
                ? "Try the C- number on the label, part of the name, or the consignor."
                : "Items appear here when the shop receives them from a consignor."
            }
          />
        ) : (
          <RowList label="Consignment items">
            {items.map((i) => {
              const pill = consignmentStatusPill(i.status, money ? i.outstanding : null);
              return (
                <ConsignmentItemRow
                  key={i.id}
                  href={`/consignment/items/${i.id}`}
                  shortId={i.shortId}
                  name={i.productName}
                  pill={pill}
                  details={[
                    i.consignor.name,
                    i.remaining !== null ? remainingLabel(i.remaining, i.quantity) : null,
                    i.askingPrice !== null
                      ? `Asking ${formatMoney(i.askingPrice, i.currency)}`
                      : null,
                  ]}
                />
              );
            })}
          </RowList>
        )}
      </section>
    </>
  );
}
