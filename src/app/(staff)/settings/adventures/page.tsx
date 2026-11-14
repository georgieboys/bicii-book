import type { Metadata } from "next";

import {
  AdventureSalesControl,
  PublishWaiverButton,
} from "@/components/domain/adventures/booking-sheets";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { getAdventureHealth, getAdventureSalesSettings } from "@/lib/domain/adventure-bookings";
import { listWaivers } from "@/lib/domain/adventure-terms";
import { getTrackerHireSettings, listTrackingDevices } from "@/lib/domain/trackers";
import { TrackerHireControl } from "@/components/domain/adventures/tracker-sheets";
import {
  PublicSurfacesControl,
  RetryFailedEmailsButton,
  SupportedSalesControl,
} from "@/components/domain/adventures/departure-sheets";
import { stripeConnection } from "@/lib/integrations/stripe/client";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Adventure sales" };

/**
 * Settings → Adventure sales (admins only; D170, D174, D215): whether riders
 * can buy certified rides on bicii.sg, the waiver they sign before paying,
 * and how long a checkout stays open.
 */
export default async function AdventureSalesSettingsPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [settings, hire, devices, health, waivers] = await Promise.all([
    getAdventureSalesSettings(supabase),
    getTrackerHireSettings(supabase),
    listTrackingDevices(supabase),
    getAdventureHealth(supabase),
    listWaivers(supabase),
  ]);
  const n = (key: string) => Number(health[key] ?? 0);
  const at = (key: string) =>
    typeof health[key] === "string" ? formatDateTime(health[key] as string) : null;
  const checks: Array<{ label: string; value: string; bad: boolean }> = [
    {
      label: "Rides waiting for review",
      value: `${n("reviews_waiting")}${at("reviews_oldest") ? `, oldest sent ${at("reviews_oldest")}` : ""}`,
      bad: false,
    },
    {
      label: "Bookings needing attention",
      value: String(n("bookings_attention")),
      bad: n("bookings_attention") > 0,
    },
    {
      label: "Cancellations asked (30 days, not cancelled)",
      value: String(n("cancellations_requested_30d")),
      bad: n("cancellations_requested_30d") > 0,
    },
    {
      label: "Emails waiting",
      value: `${n("emails_pending")}${at("emails_oldest_pending") ? `, oldest ${at("emails_oldest_pending")}` : ""}`,
      bad: false,
    },
    { label: "Emails failed", value: String(n("emails_failed")), bad: n("emails_failed") > 0 },
    { label: "Ride files waiting to be read", value: String(n("files_waiting")), bad: false },
    { label: "Ride files that failed (7 days)", value: String(n("files_failed_7d")), bad: false },
    {
      label: "Trackers overdue",
      value: String(n("trackers_overdue")),
      bad: n("trackers_overdue") > 0,
    },
    {
      label: "Payments waiting on Stripe for over an hour",
      value: String(n("payments_stale")),
      bad: n("payments_stale") > 0,
    },
    {
      label: "Feeds more than an hour behind",
      value: String(n("feeds_behind")),
      bad: n("feeds_behind") > 0,
    },
    {
      label: "Feeds failing",
      value: `${n("feeds_failing")} of ${n("feeds_enabled")}${at("feed_last_read") ? `, last read ${at("feed_last_read")}` : ""}`,
      bad: n("feeds_failing") > 0,
    },
  ];

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
              waiverVersions={waivers.map((w) => w.version)}
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
      <div className="mt-6">
        <Card title="Waiver" actions={<PublishWaiverButton />}>
          <p className="text-sm text-dust-700">
            Every rider types their full name to sign the chosen version before paying, with an
            emergency contact. A published version never changes.
          </p>
          {waivers.length === 0 ? (
            <p className="mt-3 text-sm">No waiver is published yet.</p>
          ) : (
            <ul aria-label="Published waivers" className="mt-3 flex flex-col gap-1 text-sm">
              {waivers.map((w) => (
                <li key={w.version} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <strong>{w.version}</strong> · {w.title}
                    {settings?.termsVersion === w.version ? " · riders sign this one" : ""}
                  </span>
                  <span className="text-dust-700">{formatDateTime(w.publishedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="mt-6">
        <Card title="Health">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {checks.map((c) => (
              <div key={c.label} className="contents">
                <dt className="text-dust-700">{c.label}</dt>
                <dd className={c.bad ? "font-semibold text-danger-deep" : undefined}>{c.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4">
            <RetryFailedEmailsButton failed={n("emails_failed")} />
          </div>
        </Card>
      </div>
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
          <div className="mt-6">
            <Card title="Rider sharing">
              <PublicSurfacesControl
                liveSharing={hire.liveSharing}
                publicProfiles={hire.publicProfiles}
              />
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}
