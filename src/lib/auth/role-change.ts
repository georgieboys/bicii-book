import {
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_LABELS,
  canRecordCounterPayment,
  canRecordRefund,
  roleImplies,
  type PermissionKey,
  type StaffRole,
} from "./permissions";

/**
 * The words the Staff screens use for a role change (PLAN D90-D94). Pure:
 * safe in Client Components and unit tests. The database decides; these
 * only say beforehand what it will do.
 */

/** "an Admin", "a Manager", "a Mechanic": for "<name> is now a Manager". */
export function roleWithArticle(role: StaffRole): string {
  const label = ROLE_LABELS[role];
  return `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}`;
}

/** What a person in each role has, one sentence (D91, D94). */
export const ROLE_GRANTS: Record<StaffRole, string> = {
  admin:
    "Admins have every permission, manage staff and roles, change the shop settings, and can record refunds and counter payments.",
  manager: "Managers have every permission except Manage staff, and can record refunds.",
  mechanic: "Mechanics have workshop access only, plus any extra access given to them.",
};

/** "A", "A and B", "A, B and C". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export type RoleChangeSummary = {
  /** Exceptions the new role implies: deleted with the change (D92, trigger staff_role_drop_implied_exceptions). */
  dropped: PermissionKey[];
  /** Exceptions that stay on top of the new role. */
  kept: PermissionKey[];
  /** What the person has today and will not have afterwards, as labels. */
  lost: string[];
  /** The sentences the confirm sheet shows, in order. */
  lines: string[];
};

/**
 * What changing someone from `from` to `to` does, given their exceptions
 * (staff_permissions rows): what the new role has; which exceptions it
 * includes and so removes (a later change back does not restore them,
 * D92); and what they lose (permissions the old role implied that neither
 * the new role nor an exception covers, refunds for admins and managers
 * (D94), counter payments for admins (D161a), and the admin settings).
 */
export function roleChangeSummary(
  from: StaffRole,
  to: StaffRole,
  exceptions: readonly PermissionKey[],
): RoleChangeSummary {
  const dropped = exceptions.filter((p) => roleImplies(to, p));
  const kept = exceptions.filter((p) => !roleImplies(to, p));
  const label = (p: PermissionKey) => PERMISSION_LABELS[p].label;
  const lost = [
    ...PERMISSIONS.filter(
      (p) => roleImplies(from, p) && !roleImplies(to, p) && !exceptions.includes(p),
    ).map(label),
    ...(canRecordRefund({ role: from, active: true }) &&
    !canRecordRefund({ role: to, active: true })
      ? ["Record refunds"]
      : []),
    ...(canRecordCounterPayment({ role: from, active: true }) &&
    !canRecordCounterPayment({ role: to, active: true })
      ? ["Record counter payments"]
      : []),
    ...(from === "admin" && to !== "admin" ? ["Admin settings"] : []),
  ];

  const lines = [ROLE_GRANTS[to]];
  if (dropped.length > 0) {
    lines.push(
      `Their extra access to ${joinList(dropped.map(label))} is included in the new role and will be removed. Changing the role back later does not restore it.`,
    );
  }
  if (lost.length > 0) lines.push(`They will no longer have ${joinList(lost)}.`);
  if (kept.length > 0 && from !== to) {
    lines.push(`Their extra access to ${joinList(kept.map(label))} stays.`);
  }
  return { dropped, kept, lost, lines };
}
