"use client";

import { useState, useTransition } from "react";

import { sendBalanceLinkAction } from "@/app/(staff)/jobs/payment-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/actions";
import { formatDate } from "@/lib/dates";
import { whatsappHref } from "@/lib/indent";
import { formatMoney } from "@/lib/money";
import { LINK_DAYS } from "@/lib/payments";
import { newId } from "@/lib/uuid";
import { callAction } from "@/lib/call-action";

import { CopyText } from "./copy-text";

type SendChannel = "whatsapp" | "email" | "link";

/** What sendBalanceLinkAction returns: the link, shown this once. */
export type BalanceLinkSent = {
  link: string;
  amount: string;
  validDays: number;
  expiresAt: string;
  emailedTo: string | null;
  emailFailed: boolean;
  checkoutNote: string | null;
};

/**
 * Send a payment link for what is left to pay (D156; any staff member;
 * the card offers it only while Stripe is on and the bill is final, the
 * RPC checks again): how to send it (WhatsApp only with a usable mobile
 * number, Email only when emails are on and the customer has an address,
 * or Copy link) and how long it works (1 to 30 days, 7 by default). A live
 * link is replaced, and the sheet says so. The link id is made when the
 * sheet opens; a used one is refused, never replayed (the token is shown
 * once), so a retry after a lost answer asks staff to send again.
 */
export function SendBalanceLinkSheet({
  workOrderId,
  stillToPay,
  currency,
  hasWhatsapp,
  emailEnabled,
  emailTo,
  replaces,
  now = new Date(),
  onSent,
  onClose,
}: {
  workOrderId: string;
  /** What is left to pay now (balance_due), as Postgres computed it. */
  stillToPay: string;
  currency: string;
  hasWhatsapp: boolean;
  /** RESEND_API_KEY and EMAIL_FROM are set. */
  emailEnabled: boolean;
  /** The customer's address when emails are on, else null (no Email option). */
  emailTo: string | null;
  /** The live link this one replaces (when it was sent and expires), or null. */
  replaces: { sentAt: string; expiresAt: string } | null;
  /** The time the expiry is read against (tests pass one). */
  now?: Date;
  onSent: (result: BalanceLinkSent) => void;
  onClose: () => void;
}) {
  const [linkId] = useState(newId);
  const [channel, setChannel] = useState<SendChannel>(
    hasWhatsapp ? "whatsapp" : emailTo ? "email" : "link",
  );
  const [days, setDays] = useState(String(LINK_DAYS.default));
  const [result, setResult] = useState<ActionResult<BalanceLinkSent> | null>(null);
  const [pending, start] = useTransition();
  const errors = result && !result.ok ? result.fieldErrors : undefined;

  const submit = () =>
    start(async () => {
      const r = await callAction(() =>
        sendBalanceLinkAction({ linkId, workOrderId, channel, validDays: days }),
      );
      setResult(r);
      if (r.ok) onSent(r.data);
    });

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Send payment link"
      description="The customer sees the bill and pays what is left by card or PayNow, through Stripe."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} pending={pending} pendingLabel="Sending…">
            Create link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {result && !result.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {result.error}
          </p>
        ) : null}
        <p className="flex items-baseline justify-between rounded-xl bg-sunken px-4 py-3 tabular-nums">
          <span className="text-sm text-dust-700">Still to pay</span>
          <output className="text-lg font-bold">{formatMoney(stillToPay, currency)}</output>
        </p>
        <p className="text-sm text-dust-700">
          The page always asks what is left to pay at the time, so a payment taken meanwhile is
          never asked again.
        </p>
        {replaces ? (
          <p role="note" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
            {/* The same test as the card's linkLine: an expired link already stopped. */}
            {Date.parse(replaces.expiresAt) <= now.getTime()
              ? `This replaces the link sent on ${formatDate(replaces.sentAt)}, which expired on ${formatDate(replaces.expiresAt)}.`
              : `This replaces the link sent on ${formatDate(replaces.sentAt)}. That link stops working.`}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <span className="font-display text-xs font-bold tracking-wide uppercase">Send by</span>
          <SegmentedControl
            label="Send by"
            name="channel"
            value={channel}
            onValueChange={(v) => setChannel(v as SendChannel)}
            options={[
              ...(hasWhatsapp ? [{ value: "whatsapp", label: "WhatsApp" }] : []),
              ...(emailTo ? [{ value: "email", label: "Email" }] : []),
              { value: "link", label: "Copy link" },
            ]}
          />
          {channel === "email" && emailTo ? (
            <p className="text-sm text-dust-500">The Admin emails the link to {emailTo}.</p>
          ) : null}
          {!hasWhatsapp ? (
            <p className="text-sm text-dust-500">
              No WhatsApp: the customer has no mobile number it can use.
            </p>
          ) : null}
          {!emailEnabled ? (
            <p className="text-sm text-dust-500">
              No email: emails aren&apos;t set up yet (an admin sets them up).
            </p>
          ) : !emailTo ? (
            <p className="text-sm text-dust-500">No email: the customer has no email address.</p>
          ) : null}
        </div>
        <Field
          label="Link works for (days)"
          hint={`${LINK_DAYS.min} to ${LINK_DAYS.max} days. It also stops once the bike is collected or the job is reopened.`}
          error={errors?.validDays?.[0]}
        >
          <NumberInput
            kind="quantity"
            stepper
            minValue={LINK_DAYS.min}
            maxValue={LINK_DAYS.max}
            value={days}
            onValueChange={setDays}
          />
        </Field>
      </div>
    </Sheet>
  );
}

/**
 * The payment link, shown this once (only its hash is stored): open
 * WhatsApp with the message, or copy the link and the message. Says when
 * it was emailed or the email failed, and when the replaced link's open
 * Checkout could not be expired or was paid meanwhile.
 */
export function BalanceLinkSentSheet({
  sent,
  message,
  phone,
  onClose,
}: {
  sent: BalanceLinkSent;
  message: string;
  phone: string | null;
  onClose: () => void;
}) {
  const whatsapp = whatsappHref(phone, message);
  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title="Payment link ready to send"
      description="This link is shown only now. If it is lost, send a new one."
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {sent.emailedTo ? (
          <p role="status" className="rounded-xl bg-done-soft p-3 text-sm text-done-deep">
            Emailed to {sent.emailedTo}.
          </p>
        ) : null}
        {sent.emailFailed ? (
          <p role="alert" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
            The email didn&apos;t go out. Copy the link and send it another way.
          </p>
        ) : null}
        {sent.checkoutNote ? (
          <p role="alert" className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
            {sent.checkoutNote}
          </p>
        ) : null}
        <p className="text-sm text-dust-700">
          It asks {formatMoney(sent.amount)} now and works until {formatDate(sent.expiresAt)}.
        </p>
        {whatsapp && !sent.emailedTo ? (
          <a
            href={whatsapp}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-tap items-center justify-center rounded-full bg-ink px-5 font-medium text-paper"
          >
            Open WhatsApp
          </a>
        ) : null}
        <Field label="Payment link">
          <CopyText value={sent.link} label="payment link" />
        </Field>
        <Field label="Message">
          <Textarea readOnly value={message} rows={5} />
        </Field>
      </div>
    </Sheet>
  );
}
