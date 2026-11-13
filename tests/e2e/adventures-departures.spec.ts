import { expect, test } from "@playwright/test";

import { paidBooking } from "./adventure-helpers";
import { signIn, toast } from "./helpers";

/**
 * Group ride dates in the Admin (Adventures Phase D; D193-D195), on a phone
 * and an iPad: the manager adds a date for BICII 125 (its self-supported
 * offer is published by the helper), opens its manifest, changes its
 * places and cancels it with a reason.
 */
test("the manager adds a group date, changes it and cancels it", async ({
  page,
  request,
}, testInfo) => {
  // Publishes the offer a group date needs (and makes one paid booking).
  await paidBooking(request, `Dated ${testInfo.project.name}`);
  const meeting = `Meet ${testInfo.project.name} ${Date.now().toString(36)}`;

  await signIn(page, "manager", "/adventures/departures");
  await page.getByRole("button", { name: "Add date" }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Route").selectOption({ label: "BICII 125" });
  const start = new Date(Date.now() + 9 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
  await sheet.getByLabel("Starts").fill(`${start}T07:00`);
  await sheet.getByLabel("Meeting point").fill(meeting);
  await sheet.getByLabel("Places").fill("6");
  await sheet.getByRole("button", { name: "Add date" }).click();
  await expect(toast(page, "Date added")).toBeVisible();

  await page
    .getByRole("list", { name: "Upcoming dates" })
    .getByRole("link")
    .filter({ hasText: meeting })
    .click();
  await expect(page.getByText("0 of 6 places")).toBeVisible();

  await page.getByRole("button", { name: "Change" }).click();
  await page.getByRole("dialog").getByLabel("Places").fill("8");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("0 of 8 places")).toBeVisible();

  await page.getByRole("button", { name: "Cancel date" }).click();
  await page.getByRole("dialog").getByLabel("Reason").fill("Haze over the island");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel date" }).click();
  await expect(toast(page, "Date cancelled")).toBeVisible();
  await expect(page.getByText("Cancelled: Haze over the island")).toBeVisible();
});
