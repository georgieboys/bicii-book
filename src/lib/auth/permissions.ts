import { Constants, type Database } from "@/lib/database.types";

/**
 * Permission vocabulary and resolution for the UI and Server Actions. The
 * database is the authority (private.has_permission, RLS, RPC guards); this
 * mirrors it so pages can fail fast with a 403 and hide controls the user
 * cannot use. Pure: safe in Client Components and unit tests.
 */
export type PermissionKey = Database["public"]["Enums"]["permission_key"];
export type StaffRole = Database["public"]["Enums"]["staff_role"];

export const PERMISSIONS: readonly PermissionKey[] = Constants.public.Enums.permission_key;

export const PERMISSION_LABELS: Record<PermissionKey, { label: string; description: string }> = {
  view_costs: {
    label: "View costs",
    description: "See cost, yield and Cult Commons figures on jobs and stock.",
  },
  manage_inventory: {
    label: "Manage inventory",
    description: "Create and edit products, units, transfers and publication.",
  },
  adjust_stock: {
    label: "Adjust stock",
    description: "Record manual stock adjustments and restocks, with a reason.",
  },
  manage_consignments: {
    label: "Manage consignments",
    description: "Consignors, consignment intake, returns and settlements.",
  },
  manage_purchasing: {
    label: "Manage purchasing",
    description: "Suppliers, purchase orders and receiving.",
  },
  manage_staff: {
    label: "Manage staff",
    description: "Invite staff, change permissions, deactivate and reactivate.",
  },
  view_financial_reports: {
    label: "View financial reports",
    description: "Sales, yield and Cult Commons reports.",
  },
};

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export const STAFF_ROLES: readonly StaffRole[] = Constants.public.Enums.staff_role;

/**
 * What each role implies (PLAN D91 ROLE-PERMISSIONS), mirroring
 * private.role_implies: an admin every permission; a manager every
 * permission except manage_staff; a mechanic none. A database test
 * (tests/db/staff-roles.test.ts) proves the two agree for every role and
 * permission.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly PermissionKey[]> = {
  admin: PERMISSIONS,
  manager: PERMISSIONS.filter((p) => p !== "manage_staff"),
  mechanic: [],
};

/** Whether `role` implies `permission` (D91); mirrors private.role_implies. */
export function roleImplies(role: StaffRole, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** The roles in enum order (admin, manager, mechanic), as the screens list them. */
export const ROLES: readonly StaffRole[] = STAFF_ROLES;

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: "Admin",
  manager: "Manager",
  mechanic: "Mechanic",
};

/** One line per role: what it can do (D91, D94). */
export const ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  admin: "Everything, including staff, roles and shop settings",
  manager: "Every permission except Manage staff, plus refunds",
  mechanic: "Workshop work; extra access only if granted",
};

/**
 * A role's label for display, including values read from history: the
 * append-only staff_events payloads written before D90 renamed the enum
 * value keep the text "staff", which is today's mechanic.
 */
export function roleLabel(value: string): string {
  if (value === "staff") return ROLE_LABELS.mechanic;
  return (ROLE_LABELS as Record<string, string>)[value] ?? value;
}

/**
 * Whether `permission` would be an "Extra access" exception for someone
 * with `role` (D92): true when the role does not already imply it.
 */
export function isExceptionFor(role: StaffRole, permission: PermissionKey): boolean {
  return !roleImplies(role, permission);
}

/** The permissions in `permissions` that are exceptions on top of `role` (D92). */
export function exceptionsOf(
  role: StaffRole,
  permissions: readonly PermissionKey[],
): PermissionKey[] {
  return permissions.filter((p) => isExceptionFor(role, p));
}

/** What the DAL hands to pages and actions: no tokens, no Auth internals. */
export type StaffDTO = {
  staffId: string;
  userId: string;
  displayName: string;
  email: string;
  role: StaffRole;
  /** Effective permissions: what the role implies plus exceptions; none when inactive. */
  permissions: PermissionKey[];
  active: boolean;
};

/**
 * Effective permissions, the same rule as private.has_permission (D91):
 * inactive staff have none; active staff have what their role implies plus
 * their exceptions (`granted`), in enum order.
 */
export function effectivePermissions(
  role: StaffRole,
  active: boolean,
  granted: readonly PermissionKey[],
): PermissionKey[] {
  if (!active) return [];
  return PERMISSIONS.filter((p) => roleImplies(role, p) || granted.includes(p));
}

export function hasPermission(
  staff: Pick<StaffDTO, "role" | "active" | "permissions">,
  permission: PermissionKey,
): boolean {
  return effectivePermissions(staff.role, staff.active, staff.permissions).includes(permission);
}

type Actor = Pick<StaffDTO, "staffId" | "role" | "active" | "permissions">;
type Target = { staffId: string; role: StaffRole };

/**
 * Why `actor` may not grant or revoke the exception `permission` on
 * `target`, or null when they may. Mirrors private.authorize_permission_change
 * (the D11 ceiling, restated for roles by D93) plus grant_permission's
 * implied-permission refusal (D92, P0001 permission_implied_by_role):
 *   - a permission the target's role implies is not an exception to grant;
 *   - an admin may change any other exception;
 *   - anyone else needs manage_staff, acts on mechanics only, never on
 *     their own row, never on manage_staff, and only on permissions they
 *     hold themselves, so managing staff never escalates anyone past the
 *     person doing it.
 */
export function permissionChangeBlocker(
  actor: Actor,
  target: Target,
  permission: PermissionKey,
): string | null {
  if (!actor.active) return "Only active staff can change permissions.";
  // grant_permission: private.role_implies(target role, permission).
  if (roleImplies(target.role, permission)) {
    return `Included in the ${ROLE_LABELS[target.role]} role.`;
  }
  // authorize_permission_change: an admin passes every check below.
  if (actor.role === "admin") return null;
  // require_permission('manage_staff').
  if (!hasPermission(actor, "manage_staff")) return "You need the Manage staff permission.";
  // target.id = actor.
  if (target.staffId === actor.staffId) return "Only an admin can change your permissions.";
  // target.role <> 'mechanic' and not an admin (D93).
  if (target.role !== "mechanic") return "Only an admin changes an admin's or a manager's access.";
  // permission = 'manage_staff'.
  if (permission === "manage_staff") return "Only an admin can grant or remove Manage staff.";
  // not private.has_permission(permission).
  if (!hasPermission(actor, permission)) return "You can only grant permissions you have yourself.";
  return null;
}

/**
 * Why `actor` may not deactivate or reactivate `target`, or null when they
 * may. Mirrors set_staff_active (D93): an admin acts on anyone but
 * themselves; anyone else needs manage_staff and acts on mechanics only;
 * nobody deactivates themselves.
 */
export function accessChangeBlocker(actor: Actor, target: Target): string | null {
  if (!actor.active) return "Only active staff can change access.";
  // require_permission('manage_staff') unless private.is_admin().
  if (actor.role !== "admin" && !hasPermission(actor, "manage_staff")) {
    return "You need the Manage staff permission.";
  }
  // target.id = actor and not active.
  if (target.staffId === actor.staffId) return "You can't deactivate yourself.";
  // target.role <> 'mechanic' and not caller_is_admin.
  if (target.role !== "mechanic" && actor.role !== "admin") {
    return "Only an admin changes an admin's or a manager's access.";
  }
  return null;
}

/**
 * Why `actor` may not change `target`'s role, or null when they may.
 * Mirrors update_staff's role branch (D93): only an active admin changes
 * roles, never their own. The last active admin cannot be demoted either
 * (trigger staff_keep_an_active_admin); that needs another active admin to
 * try it, and the database refuses it with 55000.
 */
export function roleChangeBlocker(actor: Actor, target: Target): string | null {
  if (!actor.active) return "Only active staff can change roles.";
  // private.is_admin().
  if (actor.role !== "admin") return "Only an admin changes roles.";
  // target.id = actor.
  if (target.staffId === actor.staffId) return "You can't change your own role.";
  return null;
}

/**
 * The roles `actor` may invite someone as. Mirrors create_staff (D93): an
 * active admin invites any role; another active manage_staff holder
 * invites mechanics only; anyone else invites nobody.
 */
export function invitableRoles(
  actor: Pick<StaffDTO, "role" | "active" | "permissions">,
): StaffRole[] {
  if (!actor.active) return [];
  if (actor.role === "admin") return [...ROLES];
  if (hasPermission(actor, "manage_staff")) return ["mechanic"];
  return [];
}

type AccessSubject = Pick<StaffDTO, "role" | "active" | "permissions">;

/**
 * Consignment money (agreed amounts, charges, item history, liability,
 * the ledger, settlements, a job line's payout snapshot): PLAN D48
 * SALES-ACCESS, mirroring private.can_view_consignment_money(). Active
 * staff with manage_consignments or view_costs; view_financial_reports
 * alone is not enough.
 */
export function canViewConsignmentMoney(staff: AccessSubject): boolean {
  return hasPermission(staff, "manage_consignments") || hasPermission(staff, "view_costs");
}

/**
 * Sale cost, yield, Cult Commons, rate and payout snapshots: D48 (follows
 * D30), mirroring private.can_view_sale_costs(). Active staff with
 * view_costs.
 */
export function canViewSaleCosts(staff: AccessSubject): boolean {
  return hasPermission(staff, "view_costs");
}

/**
 * Recording a retail refund (money going out): D94 REFUND-ROLES (amends
 * D49), mirroring private.can_record_refunds(): an active admin or manager,
 * by role. view_financial_reports is a read permission and never enough,
 * and no exception grants it.
 */
export function canRecordRefund(staff: Pick<StaffDTO, "role" | "active">): boolean {
  return staff.active && (staff.role === "admin" || staff.role === "manager");
}

/**
 * Ordering an indent part before its deposit is paid, with a reason (D152,
 * Phase 14): mirrors the gate in public.order_part_requests, which checks
 * private.can_record_refunds(): an active admin or manager, by role. Manage
 * purchasing alone is not enough, and no exception grants it.
 */
export function canOverrideDeposit(staff: Pick<StaffDTO, "role" | "active">): boolean {
  return canRecordRefund(staff);
}

/**
 * Recording money the shop took at the counter on a job, and voiding it
 * (D161a, Phase 14 step 3): mirrors private.require_admin() in
 * record_counter_payment and void_counter_payment: an active admin, by
 * role. No permission or exception grants it; every active staff member
 * still sees counter payments on the job (D154).
 */
export function canRecordCounterPayment(staff: Pick<StaffDTO, "role" | "active">): boolean {
  return staff.active && staff.role === "admin";
}
