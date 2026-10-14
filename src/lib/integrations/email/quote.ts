import "server-only";

import { getServerEnv } from "@/lib/env";
import { quoteEmail } from "@/lib/indent";
import { logger } from "@/lib/logger";

import { emailConfig, sendEmail, type EmailResult } from "./resend";

/** Whether quote emails can be sent: RESEND_API_KEY and EMAIL_FROM are set (D144). */
export function quoteEmailEnabled(): boolean {
  return emailConfig(getServerEnv()) !== null;
}

/**
 * Emails a quote's link to the customer (D144). The quote id is the
 * idempotency key, so a retried send of the same quote is one email. A
 * failure is logged with its status only (never the address or the link)
 * and returned, so staff can copy the link instead.
 */
export async function sendQuoteEmail(input: {
  quoteId: string;
  to: string;
  firstName: string | null;
  jobNumber: string;
  link: string;
  days: number;
}): Promise<EmailResult> {
  const config = emailConfig(getServerEnv());
  if (!config) return { ok: false, reason: "rejected" };
  const { subject, text, html } = quoteEmail(input);
  const result = await sendEmail(config, {
    to: input.to,
    subject,
    text,
    html,
    idempotencyKey: `quote-${input.quoteId}`,
  });
  if (!result.ok) {
    logger.warn(
      { quoteId: input.quoteId, reason: result.reason, status: result.status },
      "quote email not sent",
    );
  }
  return result;
}
