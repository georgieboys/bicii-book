import type { Metadata } from "next";

import { NewProductGroupButton } from "@/components/domain/product-group-controls";
import { ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { BoxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { RowLink, RowList } from "@/components/ui/row-list";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { listProductGroups } from "@/lib/domain/product-groups";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Product groups" };

/**
 * Product groups (D241): styles sold as several products, one per colour
 * or size. Online each group is one item with a choice of option (D243).
 * Every staff member sees them; manage_inventory makes them.
 */
export default async function ProductGroupsPage() {
  const staff = await requireStaff();
  const manage = hasPermission(staff, "manage_inventory");
  const groups = await listProductGroups(await createClient(), { includeArchived: true });

  return (
    <>
      <PageHeader
        eyebrow="Products"
        title="Groups"
        description="One style in several colours or sizes. Each product keeps its own stock and labels; online they show as one item with a choice."
        actions={manage ? <NewProductGroupButton /> : null}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={<BoxIcon />}
          title="No groups yet"
          description={
            manage
              ? "Make a group, then add its products from each product's page."
              : "Ask someone with inventory access to make one."
          }
        />
      ) : (
        <RowList label="Product groups">
          {groups.map((g) => (
            <RowLink
              key={g.id}
              href={`/products/groups/${g.id}`}
              after={g.archived ? <Badge>Archived</Badge> : null}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <ShortId value={g.shortId} />
                  <span className="font-medium">{g.name}</span>
                </span>
                <span className="text-sm text-dust-500">
                  {g.memberCount} {g.memberCount === 1 ? "product" : "products"} · by{" "}
                  {g.optionName.toLowerCase()}
                  {g.brand ? ` · ${g.brand}` : ""}
                </span>
              </span>
            </RowLink>
          ))}
        </RowList>
      )}
    </>
  );
}
