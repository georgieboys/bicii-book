import "server-only";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { balanceEmail } from "@/lib/payments";

import { emailConfig, sendEmail, type EmailResult } from "./resend";

/**
 * Whether payment link emails can be sent: RESEND_API_KEY and EMAIL_FROM
 * are set (the quote emails' switch, D144; D156).
 */
export function balanceEmailEnabled(): boolean {
  return emailConfig(getServerEnv()) !== null;
}

/**
 * Emails a payment link to the customer (D156). The link id is the
 * idempotency key (`balance-<link id>`), so a retried send of the same link
 * is one email. A failure is logged with the link id and Resend's status
 * only (never the address, the amount or the link) and returned, so staff
 * can copy the link instead.
 */
export async function sendBalanceEmail(input: {
  linkId: string;
  to: string;
  firstName: string | null;
  jobNumber: string;
  /** Formatted, as send_balance_link returned it ("$180.00"). */
  amount: string;
  link: string;
  days: number;
}): Promise<EmailResult> {
  const config = emailConfig(getServerEnv());
  if (!config) return { ok: false, reason: "rejected" };
  const { subject, text, html } = balanceEmail(input);
  const result = await sendEmail(config, {
    to: input.to,
    subject,
    text,
    html,
    idempotencyKey: `balance-${input.linkId}`,
  });
  if (!result.ok) {
    logger.warn(
      { linkId: input.linkId, reason: result.reason, status: result.status },
      "payment link email not sent",
    );
  }
  return result;
}
