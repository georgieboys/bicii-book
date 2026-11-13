import type { Metadata } from "next";

import { AdventureSalesControl } from "@/components/domain/adventures/booking-sheets";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { getAdventureSalesSettings } from "@/lib/domain/adventure-bookings";
import { getTrackerHireSettings, listTrackingDevices } from "@/lib/domain/trackers";
import { TrackerHireControl } from "@/components/domain/adventures/tracker-sheets";
import { SupportedSalesControl } from "@/components/domain/adventures/departure-sheets";
import { stripeConnection } from "@/lib/integrations/stripe/client";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adventure sales" };

/**
 * Settings → Adventure sales (admins only; D170, D174): whether riders can
 * buy certified rides on bicii.sg and which terms version they accept, and
 * how long a checkout stays open. Off until the owner publishes the terms.
 */
export default async function AdventureSalesSettingsPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [settings, hire, devices] = await Promise.all([
    getAdventureSalesSettings(supabase),
    getTrackerHireSettings(supabase),
    listTrackingDevices(supabase),
  ]);
  const stripeOn = stripeConnection().state === "on";

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Adventure sales"
        description="Whether riders can buy a certified ride on bicii.sg."
      />
      <Card title="Certified rides">
        {settings ? (
          <div className="flex flex-col gap-4">
            {settings.salesEnabled && !stripeOn ? (
              <p
                role="alert"
                className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-deep"
              >
                Sales are on but Stripe is off, so riders cannot pay. Switch sales off, or fix
                Stripe in Customer payments.
              </p>
            ) : null}
            <AdventureSalesControl
              salesEnabled={settings.salesEnabled}
              termsVersion={settings.termsVersion}
            />
            <p className="text-sm text-dust-700">
              A checkout stays open {settings.checkoutMinutes} minutes. Changed{" "}
              {formatDateTime(settings.updatedAt)}
              {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}.
            </p>
          </div>
        ) : (
          <p className="text-sm text-dust-700">The adventure settings are missing.</p>
        )}
      </Card>
      {hire ? (
        <div className="mt-6">
          <Card title="Tracker hire">
            <SupportedSalesControl enabled={hire.supportedSales} />
            <div className="mt-4" />
            <TrackerHireControl
              enabled={hire.enabled}
              maxDays={hire.maxDays}
              inService={devices.filter((d) => d.serviceState === "in_service").length}
            />
          </Card>
        </div>
      ) : null}
    </>
  );
}
