import { expect, test } from "@playwright/test";

import { paidBooking, trackerInService } from "./adventure-helpers";
import { sqlTransaction } from "./db";
import { signIn, toast } from "./helpers";

/**
 * The owner's sales terms (D212-D218), on a phone and an iPad: a rider's
 * paid hire (signed waiver, as the public site would) shows the signature
 * and emergency contact on the booking; the tracker comes back three days
 * after its return day, one past the grace, so the booking owes $40; an
 * admin records it paid at the shop. The admin also sees the published
 * waiver in Settings → Adventure sales.
 */
test("a late tracker owes a fee an admin settles; the booking shows the signed waiver", async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36).slice(-5)}`;
  const label = `L-${suffix}`;
  const hire = await paidBooking(request, `Late ${suffix}`, { hire: true });
  await sqlTransaction(async (q) => {
    await trackerInService(q, label);
  });

  await signIn(page, "admin", "/adventures/handovers");
  await page
    .getByRole("list", { name: "To collect" })
    .getByRole("listitem")
    .filter({ hasText: hire.reference })
    .getByRole("button", { name: "Give out" })
    .click();
  await page.getByRole("dialog").getByLabel("Tracker").selectOption({ label });
  await page.getByRole("dialog").getByRole("button", { name: "Give out" }).click();
  await expect(toast(page, "Tracker given out")).toBeVisible();

  // The hire's return day was three days ago (as if the rider kept it).
  await sqlTransaction(async (q) => {
    await q(
      `update public.tracker_reservations
          set collect_on = private.shop_today() - 4, return_on = private.shop_today() - 3
        where booking_id = $1`,
      [hire.bookingId],
    );
  });
  await page.reload();
  await page
    .getByRole("list", { name: "Out with riders" })
    .getByRole("listitem")
    .filter({ hasText: hire.reference })
    .getByRole("button", { name: "Take back" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Tracker returned")).toBeVisible();

  await page.goto(`/adventures/bookings/${hire.bookingId}`);
  await expect(page.getByRole("heading", { name: "Waiver" })).toBeVisible();
  await expect(page.getByText(/^Test Rider ·/)).toBeVisible();
  await expect(page.getByText(/^Test Contact ·/)).toBeVisible();
  await expect(page.getByText("Refundable until the ride is sent for review")).toBeVisible();
  const fees = page.getByRole("list", { name: "Tracker late fees" });
  await expect(fees).toContainText("2 days late");
  await expect(fees).toContainText("owed");
  await fees.getByRole("button", { name: /Settle/ }).click();
  await page.getByRole("dialog").getByLabel("Note").fill("PayNow at the counter");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Late fee settled")).toBeVisible();
  await expect(fees).toContainText("paid: PayNow at the counter");
  await expect(
    page.getByRole("list", { name: "Booking history" }).getByText("Tracker late fee"),
  ).toBeVisible();

  await page.goto("/settings/adventures");
  await expect(page.getByRole("list", { name: "Published waivers" })).toContainText("2026-11-14");
});
