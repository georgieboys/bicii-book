import { expect, test } from "@playwright/test";

import { createProduct, section, signIn, tagFor, toast } from "./helpers";

/**
 * Product groups (D241-D243), on a phone and an iPad: a manager makes a
 * group, puts two products in it by colour, sees them on the group's page,
 * and a duplicate colour is refused on its field. Every record carries
 * tagFor(testInfo).
 */
test("a manager groups two colours of one style", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagFor(testInfo);
  const groupName = `Retro saddle ${tag}`;

  await signIn(page, "manager");

  // 1. The group.
  await page.goto("/inventory");
  await page.getByRole("link", { name: "Groups" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Groups" })).toBeVisible();
  await page.getByRole("button", { name: "New group" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New group" });
  await sheet.getByRole("textbox", { name: /^Name/ }).fill(groupName);
  await sheet.getByRole("button", { name: "Add group" }).click();
  await expect(page).toHaveURL(/\/products\/groups\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: groupName })).toBeVisible();
  const groupUrl = page.url();
  const groupId = groupUrl.split("/").pop()!;

  // 2. Two products join it as Black and Brown.
  for (const colour of ["Black", "Brown"]) {
    await createProduct(page, {
      name: `Retro saddle ${colour.toLowerCase()} ${tag}`,
      sku: `SST-${colour.slice(0, 2).toUpperCase()}-${tag}`,
      price: "26.56",
      cost: "6.64",
    });
    const card = section(page, "Group");
    await card.getByRole("button", { name: "Add to a group" }).click();
    const join = page.getByRole("dialog", { name: "Group" });
    await join.getByRole("combobox", { name: /^Group/ }).selectOption(groupId);
    await join.getByRole("textbox", { name: /^Colour/ }).fill(colour);
    await join.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Group saved")).toBeVisible();
    await expect(card).toContainText(`Colour: ${colour}`);
  }

  // 3. A third product cannot also be Black.
  await createProduct(page, {
    name: `Retro saddle copy ${tag}`,
    sku: `SST-CP-${tag}`,
    price: "26.56",
    cost: "6.64",
  });
  await section(page, "Group").getByRole("button", { name: "Add to a group" }).click();
  const dup = page.getByRole("dialog", { name: "Group" });
  await dup.getByRole("combobox", { name: /^Group/ }).selectOption(groupId);
  await dup.getByRole("textbox", { name: /^Colour/ }).fill("black");
  await dup.getByRole("button", { name: "Save" }).click();
  await expect(
    dup.getByText("Another product in this group already has that option value.").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // 4. The group lists both colours.
  await page.goto(groupUrl);
  const members = page.getByRole("list", { name: "Products in this group" });
  await expect(members.getByRole("listitem")).toHaveCount(2);
  await expect(members).toContainText("Black");
  await expect(members).toContainText("Brown");
});
