import { expect, test } from "@playwright/test";

import { PO_NUMBER, PURCHASE_ORDER } from "../fixtures/ids";
import { createJobViaIntake, createProduct, pickPart, signIn, tagFor, toast } from "./helpers";
import {
  addOrderLine,
  createSubmittedOrder,
  createSupplier,
  expectNoSideScroll,
  interceptReceiveActions,
  openReceive,
  receiveLine,
  section,
  startOrderFromSupplier,
  submitOrder,
} from "./purchasing-helpers";

/**
 * Phase 7 suppliers and purchase orders on a phone and an iPad (SPEC §14,
 * §21; PLAN D60 D-PO-COSTS, D61 D-PO-CANCEL, D65 D-OVERRECEIPT). Records
 * these tests create carry tagFor(testInfo); the seeded orders
 * (tests/fixtures/ids.ts PURCHASE_ORDER) are only read.
 */

const PADS = { query: "SHI-L05A", option: /Road disc brake pads/ };

test("a buyer adds a supplier, orders from it, changes a line, submits and finds the order again", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const tag = tagFor(testInfo);
  const supplierName = `Spokes ${tag}`;

  await signIn(page, "admin");
  await createSupplier(page, {
    name: supplierName,
    contactName: "Mei Tan",
    phone: "+65 6000 0042",
    website: "spokes.test",
  });
  // The contact card dials and opens the website safely.
  await expect(page.getByRole("link", { name: /\+65 6000 0042/ })).toHaveAttribute(
    "href",
    "tel:+6560000042",
  );
  const website = page.getByRole("link", { name: /spokes\.test/ });
  await expect(website).toHaveAttribute("href", "https://spokes.test");
  await expect(website).toHaveAttribute("rel", "noopener noreferrer");

  // New order from the supplier's page: the supplier is preset.
  const { poNumber } = await startOrderFromSupplier(page, { supplierName });
  await expect(page.locator("header").getByText("Draft", { exact: true })).toBeVisible();

  await addOrderLine(page, { ...PADS, quantity: "20", unitCost: "12.00" });
  const lines = page.getByRole("table", { name: "Order lines" });
  await expect(lines).toContainText("20 items · not submitted");
  await expect(lines).toContainText("$240.00");
  await expect(
    lines.getByRole("progressbar", { name: /Road disc brake pads.* received/ }),
  ).toHaveAttribute("aria-valuemax", "20");

  // Change the line to 24, then back to 20.
  for (const [quantity, total] of [
    ["24", "$288.00"],
    ["20", "$240.00"],
  ] as const) {
    await lines.getByRole("button", { name: /Change line: Road disc brake pads/ }).click();
    const sheet = page.getByRole("dialog", { name: "Change line" });
    await sheet.getByLabel(/^Quantity/).fill(quantity);
    await sheet.getByRole("button", { name: "Save line" }).click();
    await expect(sheet).toBeHidden();
    await expect(lines).toContainText(`${quantity} items · not submitted`);
    await expect(lines).toContainText(total);
  }

  await submitOrder(page, poNumber);
  await expect(page.getByRole("button", { name: "Submit order" })).toHaveCount(0);
  await expect(lines).toContainText("0 of 20 received · 20 to come");

  // The header search finds it however the number is typed.
  const header = page.getByRole("searchbox", { name: "Search customers, bikes, jobs and stock" });
  await header.fill(poNumber.toLowerCase().replace("-", " "));
  await header.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
  const hit = page
    .getByRole("list", { name: "Purchase orders" })
    .getByRole("link", { name: new RegExp(poNumber) });
  await expect(hit).toContainText(supplierName);
  await hit.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(poNumber);
});

test("staff without purchasing access follow deliveries but see no costs or controls", async ({
  page,
}) => {
  await signIn(page, "mechanic2", "/purchasing");
  await expect(page).toHaveURL(/\/purchasing$/);
  await expect(page.getByRole("navigation", { name: "Purchasing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New order" })).toHaveCount(0);

  const row = page
    .getByRole("list", { name: "Purchase orders" })
    .getByRole("link", { name: new RegExp(PO_NUMBER.partial) });
  await expect(row).toContainText("Partially received");
  await expect(row).toContainText("Overdue");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/purchasing/orders/${PURCHASE_ORDER.partial}$`));

  const lines = page.getByRole("table", { name: "Order lines" });
  await expect(lines).toContainText("18 of 20 received · 2 to come");
  await expect(lines.getByText("Overdue")).toBeVisible();
  await expect(lines).not.toContainText("$");
  await expect(page.getByRole("heading", { name: "Totals" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "History" })).toHaveCount(0);
  for (const name of [/^New order/, "Submit order", "Cancel order…", "Add line", "Edit details"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(lines.getByRole("button")).toHaveCount(0);
  // The delivery that came is listed for everyone, without its cost.
  await expect(section(page, "Receipts")).toContainText("DN-5531");
  await expect(section(page, "Receipts")).not.toContainText("$");
});

test("a buyer cancels a submitted order with a reason, kept in its history", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const tag = tagFor(testInfo);
  const reason = `Supplier closed for stocktake ${tag}`;

  await signIn(page, "admin");
  const { poNumber } = await createSubmittedOrder(page, {
    supplierName: `Cancel ${tag}`,
    ...PADS,
  });

  const cancel = section(page, "Cancel order");
  await cancel.getByRole("button", { name: "Cancel order…" }).click();
  await expect(cancel).toContainText("Nothing has been received on this order");
  await cancel.getByLabel("Why is this order being cancelled?").fill(reason);
  // The confirm ignores presses for 400 ms after it appears (a double tap).
  await page.waitForTimeout(500);
  await cancel.getByRole("button", { name: "Cancel order", exact: true }).click();
  await expect(toast(page, `${poNumber} cancelled`)).toBeVisible();

  await expect(page.locator("header").getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Order history" })).toContainText(
    `cancelled: ${reason}`,
  );
  await expect(page.getByRole("table", { name: "Order lines" })).toContainText(
    "0 of 5 received · 5 cancelled",
  );
  // Cancelled is final: no editing, no second cancel.
  await expect(page.getByRole("button", { name: "Add line" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel order…" })).toHaveCount(0);
});

test("a fully received order is closed: a calm note and no line editing", async ({ page }) => {
  await signIn(page, "admin", `/purchasing/orders/${PURCHASE_ORDER.receivedInFull}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(PO_NUMBER.receivedInFull);
  await expect(page.locator("header").getByText("Received", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Fully received.*Extra or late units go on a new order\./),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New order for Velo Parts Asia Pte Ltd" }),
  ).toBeVisible();
  const lines = page.getByRole("table", { name: "Order lines" });
  await expect(lines).toContainText("4 of 4 received");
  await expect(lines.getByRole("button")).toHaveCount(0);
  for (const name of ["Add line", "Edit details", "Submit order", "Cancel order…"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
});

// ---------------------------------------------------------------------------
// Receiving and reorder (Phase 7 step 4; SPEC §2 "retries cannot duplicate
// stock", §27.3 journey 3; D63 D-LASTCOST, D65 D-OVERRECEIPT, D66 D-REORDER)
// ---------------------------------------------------------------------------

const productId = (url: string) => new URL(url).pathname.split("/").at(-1)!;

test("journey 3, receiving: a double-tapped delivery is received once, sets the last cost and feeds reorder", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  const name = `Brake cable ${tag}`;
  const sku = `BC-${tag}`;
  const supplierName = `Cables ${tag}`;

  await signIn(page, "admin");
  // 1. A counted product (reorder at 20, cost 12.00) and a tagged supplier.
  const product = await createProduct(page, {
    name,
    sku,
    price: "20.00",
    cost: "12.00",
    reorderPoint: "20",
  });

  // 2. New order: 20 x $12.00, submitted, then Receive.
  const order = await createSubmittedOrder(page, {
    supplierName,
    query: sku,
    option: new RegExp(name),
    quantity: "20",
    unitCost: "12.00",
  });
  await openReceive(page, order.id);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Receive ${order.poNumber}`);
  const line = receiveLine(page, name);
  const quantity = line.getByLabel("Receive now");
  await expect(quantity).toHaveValue("20");
  await expect(line).toContainText("Ordered at $12.00");
  await quantity.fill("18");
  await line.getByLabel("Actual unit cost").fill("12.50");
  await expect(line.getByText("Differs", { exact: true })).toBeVisible();
  await expect(line.getByLabel("Location")).toHaveValue(
    await page.getByLabel("Receive into").inputValue(),
  );
  await expect(page.getByText("18 items on 1 line")).toBeVisible();
  // A double tap is one receipt (the button locks; the key is the same anyway).
  await page.getByRole("button", { name: "Receive 18 items" }).dblclick();

  // 3. Back on the order.
  await expect(toast(page, "Received 18 items. 2 still to come.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/purchasing/orders/${order.id}$`));
  await expect(
    page.locator("header").getByText("Partially received", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Order lines" })).toContainText(
    "18 of 20 received · 2 to come",
  );
  const receipts = section(page, "Receipts");
  await expect(receipts.getByRole("list", { name: "Receipts" }).locator(":scope > li")).toHaveCount(
    1,
  );
  await expect(receipts).toContainText("18 ×");
  await expect(receipts).toContainText("$12.50 each");
  // Phase 8 on the received line (R-029): "Print 18 labels" opens the
  // product's print sheet at the received count; closed without printing.
  await receipts.getByRole("link", { name: `Print 18 labels for ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${productId(product.url)}\\?print=1&qty=18$`));
  const printSheet = page.getByRole("dialog");
  await expect(printSheet.getByRole("heading")).toHaveText(`Print labels · ${product.shortId}`);
  await expect(printSheet.getByRole("button", { name: "Print 18 labels" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 4. The product: 18 on hand (also after a reload), one Received +18
  // movement, the supplier with last cost $12.50 (D63), 2 on order.
  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("18 in stock")).toBeVisible();
  await page.reload();
  await expect(section(page, "Stock").getByText("18 in stock")).toBeVisible();
  const purchasing = section(page, "Suppliers & orders");
  await expect(purchasing).toContainText("On order: 2");
  await expect(
    purchasing
      .getByRole("list", { name: "Suppliers" })
      .getByRole("link", { name: new RegExp(supplierName) }),
  ).toContainText("Last cost $12.50");
  await page.goto(`/inventory/movements?product=${productId(product.url)}`);
  const movements = page.getByRole("list", { name: "Stock movements" });
  await expect(movements.getByRole("listitem", { name: "Received +18" })).toHaveCount(1);
  await expect(movements.getByRole("listitem", { name: /^Received/ })).toHaveCount(1);

  // 5. One used on a job: 17.
  await createJobViaIntake(page, { tag });
  const { sheet, choice } = await pickPart(page, sku, new RegExp(name));
  await choice.click();
  await sheet.getByRole("button", { name: "Add part" }).click();
  await expect(toast(page, `Added 1 × ${name}. 17 left at Shop floor.`)).toBeVisible();

  // 6. Reorder for that supplier: listed and ticked, on order 2, suggested
  // 2 x 20 - 17 - 2 = 21 (D66); the draft has it x 21 at the last cost.
  await page.goto(`/purchasing/reorder?supplier=${order.supplierId}`);
  const row = page
    .getByRole("list", { name: "At or below reorder point" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(row).toContainText("On hand 17 / reorder at 20");
  await expect(row).toContainText("On order 2");
  await expect(row).toContainText("Suggested 21");
  await expect(row.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "Create draft order (1 product)" }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  await expect(page.locator("header").getByText("Draft", { exact: true })).toBeVisible();
  const draftLines = page.getByRole("table", { name: "Order lines" });
  await expect(draftLines).toContainText(name);
  await expect(draftLines).toContainText("21 items · not submitted");
  await expect(draftLines).toContainText("$12.50");
});

test("a lost response is found, not received twice; a lost request is retried with the same key", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  const name = `Grip tape ${tag}`;
  const sku = `GT-${tag}`;
  const note = `DN-${tag}`;

  await signIn(page, "admin");
  const product = await createProduct(page, {
    name,
    sku,
    price: "9.00",
    cost: "4.00",
    reorderPoint: "2",
  });
  const order = await createSubmittedOrder(page, {
    supplierName: `Grips ${tag}`,
    query: sku,
    option: new RegExp(name),
    quantity: "10",
    unitCost: "4.00",
  });

  // Lost response: the server commits, the connection drops before the answer.
  await openReceive(page, order.id);
  const line = receiveLine(page, name);
  await line.getByLabel("Receive now").fill("6");
  await page.getByLabel("Delivery note reference").fill(note);
  await interceptReceiveActions(page, order.id, ["lostResponse", "slow"]);
  await page.getByRole("button", { name: "Receive 6 items" }).click();
  await expect(
    toast(page, "We could not confirm the receipt. Checking whether it was recorded…"),
  ).toBeVisible();
  await expect(page.getByText("Checking whether this delivery was recorded…")).toBeVisible();
  await expect(line.getByLabel("Receive now")).toBeDisabled();
  await expect(page.getByText(/^This delivery was recorded at .+ \(6 items\)\.$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });

  // Exactly one receipt; stock rose by 6 once.
  const orderPage = await page.context().newPage();
  await orderPage.goto(`/purchasing/orders/${order.id}`);
  await expect(
    section(orderPage, "Receipts").getByRole("list", { name: "Receipts" }).locator(":scope > li"),
  ).toHaveCount(1);
  await expect(orderPage.getByRole("table", { name: "Order lines" })).toContainText(
    "6 of 10 received · 4 to come",
  );
  await orderPage.goto(product.url);
  await expect(section(orderPage, "Stock").getByText("6 in stock")).toBeVisible();

  // A fresh form: 4 to come by default; the same delivery note is caught.
  await page.getByRole("button", { name: "Receive another delivery" }).click();
  await expect(line.getByLabel("Receive now")).toHaveValue("4");
  await expect(page.getByLabel("Delivery note reference")).toHaveValue("");
  await page.getByLabel("Delivery note reference").fill(note.toLowerCase());
  await expect(
    page.getByText(new RegExp(`^${note} was already recorded at .+ \\(6 items\\)$`)),
  ).toBeVisible();
  const commit = page.getByRole("button", { name: "Receive 4 items" });
  await expect(commit).toBeDisabled();
  await page.getByText("This is a different delivery").click();
  await expect(commit).toBeEnabled();
  await page.getByLabel("Delivery note reference").fill(`${note}-B`);

  // Lost request: it never reached the server. Checked, not recorded, retried.
  await interceptReceiveActions(page, order.id, ["lostRequest", "slow"]);
  await commit.click();
  await expect(page.getByText("Checking whether this delivery was recorded…")).toBeVisible();
  await expect(line.getByLabel("Receive now")).toBeDisabled();
  await expect(
    page.getByText("It was not recorded. Retrying is safe: it will not be received twice."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(toast(page, "Order fully received.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/purchasing/orders/${order.id}$`));
  await expect(
    section(page, "Receipts").getByRole("list", { name: "Receipts" }).locator(":scope > li"),
  ).toHaveCount(2);
  await expect(page.locator("header").getByText("Received", { exact: true })).toBeVisible();
  await page.goto(product.url);
  await expect(section(page, "Stock").getByText("10 in stock")).toBeVisible();
});

test("a received order shows the closed state on its receive page", async ({ page }) => {
  await signIn(page, "admin", `/purchasing/receive/${PURCHASE_ORDER.receivedInFull}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Receive ${PO_NUMBER.receivedInFull}`,
  );
  await expect(
    page.getByText("This order is fully received. Extra or late units go on a new order."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start a new order for this supplier" }),
  ).toBeVisible();
  await expectNoSideScroll(page);
  await expect(page.getByRole("button", { name: /^Receive \d/ })).toHaveCount(0);
  await page
    .getByRole("link", { name: `Back to ${PO_NUMBER.receivedInFull}` })
    .last()
    .click();
  await expect(page).toHaveURL(new RegExp(`/purchasing/orders/${PURCHASE_ORDER.receivedInFull}$`));
});

test("staff without purchasing access get a 403 on receiving and reorder, and no links to them", async ({
  page,
}) => {
  await signIn(page, "mechanic2", `/purchasing/orders/${PURCHASE_ORDER.partial}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(PO_NUMBER.partial);
  await expect(page.getByRole("link", { name: "Receive", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Purchasing" }).getByRole("link", { name: "Reorder" }),
  ).toHaveCount(0);
  for (const path of [`/purchasing/receive/${PURCHASE_ORDER.partial}`, "/purchasing/reorder"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(403);
  }
});

test("a buyer sees Receive on an open order and Reorder beside low stock", async ({ page }) => {
  await signIn(page, "admin", `/purchasing/orders/${PURCHASE_ORDER.partial}`);
  await expect(page.getByRole("link", { name: "Receive", exact: true })).toHaveAttribute(
    "href",
    `/purchasing/receive/${PURCHASE_ORDER.partial}`,
  );
  await page.goto(`/purchasing/orders/${PURCHASE_ORDER.draft}`);
  await expect(page.getByText("Submit the order before receiving")).toBeVisible();
  await expect(page.getByRole("link", { name: "Receive", exact: true })).toHaveCount(0);

  await page.goto("/inventory?filter=low");
  await page.getByRole("link", { name: "Reorder" }).click();
  await expect(page).toHaveURL(/\/purchasing\/reorder$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reorder" })).toBeVisible();
  // No supplier chosen yet: nothing ticked, nothing to create.
  await expect(
    page.getByRole("button", { name: "Create draft order (0 products)" }),
  ).toBeDisabled();
  await expectNoSideScroll(page);
});

test("purchasing fits a phone: no sideways scroll, names in full, the Receive footer clear of focus", async ({
  page,
}, testInfo) => {
  // The order list: the supplier's name keeps the row; the expected date
  // joins the status line on a phone.
  await signIn(page, "admin", `/purchasing?q=${PO_NUMBER.awaitingDelivery}`);
  const awaiting = page
    .getByRole("list", { name: "Purchase orders" })
    .getByRole("listitem")
    .filter({ hasText: PO_NUMBER.awaitingDelivery });
  const supplierName = awaiting.getByText("Tropic Tyre & Tube Co", { exact: true });
  await expect(supplierName).toBeVisible();
  expect(
    await supplierName.evaluate((el) => el.scrollWidth <= el.clientWidth),
    "supplier name not truncated",
  ).toBe(true);
  await expect(awaiting).toContainText(/Expected \d{1,2} [A-Z][a-z]{2} \d{4}/);
  await expectNoSideScroll(page);
  // A draft has nothing "to come" (D66).
  await page.goto(`/purchasing?q=${PO_NUMBER.draft}`);
  const draft = page
    .getByRole("list", { name: "Purchase orders" })
    .getByRole("listitem")
    .filter({ hasText: PO_NUMBER.draft });
  await expect(draft).toContainText("15 items · not submitted");
  await expect(draft).not.toContainText("to come");
  await expectNoSideScroll(page);

  // A received order's note and its preset New order button.
  await page.goto(`/purchasing/orders/${PURCHASE_ORDER.receivedInFull}`);
  await expect(page.getByRole("button", { name: /^New order for / })).toBeVisible();
  await expectNoSideScroll(page);

  // The Receive form: a one-row footer, and a focused field scrolls clear of it.
  await page.goto(`/purchasing/receive/${PURCHASE_ORDER.partial}`);
  await expect(page.getByRole("button", { name: "All to come" })).toBeEnabled();
  await expectNoSideScroll(page);
  const commit = page.getByRole("button", { name: /^Receive \d/ });
  const footer = commit.locator("xpath=..");
  const footerBox = await footer.boundingBox();
  const commitBox = await commit.boundingBox();
  expect(footerBox && commitBox).toBeTruthy();
  // One row: the footer is no taller than its button plus its own padding.
  expect(footerBox!.height).toBeLessThan(commitBox!.height + 40);
  const quantity = page
    .getByRole("list", { name: "Lines to receive" })
    .getByRole("group")
    .first()
    .getByRole("textbox")
    .first();
  // On a phone (the iPad's page is too short to scroll there), park the
  // field inside the viewport but under the footer, where a Tab would
  // otherwise leave it hidden, then focus it (WCAG 2.4.11).
  if (testInfo.project.name !== "phone") return;
  const [field, bar] = await Promise.all([quantity.boundingBox(), footer.boundingBox()]);
  await page.evaluate(
    (by) => window.scrollBy({ top: by, behavior: "instant" }),
    field!.y - (bar!.y + 8),
  );
  await expect
    .poll(async () => {
      const [f, b] = await Promise.all([quantity.boundingBox(), footer.boundingBox()]);
      return f && b ? f.y > b.y && f.y < b.y + b.height : false;
    }, "the field starts under the footer")
    .toBe(true);
  await quantity.focus();
  await expect
    .poll(async () => {
      const [f, b] = await Promise.all([quantity.boundingBox(), footer.boundingBox()]);
      return f && b ? f.y + f.height <= b.y : false;
    }, "the focused field clears the footer")
    .toBe(true);
});
