import { expect, test } from "@playwright/test";

import { createProduct, section, signIn, tagFor, toast } from "./helpers";

/**
 * D162 Change owner, on a phone and an iPad: stock entered as the shop's
 * that is really a consignor's becomes consigned stock on the same product
 * (its P- number stays), and only an admin, the highest role, is offered
 * it. Every record carries tagFor(testInfo).
 */

test("an admin makes shop stock a consignor's on the same product", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagFor(testInfo);
  const consignorName = `Consignor ${tag}`;
  const name = `Bar tape ${tag}`;

  await signIn(page, "admin");

  // 1. A consignor.
  await page.goto("/consignment");
  await page.getByRole("button", { name: "New consignor" }).first().click();
  const consignorSheet = page.getByRole("dialog", { name: "New consignor" });
  await consignorSheet
    .getByRole("textbox", { name: "Name (required)", exact: true })
    .fill(consignorName);
  await consignorSheet.getByRole("button", { name: "Create consignor" }).click();
  await expect(page).toHaveURL(/\/consignment\/consignors\/[0-9a-f-]{36}$/);

  // 2. The consignor's items entered by mistake as the shop's: a product
  // and an opening count of 5.
  const product = await createProduct(page, {
    name,
    sku: `BT-${tag}`,
    price: "20.00",
    cost: "8.00",
  });
  const stock = section(page, "Stock");
  await stock.getByRole("button", { name: "Adjust stock" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust stock" });
  await adjust.getByLabel("Quantity").fill("5");
  await adjust.getByRole("button", { name: "Opening stock count" }).click();
  await adjust.getByRole("button", { name: "Save adjustment" }).click();
  await expect(toast(page, "Stock saved. Shop floor: 5")).toBeVisible();

  // 3. A manager is not offered Change owner.
  const manager = await browser.newContext({ ...testInfo.project.use });
  const managerPage = await manager.newPage();
  await signIn(managerPage, "manager", new URL(product.url).pathname);
  await expect(managerPage.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(managerPage.getByRole("button", { name: "Adjust stock" })).toBeVisible();
  await expect(managerPage.getByRole("button", { name: "Change owner" })).toHaveCount(0);
  await manager.close();

  // 4. The admin changes the owner: the cost and price to start with.
  await page.getByRole("button", { name: "Change owner" }).click();
  const sheet = page.getByRole("dialog", { name: "Change owner" });
  await expect(sheet.getByText(/Its 5 at Shop floor leave the shop's stock/)).toBeVisible();
  await expect(sheet.getByLabel("Amount owed to the consignor when it sells")).toHaveValue("8.00");
  await expect(sheet.getByLabel("Asking price")).toHaveValue("20.00");
  await sheet.getByRole("button", { name: "Make it consigned stock" }).click();
  await expect(sheet.getByText("Choose the consignor.")).toBeVisible();
  await sheet.getByRole("combobox").fill(consignorName);
  await sheet
    .getByRole("option", { name: new RegExp(consignorName) })
    .first()
    .click();
  await sheet.getByRole("textbox", { name: /^Reason/ }).fill("Entered as shop stock by mistake");
  await sheet.getByRole("button", { name: "Make it consigned stock" }).click();
  await expect(toast(page, /^C-\d{6} received from /)).toBeVisible();
  await expect(page).toHaveURL(/\/consignment\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByText(consignorName).first()).toBeVisible();

  // 5. The same product, now consigned: same P- number, same count, no
  // shop stock moves and no Change owner.
  await page.goto(new URL(product.url).pathname);
  await expect(page.locator("header").getByText(product.shortId)).toBeVisible();
  await expect(page.getByText("Counted by quantity · Consigned stock")).toBeVisible();
  await expect(section(page, "Stock").getByText("5 in stock")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change owner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adjust stock" })).toHaveCount(0);
});
