import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import {
  STRIPE_TEST_WEBHOOK_SECRET,
  refundObject,
  sessionObject,
  stripeEvent,
  stripeWebhookHeaders,
} from "../fixtures/stripe";
import { sql } from "./db";
import { createJobViaIntake, createProduct, section, signIn, tagFor, toast } from "./helpers";
import { createSupplier } from "./purchasing-helpers";

/**
 * Indent deposits through Stripe (Phase 14 step 2; D151-D159, ADR-025;
 * TESTING.md journey 8), on a phone and an iPad, against the in-memory
 * Stripe (STRIPE_ADAPTER=fake in playwright.config.mts): the admin sets the
 * deposit to 50% in Settings → Customer payments, sends a quote (which
 * keeps 50%), the customer answers and presses Pay (the fake "returns"
 * them at once), and Stripe's confirmation arrives as a webhook this spec
 * signs with the fixtures' secret, as Stripe would. The job's Customer
 * payments card, the ordering gate (D152) and its override with a reason,
 * a partial refund and a cancelled Checkout are checked on screen. A
 * deposit paid for parts that are never fitted (R-082) is followed through
 * Complete and Collected, the closed job's words, and an admin's cancel on
 * the collected job (D149) and the refund, which clears its problem. A
 * quote left unanswered when the job closed shows "Not answered", and an
 * admin's cancel of its item on the collected job withdraws it (D149).
 *
 * Every spec shares one reset database (workers: 1), so the deposit goes
 * back to 0 straight after each quote is sent (the quote already holds its
 * snapshot, D158a) and again after every test: indent.spec and the rest
 * never see a deposit.
 */

const RESTORE_PERCENT =
  "update public.shop_settings set indent_deposit_percent = 0 where id = 1 and indent_deposit_percent <> 0";

test.afterEach(async () => {
  await sql(RESTORE_PERCENT);
});

type QuotedJob = {
  job: { id: string; jobNumber: string };
  link: string;
  partName: string;
  tag: string;
};

/**
 * A job with 2 × a 120.00 part (its own supplier) and Wheel True proposed
 * and quoted while the deposit is 50%; the percent is restored to 0 as soon
 * as the quote is sent.
 */
async function quotedJob(page: Page, testInfo: TestInfo): Promise<QuotedJob> {
  const tag = tagFor(testInfo);
  const partName = `Deposit hub ${tag}`;
  const supplierName = `Deposit supplier ${tag}`;
  await createSupplier(page, { name: supplierName });
  await createProduct(page, { name: partName, sku: `DH-${tag}`, price: "120.00", cost: "70.00" });
  const job = await createJobViaIntake(page, { tag, requestedWork: "Hub upgrade, deposit" });

  const card = section(page, "Indent parts and quote");
  await card.getByRole("button", { name: "Propose part" }).click();
  const partSheet = page.getByRole("dialog", { name: "Propose part" });
  await partSheet.getByRole("combobox", { name: /^Part/ }).fill(tag);
  await partSheet.getByRole("option", { name: new RegExp(partName) }).click();
  await partSheet.getByLabel("Quantity").fill("2");
  await partSheet.getByLabel("Supplier").selectOption({ label: supplierName });
  await partSheet.getByRole("button", { name: "Propose part" }).click();
  await expect(partSheet).toBeHidden();

  await card.getByRole("button", { name: "Propose service" }).click();
  const serviceSheet = page.getByRole("dialog", { name: "Propose service" });
  await serviceSheet.getByRole("combobox", { name: /^Service/ }).fill("Wheel True");
  await serviceSheet.getByRole("option", { name: /Wheel True/ }).click();
  await serviceSheet.getByRole("button", { name: "Propose service" }).click();
  await expect(serviceSheet).toBeHidden();

  await card.getByRole("button", { name: "Send quote (2 items)" }).click();
  const quoteSheet = page.getByRole("dialog", { name: "Send quote" });
  await quoteSheet.getByRole("button", { name: "Create link" }).click();
  const sent = page.getByRole("dialog", { name: "Quote ready to send" });
  const link = (await sent.getByLabel("quote link", { exact: true }).textContent())!.trim();
  expect(link).toMatch(/\/quote\/[A-Za-z0-9_-]{43}$/);
  // The quote holds 50% now (D158a): nothing else in the suite sees a deposit.
  await sql(RESTORE_PERCENT);
  await sent.getByRole("button", { name: "Done" }).click();
  return { job, link, partName, tag };
}

/** The customer, signed out in their own context, approves both items. */
async function answerAll(browser: Browser, page: Page, q: QuotedJob) {
  const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const customer = await context.newPage();
  await customer.goto(q.link);
  await expect(customer.getByRole("main")).toContainText(
    "the shop asks for a deposit of 50% of the parts you approve",
  );
  const quoteItems = customer.getByRole("list", { name: "Quote items" });
  for (const name of [q.partName, "Wheel True"]) {
    await quoteItems
      .getByRole("listitem", { name })
      .getByRole("radio", { name: "Approve" })
      .click();
  }
  await customer.getByLabel("Your name").fill(`Intake ${q.tag}`);
  await customer.getByRole("button", { name: "Send my answer" }).click();
  await expect(customer.getByRole("main")).toContainText(
    "The shop orders your parts once the deposit is paid.",
  );
  return { context, customer };
}

/** The job's one pending deposit payment (the row the fake's session belongs to). */
async function pendingPayment(jobNumber: string) {
  return sql<{
    id: string;
    session_id: string;
    cents: number;
    work_order_id: string;
    quote_id: string;
  }>(
    `select p.id, p.stripe_checkout_session_id as session_id, p.amount_cents::int as cents,
            p.work_order_id, p.quote_id
       from public.payments p join public.work_orders w on w.id = p.work_order_id
      where w.job_number = $1 and p.status = 'pending'`,
    [jobNumber],
  );
}

test("deposit: asked, paid through Stripe (fake) and a signed webhook, then ordered", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const project = testInfo.project.name;
  await signIn(page, "admin");

  // 1. Settings → Customer payments: the fake is on; the deposit goes to 50%.
  await page.goto("/settings/payments");
  await expect(page.getByText("Fake Stripe (development and tests only)")).toBeVisible();
  await expect(page.getByText(/\/api\/stripe\/webhooks$/)).toBeVisible();
  await page.getByRole("button", { name: "Change the deposit on indent parts" }).click();
  const percentSheet = page.getByRole("dialog", { name: "Deposit on indent parts" });
  await percentSheet.getByRole("textbox", { name: /^Deposit/ }).fill("50");
  await percentSheet.getByRole("button", { name: "Save" }).click();
  await expect(percentSheet).toBeHidden();
  await expect(
    toast(page, "Customers pay 50% of the approved indent parts after answering"),
  ).toBeVisible();

  // 2. The quote (the percent is back at 0 once it is sent).
  const q = await quotedJob(page, testInfo);
  const jobUrl = `/jobs/${q.job.id}`;

  // 3. The customer answers; the deposit is the parts' half, not the fitting's.
  const { context, customer } = await answerAll(browser, page, q);
  const deposit = section(customer, "Deposit");
  await expect(deposit).toContainText("$120.00");
  await expect(deposit).toContainText("50% of the parts you approved");
  const pay = customer.getByRole("button", { name: "Pay $120.00 deposit" });
  await expect(pay).toBeVisible();

  // 4. Staff before payment: due, and the part starts unticked in the order sheet.
  await page.goto(jobUrl);
  const payments = section(page, "Customer payments");
  await expect(payments.getByRole("list", { name: "Deposits" })).toContainText("Deposit due");
  const indent = section(page, "Indent parts and quote");
  const items = indent.getByRole("list", { name: "Proposed items" });
  await expect(items.getByRole("listitem", { name: q.partName })).toContainText("Deposit due");
  await indent.getByRole("button", { name: "Order approved parts" }).click();
  let orderSheet = page.getByRole("dialog", { name: "Order approved parts" });
  const unpaid = orderSheet.getByRole("checkbox", {
    name: `2 × ${q.partName} (deposit not paid)`,
  });
  await expect(unpaid).not.toBeChecked();
  await expect(orderSheet.getByRole("button", { name: "Add to order" })).toBeDisabled();
  // The row is the label (the box itself is visually hidden).
  await orderSheet.getByText(`2 × ${q.partName} (deposit not paid)`).click();
  await expect(unpaid).toBeChecked();
  await expect(orderSheet.getByLabel(/^Why order before the deposit is paid\?/)).toBeVisible();
  await expect(orderSheet.getByRole("button", { name: "Order without deposit" })).toBeVisible();
  await orderSheet.getByRole("button", { name: "Cancel" }).click();
  await expect(orderSheet).toBeHidden();

  // 5. Pay: the fake sends the customer straight back, still private and unindexed.
  const back = customer.waitForResponse(
    (r) => r.url().endsWith("?deposit=returned") && r.request().resourceType() === "document",
  );
  await pay.click();
  const returned = await back;
  expect(returned.headers()["referrer-policy"]).toBe("no-referrer");
  expect(returned.headers()["cache-control"]).toContain("private");
  expect(returned.headers()["cache-control"]).toContain("no-store");
  await expect(customer).toHaveURL(`${q.link}?deposit=returned`);
  await expect(customer.getByText("We're confirming your payment with Stripe…")).toBeVisible();

  // 6. One pending payment for 12000 cents (from Postgres, D158).
  const rows = await pendingPayment(q.job.jobNumber);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row.cents).toBe(12000);

  // 7. Stripe confirms: a signed webhook, then the same again, then a forged one.
  const paymentIntent = `pi_e2e_${project}_${Date.now()}`;
  const eventId = `evt_e2e_${project}_${Date.now()}`;
  const raw = JSON.stringify(
    stripeEvent({
      id: eventId,
      type: "checkout.session.completed",
      object: sessionObject({
        id: row.session_id,
        paymentId: row.id,
        workOrderId: row.work_order_id,
        quoteId: row.quote_id,
        amountCents: 12000,
        paymentIntent,
        extra: {
          customer_details: { email: "e2e@example.com", name: "E2E Payer" },
          success_url: `${q.link}?deposit=returned`,
        },
      }),
    }),
  );
  const first = await request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw }),
  });
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ duplicate: false });
  const again = await request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw }),
  });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ duplicate: true });
  const forged = await request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw, secret: `${STRIPE_TEST_WEBHOOK_SECRET}Other` }),
  });
  expect(forged.status()).toBe(400);
  expect(await forged.json()).toMatchObject({ error: "signature_invalid" });

  const [paid] = await sql<{ status: string; received: number; payload: string }>(
    `select p.status::text,
            (select count(*)::int from public.work_order_events e
              where e.work_order_id = p.work_order_id and e.event_type = 'payment_received') as received,
            (select s.payload::text from public.stripe_events s where s.stripe_event_id = $2) as payload
       from public.payments p where p.id = $1`,
    [row.id, eventId],
  );
  expect(paid.status).toBe("paid");
  expect(paid.received).toBe(1);
  expect(paid.payload).toContain(row.session_id);
  expect(paid.payload).not.toContain("customer_details");
  expect(paid.payload).not.toContain("success_url");
  expect(paid.payload).not.toContain("e2e@example.com");

  // 8. The customer sees it paid.
  await expect
    .poll(
      async () => {
        await customer.reload();
        return customer.getByText("Deposit of $120.00 paid. Thank you.").count();
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(customer.getByRole("main")).toContainText(
    "Your deposit is paid, so the shop will order your parts.",
  );
  await context.close();

  // 9. Staff after payment: paid ahead, on the timeline, and ordered without a reason.
  await page.reload();
  await expect(payments.getByRole("list", { name: "Deposits" })).toContainText("Deposit paid");
  await expect(payments.getByLabel("Paid online")).toContainText("$120.00");
  await expect(payments.getByLabel("Paid online")).toContainText(
    "Indent parts join the job total when they're fitted.",
  );
  await expect(payments).toContainText("Paid ahead");
  const timeline = section(page, "Timeline");
  await expect(timeline).toContainText("Deposit of $120.00 paid online");
  await expect(items.getByRole("listitem", { name: q.partName })).not.toContainText("Deposit due");
  await indent.getByRole("button", { name: "Order approved parts" }).click();
  orderSheet = page.getByRole("dialog", { name: "Order approved parts" });
  await expect(
    orderSheet.getByRole("checkbox", { name: `2 × ${q.partName}`, exact: true }),
  ).toBeChecked();
  await expect(orderSheet.getByText(/hasn't paid the deposit/)).toHaveCount(0);
  await expect(orderSheet.getByLabel(/^Supplier/)).toHaveValue(/.+/);
  await orderSheet.getByRole("button", { name: "Add to order" }).click();
  await expect(orderSheet).toBeHidden();
  await expect(toast(page, "Added to the supplier's draft order.")).toBeVisible();
  await expect(items.getByRole("listitem", { name: q.partName })).toContainText("Ordered");
  await expect(timeline).toContainText("Parts ordered on PO-");
  await expect(timeline).not.toContainText("Ordered before the deposit was paid");

  // 10. A partial refund made in Stripe arrives on its own.
  const refundRaw = JSON.stringify(
    stripeEvent({
      id: `evt_e2e_${project}_r${Date.now()}`,
      type: "refund.updated",
      object: refundObject({
        id: `re_e2e_${project}_${Date.now()}`,
        paymentIntent,
        amountCents: 5000,
        status: "succeeded",
      }),
    }),
  );
  const refunded = await request.post("/api/stripe/webhooks", {
    data: refundRaw,
    headers: stripeWebhookHeaders({ raw: refundRaw }),
  });
  expect(refunded.status()).toBe(200);
  await page.reload();
  const online = payments.getByRole("list", { name: "Online payments" });
  await expect(online).toContainText("Partly refunded");
  await expect(online).toContainText("of which $50.00 refunded");
  await expect(timeline).toContainText("$50.00 refunded in Stripe");
});

test("an admin orders before the deposit is paid, with a reason", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, "admin");
  await sql("update public.shop_settings set indent_deposit_percent = 50 where id = 1");
  const q = await quotedJob(page, testInfo);
  const { context, customer } = await answerAll(browser, page, q);

  await page.goto(`/jobs/${q.job.id}`);
  const indent = section(page, "Indent parts and quote");
  await indent.getByRole("button", { name: "Order approved parts" }).click();
  const orderSheet = page.getByRole("dialog", { name: "Order approved parts" });
  await orderSheet.getByText(`2 × ${q.partName} (deposit not paid)`).click();
  await expect(
    orderSheet.getByRole("checkbox", { name: `2 × ${q.partName} (deposit not paid)` }),
  ).toBeChecked();
  await expect(orderSheet.getByRole("status")).toHaveText(
    "The customer hasn't paid the deposit for 1 of these parts.",
  );
  // The reason is required: the sheet is the confirm step.
  await orderSheet.getByRole("button", { name: "Order without deposit" }).click();
  await expect(orderSheet).toContainText(
    "Say why the parts are ordered before the deposit is paid.",
  );
  await orderSheet
    .getByLabel(/^Why order before the deposit is paid\?/)
    .fill("Customer is paying at the counter");
  await orderSheet.getByRole("button", { name: "Order without deposit" }).click();
  await expect(orderSheet).toBeHidden();
  await expect(
    toast(page, "Added to the supplier's draft order without the deposit."),
  ).toBeVisible();
  const timeline = section(page, "Timeline");
  await expect(timeline).toContainText(/Parts ordered on PO-\d{6}/);
  await expect(timeline).toContainText(
    "Ordered before the deposit was paid: Customer is paying at the counter",
  );
  // Still due: ordering doesn't pay the deposit.
  await expect(
    section(page, "Customer payments").getByRole("list", { name: "Deposits" }),
  ).toContainText("Deposit due");

  // The customer's page no longer says the order waits for the deposit, and
  // warns before a second payment (the counter is not recorded, R-089).
  await customer.reload();
  await expect(customer.getByRole("main")).toContainText(
    "The shop has ordered your parts. Ask the shop if you still need to pay the deposit.",
  );
  await expect(customer.getByRole("main")).not.toContainText(
    "The shop orders your parts once the deposit is paid.",
  );
  await expect(section(customer, "Deposit")).toContainText(
    "The shop has already ordered your parts. If you paid the deposit another way, ask the shop before paying here.",
  );
  await expect(customer.getByRole("button", { name: "Pay $120.00 deposit" })).toBeVisible();
  await context.close();
});

test("a cancelled Checkout can be paid later with the same session", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, "admin");
  await sql("update public.shop_settings set indent_deposit_percent = 50 where id = 1");
  const q = await quotedJob(page, testInfo);
  const { context, customer } = await answerAll(browser, page, q);

  await customer.getByRole("button", { name: "Pay $120.00 deposit" }).click();
  await expect(customer).toHaveURL(`${q.link}?deposit=returned`);
  const [firstAttempt] = await pendingPayment(q.job.jobNumber);

  // Back from Stripe without paying.
  await customer.goto(`${q.link}?deposit=cancelled`);
  await expect(customer.getByText("Payment not finished. Nothing was charged.")).toBeVisible();

  // Paying again reuses the open session: the same URL and still one pending row.
  await customer.getByRole("button", { name: "Pay $120.00 deposit" }).click();
  await expect(customer).toHaveURL(`${q.link}?deposit=returned`);
  const rows = await pendingPayment(q.job.jobNumber);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(firstAttempt.id);
  expect(rows[0].session_id).toBe(firstAttempt.session_id);
  await context.close();

  // Staff see the open Checkout and can ask Stripe about it.
  await page.goto(`/jobs/${q.job.id}`);
  const payments = section(page, "Customer payments");
  await expect(payments.getByRole("list", { name: "Online payments" })).toContainText(
    "Checkout open",
  );
  await payments.getByRole("button", { name: "Check with Stripe" }).click();
  await expect(toast(page, "Nothing new from Stripe.")).toBeVisible();

  // Stripe confirms a different amount: recorded, flagged once on Exceptions
  // (the sentence, then where to act), and shown by the job's total.
  const raw = JSON.stringify(
    stripeEvent({
      id: `evt_e2e_${testInfo.project.name}_m${Date.now()}`,
      type: "checkout.session.completed",
      object: sessionObject({
        id: rows[0].session_id,
        paymentId: rows[0].id,
        workOrderId: rows[0].work_order_id,
        quoteId: rows[0].quote_id,
        amountCents: 11999,
        paymentIntent: `pi_e2e_${testInfo.project.name}_m${Date.now()}`,
      }),
    }),
  );
  const delivered = await page.request.post("/api/stripe/webhooks", {
    data: raw,
    headers: stripeWebhookHeaders({ raw }),
  });
  expect(delivered.status()).toBe(200);
  const sentence = "Stripe received $119.99, not the $120.00 asked. Check the payment in Stripe.";
  await page.reload();
  await expect(payments.getByRole("list", { name: "Payment problems" })).toHaveText(sentence);
  const lines = section(page, "Lines");
  await expect(lines.getByRole("link", { name: "Paid online $119.99" })).toBeVisible();

  await page.goto("/reports/exceptions");
  const row = page.getByRole("link").filter({ hasText: q.job.jobNumber });
  await expect(row).toHaveCount(1);
  const subject = row.getByText(sentence, { exact: true });
  await expect(subject).toHaveCount(1);
  await expect(row).toContainText("Open the job's Customer payments");
  // The sentence is what to do, so it wraps in full rather than being cut
  // off with an ellipsis (on a phone in particular): nothing is clipped.
  await expect(subject).toBeVisible();
  const clipped = await subject.evaluate((el) => ({
    overflow: getComputedStyle(el).textOverflow,
    hidden: el.scrollWidth > el.clientWidth + 1,
  }));
  expect(clipped).toEqual({ overflow: "clip", hidden: false });
  if (testInfo.project.name === "phone") {
    // On a phone this sentence cannot fit one line: it really wraps.
    const lines = await subject.evaluate((el) =>
      Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    );
    expect(lines).toBeGreaterThan(1);
  }
});

test("a deposit for parts never fitted: the memo, Collected, and an admin cancels on the collected job", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const project = testInfo.project.name;
  await signIn(page, "admin");
  await sql("update public.shop_settings set indent_deposit_percent = 50 where id = 1");
  const q = await quotedJob(page, testInfo);
  const { context, customer } = await answerAll(browser, page, q);

  // Paid: the fake's Checkout, then Stripe's signed confirmation.
  await customer.getByRole("button", { name: "Pay $120.00 deposit" }).click();
  await expect(customer).toHaveURL(`${q.link}?deposit=returned`);
  const [row] = await pendingPayment(q.job.jobNumber);
  const paymentIntent = `pi_e2e_${project}_n${Date.now()}`;
  const deliver = async (event: unknown) => {
    const raw = JSON.stringify(event);
    const res = await request.post("/api/stripe/webhooks", {
      data: raw,
      headers: stripeWebhookHeaders({ raw }),
    });
    expect(res.status()).toBe(200);
  };
  await deliver(
    stripeEvent({
      id: `evt_e2e_${project}_n${Date.now()}`,
      type: "checkout.session.completed",
      object: sessionObject({
        id: row.session_id,
        paymentId: row.id,
        workOrderId: row.work_order_id,
        quoteId: row.quote_id,
        amountCents: 12000,
        paymentIntent,
      }),
    }),
  );

  // 1. Open: the approved items are a memo under the total, never in it.
  await page.goto(`/jobs/${q.job.id}`);
  const lines = section(page, "Lines");
  const memo = lines.getByLabel("Approved, not on the bill");
  await expect(memo).toHaveText(
    "Approved, not on the bill yet: 2 items, $275.00. Fit them to bill them.",
  );
  await expect(lines.getByRole("link", { name: "Paid online $120.00" })).toBeVisible();
  await expect(lines).toContainText("Paid ahead $120.00");

  // 2. Completed without fitting: never fitted, and the card says what to do.
  const header = page.getByRole("main").locator("header").first();
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(header).toContainText("In progress");
  await page.getByRole("button", { name: "Complete" }).click();
  await expect(header).toContainText("Completed");
  await expect(memo).toHaveText("Approved but never fitted: $275.00 (not billed).");
  const indent = section(page, "Indent parts and quote");
  const items = indent.getByRole("list", { name: "Proposed items" });
  const part = items.getByRole("listitem", { name: q.partName });
  await expect(part).toContainText("Not fitted");
  await expect(part).toContainText("Deposit paid");
  await expect(part).toContainText(
    "Not on the bill: the job was completed before this was fitted. Reopen the job with Change status to fit it, or cancel it.",
  );
  await expect(part.getByRole("button", { name: "Fit" })).toHaveCount(0);
  const payments = section(page, "Customer payments");
  await expect(payments.getByRole("list", { name: "Payment problems" })).toHaveText(
    "$120.00 is held for parts that are not on this job. Reopen the job to fit them, or cancel them and refund in Stripe.",
  );

  // 3. Collected: both ways name what is not on the bill.
  await page.getByRole("button", { name: "Ready for collection" }).click();
  await expect(header).toContainText("Ready for collection");
  const paidSentence =
    "$120.00 was paid online. That is $120.00 more than the job total, paid for parts that are not on the bill.";
  const notOnBill = `Not on the bill: ${q.partName} $240.00 and Wheel True $35.00, approved and not fitted. To bill them, reopen the job and fit them; otherwise cancel them and refund any deposit in Stripe.`;
  await page.getByRole("button", { name: "Change status" }).click();
  const sheet = page.getByRole("dialog", { name: "Change status" });
  await sheet.getByLabel("Collected").check();
  await expect(sheet).toContainText(paidSentence);
  await expect(sheet).toContainText(notOnBill);
  // The footer's Close (the header's icon button has the same name).
  await sheet.getByText("Close", { exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Collected…" }).click();
  const confirm = page.getByRole("group", { name: /^Mark .* collected by / });
  await expect(confirm).toContainText(paidSentence);
  await expect(confirm).toContainText(notOnBill);
  await expect(confirm).not.toContainText("take nothing more");
  await confirm.getByRole("button", { name: "Mark collected" }).click();
  await expect(header).toContainText("Collected");

  // 4. Closed: what was paid against what was billed, and why.
  await expect(lines.getByRole("link", { name: "Paid online $120.00" })).toBeVisible();
  await expect(lines).toContainText("· $120.00 more than the bill");
  await expect(memo).toHaveText("Approved but never fitted: $275.00 (not billed).");
  await expect(payments.getByRole("list", { name: "Payment problems" })).toHaveText(
    "$120.00 is held for parts that never went on this job. Cancel them and refund in Stripe, or agree with the customer how it counts.",
  );
  await expect(payments.getByLabel("Paid online")).toContainText(
    "$120.00 was paid online above this job's bill of $0.00. Refund it in Stripe if it is due back, or agree with the customer how it counts.",
  );
  await expect(part).toContainText(
    "Not on the bill, and it can no longer be fitted: the job is collected. An admin or manager can cancel it and refund any deposit in Stripe.",
  );
  // The customer's page no longer says the shop will order the parts.
  await customer.goto(q.link);
  await expect(customer.getByRole("main")).toContainText("Ask the shop about your deposit.");
  await expect(customer.getByRole("main")).not.toContainText("the shop will order your parts");
  await context.close();

  // 5. D149: a mechanic gets no Cancel on the collected job; the admin does.
  const mechanicContext = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const mechanic = await mechanicContext.newPage();
  await signIn(mechanic, "mechanic1");
  await mechanic.goto(`/jobs/${q.job.id}`);
  const mechanicPart = section(mechanic, "Indent parts and quote").getByRole("listitem", {
    name: q.partName,
  });
  await expect(mechanicPart).toContainText("Not fitted");
  await expect(mechanicPart.getByRole("button", { name: `Cancel ${q.partName}` })).toHaveCount(0);
  await mechanicContext.close();

  await part.getByRole("button", { name: `Cancel ${q.partName}` }).click();
  const cancelSheet = page.getByRole("dialog", { name: `Cancel ${q.partName}` });
  await expect(cancelSheet).toContainText("refund any deposit for it in Stripe");
  await cancelSheet.getByLabel(/^Reason/).fill("Never supplied; deposit refunded in Stripe");
  await cancelSheet.getByRole("button", { name: "Cancel item" }).click();
  await expect(cancelSheet).toBeHidden();
  await expect(toast(page, `${q.partName} cancelled.`)).toBeVisible();
  await expect(items.getByRole("listitem", { name: q.partName })).toHaveCount(0);
  await expect(header).toContainText("Collected");
  await expect(payments.getByRole("list", { name: "Payment problems" })).toHaveText(
    "$120.00 is held but every part it was for is cancelled. Refund it in Stripe, or agree with the customer that it counts towards the job.",
  );

  // 6. The refund made in Stripe clears it.
  await deliver(
    stripeEvent({
      id: `evt_e2e_${project}_nr${Date.now()}`,
      type: "refund.updated",
      object: refundObject({
        id: `re_e2e_${project}_n${Date.now()}`,
        paymentIntent,
        amountCents: 12000,
        status: "succeeded",
      }),
    }),
  );
  await page.reload();
  await expect(payments.getByRole("list", { name: "Payment problems" })).toHaveCount(0);
  await expect(lines.getByRole("link", { name: /^Paid online/ })).toHaveCount(0);
});

test("a quote left unanswered on a closed job: Not answered, and an admin's cancel withdraws it (D149)", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, "admin");
  const q = await quotedJob(page, testInfo);

  // Completed with the quote unanswered: nobody can answer it now.
  await page.goto(`/jobs/${q.job.id}`);
  const header = page.getByRole("main").locator("header").first();
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(header).toContainText("In progress");
  await page.getByRole("button", { name: "Complete" }).click();
  await expect(header).toContainText("Completed");
  const indent = section(page, "Indent parts and quote");
  const status = indent.getByLabel("Quote status");
  const items = indent.getByRole("list", { name: "Proposed items" });
  const part = items.getByRole("listitem", { name: q.partName });
  await expect(status).toContainText(
    "The job is no longer open, so the customer can't answer it. Reopen the job with Change status to withdraw it or send it again.",
  );
  await expect(part).toContainText("Not answered");
  await expect(part).not.toContainText("Waiting for the customer");
  await expect(part.getByRole("button", { name: `Cancel ${q.partName}` })).toHaveCount(0);

  // Collected: an admin cancels the item, which withdraws the quote.
  await page.getByRole("button", { name: "Ready for collection" }).click();
  await expect(header).toContainText("Ready for collection");
  await page.getByRole("button", { name: "Collected…" }).click();
  await page
    .getByRole("group", { name: /^Mark .* collected by / })
    .getByRole("button", { name: "Mark collected" })
    .click();
  await expect(header).toContainText("Collected");
  await expect(status).toContainText(
    "An admin or manager can cancel its items, which withdraws it.",
  );
  await part.getByRole("button", { name: `Cancel ${q.partName}` }).click();
  const sheet = page.getByRole("dialog", { name: `Cancel ${q.partName}` });
  await expect(sheet).toContainText("cancelling it withdraws that quote");
  await sheet.getByLabel(/^Reason/).fill("Customer never answered; job collected");
  await sheet.getByRole("button", { name: "Cancel item" }).click();
  await expect(sheet).toBeHidden();
  await expect(toast(page, `${q.partName} cancelled. The quote was withdrawn.`)).toBeVisible();
  await expect(status).toHaveText("The last quote was withdrawn.");
  await expect(items.getByRole("listitem", { name: q.partName })).toHaveCount(0);
  await expect(items.getByRole("listitem", { name: "Wheel True" })).toContainText("Proposed");
  await expect(header).toContainText("Collected");

  // The customer's link no longer offers the quote.
  const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const customer = await context.newPage();
  await customer.goto(q.link);
  await expect(customer.getByRole("main")).toContainText(
    "The shop replaced or withdrew this quote.",
  );
  await context.close();
});
