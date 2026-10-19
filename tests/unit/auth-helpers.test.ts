import { describe, expect, it } from "vitest";

import {
  MORE_ITEMS,
  TABS,
  isActive,
  isItemActive,
  isMoreActive,
  moreItemsFor,
} from "@/components/shell/nav";
import {
  PERMISSIONS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  accessChangeBlocker,
  effectivePermissions,
  exceptionsOf,
  hasPermission,
  invitableRoles,
  isExceptionFor,
  isPermissionKey,
  permissionChangeBlocker,
  roleChangeBlocker,
  roleImplies,
  roleLabel,
  type PermissionKey,
  type StaffDTO,
  type StaffRole,
} from "@/lib/auth/permissions";
import { isPublicPath } from "@/lib/auth/routes";
import { greetingFor } from "@/lib/dates";
import { echoValues, formDataToObject } from "@/lib/form-data";
import { newRequestId } from "@/lib/request-id";

describe("permission resolution (mirrors private.has_permission)", () => {
  it("admin implies every permission", () => {
    expect(effectivePermissions("admin", true, [])).toEqual([...PERMISSIONS]);
    expect(hasPermission({ role: "admin", active: true, permissions: [] }, "manage_staff")).toBe(
      true,
    );
  });

  it("a manager has every permission except manage_staff, plus exceptions (D91)", () => {
    expect(effectivePermissions("manager", true, [])).toEqual(
      PERMISSIONS.filter((p) => p !== "manage_staff"),
    );
    expect(effectivePermissions("manager", true, ["manage_staff"])).toEqual([...PERMISSIONS]);
    expect(roleImplies("manager", "manage_staff")).toBe(false);
    expect(roleImplies("admin", "manage_staff")).toBe(true);
    for (const p of PERMISSIONS) expect(roleImplies("mechanic", p), p).toBe(false);
  });

  it("staff have exactly what was granted", () => {
    expect(effectivePermissions("mechanic", true, ["view_costs"])).toEqual(["view_costs"]);
    expect(
      hasPermission(
        { role: "mechanic", active: true, permissions: ["view_costs"] },
        "adjust_stock",
      ),
    ).toBe(false);
  });

  it("inactive staff have none, admins included", () => {
    expect(effectivePermissions("admin", false, [])).toEqual([]);
    expect(effectivePermissions("mechanic", false, ["view_costs"])).toEqual([]);
    expect(
      hasPermission({ role: "admin", active: false, permissions: [...PERMISSIONS] }, "view_costs"),
    ).toBe(false);
  });

  it("recognises only the seven permission keys", () => {
    expect(PERMISSIONS).toHaveLength(7);
    expect(isPermissionKey("view_costs")).toBe(true);
    expect(isPermissionKey("superuser")).toBe(false);
    expect(isPermissionKey(1)).toBe(false);
  });
});

describe("isPublicPath", () => {
  it("opens only the login page, the dev gallery, health checks, quote links and payment links", () => {
    for (const p of ["/login", "/dev/ui", "/api/health", "/quote/abc", "/pay/abc"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of [
      "/",
      "/loginx",
      "/settings",
      "/dev",
      "/api/healthz",
      "/jobs/login",
      "/quote",
      "/quotes/abc",
      "/jobs/quote/abc",
      "/pay",
      "/payments/abc",
      "/payx/abc",
      "/jobs/pay/abc",
    ]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});

describe("newRequestId", () => {
  it("mints a fresh UUID each time (an incoming x-request-id is never kept)", () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newRequestId()).not.toBe(a);
  });
});

describe("formDataToObject", () => {
  it("flattens fields, collects repeats, drops React action keys", () => {
    const fd = new FormData();
    fd.append("email", "a@b.c");
    fd.append("tag", "x");
    fd.append("tag", "y");
    fd.append("$ACTION_ID_abc", "");
    expect(formDataToObject(fd)).toEqual({ email: "a@b.c", tag: ["x", "y"] });
  });
});

describe("navigation", () => {
  it("puts Scan in the middle of five tabs", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Today", "Jobs", "Scan", "Inventory", "More"]);
  });

  it("lists the ten More destinations, Sales and Shopify right after Consignment", () => {
    expect(MORE_ITEMS.map((i) => i.label)).toEqual([
      "Customers",
      "Bikes",
      "Appointments",
      "Consignment",
      "Sales",
      "Shopify",
      "Purchasing",
      "Labels",
      "Reports",
      "Settings",
    ]);
  });

  it("lists the ten destinations for admins and nine for others: Shopify is admin-only (D86)", () => {
    expect(moreItemsFor(true)).toHaveLength(10);
    const others = moreItemsFor(false).map((i) => i.label);
    expect(others).toHaveLength(9);
    expect(others).not.toContain("Shopify");
    expect(MORE_ITEMS.filter((i) => i.adminOnly).map((i) => i.href)).toEqual(["/shopify"]);
    // The More tab still lights up on an admin-only section.
    expect(isMoreActive("/shopify/queue")).toBe(true);
  });

  it("matches sections by prefix, and Today only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/jobs", "/")).toBe(false);
    expect(isActive("/jobs/123", "/jobs")).toBe(true);
    expect(isActive("/jobsx", "/jobs")).toBe(false);
    expect(isMoreActive("/settings/staff")).toBe(true);
    expect(isMoreActive("/inventory")).toBe(false);
    expect(isMoreActive("/sales/123")).toBe(true);
  });

  it("keeps the Inventory tab active on products, units and movements", () => {
    const inventory = TABS.find((t) => t.label === "Inventory")!;
    for (const path of ["/inventory", "/inventory/movements", "/products/p1", "/units/u1"]) {
      expect(isItemActive(path, inventory)).toBe(true);
      expect(isMoreActive(path)).toBe(false);
    }
    expect(isItemActive("/productsx", inventory)).toBe(false);
    expect(isItemActive("/jobs", inventory)).toBe(false);
    const jobs = TABS.find((t) => t.label === "Jobs")!;
    expect(isItemActive("/jobs/1", jobs)).toBe(true);
  });
});

describe("greetingFor", () => {
  it("uses the shop's time zone (Asia/Singapore, UTC+8)", () => {
    expect(greetingFor("2026-10-04T01:00:00Z")).toBe("Good morning"); // 09:00 SGT
    expect(greetingFor("2026-10-04T05:00:00Z")).toBe("Good afternoon"); // 13:00 SGT
    expect(greetingFor("2026-10-04T12:00:00Z")).toBe("Good evening"); // 20:00 SGT
  });
});

describe("roles (D90, D91, mirrors private.role_implies)", () => {
  // The full table: 3 roles x 7 permissions. tests/db/staff-roles.test.ts
  // proves private.role_implies gives the same answers.
  const table: Record<StaffRole, Record<PermissionKey, boolean>> = {
    admin: {
      view_costs: true,
      manage_inventory: true,
      adjust_stock: true,
      manage_consignments: true,
      manage_purchasing: true,
      manage_staff: true,
      view_financial_reports: true,
    },
    manager: {
      view_costs: true,
      manage_inventory: true,
      adjust_stock: true,
      manage_consignments: true,
      manage_purchasing: true,
      manage_staff: false,
      view_financial_reports: true,
    },
    mechanic: {
      view_costs: false,
      manage_inventory: false,
      adjust_stock: false,
      manage_consignments: false,
      manage_purchasing: false,
      manage_staff: false,
      view_financial_reports: false,
    },
  };

  it("lists the three roles in enum order with labels and one-line descriptions", () => {
    expect(ROLES).toEqual(["admin", "manager", "mechanic"]);
    expect(ROLE_LABELS).toEqual({ admin: "Admin", manager: "Manager", mechanic: "Mechanic" });
    expect(ROLE_DESCRIPTIONS).toEqual({
      admin: "Everything, including staff, roles and shop settings",
      manager: "Every permission except Manage staff, plus refunds",
      mechanic: "Workshop work; extra access only if granted",
    });
  });

  for (const role of ["admin", "manager", "mechanic"] as const) {
    for (const p of PERMISSIONS) {
      it(`${role} ${table[role][p] ? "implies" : "does not imply"} ${p}`, () => {
        expect(roleImplies(role, p)).toBe(table[role][p]);
        expect(isExceptionFor(role, p)).toBe(!table[role][p]);
      });
    }
  }

  it('reads the legacy history value "staff" as Mechanic, and every role by its label', () => {
    expect(roleLabel("staff")).toBe("Mechanic");
    expect(roleLabel("mechanic")).toBe("Mechanic");
    expect(roleLabel("manager")).toBe("Manager");
    expect(roleLabel("admin")).toBe("Admin");
  });

  it("effective permissions per role, with and without exceptions, and none when inactive", () => {
    expect(effectivePermissions("admin", true, [])).toEqual([...PERMISSIONS]);
    expect(effectivePermissions("manager", true, [])).toEqual(
      PERMISSIONS.filter((p) => p !== "manage_staff"),
    );
    expect(effectivePermissions("manager", true, ["manage_staff"])).toEqual([...PERMISSIONS]);
    expect(effectivePermissions("mechanic", true, [])).toEqual([]);
    expect(effectivePermissions("mechanic", true, ["manage_purchasing", "view_costs"])).toEqual([
      "view_costs",
      "manage_purchasing",
    ]);
    for (const role of ROLES) {
      expect(effectivePermissions(role, false, [...PERMISSIONS]), role).toEqual([]);
    }
  });

  it("exceptionsOf keeps only what the role does not imply", () => {
    expect(exceptionsOf("admin", [...PERMISSIONS])).toEqual([]);
    expect(exceptionsOf("manager", [...PERMISSIONS])).toEqual(["manage_staff"]);
    expect(exceptionsOf("mechanic", ["view_costs", "manage_purchasing"])).toEqual([
      "view_costs",
      "manage_purchasing",
    ]);
  });
});

describe("delegation ceiling (mirrors private.authorize_permission_change and grant_permission, D11, D92, D93)", () => {
  const actor = (
    role: StaffRole,
    permissions: StaffDTO["permissions"] = effectivePermissions(role, true, []),
    active = true,
  ) => ({ staffId: "me", role, active, permissions });
  const mechanic = { staffId: "them", role: "mechanic" as const };
  const manager = { staffId: "boss", role: "manager" as const };
  const admin = { staffId: "owner", role: "admin" as const };

  it("a permission the target's role implies is never an exception to grant", () => {
    for (const p of PERMISSIONS.filter((p) => p !== "manage_staff")) {
      expect(permissionChangeBlocker(actor("admin"), manager, p)).toBe(
        "Included in the Manager role.",
      );
    }
    for (const p of PERMISSIONS) {
      expect(permissionChangeBlocker(actor("admin"), admin, p)).toBe("Included in the Admin role.");
    }
  });

  it("an admin may change any exception: a mechanic's, and a manager's manage_staff", () => {
    for (const p of PERMISSIONS) {
      expect(permissionChangeBlocker(actor("admin"), mechanic, p)).toBeNull();
    }
    expect(permissionChangeBlocker(actor("admin"), manager, "manage_staff")).toBeNull();
  });

  it("a manager without the exception changes nothing", () => {
    expect(permissionChangeBlocker(actor("manager"), mechanic, "view_costs")).toBe(
      "You need the Manage staff permission.",
    );
  });

  it("a non-admin manage_staff holder acts on mechanics only, within what they hold", () => {
    const holder = actor("mechanic", ["manage_staff", "adjust_stock"]);
    expect(permissionChangeBlocker(holder, mechanic, "adjust_stock")).toBeNull();
    expect(permissionChangeBlocker(holder, mechanic, "view_costs")).toBe(
      "You can only grant permissions you have yourself.",
    );
    expect(permissionChangeBlocker(holder, mechanic, "manage_staff")).toBe(
      "Only an admin can grant or remove Manage staff.",
    );
    expect(
      permissionChangeBlocker(holder, { staffId: "me", role: "mechanic" }, "adjust_stock"),
    ).toBe("Only an admin can change your permissions.");
    expect(permissionChangeBlocker(holder, manager, "manage_staff")).toBe(
      "Only an admin changes an admin's or a manager's access.",
    );
    expect(permissionChangeBlocker(holder, manager, "adjust_stock")).toBe(
      "Included in the Manager role.",
    );
  });

  it("a manager granted manage_staff acts on mechanics only, never on another manager", () => {
    const holder = actor("manager", [...PERMISSIONS]);
    expect(permissionChangeBlocker(holder, mechanic, "view_costs")).toBeNull();
    expect(permissionChangeBlocker(holder, mechanic, "manage_staff")).toBe(
      "Only an admin can grant or remove Manage staff.",
    );
    expect(permissionChangeBlocker(holder, manager, "manage_staff")).toBe(
      "Only an admin changes an admin's or a manager's access.",
    );
    expect(
      permissionChangeBlocker(holder, { staffId: "me", role: "manager" }, "manage_staff"),
    ).toBe("Only an admin can change your permissions.");
  });

  it("staff without manage_staff, and inactive staff, change nothing", () => {
    expect(permissionChangeBlocker(actor("mechanic", ["view_costs"]), mechanic, "view_costs")).toBe(
      "You need the Manage staff permission.",
    );
    expect(permissionChangeBlocker(actor("admin", [], false), mechanic, "view_costs")).toBe(
      "Only active staff can change permissions.",
    );
  });

  it("access: nobody deactivates themselves; only admins change an admin's or a manager's", () => {
    const holder = actor("mechanic", ["manage_staff"]);
    expect(accessChangeBlocker(holder, mechanic)).toBeNull();
    expect(accessChangeBlocker(holder, { staffId: "me", role: "mechanic" })).toBe(
      "You can't deactivate yourself.",
    );
    expect(accessChangeBlocker(holder, admin)).toBe(
      "Only an admin changes an admin's or a manager's access.",
    );
    expect(accessChangeBlocker(holder, manager)).toBe(
      "Only an admin changes an admin's or a manager's access.",
    );
    expect(accessChangeBlocker(actor("manager", [...PERMISSIONS]), manager)).toBe(
      "Only an admin changes an admin's or a manager's access.",
    );
    expect(accessChangeBlocker(actor("manager"), mechanic)).toBe(
      "You need the Manage staff permission.",
    );
    expect(accessChangeBlocker(actor("admin"), admin)).toBeNull();
    expect(accessChangeBlocker(actor("admin"), manager)).toBeNull();
    expect(accessChangeBlocker(actor("admin"), { staffId: "me", role: "admin" })).toBe(
      "You can't deactivate yourself.",
    );
    expect(accessChangeBlocker(actor("admin", [], false), mechanic)).toBe(
      "Only active staff can change access.",
    );
  });

  it("roles: only an active admin changes them, never their own (mirrors update_staff)", () => {
    expect(roleChangeBlocker(actor("admin"), mechanic)).toBeNull();
    expect(roleChangeBlocker(actor("admin"), manager)).toBeNull();
    expect(roleChangeBlocker(actor("admin"), admin)).toBeNull();
    expect(roleChangeBlocker(actor("admin"), { staffId: "me", role: "admin" })).toBe(
      "You can't change your own role.",
    );
    expect(roleChangeBlocker(actor("manager", [...PERMISSIONS]), mechanic)).toBe(
      "Only an admin changes roles.",
    );
    expect(roleChangeBlocker(actor("mechanic", ["manage_staff"]), mechanic)).toBe(
      "Only an admin changes roles.",
    );
    expect(roleChangeBlocker(actor("admin", [], false), mechanic)).toBe(
      "Only active staff can change roles.",
    );
  });

  it("invites: an admin any role; another manage_staff holder mechanics only (mirrors create_staff)", () => {
    expect(invitableRoles(actor("admin"))).toEqual(["admin", "manager", "mechanic"]);
    expect(invitableRoles(actor("manager", [...PERMISSIONS]))).toEqual(["mechanic"]);
    expect(invitableRoles(actor("mechanic", ["manage_staff"]))).toEqual(["mechanic"]);
    expect(invitableRoles(actor("manager"))).toEqual([]);
    expect(invitableRoles(actor("mechanic", []))).toEqual([]);
    expect(invitableRoles(actor("admin", [], false))).toEqual([]);
  });
});

describe("echoValues", () => {
  it("returns text fields to refill a form, never secrets or React's action keys", () => {
    const fd = new FormData();
    fd.set("displayName", "Priya Ramesh");
    fd.set("email", "priya-at-bicii");
    fd.set("password", "hunter2hunter2");
    fd.set("confirm", "hunter2hunter2");
    fd.set("currentPassword", "old");
    fd.set("pin", "1234");
    fd.set("$ACTION_ID_abc", "");
    fd.set("photo", new File(["x"], "x.jpg"));
    expect(echoValues(fd)).toEqual({
      displayName: "Priya Ramesh",
      email: "priya-at-bicii",
    });
  });
});
