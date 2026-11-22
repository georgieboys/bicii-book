import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ShortIdLink } from "@/components/domain/short-id";
import { JobPanel } from "@/components/domain/shopify/job-panel";
import { JsonView } from "@/components/domain/shopify/json-view";
import {
  LinkCustomerButton,
  UnlinkCustomerButton,
} from "@/components/domain/shopify/link-customer-sheet";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { requireAdmin } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/dates";
import { getEvent } from "@/lib/domain/shopify";
import {
  attemptText,
  eventStatusLabel,
  eventStatusTone,
  jobStatusLabel,
  jobStatusTone,
  outcomeText,
  rejectionText,
  topicLabel,
} from "@/lib/shopify";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Shopify event" };

const when = (v: string | null) => (v ? formatDateTime(v) : "—");

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-sm text-dust-500 sm:w-40">{term}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function SaleLink({ sale }: { sale: { id: string; saleNumber: string } }) {
  return (
    <Link href={`/sales/${sale.id}`} className="font-semibold underline underline-offset-4">
      {sale.saleNumber}
    </Link>
  );
}

/**
 * One webhook (admins; D86: payloads name customers). Summary: what BICII
 * did, in words, linking the sale. Delivery: the ids, shop, API version,
 * times, deliveries, the signature and why a delivery was rejected.
 * Processing: attempts, the human error, the unexpected detail folded
 * away, unmapped lines with Link buttons, and the job with Retry and
 * Dismiss as on the queue. Customer (orders): the Shopify customer and
 * the linked BICII customer with Unlink, or Link. Headers, then the payload.
 */
export default async function ShopifyEventPage({ params }: PageProps<"/shopify/events/[id]">) {
  await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const event = await getEvent(await createClient(), id);
  if (!event) notFound();

  const summary = outcomeText(event.outcome, {
    saleNumber: event.sale?.saleNumber ?? null,
    result: event.result,
    resolutionReason: event.job?.resolutionReason ?? null,
    currency: event.sale?.currency,
  });
  const rejection = rejectionText(event.rejectionReason);
  const job = event.job;
  const jobOpen = job && (job.status === "needs_attention" || job.status === "queued");

  return (
    <>
      <PageHeader
        eyebrow={`Shopify · ${topicLabel(event.topic)}`}
        title={event.subject ?? topicLabel(event.topic)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={eventStatusTone(event.status)}>
              {eventStatusLabel(event.status)}
            </StatusPill>
            {event.testDelivery ? <Badge tone="waiting">Test</Badge> : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Summary">
          <div className="flex flex-col gap-2">
            {summary && event.sale && event.outcome === "sale_recorded" ? (
              <p className="font-medium">
                Recorded as sale <SaleLink sale={event.sale} />
              </p>
            ) : summary && event.sale && event.outcome === "duplicate_order" ? (
              <p className="font-medium">
                Already recorded from another delivery (<SaleLink sale={event.sale} />)
              </p>
            ) : summary ? (
              <p className="font-medium">{summary.text}</p>
            ) : rejection ? (
              <p className="font-medium">Rejected: {rejection}</p>
            ) : event.status === "failed" ? (
              <p className="font-medium text-danger-deep">Not recorded yet: it needs attention.</p>
            ) : (
              <p className="font-medium">Waiting to be processed.</p>
            )}
            {summary?.detail ? <p className="text-sm text-dust-700">{summary.detail}</p> : null}
            {event.sale && event.outcome?.startsWith("refund") ? (
              <p className="text-sm">
                Sale <ShortIdLink href={`/sales/${event.sale.id}`} value={event.sale.saleNumber} />
              </p>
            ) : null}
          </div>
        </Card>

        <Card title="Delivery">
          <dl className="flex flex-col gap-2">
            <Row term="Webhook id">
              <span className="font-mono">{event.webhookId}</span>
            </Row>
            <Row term="Shopify event id">
              <span className="font-mono">{event.shopifyEventId ?? "—"}</span>
            </Row>
            <Row term="Shop">{event.shopDomain ?? "—"}</Row>
            <Row term="API version">{event.apiVersion ?? "—"}</Row>
            <Row term="Triggered">{when(event.triggeredAt)}</Row>
            <Row term="Received">{when(event.receivedAt)}</Row>
            <Row term="Last delivered">{when(event.lastDeliveredAt)}</Row>
            <Row term="Deliveries">{event.deliveryCount}</Row>
            <Row term="Signature">{event.hmacValid ? "Valid" : "Invalid"}</Row>
            {rejection ? <Row term="Rejected because">{rejection}</Row> : null}
            <Row term="Body">
              {event.bodyBytes} bytes ·{" "}
              <span className="font-mono text-xs break-all">SHA-256 {event.bodySha256}</span>
            </Row>
          </dl>
        </Card>
      </div>

      {event.status !== "rejected" ? (
        <Card title="Processing" className="mt-6">
          <div className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2">
              <Row term="Attempts">{event.attempts}</Row>
              {event.processedAt ? <Row term="Finished">{when(event.processedAt)}</Row> : null}
              {event.lastError ? (
                <Row term="Problem">
                  <span className="text-danger-deep">{event.lastError}</span>
                  {event.lastErrorCode ? (
                    <span className="ml-2 font-mono text-xs text-dust-500">
                      {event.lastErrorCode}
                    </span>
                  ) : null}
                </Row>
              ) : null}
            </dl>
            {event.lastErrorDetail ? (
              <details className="rounded-xl border border-hairline">
                <summary className="flex min-h-tap cursor-pointer items-center px-3 text-sm font-medium">
                  Technical detail
                </summary>
                <p className="px-3 pb-3 font-mono text-xs break-all">{event.lastErrorDetail}</p>
              </details>
            ) : null}
            {job ? (
              <div className="flex flex-col gap-3">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-dust-500">Queue</span>
                  <StatusPill status={jobStatusTone(job.status)}>
                    {jobStatusLabel(job.status)}
                  </StatusPill>
                  <span className="text-sm text-dust-500 tabular-nums">
                    {attemptText({
                      attempts: job.attempts,
                      maxAttempts: job.maxAttempts,
                      nextAttemptAt: job.nextAttemptAt,
                      status: job.status,
                    })}
                  </span>
                </p>
                {job.status === "dismissed" && job.resolutionReason ? (
                  <p className="text-sm text-dust-700">Dismissed: {job.resolutionReason}</p>
                ) : null}
                {jobOpen ? <JobPanel job={job} /> : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {event.customer ? (
        <Card title="Customer" className="mt-6">
          <div className="flex flex-col gap-3">
            <dl className="flex flex-col gap-2">
              <Row term="Shopify customer">
                <span className="font-mono text-xs break-all">{event.customer.gid}</span>
              </Row>
              <Row term="Email on the order">{event.customer.email ?? "—"}</Row>
              <Row term="BICII customer">
                {event.customer.linked ? (
                  <Link
                    href={`/customers/${event.customer.linked.id}`}
                    className="font-semibold underline underline-offset-4"
                  >
                    {event.customer.linked.label}
                  </Link>
                ) : (
                  "Not linked"
                )}
              </Row>
            </dl>
            {event.customer.linked ? (
              <>
                <p className="text-sm text-dust-700">
                  This customer sees every order of this Shopify customer in their account, and
                  later orders are recorded for them. If it is the wrong person (a link can also be
                  made automatically from a verified email), unlink it; the right customer can then
                  be linked.
                </p>
                <UnlinkCustomerButton
                  customerId={event.customer.linked.id}
                  customerLabel={event.customer.linked.label}
                />
              </>
            ) : (
              <>
                <p className="text-sm text-dust-700">
                  Online orders are recorded without a customer until an admin links the Shopify
                  customer. A matching email is a candidate, never proof.
                </p>
                <LinkCustomerButton eventId={event.id} customer={event.customer} />
              </>
            )}
          </div>
        </Card>
      ) : null}

      <Card title="Headers" className="mt-6">
        {event.headers.length === 0 ? (
          <p className="text-dust-700">No headers stored.</p>
        ) : (
          <dl className="flex flex-col gap-2">
            {event.headers.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <dt className="font-mono text-xs text-dust-500">{k}</dt>
                <dd className="font-mono text-xs break-all">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {event.headersTruncated ? (
          <p className="mt-3 text-sm text-dust-700">Some headers were shortened.</p>
        ) : null}
      </Card>

      <Card title="Payload" className="mt-6">
        {event.payload !== null ? (
          <JsonView json={event.payload} />
        ) : event.payloadPurgedAt ? (
          <p className="text-dust-700">Payload removed after the retention period.</p>
        ) : event.rejectionReason ? (
          // D88: a rejected delivery's body is never stored, only its size
          // and SHA-256, so a forgery cannot plant data.
          <p className="text-dust-700">
            {event.rejectionReason === "hmac_invalid"
              ? "Body not stored: the signature did not match, so BICII kept only its size and fingerprint."
              : "Body not stored: the delivery was rejected, so BICII kept only its size and fingerprint."}
          </p>
        ) : (
          <p className="text-dust-700">No payload stored.</p>
        )}
      </Card>
    </>
  );
}
