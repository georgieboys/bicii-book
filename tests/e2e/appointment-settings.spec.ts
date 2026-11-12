import { expect, test, type Page } from "@playwright/test";

import { shiftShopDay, shopToday } from "../../src/lib/dates";
import { STAFF_EMAIL } from "../fixtures/ids";
import { rpc, select, signInApi } from "./api";
import { clearDay, openBookSheet, section, signIn, tagFor, toast } from "./helpers";

/**
 * Phase 2's schedule and appointment-type settings on a phone and an iPad
 * (SPEC §6; PLAN D2, D35, D37, D38). Each test picks its own clear future
 * day (7 days later on the iPad, so the projects never share one) and
 * restores what it changed in afterEach through the admin RPCs, which are
 * replay-safe, so a failure never leaks into later specs or the other
 * project: the seeded Sunday hours, its own closures (found by their
 * tagged reason) and its own type (deactivated: types are never deleted).
 */

let adminToken = "";
let tag = "";

const SEEDED_SUNDAY = [{ opens_at: "09:00", closes_at: "13:00" }];

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({}, testInfo) => {
  adminToken ||= await signInApi(STAFF_EMAIL.admin);
  tag = tagFor(testInfo);
});

test.afterEach(async () => {
  await rpc(adminToken, "set_shop_hours", { weekday: 0, intervals: SEEDED_SUNDAY, active: true });
  const closures = await select<{ id: string }>(
    adminToken,
    `closure_overrides?select=id&reason=like.${encodeURIComponent(`*${tag}`)}`,
  );
  for (const c of closures) {
    await rpc(adminToken, "delete_closure_override", { closure_id: c.id, reason: "E2E cleanup" });
  }
  const types = await select<{
    id: string;
    name: string;
    description: string | null;
    duration_minutes: number;
    capacity_units: number;
    public: boolean;
    sort_order: number;
  }>(
    adminToken,
    `appointment_types?select=id,name,description,duration_minutes,capacity_units,public,sort_order&name=like.${encodeURIComponent(`*${tag}`)}&active=is.true`,
  );
  for (const t of types) {
    await rpc(adminToken, "save_appointment_type", {
      appointment_type_id: t.id,
      is_new: false,
      name: t.name,
      description: t.description ?? "",
      duration_minutes: t.duration_minutes,
      capacity_units: t.capacity_units,
      public: t.public,
      active: false,
      sort_order: t.sort_order,
    });
  }
});

/** The times the open Book sheet offers on its current day, "HH:MM". */
async function offeredTimes(sheet: ReturnType<Page["getByRole"]>): Promise<string[]> {
  const labels = await sheet
    .locator('input[name="startsAt"]')
    .evaluateAll((inputs) => inputs.map((i) => i.closest("label")?.textContent ?? ""));
  return labels.map((l) => l.slice(0, 5));
}

async function addClosure(
  page: Page,
  fill: (sheet: ReturnType<Page["getByRole"]>) => Promise<void>,
  submit: string,
) {
  await page.goto("/settings/schedule");
  await page.getByRole("button", { name: "Add closure" }).click();
  const sheet = page.getByRole("dialog", { name: "Add closure" });
  await fill(sheet);
  await sheet.getByRole("button", { name: submit, exact: true }).click();
  await expect(sheet).toBeHidden();
}

async function deleteClosure(page: Page, reason: string) {
  await page.goto("/settings/schedule");
  const upcoming = page.getByRole("list", { name: "Upcoming closures" });
  const row = upcoming.getByRole("listitem").filter({ hasText: reason });
  // Each closure's Delete… is named for its closure.
  const start = row.getByRole("button", { name: /^Delete the .+ closure…$/ });
  await expect(start).toBeVisible();
  // Screen-reader and voice-control users tell the rows' Delete… apart.
  const names = await upcoming
    .getByRole("button", { name: /^Delete/ })
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
  expect(new Set(names).size).toBe(names.length);
  await start.click();
  await row.getByLabel(/^Why remove/).fill(`Plans changed ${tag}`);
  await page.waitForTimeout(500); // the confirm button ignores presses for 400 ms
  await row.getByRole("button", { name: "Delete closure" }).click();
  await expect(toast(page, "Closure deleted")).toBeVisible();
  await expect(row).toHaveCount(0);
}

test("An admin closes a day: nothing can be booked, and deleting it opens the times again", async ({
  page,
}, testInfo) => {
  const day = clearDay(testInfo, shiftShopDay(shopToday(), 35), 3); // a Wednesday
  const reason = `E2E closed ${tag}`;
  await signIn(page, "admin", "/settings/schedule");
  await addClosure(
    page,
    async (sheet) => {
      await sheet.getByLabel("First day").fill(day);
      await expect(sheet.getByLabel("Last day")).toHaveValue(day);
      await sheet.getByLabel("Reason").fill(reason);
    },
    "Add closure",
  );
  await expect(toast(page, "Closure added")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Upcoming closures" })
      .getByRole("listitem")
      .filter({ hasText: reason }),
  ).toContainText("Closed all day");

  await page.goto(`/appointments?date=${day}`);
  await expect(page.getByText(`Closed: ${reason}`)).toBeVisible();
  let sheet = await openBookSheet(page);
  await expect(sheet.getByText("No free times on this day.")).toBeVisible();
  await sheet.getByRole("button", { name: "Next day with free times" }).click();
  await expect(sheet.getByLabel("Or pick a date")).not.toHaveValue(day);
  await expect(sheet.locator('input[name="startsAt"]').first()).toBeAttached();
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();

  await deleteClosure(page, reason);
  await page.goto(`/appointments?date=${day}`);
  await expect(page.getByText(`Closed: ${reason}`)).toHaveCount(0);
  sheet = await openBookSheet(page);
  await expect(sheet.getByRole("radio", { name: /^10:00/ })).toBeVisible();
});

test("A short day 12:00-16:00 offers only 12:00 to 15:30 for a 30-minute type", async ({
  page,
}, testInfo) => {
  const day = clearDay(testInfo, shiftShopDay(shopToday(), 35), 4); // a Thursday
  const reason = `E2E short ${tag}`;
  await signIn(page, "admin", "/settings/schedule");
  await addClosure(
    page,
    async (sheet) => {
      await sheet.getByRole("radio", { name: "Short day" }).click();
      await sheet.getByLabel("First day").fill(day);
      await sheet.getByLabel("Opens").fill("12:00");
      await sheet.getByLabel("Closes").fill("16:00");
      await sheet.getByLabel("Reason").fill(reason);
    },
    "Add short day",
  );
  await expect(toast(page, "Short day added")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Upcoming closures" })
      .getByRole("listitem")
      .filter({ hasText: reason }),
  ).toContainText("Open 12:00–16:00");

  await page.goto(`/appointments?date=${day}`);
  const sheet = await openBookSheet(page);
  await sheet.getByRole("radio", { name: /^Service drop-off/ }).check();
  await expect(sheet.getByRole("radio", { name: /^12:00/ })).toBeVisible();
  expect(await offeredTimes(sheet)).toEqual([
    "12:00",
    "12:30",
    "13:00",
    "13:30",
    "14:00",
    "14:30",
    "15:00",
    "15:30",
  ]);
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();

  await deleteClosure(page, reason);
});

test("A staff-only type is bookable by staff until an admin deactivates it", async ({ page }) => {
  const name = `E2E fit ${tag}`;
  await signIn(page, "admin", "/settings/appointment-types");
  await page.getByRole("button", { name: "New type" }).click();
  let sheet = page.getByRole("dialog", { name: "New appointment type" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Duration").fill("45");
  await expect(sheet.getByRole("switch", { name: "Public" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await sheet.getByRole("button", { name: "Add type" }).click();
  await expect(toast(page, `${name} added`)).toBeVisible();
  const row = page.getByRole("listitem", { name });
  await expect(row).toContainText("Staff only");
  await expect(row).toContainText("45 min · 1 unit");

  await page.goto("/appointments");
  sheet = await openBookSheet(page);
  const card = sheet.getByRole("radio", { name: new RegExp(`^${name}`) });
  await expect(card).toBeAttached();
  await expect(sheet.locator("label").filter({ hasText: name })).toContainText("Staff only");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.goto("/settings/appointment-types");
  await page.getByRole("button", { name: `Edit ${name}` }).click();
  sheet = page.getByRole("dialog", { name: `Edit ${name}` });
  await sheet.getByRole("switch", { name: "Active" }).click();
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, `${name} saved`)).toBeVisible();
  await expect(page.getByRole("listitem", { name })).toContainText("Inactive");

  await page.goto("/appointments");
  sheet = await openBookSheet(page);
  await expect(sheet.getByRole("radio", { name: /^Service drop-off/ })).toBeAttached();
  await expect(sheet.getByRole("radio", { name: new RegExp(`^${name}`) })).toHaveCount(0);
});

test("An admin adds Sunday afternoon hours, sees them offered, then restores the seeded hours", async ({
  page,
}, testInfo) => {
  const sunday = clearDay(testInfo, shiftShopDay(shopToday(), 21), 0);
  await signIn(page, "admin", "/settings/schedule");
  const hours = page.getByRole("list", { name: "Weekly hours" });
  await hours.getByRole("button", { name: /^Sunday: 09:00–13:00/ }).click();
  let sheet = page.getByRole("dialog", { name: "Sunday hours" });
  await expect(sheet.getByRole("switch", { name: "Open on Sunday" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await sheet.getByRole("button", { name: "Add hours" }).click();
  await sheet.getByLabel("Opens (2)").fill("14:00");
  await sheet.getByLabel("Closes (2)").fill("16:00");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Sunday saved")).toBeVisible();
  await expect(
    hours.getByRole("button", { name: /^Sunday: 09:00–13:00, 14:00–16:00/ }),
  ).toBeVisible();

  await page.goto(`/appointments?date=${sunday}`);
  const book = await openBookSheet(page);
  await book.getByRole("radio", { name: /^Service drop-off/ }).check();
  await expect(book.getByRole("radio", { name: /^14:00/ })).toBeVisible();
  await expect(book.getByRole("radio", { name: /^15:30/ })).toBeVisible();
  await expect(book.getByRole("radio", { name: /^13:00/ })).toHaveCount(0);
  await book.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.goto("/settings/schedule");
  await hours.getByRole("button", { name: /^Sunday: 09:00–13:00, 14:00–16:00/ }).click();
  sheet = page.getByRole("dialog", { name: "Sunday hours" });
  await sheet.getByRole("button", { name: "Remove 14:00–16:00" }).click();
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Sunday saved")).toBeVisible();
  await expect(hours.getByRole("button", { name: /^Sunday: 09:00–13:00\. Edit$/ })).toBeVisible();
});

test("An admin chooses who gets booking emails (D163b), then clears them again", async ({
  page,
}) => {
  await signIn(page, "admin", "/settings/schedule");
  const card = section(page, "Booking emails");
  await expect(card).toContainText("Shop alerts go to");
  await card.getByRole("button", { name: "Edit booking emails" }).click();
  const sheet = page.getByRole("dialog", { name: "Booking emails" });
  // The row is the label (the box itself is visually hidden).
  await sheet.getByText("Marcus Tan", { exact: true }).click();
  await expect(sheet.getByRole("checkbox", { name: "Marcus Tan" })).toBeChecked();
  await sheet.getByLabel("Other addresses").fill("Team@Example.com\nnot an address");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet.getByText("Enter each address in full, like team@example.com")).toBeVisible();
  await sheet.getByLabel("Other addresses").fill("Team@Example.com\nteam@example.com");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Booking emails saved")).toBeVisible();
  await expect(card).toContainText("Marcus Tan, team@example.com");

  await card.getByRole("button", { name: "Edit booking emails" }).click();
  await expect(sheet.getByRole("checkbox", { name: "Marcus Tan" })).toBeChecked();
  await sheet.getByText("Marcus Tan", { exact: true }).click();
  await expect(sheet.getByRole("checkbox", { name: "Marcus Tan" })).not.toBeChecked();
  await sheet.getByLabel("Other addresses").fill("");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Booking emails saved")).toBeVisible();
  await expect(card).toContainText("Nobody yet");
});

test("A mechanic without permissions reads the schedule and types but cannot change them", async ({
  page,
}) => {
  await signIn(page, "mechanic2", "/settings");
  await page.getByRole("link", { name: /Shop hours and closures/ }).click();
  await expect(page).toHaveURL(/\/settings\/schedule$/);
  await expect(section(page, "Booking capacity")).toContainText("Singapore time");
  await expect(section(page, "Booking capacity")).toContainText(
    /Up to \d+ bikes? can be booked in for each \d+-minute slot/,
  );
  const hours = page.getByRole("list", { name: "Weekly hours" });
  await expect(hours).toContainText("Monday");
  await expect(hours).toContainText("Sunday");
  await expect(hours.getByRole("button")).toHaveCount(0);
  for (const name of [/^Edit/, "Add closure", "Delete"]) {
    await expect(page.getByRole("main").getByRole("button", { name })).toHaveCount(0);
  }

  await page.goto("/settings");
  await page.getByRole("link", { name: /Appointment types/ }).click();
  await expect(page).toHaveURL(/\/settings\/appointment-types$/);
  await expect(page.getByRole("listitem", { name: "Service drop-off" })).toContainText("Public");
  await expect(page.getByRole("listitem", { name: "Warranty inspection" })).toContainText(
    "Staff only",
  );
  await expect(page.getByRole("main").getByRole("button", { name: "New type" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button", { name: /^Edit/ })).toHaveCount(0);
});
