import { expect, test } from "@playwright/test";

import { paidBooking } from "./adventure-helpers";
import { signIn, toast } from "./helpers";

/**
 * Tracker hire at the counter (Adventures Phase C; D186-D188), on a phone
 * and an iPad: the manager adds a tracker and puts it in service; a rider's
 * paid hire is built as the public site and Stripe would
 * (adventure-helpers.ts); the manager gives the tracker out from
 * Handovers, takes it back in good condition, and the hire is finished.
 */
test("the manager adds a tracker, gives it out and takes it back", async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36).slice(-5)}`;
  const label = `T-${suffix}`;

  await signIn(page, "manager", "/adventures/trackers");
  await page.getByRole("button", { name: "Add tracker" }).first().click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Label").fill(label);
  await add.getByLabel("Device ID").fill(`ESN-${suffix}`);
  await add.getByRole("button", { name: "Add tracker" }).click();
  await expect(toast(page, "Tracker added")).toBeVisible();

  const device = page.getByRole("listitem").filter({ hasText: label });
  await expect(device.getByText("Maintenance")).toBeVisible();
  await device.getByRole("button", { name: `Change the state of ${label}` }).click();
  await page.getByRole("dialog").getByLabel("State").selectOption("in_service");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(device.getByText("In service")).toBeVisible();

  const rider = `Hirer ${suffix}`;
  const hire = await paidBooking(request, rider, { hire: true });

  await page.goto("/adventures/handovers");
  const toCollect = page
    .getByRole("list", { name: "To collect" })
    .getByRole("listitem")
    .filter({ hasText: hire.reference });
  await toCollect.getByRole("button", { name: "Give out" }).click();
  await page.getByRole("dialog").getByLabel("Tracker").selectOption({ label });
  await page.getByRole("dialog").getByRole("button", { name: "Give out" }).click();
  await expect(toast(page, "Tracker given out")).toBeVisible();

  const out = page
    .getByRole("list", { name: "Out with riders" })
    .getByRole("listitem")
    .filter({ hasText: hire.reference });
  await expect(out.getByText(label, { exact: false })).toBeVisible();
  await out.getByRole("button", { name: "Take back" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Tracker returned")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Recently finished" })
      .getByRole("listitem")
      .filter({ hasText: hire.reference }),
  ).toContainText("Good: back in service");

  await page.goto(`/adventures/bookings/${hire.bookingId}`);
  await expect(page.getByRole("heading", { name: "Tracker hire" })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Booking history" }).getByText("Tracker returned"),
  ).toBeVisible();
});
