import type { Metadata } from "next";

import { CategoriesEditor } from "@/components/domain/categories-card";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TagIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { hasPermission } from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";
import { listCategories } from "@/lib/domain/services";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Product categories" };

/**
 * Product categories (SPEC §11): the groups New product and Edit details
 * offer. Every staff member sees the active ones; manage_inventory adds,
 * renames, archives and brings them back with the same editor as service
 * categories (categories of kind 'product'). Nothing is ever deleted: a
 * product filed under an archived category keeps it.
 */
export default async function ProductCategoriesPage() {
  const staff = await requireStaff();
  const manage = hasPermission(staff, "manage_inventory");
  const categories = await listCategories(await createClient(), {
    kind: "product",
    includeArchived: manage,
  });

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Product categories"
        description="How inventory products are grouped, such as tubes, brake pads or complete bikes. New product offers them."
      />
      {manage ? (
        <Card title="Categories">
          <CategoriesEditor categories={categories} kind="product" />
        </Card>
      ) : categories.length === 0 ? (
        <EmptyState
          icon={<TagIcon />}
          title="No product categories yet"
          description="Someone with inventory access adds them."
        />
      ) : (
        <ul
          aria-label="Categories"
          className="divide-y divide-hairline rounded-2xl border border-hairline bg-card"
        >
          {categories.map((c) => (
            <li key={c.id} className="flex min-h-tap items-center px-4 py-3 font-medium">
              {c.name}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
