import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { shopToday } from "../../src/lib/dates";
import { REPORT_JOB, REPORT_JOB_NUMBER, SERVICE, STAFF_EMAIL } from "../fixtures/ids";
import { insert, rpc, signInApi } from "./api";
import { anchorDay, isPhone, readMoney, section, signIn, tagFor, todayTile } from "./helpers";
import { expectNoSideScroll } from "./purchasing-helpers";

/**
 * Period reports (Phase 9 step 2; SPEC §19.2, §21, §22; PLAN D30,
 * D100–D105) on a phone and an iPad: the period and basis controls, the
 * breakdown and its drill-down, the CSV export and who sees what.
 *
 * Every figure comes from the seeded Phase 5 history (tests/fixtures/
 * reporting.ts), on days counted from the seed's anchor (anchorDay(n)),
 * never today. J-000013 (REPORT_JOB.combined, lead mechanic1) is checked
 * in on anchorDay(4), completed and ready on anchorDay(3) and collected on
 * anchorDay(2). Other jobs and sales share those days, and other specs add
 * records, so the tests assert J-000013's MEMBERSHIP, never emptiness or
 * exact totals.
 *
 * Customer payments (Phase 14 step 3, D154): money held, not sales, on the
 * day it moved. The test makes its own three jobs as the admin through the
 * API and the real RPCs (record_counter_payment, void_counter_payment,
 * set_work_order_status) on today's shop day, and asserts the tiles' CHANGE
 * and its jobs' membership of the held lists, since other specs record
 * payments on the same day.
 */

const JOB = REPORT_JOB_NUMBER.combined;
const JOB_ID = REPORT_JOB.combined;
const BASIS_LABEL = {
  sale: "Sale date",
  check_in: "Check-in",
  completion: "Completed",
  collection: "Collected",
} as const;
type Basis = keyof typeof BASIS_LABEL;

const breakdown = (page: Page) => section(page, "Breakdown");
const figures = (page: Page) => section(page, "Figures");
const jobLink = (page: Page) => breakdown(page).getByRole("link", { name: new RegExp(JOB) });

/** Chooses a date basis and waits for the page rendered on it. */
async function chooseBasis(page: Page, basis: Basis) {
  await page
    .getByRole("radiogroup", { name: "Date basis" })
    .getByRole("radio", { name: BASIS_LABEL[basis] })
    .click();
  await expect(page).toHaveURL(new RegExp(`[?&]basis=${basis}(&|$)`));
  await expect(figures(page)).toContainText(`on the ${BASIS_LABEL[basis]} basis.`);
}

/** Asserts J-000013 is (or is not) in the Job / sale breakdown on each basis. */
async function expectJobOn(page: Page, shown: readonly Basis[]) {
  for (const basis of ["sale", "check_in", "completion", "collection"] as const) {
    await chooseBasis(page, basis);
    // The URL keeps the period and the dimension (D100 changes only the basis).
    await expect(page).toHaveURL(/[?&]period=day(&|$)/);
    await expect(page).toHaveURL(/[?&]by=job(&|$)/);
    if (shown.includes(basis)) await expect(jobLink(page)).toBeVisible();
    else await expect(jobLink(page)).toHaveCount(0);
  }
}

test("an admin steps through days and bases, and J-000013 counts on its own dates", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "admin");

  // From the navigation: More on the phone, the rail on the iPad.
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isPhone(page)) {
    await nav.getByRole("link", { name: "More", exact: true }).click();
    await page
      .getByRole("main")
      .getByRole("link", { name: /^Reports/ })
      .click();
  } else {
    await nav.getByRole("link", { name: "Reports", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "Week" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("radiogroup", { name: "Date basis" }).getByRole("radio", { name: "Sale date" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(todayTile(figures(page), "Gross sales")).toContainText(/\$[\d,]+\.\d{2}/);
  await expect(todayTile(figures(page), "Yield")).toBeVisible();

  // The stepper, once each way.
  await page.goto(`/reports?period=day&date=${anchorDay(4)}&by=job`);
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${anchorDay(5)}`));
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${anchorDay(4)}`));

  // Every section fits the screen: tables scroll inside their own box.
  await expect(jobLink(page)).toHaveCount(0);
  await expectNoSideScroll(page);

  // Checked in on anchorDay(4): only the Check-in basis has it.
  await expectJobOn(page, ["check_in"]);

  // Completed on anchorDay(3): the Completed and Sale date bases (D100).
  await page.goto(`/reports?period=day&date=${anchorDay(3)}&by=job`);
  await expectJobOn(page, ["sale", "completion"]);

  // Collected on anchorDay(2): only the Collected basis.
  await page.goto(`/reports?period=day&date=${anchorDay(2)}&by=job`);
  await expectJobOn(page, ["collection"]);

  // A custom range before any record, on Completed: the empty state says why.
  await chooseBasis(page, "completion");
  await page
    .getByRole("radiogroup", { name: "Period" })
    .getByRole("radio", { name: "Custom" })
    .click();
  const sheet = page.getByRole("dialog", { name: "Custom range" });
  await sheet.getByLabel("From").fill("2020-01-07");
  await sheet.getByLabel("To").fill("2020-01-01");
  await sheet.getByRole("button", { name: "Apply" }).click();
  // A reversed range is refused in the sheet, which keeps the values.
  await expect(sheet.getByRole("alert")).toContainText("on or before the end day");
  await expect(sheet.getByLabel("From")).toHaveValue("2020-01-07");
  await sheet.getByLabel("From").fill("2020-01-01");
  await sheet.getByLabel("To").fill("2020-01-07");
  await sheet.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/period=custom/);
  await expect(page).toHaveURL(/from=2020-01-01/);
  await expect(page).toHaveURL(/to=2020-01-07/);
  await expect(page).toHaveURL(/basis=completion/);
  await expect(breakdown(page)).toContainText(
    "Nothing recorded for this period on the Completed basis.",
  );
  await expect(breakdown(page)).toContainText(
    "Jobs not completed yet only show on the Check-in basis.",
  );
});

test("a breakdown row opens its job, and a product opens its lines", async ({ page }) => {
  await signIn(page, "admin");
  const report = `/reports?period=day&date=${anchorDay(3)}&basis=completion&by=job`;
  await page.goto(report);
  await jobLink(page).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB_ID}$`));

  await page.goto(report);
  await breakdown(page).getByRole("link", { name: "Product", exact: true }).click();
  await expect(page).toHaveURL(/[?&]by=product(&|$)/);
  await expect(breakdown(page).getByRole("link", { name: "Product", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await breakdown(page)
    .getByRole("link", { name: /Carbon disc wheelset 700c, 45mm/ })
    .click();
  await expect(page).toHaveURL(/\/reports\/lines\?.*by=product.*key=d5300000-/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Carbon disc wheelset 700c, 45mm",
  );
  await expect(
    page.getByRole("main").getByRole("link", { name: JOB, exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Reports" })).toHaveAttribute(
    "href",
    /\/reports\?.*basis=completion/,
  );
});

test("the breakdown exports as CSV with its costs and a TOTAL row", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto(`/reports?period=day&date=${anchorDay(3)}&basis=completion&by=job`);
  const link = page.getByRole("link", { name: "Export CSV: breakdown by Job / sale" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/reports\/export\?kind=breakdown&/);

  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^text\/csv/);
  expect(response.headers()["content-disposition"]).toMatch(
    new RegExp(
      `^attachment; filename="bicii-breakdown-completion-${anchorDay(3)}_${anchorDay(3)}\\.csv"$`,
    ),
  );
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body = await response.text();
  expect(body.startsWith("\uFEFF")).toBe(true);
  const lines = body.slice(1).split("\r\n");
  expect(lines[0]).toBe(
    "dimension,key,name,detail,lines,jobs,sales,quantity,gross,cost,yield,cult_commons,after_cc,currency",
  );
  expect(lines.some((l) => l.startsWith(`job,${JOB_ID},${JOB},`))).toBe(true);
  expect(lines.some((l) => l.startsWith("TOTAL,"))).toBe(true);
});

test("a manager sees costs through the role", async ({ page }) => {
  await signIn(page, "manager");
  await page.goto(`/reports?period=day&date=${anchorDay(3)}`);
  await expect(todayTile(figures(page), "Yield")).toBeVisible();
  await expect(todayTile(figures(page), "Cult Commons")).toBeVisible();
});

test("a mechanic without permissions sees activity only, and the exports refuse", async ({
  page,
}) => {
  await signIn(page, "mechanic2");
  const query = `period=day&date=${anchorDay(3)}&basis=completion`;
  await page.goto(`/reports?${query}`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Sales, yield and Cult Commons figures need the View financial reports permission.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Gross sales")).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Date basis" })).toHaveCount(0);

  const refused = await page.request.get(`/reports/export?kind=breakdown&${query}&by=job`);
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toBe("Forbidden");

  const lines = await page.goto(`/reports/lines?${query}&by=job&key=${JOB_ID}`);
  expect(lines?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "You can't open this" })).toBeVisible();

  // Customer payments need View financial reports too (D154d).
  await page.goto(`/reports?${query}`);
  await expect(page.getByRole("heading", { name: "Customer payments" })).toHaveCount(0);
  const list = await page.goto(`/reports/payments?${query}`);
  expect(list?.status()).toBe(403);
  for (const kind of [`payments&${query}`, "payments_held"]) {
    const export_ = await page.request.get(`/reports/export?kind=${kind}`);
    expect(export_.status()).toBe(403);
  }

  const mechanics = await page.request.get(`/reports/export?kind=mechanics&${query}`);
  expect(mechanics.status()).toBe(200);
  expect(mechanics.headers()["content-type"]).toMatch(/^text\/csv/);
  const body = await mechanics.text();
  expect(body.slice(1).split("\r\n")[0]).toBe(
    "name,active,checked_in,completed,collected,open_now",
  );
});

/** A new bike for `customerId` checked in with one Wheel True ($35.00), as the admin through the API. */
async function heldJob(
  token: string,
  customerId: string,
  model: string,
): Promise<{ id: string; jobNumber: string }> {
  const bikeId = randomUUID();
  await insert(token, "bikes", { id: bikeId, customer_id: customerId, brand: "Brompton", model });
  const id = randomUUID();
  const created = await rpc<{ job_number: string } | { job_number: string }[]>(
    token,
    "create_work_order",
    {
      work_order_id: id,
      customer_id: customerId,
      bike_id: bikeId,
      requested_work: "Wheel true, paid at the counter",
      services: [{ line_id: randomUUID(), service_id: SERVICE.wheelTrue, quantity: 1 }],
    },
  );
  const row = Array.isArray(created) ? created[0] : created;
  return { id, jobNumber: row.job_number };
}

/** Money taken at the counter today (p_received_at null: the database stamps now). */
async function counterPayment(
  token: string,
  workOrderId: string,
  amount: string,
  method: "cash" | "card" | "paynow",
): Promise<string> {
  const [row] = await rpc<{ counter_payment_id: string }[]>(token, "record_counter_payment", {
    p_id: randomUUID(),
    p_work_order_id: workOrderId,
    p_quote_id: null,
    p_amount: amount,
    p_method: method,
    p_received_at: null,
    p_reference: null,
    p_note: null,
  });
  return row.counter_payment_id;
}

async function moveJob(token: string, workOrderId: string, statuses: readonly string[]) {
  for (const status of statuses) {
    await rpc(token, "set_work_order_status", { work_order_id: workOrderId, status });
  }
}

/** A tile's amount in cents and its count (the hint under it, "4 payments"), to compare before and after. */
async function readTile(
  figures: Locator,
  label: string,
): Promise<{ cents: number; count: number }> {
  const money = await readMoney(figures, label);
  const hint =
    (await figures
      .locator("dl")
      .filter({
        has: figures
          .page()
          .locator("dt")
          .filter({ hasText: new RegExp(`^${label}$`) }),
      })
      .locator("xpath=following-sibling::p[1]")
      .textContent()) ?? "";
  const count = /^(\d+) (?:payment|refund)s?$/.exec(hint.trim());
  return { cents: Math.round(Number(money) * 100), count: count ? Number(count[1]) : NaN };
}

test("Customer payments: the figures, the money held on jobs now, each payment and both exports", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagFor(testInfo);
  // Today's shop day, read once: the counter payments below are dated now.
  const day = shopToday();
  const report = `/reports?period=day&date=${day}`;
  await signIn(page, "admin");
  await page.goto(report);
  const payments = section(page, "Customer payments");
  const figures = payments.getByRole("group", { name: "Customer payment figures" });
  const labels = ["Recorded at the counter", "Given back at the counter", "Net taken"] as const;
  const before = new Map<string, { cents: number; count: number }>();
  for (const label of labels) before.set(label, await readTile(figures, label));

  // Three jobs of $35.00 for one customer: $50 + $10 cash on an open one
  // (the $10 then given back), $20 PayNow on a completed one, and $50 by
  // card on one then collected.
  const token = await signInApi(STAFF_EMAIL.admin);
  const customerId = randomUUID();
  await insert(token, "customers", { id: customerId, first_name: "Held", last_name: tag });
  const open = await heldJob(token, customerId, `Held open ${tag}`);
  const awaiting = await heldJob(token, customerId, `Held awaiting ${tag}`);
  const above = await heldJob(token, customerId, `Held above ${tag}`);
  await counterPayment(token, open.id, "50.00", "cash");
  const handedBack = await counterPayment(token, open.id, "10.00", "cash");
  await rpc(token, "void_counter_payment", {
    p_counter_payment_id: handedBack,
    p_kind: "given_back",
    p_reason: "E2E: handed back at the counter",
  });
  await moveJob(token, awaiting.id, ["in_progress", "completed"]);
  await counterPayment(token, awaiting.id, "20.00", "paynow");
  await counterPayment(token, above.id, "50.00", "card");
  await moveJob(token, above.id, ["in_progress", "completed", "ready_for_collection", "collected"]);

  // 1. The figures moved by exactly this test's money, with their counts.
  await page.reload();
  const after = new Map<string, { cents: number; count: number }>();
  for (const label of labels) after.set(label, await readTile(figures, label));
  const change = (label: (typeof labels)[number]) => ({
    cents: after.get(label)!.cents - before.get(label)!.cents,
    count: after.get(label)!.count - before.get(label)!.count,
  });
  expect(change("Recorded at the counter")).toEqual({ cents: 13000, count: 4 });
  expect(change("Given back at the counter")).toEqual({ cents: 1000, count: 1 });
  expect(change("Net taken").cents).toBe(12000);
  await expect(todayTile(figures, "Taken online")).toBeVisible();
  await expect(todayTile(figures, "Refunded online")).toBeVisible();
  await expect(payments).toContainText(
    "Not sales: money taken and given back by the day it moved.",
  );
  await expect(payments).toContainText(
    "Recorded at the counter: only what an admin recorded in BICII; not the till's takings.",
  );
  // Outside Figures: the date basis does not apply.
  await expect(payments.getByRole("radiogroup", { name: "Date basis" })).toHaveCount(0);
  await expect(payments).toContainText(", by the day it moved, whatever the basis.");

  // 2. Held on jobs now: three lists, each with its own total, and the basis sentence.
  await expect(payments).toContainText(
    "Not sales. On the Sale date basis, a job counts as sales on the day it is completed, so the second list is already in that figure and the others are not.",
  );
  const list = (name: string) => payments.getByRole("region", { name });
  const held = (name: string, job: string) =>
    list(name).getByRole("link", { name: new RegExp(`${job}\\b`) });
  for (const name of [
    "Paid on open jobs",
    "Paid on jobs awaiting collection",
    "Paid above the bill",
  ]) {
    await expect(list(name)).toContainText(/Total \$[\d,]+\.\d{2} · \d+ jobs?/);
  }
  await expect(held("Paid on open jobs", open.jobNumber)).toContainText("$50.00");
  await expect(held("Paid on open jobs", open.jobNumber)).toContainText(
    "Paid at the counter · Paid ahead $15.00",
  );
  await expect(held("Paid on jobs awaiting collection", awaiting.jobNumber)).toContainText(
    "$20.00",
  );
  await expect(held("Paid on jobs awaiting collection", awaiting.jobNumber)).toContainText(
    "Still to pay $15.00",
  );
  await expect(held("Paid above the bill", above.jobNumber)).toContainText("$15.00");
  await expect(held("Paid above the bill", above.jobNumber)).toContainText(
    "Paid $50.00 of a $35.00 bill",
  );
  // Each job in its own list only.
  await expect(held("Paid on jobs awaiting collection", open.jobNumber)).toHaveCount(0);
  await expect(held("Paid on open jobs", above.jobNumber)).toHaveCount(0);
  await expect(held("Paid on jobs awaiting collection", above.jobNumber)).toHaveCount(0);
  await expectNoSideScroll(page);

  // 3. Both exports: the period's movements (signed, no basis in the name), and what is held now.
  const paymentsCsv = await page.request.get(
    (await payments
      .getByRole("link", { name: "Export CSV: customer payments" })
      .getAttribute("href"))!,
  );
  expect(paymentsCsv.status()).toBe(200);
  expect(paymentsCsv.headers()["content-disposition"]).toBe(
    `attachment; filename="bicii-payments-${day}_${day}.csv"`,
  );
  const movements = (await paymentsCsv.text()).slice(1).split("\r\n");
  expect(movements[0]).toBe(
    "date,movement,job_number,customer,kind,method,amount,currency,other_currency,recorded_at,recorded_by",
  );
  const ours = (job: string) => movements.filter((l) => l.split(",")[2] === job);
  expect(ours(open.jobNumber).map((l) => l.split(",").slice(1, 2).concat(l.split(",")[6]))).toEqual(
    expect.arrayContaining([
      ["counter_payment", "50.00"],
      ["counter_payment", "10.00"],
      ["counter_given_back", "-10.00"],
    ]),
  );
  expect(ours(open.jobNumber)).toHaveLength(3);
  expect(ours(above.jobNumber)).toHaveLength(1);
  expect(ours(above.jobNumber)[0]).toContain(",counter_payment,");
  expect(ours(above.jobNumber)[0]).toContain(",card,50.00,SGD,");

  const heldCsv = await page.request.get(
    (await payments
      .getByRole("link", { name: "Export CSV: money held on jobs now" })
      .getAttribute("href"))!,
  );
  expect(heldCsv.status()).toBe(200);
  expect(heldCsv.headers()["content-disposition"]).toMatch(
    /^attachment; filename="bicii-payments_held-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  const heldLines = (await heldCsv.text()).slice(1).split("\r\n");
  expect(heldLines[0]).toBe(
    "group,job_number,status,customer,amount,net_paid,net_paid_online,paid_at_counter,job_total,balance_due,paid_ahead,currency",
  );
  const heldRow = (job: string) => heldLines.find((l) => l.split(",")[1] === job) ?? "";
  expect(heldRow(open.jobNumber)).toMatch(new RegExp(`^open,${open.jobNumber},received,`));
  expect(heldRow(awaiting.jobNumber)).toMatch(
    new RegExp(`^awaiting_collection,${awaiting.jobNumber},completed,`),
  );
  expect(heldRow(above.jobNumber)).toMatch(new RegExp(`^above_bill,${above.jobNumber},collected,`));

  // 4. See each payment: the list (a table only from 1024 px), newest first, signed.
  await payments.getByRole("link", { name: "See each payment" }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/payments\\?.*date=${day}`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Customer payments");
  const rows = page.getByRole("list", { name: "Payments" }).getByRole("listitem");
  const openRows = rows.filter({ hasText: open.jobNumber });
  await expect(openRows).toHaveCount(3);
  await expect(openRows.filter({ hasText: "Given back at the counter" })).toContainText(
    "\u2212$10.00",
  );
  await expect(openRows.first()).toContainText("Recorded ");
  await expect(page.getByRole("table")).toBeHidden();
  await expectNoSideScroll(page);
  await page.getByRole("main").getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\?.*#reports-payments$/);
});
