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
 * a partial refund and a cancelled Checkout are checked on screen.
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
  await expect(row.getByText(sentence, { exact: true })).toHaveCount(1);
  await expect(row).toContainText("Open the job's Customer payments");
});
