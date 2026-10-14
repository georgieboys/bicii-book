import type { Metadata } from "next";
import Link from "next/link";

import { DepositPercentControl } from "@/components/domain/deposit-percent-control";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { getIndentDepositPercent, listRecentStripeEvents } from "@/lib/domain/payments";
import { stripeConnection } from "@/lib/integrations/stripe/client";
import { HANDLED_EVENT_TYPES } from "@/lib/integrations/stripe/config";
import {
  STRIPE_EVENT_STATUS_LABELS,
  STRIPE_EVENT_STATUS_TONES,
  STRIPE_OFF_REASONS,
  STRIPE_REJECTION_LABELS,
  stripeConnectionLabel,
  stripeOutcomeLabel,
} from "@/lib/payments";
import { runbookHref } from "@/lib/docs-links";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Customer payments" };

const RUNBOOK = runbookHref("stripe-payments");

/**
 * Settings → Customer payments (admins only, a real 403 for anyone else:
 * there is no loading.tsx in this subtree, so the guard runs before
 * anything streams; Phase 14 step 2; D151, D157, D159; ADR-025; RUNBOOK
 * "Stripe payments").
 *
 * - Stripe: Live, Test mode, the fake, or Off with the reason (a variable
 *   named, never a value); when on, what to set up in Stripe's Dashboard.
 * - Deposit on indent parts: the percent new quotes take when sent; above 0
 *   only while Stripe is on (D157a).
 * - Recent Stripe deliveries: the newest stripe_events rows (D86), linked
 *   from Exceptions' "Stripe needs attention".
 */
export default async function CustomerPaymentsPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [percent, deliveries] = await Promise.all([
    getIndentDepositPercent(supabase),
    listRecentStripeEvents(supabase),
  ]);
  const stripe = stripeConnection();
  const on = stripe.state === "on";
  const offReason = stripe.reason ? STRIPE_OFF_REASONS[stripe.reason] : null;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Customer payments"
        description="Online payments through Stripe, and the deposit customers pay on indent parts."
      />

      <Card title="Stripe">
        <div className="flex flex-col gap-4">
          {percent > 0 && !on ? (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-deep"
            >
              Deposits are asked but Stripe is off, so customers can&apos;t pay online. Set the
              deposit to 0, or fix Stripe.
            </p>
          ) : null}
          {on ? (
            <>
              <p>
                <StatusPill status={stripe.mode === "live" ? "done" : "info"}>
                  {stripeConnectionLabel(stripe)}
                </StatusPill>
              </p>
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-dust-700">Webhook endpoint</dt>
                <dd className="font-mono break-all select-all">{stripe.webhookEndpoint}</dd>
                <dt className="text-dust-700">API version</dt>
                <dd className="font-mono">{stripe.apiVersion}</dd>
                <dt className="text-dust-700">Events to send</dt>
                <dd>
                  <ul className="flex flex-col font-mono">
                    {HANDLED_EVENT_TYPES.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </>
          ) : (
            <>
              <p>
                <StatusPill status="danger">Off</StatusPill>
              </p>
              <p className="text-sm text-dust-700">{offReason}</p>
            </>
          )}
          <p className="text-sm text-dust-700">
            Setup, switching on and off, and fixing problems are in the{" "}
            <Link href={RUNBOOK} className="font-semibold underline underline-offset-4">
              runbook
            </Link>
            .
          </p>
        </div>
      </Card>

      <Card title="Deposit on indent parts">
        <div className="flex flex-col gap-3">
          <DepositPercentControl percent={percent} stripeOn={on} offReason={offReason} />
          <p className="text-sm text-dust-700">
            A quote keeps the percent it was sent with. Parts whose deposit isn&apos;t paid can be
            ordered by an admin or manager, with a reason.
          </p>
        </div>
      </Card>

      <Card title="Recent Stripe deliveries" id="deliveries">
        {deliveries.length === 0 ? (
          <p className="text-sm text-dust-700">Nothing from Stripe yet.</p>
        ) : (
          <ul
            aria-label="Recent Stripe deliveries"
            className="flex flex-col divide-y divide-hairline"
          >
            {deliveries.map((d, i) => (
              <li key={`${d.receivedAt}-${i}`} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm break-all">{d.eventType}</span>
                  <StatusPill status={STRIPE_EVENT_STATUS_TONES[d.status]}>
                    {STRIPE_EVENT_STATUS_LABELS[d.status]}
                  </StatusPill>
                </div>
                <p className="text-sm text-dust-700">
                  {formatDateTime(d.receivedAt)}
                  {d.rejectionReason
                    ? ` · ${STRIPE_REJECTION_LABELS[d.rejectionReason]}`
                    : d.outcome
                      ? ` · ${stripeOutcomeLabel(d.outcome)}`
                      : ""}
                  {d.deliveryCount > 1 ? ` · delivered ${d.deliveryCount} times` : ""}
                  {d.workOrderId ? (
                    <>
                      {" · "}
                      <Link
                        href={`/jobs/${d.workOrderId}`}
                        className="font-semibold underline underline-offset-4"
                      >
                        Job {d.jobNumber ?? ""}
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
