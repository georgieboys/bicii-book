import { expect, test } from "@playwright/test";

import { AUTH_USER, LOCATION } from "../fixtures/ids";
import { answerQuoteByLink, sqlTransaction } from "./db";
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
 * it (R-082). Then (D149a, D149b, D149c): Complete opens a checklist of the
 * approved items, where a part never ordered in BICII is fitted as bought
 * outside BICII at the cost the admin enters (the stock count does not
 * change); and Cancel job lists them with Cancel only, naming the open
 * quote it withdraws. D160: voiding the line a fitted item became puts the
 * item back to approved, with Fit and Cancel, and it is fitted again from
 * the stock the void returned. Every record carries tagFor(testInfo).
 */

/** Sends the job's proposed items as a quote and returns the link (shown once). */
async function sendQuote(page: import("@playwright/test").Page, items: number) {
  const card = section(page, "Indent parts and quote");
  await card
    .getByRole("button", { name: new RegExp(`^Send (quote|again) \\(${items} items?\\)$`) })
    .click();
  const quoteSheet = page.getByRole("dialog", { name: "Send quote" });
  await quoteSheet.getByRole("button", { name: "Create link" }).click();
  const sent = page.getByRole("dialog", { name: "Quote ready to send" });
  const link = (await sent.getByLabel("quote link", { exact: true }).textContent())!.trim();
  await sent.getByRole("button", { name: "Done" }).click();
  await expect(sent).toBeHidden();
  return link;
}

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

test("Complete settles first: a part bought outside BICII is recorded and fitted, the count unchanged", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  const partName = `Dropper post ${tag}`;
  await signIn(page, "admin");
  const product = await createProduct(page, {
    name: partName,
    sku: `DP-${tag}`,
    price: "120.00",
    cost: "70.00",
  });
  const job = await createJobViaIntake(page, { tag, requestedWork: "Dropper post" });

  // Proposed with an expected cost (the admin holds View costs), quoted and approved.
  const card = section(page, "Indent parts and quote");
  await card.getByRole("button", { name: "Propose part" }).click();
  const partSheet = page.getByRole("dialog", { name: "Propose part" });
  await partSheet.getByRole("combobox", { name: /^Part/ }).fill(tag);
  await partSheet.getByRole("option", { name: new RegExp(partName) }).click();
  await partSheet.getByLabel("Expected cost each").fill("28.00");
  await partSheet.getByRole("button", { name: "Propose part" }).click();
  await expect(partSheet).toBeHidden();
  const link = await sendQuote(page, 1);
  await answerQuoteByLink(link, `Intake ${tag}`);
  await page.reload();
  const items = card.getByRole("list", { name: "Proposed items" });
  await expect(items.getByRole("listitem", { name: partName })).toContainText("Approved");

  // Complete… opens the checklist instead of completing.
  const header = page.getByRole("main").locator("header").first();
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(header).toContainText("In progress");
  await page.getByRole("button", { name: "Complete…" }).click();
  const checklist = page.getByRole("dialog", { name: `Before completing ${job.jobNumber}` });
  await expect(checklist).toContainText("Fit or cancel each approved or ordered item first.");
  const row = checklist.getByRole("listitem", { name: partName });
  await expect(row).toContainText(`1 × ${partName} · $120.00`);
  await expect(checklist.getByRole("button", { name: "Complete job" })).toBeDisabled();
  await expect(header).toContainText("In progress");

  // Fit → Bought outside BICII, prefilled with the expected cost.
  await row.getByRole("button", { name: "Fit" }).click();
  const fitSheet = page.getByRole("dialog", { name: "Fit part" });
  await fitSheet.getByRole("radio", { name: "Bought outside BICII" }).click();
  const costEach = fitSheet.getByLabel(/^Cost each/);
  await expect(costEach).toHaveValue("28.00");
  await costEach.fill("30.00");
  await fitSheet.getByLabel(/^Bought from/).fill("Bike Hub receipt 4471");
  await expect(fitSheet).toContainText("The stock count there doesn't change");
  await expect(fitSheet).toContainText("Cost 1 × $30.00 = $30.00");
  await fitSheet.getByRole("button", { name: "Record and fit" }).click();
  await expect(fitSheet).toBeHidden();
  await expect(toast(page, `${partName} is on the job (bought outside BICII).`)).toBeVisible();

  // Nothing is left: Complete job.
  await expect(checklist).toContainText("All settled.");
  await checklist.getByRole("button", { name: "Complete job" }).click();
  await expect(checklist).toBeHidden();
  await expect(header).toContainText("Completed");
  await expect(section(page, "Lines")).toContainText(partName);
  await expect(section(page, "Timeline")).toContainText(
    "Bought outside BICII · Bike Hub receipt 4471",
  );

  // The product: bought +1 and used −1, so the count is where it was.
  await page.goto(product.url);
  const moves = section(page, "Recent movements");
  await expect(moves.getByRole("listitem", { name: /^Bought outside BICII \+1/ })).toBeVisible();
  await expect(moves.getByRole("listitem", { name: /^Used on job/ })).toBeVisible();
  await expect(moves.getByRole("listitem")).toHaveCount(2);
});

test("Cancel job lists the approved items with Cancel only, and withdraws the open quote", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  await signIn(page, "admin");
  const job = await createJobViaIntake(page, { tag, requestedWork: "Wheel check" });
  const card = section(page, "Indent parts and quote");
  const propose = async (service: string) => {
    await card.getByRole("button", { name: "Propose service" }).click();
    const sheet = page.getByRole("dialog", { name: "Propose service" });
    await sheet.getByRole("combobox", { name: /^Service/ }).fill(service);
    await sheet.getByRole("option", { name: new RegExp(service) }).click();
    await sheet.getByRole("button", { name: "Propose service" }).click();
    await expect(sheet).toBeHidden();
  };
  // Wheel True approved on a first quote; Basic Service on a second, open one.
  await propose("Wheel True");
  await answerQuoteByLink(await sendQuote(page, 1), `Intake ${tag}`);
  await page.reload();
  await propose("Basic Service");
  await sendQuote(page, 1);
  await expect(card.getByLabel("Quote status")).toContainText("waiting for the customer");

  await page.getByRole("button", { name: "Change status" }).click();
  const change = page.getByRole("dialog", { name: "Change status" });
  await expect(change).toContainText("cancel its approved and ordered indent items");
  await change.getByRole("button", { name: "Cancel job…" }).click();
  const checklist = page.getByRole("dialog", { name: `Before cancelling ${job.jobNumber}` });
  await expect(checklist).toContainText(
    "Cancel each approved or ordered item first. A cancelled job can't keep items waiting.",
  );
  await expect(checklist).toContainText("Cancelling the job withdraws the quote sent");
  await expect(checklist).toContainText("its item goes back to Proposed.");
  const row = checklist.getByRole("listitem", { name: "Wheel True" });
  await expect(row.getByRole("button", { name: "Add to job" })).toHaveCount(0);
  await expect(checklist.getByRole("button", { name: "Cancel job…" })).toBeDisabled();

  await row.getByRole("button", { name: /^Cancel item/ }).click();
  const cancelItem = page.getByRole("dialog", { name: "Cancel Wheel True" });
  await cancelItem.getByLabel(/^Reason/).fill("Customer took the bike elsewhere");
  await cancelItem.getByRole("button", { name: "Cancel item" }).click();
  await expect(cancelItem).toBeHidden();
  await expect(checklist).toContainText("All settled.");

  await checklist.getByRole("button", { name: "Cancel job…" }).click();
  await checklist
    .getByLabel(/^Why is this job being cancelled/)
    .fill("Customer took the bike elsewhere");
  await page.waitForTimeout(500); // the confirm button ignores presses for 400 ms
  await checklist.getByRole("button", { name: "Cancel job", exact: true }).click();
  await expect(toast(page, `${job.jobNumber} cancelled`)).toBeVisible();
  const header = page.getByRole("main").locator("header").first();
  await expect(header).toContainText("Cancelled");
  // D149c(2): the open quote went with the job; its item is proposed again.
  await expect(card.getByLabel("Quote status")).toHaveText("The last quote was withdrawn.");
  await expect(
    card
      .getByRole("list", { name: "Proposed items" })
      .getByRole("listitem", { name: "Basic Service" }),
  ).toContainText("Proposed");
});

test("Voiding a fitted indent part puts it back to approved, with Fit and Cancel (D160)", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = tagFor(testInfo);
  const partName = `Brake rotor ${tag}`;
  await signIn(page, "admin");
  await createProduct(page, { name: partName, sku: `BR-${tag}`, price: "120.00", cost: "70.00" });
  const job = await createJobViaIntake(page, { tag, requestedWork: "Brake rotor" });

  // Proposed, quoted and approved.
  const card = section(page, "Indent parts and quote");
  await card.getByRole("button", { name: "Propose part" }).click();
  const partSheet = page.getByRole("dialog", { name: "Propose part" });
  await partSheet.getByRole("combobox", { name: /^Part/ }).fill(tag);
  await partSheet.getByRole("option", { name: new RegExp(partName) }).click();
  await partSheet.getByRole("button", { name: "Propose part" }).click();
  await expect(partSheet).toBeHidden();
  await answerQuoteByLink(await sendQuote(page, 1), `Intake ${tag}`);
  await page.reload();
  const item = card.getByRole("list", { name: "Proposed items" }).getByRole("listitem", {
    name: partName,
  });
  await expect(item).toContainText("Approved");

  // Fitted as bought outside BICII (the stock count does not move).
  await item.getByRole("button", { name: "Fit" }).click();
  const fitSheet = page.getByRole("dialog", { name: "Fit part" });
  await fitSheet.getByRole("radio", { name: "Bought outside BICII" }).click();
  await fitSheet.getByLabel(/^Cost each/).fill("30.00");
  await fitSheet.getByRole("button", { name: "Record and fit" }).click();
  await expect(fitSheet).toBeHidden();
  await expect(item).toContainText("Fitted");
  await expect(item.getByRole("button", { name: "Fit" })).toHaveCount(0);

  // Void its line: the confirmation says the item goes back to approved.
  const partLine = page.getByRole("row", { name: new RegExp(partName) });
  await partLine.getByRole("button", { name: "Void…" }).click();
  await expect(partLine).toContainText(
    `Voiding puts ${partName} back to approved: fit it again or cancel it before completing the job.`,
  );
  await partLine.getByLabel(`Why are you voiding ${partName}?`).fill("Fitted the wrong size");
  await page.waitForTimeout(500); // the confirm button ignores presses for 400 ms
  await partLine.getByRole("button", { name: "Void line" }).click();
  await expect(toast(page, `${partName} is back to approved`)).toBeVisible();

  // Back to approved, with Fit and Cancel, and not on the bill.
  await expect(item).toContainText("Approved");
  await expect(item).toContainText(
    "Its line was voided, so it is not on the bill. The part bought outside BICII went back into stock: fit it from stock, or cancel it.",
  );
  await expect(item.getByRole("button", { name: "Fit" })).toBeVisible();
  await expect(item.getByRole("button", { name: `Cancel ${partName}` })).toBeVisible();
  const memo = section(page, "Lines").getByLabel("Approved, not on the bill");
  await expect(memo).toHaveText(
    "Approved, not on the bill yet: 1 item, $120.00. Fit it to bill it.",
  );
  await expect(section(page, "Timeline")).toContainText(
    `${partName} back to approved: its line was voided`,
  );

  // Complete waits for it (D149b), listing it with Fit.
  const header = page.getByRole("main").locator("header").first();
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(header).toContainText("In progress");
  await page.getByRole("button", { name: "Complete…" }).click();
  const checklist = page.getByRole("dialog", { name: `Before completing ${job.jobNumber}` });
  await expect(checklist.getByRole("listitem", { name: partName })).toBeVisible();
  await expect(checklist.getByRole("button", { name: "Complete job" })).toBeDisabled();
  await checklist.getByRole("button", { name: "Back" }).click();
  await expect(checklist).toBeHidden();

  // Fitted again from stock, where the void put it.
  await item.getByRole("button", { name: "Fit" }).click();
  await expect(fitSheet).toContainText("It went back into stock when its line was voided");
  await fitSheet.getByRole("button", { name: "Fit part" }).click();
  await expect(fitSheet).toBeHidden();
  await expect(toast(page, `${partName} is on the job.`)).toBeVisible();
  await expect(item).toContainText("Fitted");
  await expect(memo).toHaveCount(0);
});
