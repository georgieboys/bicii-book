import { expect, test } from "@playwright/test";

import { submittedRide } from "./adventure-helpers";
import { signIn, toast } from "./helpers";

/**
 * Certifying a ride (Adventures Phase B; D178-D182), on a phone and an
 * iPad: a rider's paid booking and submitted recording are built as the
 * public site and Stripe would (adventure-helpers.ts); the manager finds it
 * in Reviews, starts the review, is refused while the checklist is
 * incomplete, certifies it, and moves the finisher pack to ready.
 */
test("the manager certifies a ride and readies its pack", async ({ page, request }, testInfo) => {
  const rider = `Rider ${testInfo.project.name} ${Date.now().toString(36)}`;
  const ride = await submittedRide(request, rider);

  await signIn(page, "manager", "/adventures/reviews");
  await page.getByRole("link", { name: new RegExp(ride.reference) }).click();
  await expect(page.getByRole("heading", { name: rider })).toBeVisible();
  await expect(page.getByRole("img", { name: /Recorded track/ })).toBeVisible();
  await expect(page.getByText("133.4 km (point to point)")).toBeVisible();

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByText(/In review · Kavya Menon/)).toBeVisible();

  const certify = page.getByRole("button", { name: "Certify this ride" });
  await certify.click();
  await expect(
    page.getByRole("alert").getByText("Tick every check before approving."),
  ).toBeVisible();

  for (const name of [
    "The recording is the rider's own ride",
    "The track covers the whole route",
    "Every mandatory checkpoint is passed, with its photo",
    "Times run forward with no impossible jumps",
    "The ride is inside the route's time limit",
    "The distance is at least the route's",
  ]) {
    // The row is the label (the box itself is visually hidden).
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByRole("checkbox", { name })).toBeChecked();
  }
  await expect(page.getByLabel("Accepted distance (km)")).toHaveValue("133.4");
  await certify.click();
  await expect(toast(page, "Approved")).toBeVisible();
  await expect(page.getByText(/Version 1: Approved · Kavya Menon/)).toBeVisible();

  await page.goto("/adventures/packs");
  const pack = page.getByRole("listitem").filter({ hasText: rider });
  await expect(pack.getByText("To pack")).toBeVisible();
  await pack.getByRole("button", { name: "Packed, ready to collect" }).click();
  await page.getByRole("dialog").getByLabel("Note").fill("Size M packed");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(pack.getByText("Ready to collect")).toBeVisible();

  await page.goto(`/adventures/bookings/${ride.bookingId}`);
  await expect(page.getByRole("heading", { name: /Certificate BC-\d{6}/ })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Booking history" }).getByText("Certified"),
  ).toBeVisible();
});
