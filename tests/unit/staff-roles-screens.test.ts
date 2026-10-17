import { describe, expect, it } from "vitest";

import { joinList, roleChangeSummary, roleWithArticle } from "@/lib/auth/role-change";
import { describeStaffEvent, type StaffEventLike } from "@/lib/staff-events";

/**
 * The words the Staff screens use for roles (PLAN D90-D94): the history
 * lines (including the pre-D90 value "staff"), the toast's article and
 * what the "Change role" sheet says will change.
 */

const event = (e: Partial<StaffEventLike> & Pick<StaffEventLike, "type">): StaffEventLike => ({
  permission: null,
  payload: {},
  ...e,
});

describe("staff history lines", () => {
  it("names the role someone was added as, reading the legacy 'staff' as Mechanic", () => {
    expect(describeStaffEvent(event({ type: "created", payload: { role: "manager" } }))).toBe(
      "Added as Manager",
    );
    expect(describeStaffEvent(event({ type: "created", payload: { role: "staff" } }))).toBe(
      "Added as Mechanic",
    );
    expect(describeStaffEvent(event({ type: "created", payload: { role: "admin" } }))).toBe(
      "Added as Admin",
    );
    expect(describeStaffEvent(event({ type: "created" }))).toBe("Added");
  });

  it("says a role change from and to, by label", () => {
    const changed = (from: unknown, to: unknown) =>
      describeStaffEvent(event({ type: "role_changed", payload: { role: { from, to } } }));
    expect(changed("mechanic", "manager")).toBe("Role changed from Mechanic to Manager");
    expect(changed("staff", "admin")).toBe("Role changed from Mechanic to Admin");
    expect(changed("admin", "staff")).toBe("Role changed from Admin to Mechanic");
    expect(changed(undefined, "manager")).toBe("Role changed to Manager");
    expect(describeStaffEvent(event({ type: "role_changed" }))).toBe("Role changed");
  });

  it("marks permission events as extra access", () => {
    expect(
      describeStaffEvent(event({ type: "permission_granted", permission: "manage_purchasing" })),
    ).toBe("Extra access: Manage purchasing granted");
    expect(
      describeStaffEvent(event({ type: "permission_revoked", permission: "manage_staff" })),
    ).toBe("Extra access: Manage staff removed");
  });

  it("keeps the other events short", () => {
    expect(describeStaffEvent(event({ type: "deactivated" }))).toBe("Deactivated");
    expect(describeStaffEvent(event({ type: "reactivated" }))).toBe("Reactivated");
    expect(describeStaffEvent(event({ type: "details_changed" }))).toBe("Details changed");
  });
});

describe("role change wording", () => {
  it("uses the right article for the toast", () => {
    expect(roleWithArticle("admin")).toBe("an Admin");
    expect(roleWithArticle("manager")).toBe("a Manager");
    expect(roleWithArticle("mechanic")).toBe("a Mechanic");
  });

  it("joins lists the way the screens write them", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["A"])).toBe("A");
    expect(joinList(["A", "B"])).toBe("A and B");
    expect(joinList(["A", "B", "C"])).toBe("A, B and C");
  });

  it("mechanic to manager: what managers have, and the exceptions the role now includes go", () => {
    const s = roleChangeSummary("mechanic", "manager", ["manage_purchasing", "view_costs"]);
    expect(s.dropped).toEqual(["manage_purchasing", "view_costs"]);
    expect(s.kept).toEqual([]);
    expect(s.lost).toEqual([]);
    expect(s.lines).toEqual([
      "Managers have every permission except Manage staff, and can record refunds.",
      "Their extra access to Manage purchasing and View costs is included in the new role and will be removed. Changing the role back later does not restore it.",
    ]);
  });

  it("mechanic with Manage staff to manager: that exception stays on top", () => {
    const s = roleChangeSummary("mechanic", "manager", ["manage_staff", "adjust_stock"]);
    expect(s.dropped).toEqual(["adjust_stock"]);
    expect(s.kept).toEqual(["manage_staff"]);
    expect(s.lines.at(-1)).toBe("Their extra access to Manage staff stays.");
  });

  it("manager to mechanic: what they lose, refunds included", () => {
    const s = roleChangeSummary("manager", "mechanic", []);
    expect(s.dropped).toEqual([]);
    expect(s.lost).toEqual([
      "View costs",
      "Manage inventory",
      "Adjust stock",
      "Manage consignments",
      "Manage purchasing",
      "View financial reports",
      "Record refunds",
    ]);
    expect(s.lines[0]).toBe(
      "Mechanics have workshop access only, plus any extra access given to them.",
    );
    expect(s.lines[1]).toMatch(/^They will no longer have View costs, .* and Record refunds\.$/);
  });

  it("manager with Manage staff to admin: the exception is included, nothing is lost", () => {
    const s = roleChangeSummary("manager", "admin", ["manage_staff"]);
    expect(s.dropped).toEqual(["manage_staff"]);
    expect(s.lost).toEqual([]);
  });

  it("admin to manager: Manage staff, counter payments and the admin settings go, refunds stay", () => {
    const s = roleChangeSummary("admin", "manager", []);
    expect(s.lost).toEqual(["Manage staff", "Record counter payments", "Admin settings"]);
    expect(s.lines).toContain(
      "They will no longer have Manage staff, Record counter payments and Admin settings.",
    );
  });

  it("admin to mechanic: counter payments go with refunds (D161a)", () => {
    const s = roleChangeSummary("admin", "mechanic", []);
    expect(s.lost.slice(-3)).toEqual([
      "Record refunds",
      "Record counter payments",
      "Admin settings",
    ]);
  });

  it("to admin: what admins have names counter payments", () => {
    expect(roleChangeSummary("manager", "admin", []).lines[0]).toBe(
      "Admins have every permission, manage staff and roles, change the shop settings, and can record refunds and counter payments.",
    );
  });
});
