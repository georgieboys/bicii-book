import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

import { PRODUCT, PRODUCT_SHORT_ID } from "../fixtures/ids";
import {
  createJobViaIntake,
  createProduct,
  pickPart,
  section,
  signIn,
  tagFor,
  toast,
} from "./helpers";
import { labelPayloads, pdfLinkUris, qrPayloadFor } from "./label-helpers";

/**
 * M1.4 inventory, on a phone and an iPad: SPEC §27.3 journey 3 without
 * receiving (a product stocked by an opening count, labelled with ten
 * identical QR labels through the PDF adapter, used on a job, returned by
 * voiding the line and used again; receiving is Phase 7, on the parallel
 * track, RISKS R-029), a unique item on one job only, and the permission
 * boundary. Every record carries
 * tagFor(testInfo), and stock is asserted on the test's own product, so
 * runs and projects never see each other's counts.
 */

const MINUS = "−";

test("journey 3: a product is stocked, used on a job, returned to stock and used again", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagFor(testInfo);
  const name = `Inner tube ${tag}`;
  const sku = `TT-${tag}`;

  await signIn(page, "admin");

  // 1. A counted product.
  const product = await createProduct(page, {
    name,
    sku,
    price: "12.00",
    cost: "5.00",
    reorderPoint: "3",
  });
  const stock = section(page, "Stock");
  await expect(stock.getByText("Out of stock")).toBeVisible();

  // 2. Opening stock: 10 at the Shop floor.
  await stock.getByRole("button", { name: "Adjust stock" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust stock" });
  await expect(adjust.getByRole("radio", { name: /^Shop floor/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await adjust.getByLabel("Quantity").fill("10");
  await adjust.getByRole("button", { name: "Opening stock count" }).click();
  await expect(adjust.getByRole("textbox", { name: /^Reason/ })).toHaveValue("Opening stock count");
  await expect(adjust.locator("output")).toHaveText("Shop floor: 0 → 10");
  await adjust.getByRole("button", { name: "Save adjustment" }).click();
  await expect(toast(page, "Stock saved. Shop floor: 10")).toBeVisible();
  await expect(stock.getByText("10 in stock")).toBeVisible();

  // The list finds it by SKU, with its badge.
  await page.goto(`/inventory?q=${encodeURIComponent(sku)}`);
  const row = page
    .getByRole("list", { name: "Products" })
    .getByRole("link", { name: new RegExp(name) });
  await expect(row).toContainText(product.shortId);
  await expect(row).toContainText("10 in stock");

  // 2b. Ten labels through the PDF adapter (SPEC §31; PLAN D9, D56, D59):
  // ten identical payloads, exactly the database QR base, on the print view
  // and in the PDF; confirmed printed by hand. Printing moves no stock.
  await page.goto(product.url);
  const payload = qrPayloadFor(product.shortId);
  await page.getByRole("button", { name: "Print label" }).first().click();
  const printSheet = page.getByRole("dialog");
  await expect(printSheet.getByRole("heading")).toHaveText(`Print labels · ${product.shortId}`);
  await printSheet.getByRole("button", { name: "10 labels" }).click();
  await printSheet.getByRole("radio", { name: "PDF download" }).click();
  await printSheet.getByRole("button", { name: "Print 10 labels" }).click();
  await expect(page).toHaveURL(/\/print\/labels\/[0-9a-f-]{36}$/);
  const printJobId = page.url().split("/").at(-1)!;
  await expect(page.locator("[data-label]")).toHaveCount(10);
  expect(await labelPayloads(page)).toEqual(Array.from({ length: 10 }, () => payload));

  const openPdf = page.getByRole("link", { name: "Open PDF" });
  const pdfHref = await openPdf.getAttribute("href");
  expect(pdfHref).toBe(`/api/labels/${printJobId}/pdf`);
  const pdfResponse = await page.request.get(pdfHref!);
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
  const pdf = await PDFDocument.load(await pdfResponse.body(), { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(10);
  expect(pdfLinkUris(pdf)).toEqual(Array.from({ length: 10 }, () => payload));

  const [pdfTab] = await Promise.all([page.waitForEvent("popup"), openPdf.click()]);
  await pdfTab.close();
  await expect(
    page.getByRole("heading", { name: "Did all 10 labels print correctly?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, all printed" }).click();
  await expect(toast(page, "Marked as printed")).toBeVisible();

  await page.goto(`/labels?q=${encodeURIComponent(product.shortId)}`);
  const printed = page
    .getByRole("list", { name: "Print jobs" })
    .locator(`a[href="/labels/${printJobId}"]`);
  await expect(printed).toContainText("Printed");
  await expect(printed).toContainText("10 ×");
  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("10 in stock")).toBeVisible();

  // 3. A walk-in job; 1 × the product from Add part.
  const job = await createJobViaIntake(page, { tag });
  let { sheet, choice } = await pickPart(page, sku, new RegExp(name));
  await expect(choice).toContainText("10 at Shop floor · 10 total");
  await choice.click();
  await expect(sheet.getByText("Selling price", { exact: true })).toBeVisible();
  await expect(sheet.locator("output")).toHaveText("$12.00");
  await sheet.getByRole("button", { name: "Add part" }).click();
  await expect(toast(page, `Added 1 × ${name}. 9 left at Shop floor.`)).toBeVisible();
  await expect(sheet).toBeHidden();

  // 4. The line shows the P- number and what is left.
  const line = page.getByRole("row", { name: new RegExp(name) });
  await expect(line).toContainText(product.shortId);
  await expect(line).toContainText("9 left at Shop floor");
  await expect(page.getByLabel("Totals", { exact: true })).toContainText(/Total\s*\$12\.00/);

  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("9 in stock")).toBeVisible();
  await section(page, "Recent movements").getByRole("link", { name: "All movements" }).click();
  await expect(page).toHaveURL(/\/inventory\/movements\?product=/);
  await expect(
    page.getByRole("link", { name: `Remove filter: ${name} (${product.shortId})` }),
  ).toBeVisible();
  const movements = page.getByRole("list", { name: "Stock movements" });
  const used = movements.getByRole("listitem", { name: `Used on job ${MINUS}1` });
  await expect(used).toContainText(job.jobNumber);
  await expect(movements.getByRole("listitem", { name: "Adjustment +10" })).toContainText(
    "Opening stock count",
  );

  // 5. Void the line: back to 10, with a reversal linked to the original.
  await page.goto(`/jobs/${job.id}`);
  const partLine = page.getByRole("row", { name: new RegExp(name) });
  await partLine.getByRole("button", { name: "Void…" }).click();
  await expect(partLine).toContainText(
    "Voiding returns 1 to Shop floor (a reversal is recorded; nothing is deleted).",
  );
  await partLine.getByLabel(`Why are you voiding ${name}?`).fill("Wrong size");
  await page.waitForTimeout(500);
  await partLine.getByRole("button", { name: "Void line" }).click();
  await expect(toast(page, "Returned to stock")).toBeVisible();
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(
    timeline.getByText(`Used 1 × ${name} (${product.shortId}) from Shop floor`, { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByText(`Returned 1 × ${name} (${product.shortId}) to Shop floor`, { exact: true }),
  ).toBeVisible();

  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("10 in stock")).toBeVisible();
  await page.goto(
    `/inventory/movements?product=${new URL(product.url).pathname.split("/").at(-1)}`,
  );
  const returned = movements.getByRole("listitem", { name: "Returned from job +1" });
  await expect(returned).toContainText("Wrong size");
  const reversesLink = returned.getByRole("link", { name: /^Reverses #\d+$/ });
  const originalId = (await reversesLink.textContent())!.replace("Reverses #", "");
  await expect(
    movements.getByRole("listitem", { name: `Used on job ${MINUS}1` }).getByRole("link", {
      name: /^Reversed by #\d+$/,
    }),
  ).toBeVisible();
  await reversesLink.click();
  await expect(page).toHaveURL(new RegExp(`#movement-${originalId}$`));

  // 6. Add it again: 9.
  await page.goto(`/jobs/${job.id}`);
  ({ sheet, choice } = await pickPart(page, sku, new RegExp(name)));
  await expect(choice).toContainText("10 at Shop floor");
  await choice.click();
  await sheet.getByRole("button", { name: "Add part" }).click();
  await expect(toast(page, `Added 1 × ${name}. 9 left at Shop floor.`)).toBeVisible();
  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("9 in stock")).toBeVisible();
});

test("a unique item goes on one job only, and is held for it", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = tagFor(testInfo);
  const name = `Frame ${tag}`;

  await signIn(page, "admin");
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New product" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New product" });
  await sheet.getByRole("radio", { name: "Unique" }).click();
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Sale price", { exact: true }).fill("900.00");
  await sheet.getByLabel("Cost", { exact: true }).fill("400.00");
  await expect(sheet.getByLabel("Reorder point")).toHaveCount(0);
  const firstUnit = sheet.getByRole("region", { name: "First unit" });
  await expect(firstUnit.getByRole("radio", { name: "Shop floor" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await firstUnit.getByLabel("Serial number").fill(`SN-${tag}`);
  await firstUnit.getByLabel("Condition (shown publicly when published)").fill("As new");
  await sheet.getByRole("button", { name: "Add product" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  const units = page.getByRole("list", { name: "Units" });
  await expect(units.getByRole("listitem")).toHaveCount(1);
  await expect(units).toContainText("Available");
  const unitShortId = (await units.getByText(/^U-\d{6}$/).textContent())!.trim();

  // Job A takes it.
  const jobA = await createJobViaIntake(page, { tag });
  const { sheet: add, choice } = await pickPart(page, name, new RegExp(unitShortId));
  await choice.click();
  await expect(add.getByText(/A unique item: quantity 1, from Shop floor/)).toBeVisible();
  await add.getByRole("button", { name: "Add part" }).click();
  await expect(
    toast(page, `Added ${name} (${unitShortId}). It is on hold for this job.`),
  ).toBeVisible();

  // The unit is on job A.
  await page
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("link", { name: unitShortId })
    .click();
  await expect(page).toHaveURL(/\/units\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: `On job ${jobA.jobNumber}` })).toBeVisible();
  await expect(page.locator("header").getByText("On a job", { exact: true })).toBeVisible();

  // Job B's picker does not offer it.
  await createJobViaIntake(page, { tag });
  await page.getByRole("button", { name: "Add part" }).click();
  const addB = page.getByRole("dialog", { name: "Add part" });
  await addB.getByRole("combobox").fill(name);
  await expect(addB.getByText(/No part in stock matches/)).toBeVisible();
  await expect(addB.getByRole("option")).toHaveCount(0);
});

test("a mechanic without inventory permissions sees no stock controls or costs, and can still use a part", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = tagFor(testInfo);

  await signIn(page, "mechanic2");
  await page.goto(`/products/${PRODUCT.roadTube}`);
  await expect(page.locator("header").getByText(PRODUCT_SHORT_ID.roadTube)).toBeVisible();
  await expect(section(page, "Stock")).toBeVisible();
  for (const name of ["Adjust stock", "Transfer", "Edit details", "Add unit"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(page.getByText(/Cost and yield|Expected yield|Cult Commons/)).toHaveCount(0);
  await expect(section(page, "Archive")).toHaveCount(0);
  // Not hidden but absent: the page carries no cost figure (3.80) at all.
  expect(await page.content()).not.toContain("3.80");

  // Any staff member may still put a part on a job.
  await createJobViaIntake(page, { tag });
  const { sheet, choice } = await pickPart(page, PRODUCT_SHORT_ID.roadTube, /Road inner tube/);
  await choice.click();
  await expect(sheet.getByText(/Cost \(staff with cost access only\)/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "Add part" }).click();
  await expect(toast(page, "Added 1 × Road inner tube")).toBeVisible();
  await expect(page.getByRole("row", { name: /Road inner tube/ })).toContainText(
    PRODUCT_SHORT_ID.roadTube,
  );
  await expect(page.getByText(/Unit cost|Yield/)).toHaveCount(0);
});

test("product categories: added in Settings, offered on a new product, kept by it after archiving", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = tagFor(testInfo);
  const category = `Tubes ${tag}`;
  const name = `Tube ${tag}`;

  await signIn(page, "admin");

  // 1. Added under Settings → Product categories.
  await page.goto("/settings");
  await page.getByRole("link", { name: /Product categories/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Product categories");
  await page.getByLabel("New category").fill(category);
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(toast(page, `${category} added`)).toBeVisible();
  await expect(page.getByRole("list", { name: "Categories" })).toContainText(category);

  // A product category is not a service category.
  await page.goto("/settings/services");
  await expect(page.getByText(category)).toHaveCount(0);

  // 2. New product offers it, and the product shows it.
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New product" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New product" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Category").selectOption({ label: category });
  await sheet.getByLabel("Sale price", { exact: true }).fill("9.00");
  await sheet.getByRole("button", { name: "Add product" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
  const productUrl = page.url();
  await expect(page.locator("header")).toContainText(category);

  // 3. Archived: no longer offered to new products, kept by this one.
  await page.goto("/settings/product-categories");
  await page.getByRole("button", { name: `Archive ${category}` }).click();
  await expect(toast(page, `${category} archived`)).toBeVisible();
  await expect(page.getByRole("list", { name: "Archived categories" })).toContainText(category);

  await page.goto(productUrl);
  await expect(page.locator("header")).toContainText(category);
  await page.getByRole("button", { name: "Edit details" }).click();
  const edit = page.getByRole("dialog", { name: "Edit details" });
  await expect(edit.getByLabel("Category").locator("option:checked")).toHaveText(
    `${category} (archived)`,
  );
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();

  await page.goto("/inventory");
  await page.getByRole("button", { name: "New product" }).first().click();
  await expect(
    page
      .getByRole("dialog", { name: "New product" })
      .getByLabel("Category")
      .locator("option", { hasText: category }),
  ).toHaveCount(0);
});
