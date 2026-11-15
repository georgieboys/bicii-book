import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ArchiveGroupButton,
  EditProductGroupButton,
} from "@/components/domain/product-group-controls";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { BoxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { getProductGroup } from "@/lib/domain/product-groups";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Product group" };

/**
 * One product group (D241-D243): its name, option, description and the
 * products in it with their option values. Products join or leave from
 * their own page; manage_inventory edits and archives the group.
 */
export default async function ProductGroupPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const manage = hasPermission(staff, "manage_inventory");
  const group = await getProductGroup(await createClient(), id);
  if (!group) notFound();

  return (
    <>
      <PageHeader
        eyebrow={<ShortId value={group.shortId} />}
        title={group.name}
        description={`Sold online as one item, by ${group.optionName.toLowerCase()}.${group.brand ? ` Brand: ${group.brand}.` : ""}`}
        actions={
          <>
            {group.archived ? <Badge>Archived</Badge> : null}
            {group.onShopify ? <Badge tone="done">On Shopify</Badge> : null}
            {manage ? (
              <>
                <EditProductGroupButton group={group} />
                <ArchiveGroupButton id={group.id} archived={group.archived} />
              </>
            ) : null}
          </>
        }
      />
      {group.description ? (
        <p className="whitespace-pre-line text-dust-700">{group.description}</p>
      ) : null}
      {group.members.length === 0 ? (
        <EmptyState
          icon={<BoxIcon />}
          title="No products in this group"
          description="Open a product and choose Add to a group, with its option value."
        />
      ) : (
        <RowList label="Products in this group">
          {group.members.map((m) => (
            <RowLink
              key={m.id}
              href={`/products/${m.id}`}
              after={
                <span className="flex items-center gap-2">
                  {m.onShopify ? <Badge tone="done">On Shopify</Badge> : null}
                  {m.archived ? <Badge>Archived</Badge> : null}
                </span>
              }
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <ShortId value={m.shortId} />
                  <span className="font-medium">{m.optionValue}</span>
                </span>
                <span className="text-sm text-dust-500">
                  {m.name}
                  {m.sku ? ` · ${m.sku}` : ""}
                </span>
              </span>
            </RowLink>
          ))}
        </RowList>
      )}
    </>
  );
}
