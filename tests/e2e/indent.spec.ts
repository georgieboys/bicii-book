import { expect, test } from "@playwright/test";

import { AUTH_USER, LOCATION } from "../fixtures/ids";
import { sqlTransaction } from "./db";
import { createJobViaIntake, createProduct, section, signIn, tagFor, toast } from "./helpers";
import { createSupplier } from "./purchasing-helpers";

/**
 * Indent parts and quotes (Phase 13 step 2; PLAN D140-D146, ADR-024), on a
 * phone and an iPad: the admin proposes a part the shop doesn't stock and
 * its fitting on a new job, sends a quote and gets the link once; the
 * customer opens it signed out and approves both items on the quote page;
 * the supplier's delivery is made in SQL as the admin through the same
 * RPCs (receiving has its own spec); then the admin
 * orders the approved part onto the supplier's draft (the job moves to
 * Waiting on parts); the arrived parts show as reserved on the product page
 * until the admin fits them and the service, which become the job's lines.
 * Until then the Lines card shows them as a memo under the total, never in
 * it (R-082). Every record carries tagFor(testInfo).
 */

test("indent part: proposed, quoted, answered, ordered, received and fitted", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  const partName = `Rohloff hub ${tag}`;
  // Its own supplier: ordering adds to the supplier's newest draft (D145),
  // and a seeded supplier's draft belongs to the purchasing specs.
  const supplierName = `Indent supplier ${tag}`;

  await signIn(page, "admin");
  await createSupplier(page, { name: supplierName });
  const product = await createProduct(page, {
    name: partName,
    sku: `RH-${tag}`,
    price: "120.00",
    cost: "70.00",
  });
  const job = await createJobViaIntake(page, { tag, requestedWork: "Hub upgrade" });

  const card = section(page, "Indent parts and quote");
  await expect(card).toContainText("Nothing proposed.");

  // 1. Propose the part (2 at the selling price) and its fitting.
  await card.getByRole("button", { name: "Propose part" }).click();
  const partSheet = page.getByRole("dialog", { name: "Propose part" });
  await partSheet.getByRole("combobox", { name: /^Part/ }).fill(tag);
  await partSheet.getByRole("option", { name: new RegExp(partName) }).click();
  await partSheet.getByLabel("Quantity").fill("2");
  await partSheet.getByLabel("Supplier").selectOption({ label: supplierName });
  await partSheet.getByRole("button", { name: "Propose part" }).click();
  await expect(partSheet).toBeHidden();
  await expect(toast(page, /Part proposed/)).toBeVisible();

  await card.getByRole("button", { name: "Propose service" }).click();
  const serviceSheet = page.getByRole("dialog", { name: "Propose service" });
  await serviceSheet.getByRole("combobox", { name: /^Service/ }).fill("Wheel True");
  await serviceSheet.getByRole("option", { name: /Wheel True/ }).click();
  await serviceSheet.getByRole("button", { name: "Propose service" }).click();
  await expect(serviceSheet).toBeHidden();

  const items = card.getByRole("list", { name: "Proposed items" });
  await expect(items.getByRole("listitem")).toHaveCount(2);
  await expect(items.getByRole("listitem", { name: partName })).toContainText("Proposed");
  // Nothing is on the job yet.
  await expect(section(page, "Lines")).not.toContainText(partName);

  // 2. Send the quote; the link is shown once.
  await card.getByRole("button", { name: "Send quote (2 items)" }).click();
  const quoteSheet = page.getByRole("dialog", { name: "Send quote" });
  await expect(quoteSheet.locator("output")).toHaveText("$275.00");
  await quoteSheet.getByRole("button", { name: "Create link" }).click();
  const sent = page.getByRole("dialog", { name: "Quote ready to send" });
  const link = (await sent.getByLabel("quote link", { exact: true }).textContent())!.trim();
  expect(link).toMatch(/\/quote\/[A-Za-z0-9_-]{43}$/);
  await expect(sent.getByRole("textbox", { name: "Message" })).toHaveValue(
    new RegExp(`job ${job.jobNumber}`),
  );
  await sent.getByRole("button", { name: "Done" }).click();
  await expect(card.getByLabel("Quote status")).toContainText("waiting for the customer");
  await expect(items.getByRole("listitem", { name: partName })).toContainText(
    "Waiting for the customer",
  );
  // A lost link is replaced by sending again, with the same items.
  await expect(card.getByRole("button", { name: "Send again (2 items)" })).toBeVisible();

  // 3. The customer opens the link signed out and approves both items.
  const customerContext = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const customer = await customerContext.newPage();
  const response = await customer.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(customer).toHaveURL(link);
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText(
    "Hi Intake, here is your quote",
  );
  await expect(customer.getByText(`Job ${job.jobNumber}`)).toBeVisible();
  const quoteItems = customer.getByRole("list", { name: "Quote items" });
  await expect(quoteItems.getByRole("listitem")).toHaveCount(2);
  // Nothing about costs or suppliers reaches the page.
  await expect(customer.getByRole("main")).not.toContainText(supplierName);
  await customer.getByRole("button", { name: "Send my answer" }).click();
  const customerMain = customer.getByRole("main");
  await expect(customerMain.getByRole("alert")).toHaveText(
    "Approve or decline every item (2 still need an answer).",
  );
  for (const name of [partName, "Wheel True"]) {
    await quoteItems
      .getByRole("listitem", { name })
      .getByRole("radio", { name: "Approve" })
      .click();
  }
  await expect(customer.getByLabel("Approved total")).toHaveText("$275.00");
  await expect(customerMain.getByRole("alert")).toHaveCount(0);
  await customer.getByLabel("Your name").fill(`Intake ${tag}`);
  await customer.getByRole("button", { name: "Send my answer" }).click();
  await expect(customerMain.getByRole("status")).toContainText(
    `Thank you, Intake ${tag}. You approved 2 of 2 items`,
  );
  await customer.reload();
  await expect(customer.getByRole("list", { name: "Your answer" })).toContainText("Approved");
  await expect(customer.getByRole("button", { name: "Send my answer" })).toHaveCount(0);
  // A link that is not a quote's shows a notice, not the sign-in page.
  await customer.goto(`/quote/${"x".repeat(43)}`);
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("This link is not valid");
  await customerContext.close();

  await page.reload();
  await expect(card.getByLabel("Quote status")).toContainText(`Quote answered by Intake ${tag}`);
  await expect(items.getByRole("listitem", { name: partName })).toContainText("Approved");
  // R-082: approved items are a memo under the total until they are fitted.
  const memo = section(page, "Lines").getByLabel("Approved, not on the bill");
  await expect(memo).toHaveText(
    "Approved, not on the bill yet: 2 items, $275.00. Fit them to bill them.",
  );

  // 4. Order the approved part from its supplier; the job waits on parts.
  await card.getByRole("button", { name: "Order approved parts" }).click();
  const orderSheet = page.getByRole("dialog", { name: "Order approved parts" });
  await expect(orderSheet.getByLabel("Supplier")).toHaveValue(/.+/);
  await orderSheet.getByRole("button", { name: "Add to order" }).click();
  await expect(orderSheet).toBeHidden();
  await expect(toast(page, "Added to the supplier's draft order.")).toBeVisible();
  const ordered = items.getByRole("listitem", { name: partName });
  await expect(ordered).toContainText("Ordered");
  await expect(ordered).toContainText("not arrived yet");
  await expect(page.getByRole("main").locator("header").first()).toContainText("Waiting on parts");
  const poNumber = (await ordered.textContent())!.match(/PO-\d{6}/)![0];

  // 5. The supplier delivers (submitted and received as the admin).
  await sqlTransaction(async (query) => {
    await query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: "authenticated", sub: AUTH_USER.admin }),
    ]);
    await query("set local role authenticated");
    const [po] = await query<{ id: string; status: string }>(
      "select id, status::text from public.purchase_orders where po_number = $1",
      [poNumber],
    );
    if (po.status === "draft") await query("select public.submit_purchase_order($1)", [po.id]);
    const lines = await query<{ id: string; quantity_ordered: number }>(
      "select id, quantity_ordered from public.purchase_order_lines where purchase_order_id = $1",
      [po.id],
    );
    await query("select public.receive_purchase($1, gen_random_uuid(), $2::jsonb)", [
      po.id,
      JSON.stringify(
        lines.map((l) => ({
          purchase_order_line_id: l.id,
          quantity_received: l.quantity_ordered,
          location_id: LOCATION.shopFloor,
        })),
      ),
    ]);
  });
  await page.reload();
  await expect(items.getByRole("listitem", { name: partName })).toContainText("Arrived");

  // The product page shows the arrived parts as reserved for the job (not held).
  const jobUrl = page.url();
  await page.goto(product.url);
  const reserved = section(page, "Stock").getByRole("list", { name: "Reserved for jobs" });
  await expect(reserved).toContainText(job.jobNumber);
  await expect(reserved).toContainText("× 2");
  await page.goto(jobUrl);

  // 6. Fit the part and add the service: both become ordinary lines.
  await items
    .getByRole("listitem", { name: partName })
    .getByRole("button", { name: "Fit" })
    .click();
  const fitSheet = page.getByRole("dialog", { name: "Fit part" });
  await expect(fitSheet).toContainText("$240.00");
  await fitSheet.getByRole("button", { name: "Fit part" }).click();
  await expect(fitSheet).toBeHidden();
  await expect(toast(page, `${partName} is on the job.`)).toBeVisible();
  await expect(items.getByRole("listitem", { name: partName })).toContainText("Fitted");

  await items
    .getByRole("listitem", { name: "Wheel True" })
    .getByRole("button", { name: "Add to job" })
    .click();
  const addSheet = page.getByRole("dialog", { name: "Add to job" });
  await addSheet.getByRole("button", { name: "Add to job" }).click();
  await expect(addSheet).toBeHidden();

  const lines = section(page, "Lines");
  await expect(lines).toContainText(partName);
  await expect(lines).toContainText("Wheel True");
  // Both are on the bill now: no memo.
  await expect(memo).toHaveCount(0);

  // Fitted parts are no longer reserved.
  await page.goto(product.url);
  await expect(section(page, "Stock")).toBeVisible();
  await expect(page.getByRole("list", { name: "Reserved for jobs" })).toHaveCount(0);
});
