import type { Metadata } from "next";

import {
  ArchiveBuildPackageButton,
  EditBuildPackageButton,
  NewBuildPackageButton,
} from "@/components/domain/build-package-controls";
import { ArchivedFilter } from "@/components/domain/list-filter";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { WrenchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaff } from "@/lib/auth/session";
import {
  BUILD_KIND_LABEL,
  listBuildPackages,
  type BuildPackageKind,
} from "@/lib/domain/build-packages";
import { listActiveServices } from "@/lib/domain/services";
import { formatMoney } from "@/lib/money";
import { readFlag } from "@/lib/search-params";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Build packages" };

const KINDS: BuildPackageKind[] = ["full_build", "build_only"];

/**
 * Build packages (D246): every staff member sees them; admins add, edit
 * and archive. A full build's labour amount is service revenue and the
 * rest of its price the parts budget (D249).
 */
export default async function BuildPackagesPage({
  searchParams,
}: PageProps<"/settings/build-packages">) {
  const staff = await requireStaff();
  const archived = readFlag((await searchParams).archived);
  const admin = staff.role === "admin";
  const supabase = await createClient();
  const [all, services] = await Promise.all([
    listBuildPackages(supabase, { includeArchived: true }),
    admin ? listActiveServices(supabase, { viewCosts: false }) : Promise.resolve([]),
  ]);
  const packages = all.filter((p) => p.archived === archived);
  const serviceChoices = services.map((s) => ({ id: s.id, name: s.name }));

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Build packages"
        description="Builds sold at one price. On a full build, the labour amount is service revenue and the rest is the parts budget."
        actions={admin && !archived ? <NewBuildPackageButton services={serviceChoices} /> : null}
      />
      <ArchivedFilter
        basePath="/settings/build-packages"
        q=""
        archived={archived}
        label="Show packages"
      />
      {packages.length === 0 ? (
        <EmptyState
          icon={<WrenchIcon />}
          title={archived ? "No archived packages" : "No packages yet"}
          description={
            archived
              ? "Archived packages appear here and can be brought back."
              : admin
                ? "Add the full builds and build-only packages the workshop sells."
                : "Ask an admin to add the workshop's build packages."
          }
        />
      ) : (
        KINDS.map((kind) => {
          const rows = packages.filter((p) => p.kind === kind);
          if (rows.length === 0) return null;
          return (
            <section key={kind} aria-labelledby={`kind-${kind}`} className="flex flex-col gap-2">
              <h2 id={`kind-${kind}`} className="eyebrow text-dust-500">
                {BUILD_KIND_LABEL[kind]}
              </h2>
              <ul
                aria-label={BUILD_KIND_LABEL[kind]}
                className="divide-y divide-hairline rounded-2xl border border-hairline bg-card"
              >
                {rows.map((p) => (
                  <li key={p.id} className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3">
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.archived ? <Badge tone="waiting">Archived</Badge> : null}
                        {!p.public ? <Badge tone="info">Not on the site</Badge> : null}
                      </span>
                      <span className="text-sm text-dust-500">
                        {kind === "full_build"
                          ? `Labour ${formatMoney(p.labourAmount, p.currency)} · parts budget ${formatMoney(
                              String(Number(p.price) - Number(p.labourAmount)),
                              p.currency,
                            )}`
                          : `Labour ${formatMoney(p.labourAmount, p.currency)}`}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">
                      {p.priceIsFrom ? "From " : ""}
                      {formatMoney(p.price, p.currency)}
                    </span>
                    {admin ? (
                      <span className="flex gap-2">
                        {!p.archived ? (
                          <EditBuildPackageButton pkg={p} services={serviceChoices} />
                        ) : null}
                        <ArchiveBuildPackageButton id={p.id} archived={p.archived} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}
