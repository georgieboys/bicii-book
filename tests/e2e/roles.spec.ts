import { expect, test, type Page } from "@playwright/test";

import { SALE, SALE_NUMBER, STAFF, WORK_ORDER } from "../fixtures/ids";
import { section, signIn, signInAs, tagFor, toast } from "./helpers";
import { expectNoSideScroll } from "./purchasing-helpers";

/**
 * Staff roles (PLAN D90-D94) on a phone and an iPad: what a manager sees
 * and does (costs, Money on Today, refunds; no Staff settings), what a
 * mechanic does not, and an admin changing a colleague's role with the
 * change, the dropped extra access and the reason in their history. Every
 * record a test creates carries tagFor(testInfo); seeded records are only
 * read.
 */

/** The seeded job J-000002 (priyaDomaneReady): $300.00 sale, cost lines. */
const SEEDED_JOB = WORK_ORDER.priyaDomaneReady;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A counted product with `stock` at the Shop floor, made by whoever is signed in. */
async function stockedProduct(page: Page, name: string, sku: string, stock: number) {
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New product" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New product" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("SKU").fill(sku);
  await sheet.getByLabel("Sale price", { exact: true }).fill("20.00");
  await sheet.getByLabel("Cost", { exact: true }).fill("8.00");
  await sheet.getByRole("button", { name: "Add product" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

  const stockCard = section(page, "Stock");
  await stockCard.getByRole("button", { name: "Adjust stock" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust stock" });
  await adjust.getByLabel("Quantity").fill(String(stock));
  await adjust.getByRole("button", { name: "Opening stock count" }).click();
  await adjust.getByRole("button", { name: "Save adjustment" }).click();
  await expect(toast(page, `Stock saved. Shop floor: ${stock}`)).toBeVisible();
}

test("a manager sees costs and financial screens and records a refund but cannot manage staff", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await signIn(page, "manager");

  // Today shows Money (view_financial_reports, from the role).
  await expect(page.getByRole("heading", { name: "Right now", exact: true })).toBeVisible();
  await expect(section(page, "Money")).toBeVisible();

  // A job shows its cost and yield (view_costs, from the role).
  await page.goto(`/jobs/${SEEDED_JOB}`);
  const totals = page.getByLabel("Totals", { exact: true });
  await expect(totals).toContainText("Cost");
  await expect(totals).toContainText("Cult Commons (30%)");

  // Staff settings are not theirs: no row in Settings, a 403 by URL.
  await page.goto("/settings");
  const settings = page.getByRole("main");
  await expect(settings.getByRole("link", { name: /^Your profile/ })).toBeVisible();
  await expect(settings.getByRole("link", { name: /^Staff/ })).toHaveCount(0);
  const response = await page.goto("/settings/staff");
  expect(response?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "You can't open this" })).toBeVisible();

  // Their own product (manage_inventory, adjust_stock), sold, then partly
  // refunded with a reason (D94: admins and managers).
  const tag = tagFor(testInfo);
  const name = `Role test pads ${tag}`;
  const sku = `ROLE-${tag}`;
  await stockedProduct(page, name, sku, 3);
  await page.goto("/sales");
  await page.getByRole("button", { name: "New sale" }).click();
  const sheet = page.getByRole("dialog", { name: "New sale" });
  await sheet.getByRole("combobox").first().fill(sku);
  await sheet
    .getByRole("option", { name: new RegExp(escapeRegExp(name)) })
    .first()
    .click();
  await expect(sheet.getByRole("region", { name: "Preview" })).toContainText("$12.00");
  await sheet.getByRole("button", { name: "Record sale · $20.00" }).click();
  await expect(toast(page, /^S-\d{6} recorded$/)).toBeVisible();
  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}$/);

  await page.getByRole("button", { name: "Record refund" }).click();
  const refund = page.getByRole("dialog", { name: "Record refund" });
  await refund.getByLabel("Amount").fill("6");
  await refund.getByRole("button", { name: "Record refund of $6.00…" }).click();
  await refund.getByLabel("Why is it being refunded?").fill("Manager goodwill credit");
  await page.waitForTimeout(500);
  await refund.getByRole("button", { name: "Refund $6.00" }).click();
  await expect(toast(page, "Refund of $6.00 recorded")).toBeVisible();
  await expect(page.getByRole("list", { name: "Refunds" })).toContainText(
    "Manager goodwill credit",
  );

  // Their profile names the role and what it includes.
  await page.goto("/settings/profile");
  const card = section(page, "Your role and access");
  await expect(card.getByText("Manager", { exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "Your permissions" });
  await expect(list).toContainText("View costs");
  await expect(list).toContainText("View financial reports");
  await expect(list).toContainText("Record refunds");
  await expect(list).not.toContainText("Manage staff");
  await expect(list).not.toContainText("Admin settings");
});

test("a mechanic does not see costs or money, record refunds or manage staff", async ({ page }) => {
  await signIn(page, "mechanic2");

  await expect(page.getByRole("heading", { name: "Right now", exact: true })).toBeVisible();
  await expect(section(page, "Money")).toHaveCount(0);

  await page.goto(`/jobs/${SEEDED_JOB}`);
  const totals = page.getByLabel("Totals", { exact: true });
  await expect(totals).toContainText(/Total\s*\$300\.00/);
  await expect(totals).not.toContainText("Cost");
  await expect(page.getByText(/Cult Commons|Yield|Unit cost/)).toHaveCount(0);

  // A seeded sale opens, without Record refund.
  await page.goto(`/sales/${SALE.jerseyToday}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SALE_NUMBER.jerseyToday);
  await expect(page.getByRole("button", { name: "Record refund" })).toHaveCount(0);

  const response = await page.goto("/settings/staff");
  expect(response?.status()).toBe(403);

  await page.goto("/settings/profile");
  const card = section(page, "Your role and access");
  await expect(card.getByText("Mechanic", { exact: true })).toBeVisible();
  await expect(card).toContainText("Workshop access only");
  await expect(card).not.toContainText("Record refunds");
});

test("an admin changes a role and the change shows in history", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = tagFor(testInfo);
  const name = `Rosa ${tag}`;
  const email = `e2e-role-${testInfo.project.name}-${Date.now()}@bicii.test`;
  const reason = `Runs the floor on weekends ${tag}`;

  // The narrowest phone the Admin supports (an iPhone SE, 375 px), so the
  // side-scroll checks below hold for it as well as the iPhone 13 project.
  if (testInfo.project.name === "phone") await page.setViewportSize({ width: 375, height: 667 });
  await signIn(page, "admin");

  // Their own row: the picker is there but off, with the reason.
  await page.goto(`/settings/staff/${STAFF.admin}`);
  const ownRoles = section(page, "Role").getByRole("radiogroup", { name: "Role" });
  for (const role of ["Admin", "Manager", "Mechanic"]) {
    await expect(ownRoles.getByRole("radio", { name: role })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  await expect(section(page, "Role")).toContainText("You can't change your own role.");
  await expect(page.getByRole("button", { name: "Change role…" })).toBeDisabled();
  await expect(section(page, "Extra access")).toContainText(
    "Admins have every permission; there is nothing extra to grant.",
  );
  await expectNoSideScroll(page);

  // Invite a colleague: an admin picks the role; Mechanic is chosen first.
  await page.goto("/settings/staff/new");
  const inviteRoles = page.getByRole("radiogroup", { name: "Role" });
  await expect(inviteRoles.getByRole("radio")).toHaveText(["Admin", "Manager", "Mechanic"]);
  await expect(inviteRoles.getByRole("radio", { name: "Mechanic" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The role picker and each role's description fit the phone.
  await expectNoSideScroll(page);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `${email} can now sign in.` }),
  ).toBeVisible();
  await expect(page.getByText("They join as a Mechanic.")).toBeVisible();
  await page.getByRole("link", { name: "Set extra access" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.locator("header").getByText("Mechanic", { exact: true })).toBeVisible();
  const history = page.getByRole("list", { name: "Staff history" });
  await expect(history).toContainText("Added as Mechanic");

  // Extra access on top of the Mechanic role.
  const extra = section(page, "Extra access");
  // The seven from SPEC §4.2 and the three adventure permissions (D169).
  await expect(extra.getByRole("switch")).toHaveCount(10);
  await extra.getByRole("switch", { name: "Manage purchasing" }).click();
  await expect(toast(page, "Manage purchasing granted")).toBeVisible();
  await expect(history).toContainText("Extra access: Manage purchasing granted");
  // The person page (role picker, extra access, access, history) fits a phone.
  await expectNoSideScroll(page);

  // Change the role to Manager, with a reason.
  const roles = section(page, "Role").getByRole("radiogroup", { name: "Role" });
  await expect(roles.getByRole("radio", { name: "Mechanic" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await roles.getByRole("radio", { name: "Manager" }).click();
  await page.getByRole("button", { name: "Change role…" }).click();
  const sheet = page.getByRole("dialog", { name: `Change ${name} to Manager?` });
  await expect(sheet).toContainText(
    "Managers have every permission except Manage staff, and can record refunds.",
  );
  await expect(sheet).toContainText(
    "Their extra access to Manage purchasing is included in the new role and will be removed.",
  );
  // Focus starts on Cancel, not in the optional reason (DESIGN.md "Forms").
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectNoSideScroll(page);
  await sheet.getByLabel("Why?").fill(reason);
  await sheet.getByRole("button", { name: "Change role", exact: true }).click();
  await expect(toast(page, `${name} is now a Manager`)).toBeVisible();
  await expect(sheet).toBeHidden();

  await expect(page.locator("header").getByText("Manager", { exact: true })).toBeVisible();
  await expect(extra.getByRole("switch", { name: "Manage purchasing" })).toHaveCount(0);
  await expect(extra.getByRole("switch")).toHaveCount(1);
  await expect(extra.getByRole("switch", { name: "Manage staff" })).toBeVisible();
  await expect(extra).toContainText("Included in the Manager role:");
  await expect(extra).toContainText("Manage purchasing");

  const roleChange = history.getByRole("listitem").filter({ hasText: "Role changed" });
  await expect(roleChange).toHaveCount(1);
  await expect(roleChange).toContainText("Role changed from Mechanic to Manager");
  await expect(roleChange).toContainText(reason);
  await expect(roleChange).toContainText("Asha Admin");
  await expect(
    history.getByRole("listitem").filter({ hasText: "Extra access: Manage purchasing removed" }),
  ).toContainText(reason);

  // The list shows the new role.
  await page.goto("/settings/staff");
  const row = page.getByRole("link", { name: new RegExp(escapeRegExp(email)) });
  await expect(row).toContainText("Manager");
  await expect(row).toContainText("Every permission except Manage staff");

  // The colleague signs in and sees Manager on their profile.
  const colleague = await browser.newContext({ ...testInfo.project.use });
  const colleaguePage = await colleague.newPage();
  try {
    await signInAs(colleaguePage, email, "/settings/profile");
    const card = section(colleaguePage, "Your role and access");
    await expect(card.getByText("Manager", { exact: true })).toBeVisible();
    await expect(card).toContainText("Record refunds");
  } finally {
    await colleague.close();
  }

  // Leave nobody extra active: deactivate them again, with a reason.
  await row.click();
  await page.getByRole("button", { name: "Deactivate…" }).click();
  await page.getByLabel(/Why are you deactivating/).fill(`E2E: done ${tag}`);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: `Deactivate ${name}` }).click();
  await expect(toast(page, `${name} deactivated`)).toBeVisible();
});
