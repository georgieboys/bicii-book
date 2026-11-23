/**
 * "Tell the customer" on a completed or ready-for-collection job: the
 * message the counter sends by WhatsApp or email, and the links that open
 * it. Pure: safe in Client Components and unit tests. Nothing is sent by
 * BICII; the staff member's own WhatsApp or mail app sends it.
 */

import { SHOP_ADDRESS } from "@/lib/appointment-notices";
import { formatMoney } from "@/lib/money";
import { mailtoHref } from "@/lib/people";
import type { WorkOrderStatus } from "@/lib/workshop";

/** The statuses the button shows on: the work is done, the bike not yet collected. */
export function canTellCustomer(status: WorkOrderStatus): boolean {
  return status === "completed" || status === "ready_for_collection";
}

export type ReadyMessageInput = {
  firstName: string | null;
  jobNumber: string;
  bikeTitle: string;
  /**
   * What is still to pay (work_order_payment_totals.balance_due), or null
   * when it is not known (the payments read failed, or outside SGD): the
   * message then says nothing about money.
   */
  balanceDue: string | null;
  currency: string;
};

/** The words: the bike, the job, what is left to pay and where to collect it. */
export function readyMessage(input: ReadyMessageInput): string {
  const first = input.firstName?.trim();
  const hello = first ? `Hi ${first},` : "Hi,";
  const lines = [
    `${hello} your ${input.bikeTitle} is ready for collection at BICII (job ${input.jobNumber}).`,
  ];
  if (input.balanceDue !== null) {
    lines.push(
      Number(input.balanceDue) > 0
        ? `Balance due on collection: ${formatMoney(input.balanceDue, input.currency)}.`
        : "It is all paid, nothing is due on collection.",
    );
  }
  lines.push(`Collect it at ${SHOP_ADDRESS}.`);
  return lines.join("\n");
}

/** The email's subject line. */
export function readySubject(jobNumber: string): string {
  return `Your bike is ready for collection (job ${jobNumber})`;
}

/** A mailto: link with the subject and message, or null without an email address. */
export function readyMailtoHref(
  email: string | null | undefined,
  subject: string,
  text: string,
): string | null {
  const base = mailtoHref(email);
  if (!base) return null;
  return `${base}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

/** The timeline note left when the message is opened in WhatsApp or the mail app. */
export function toldCustomerNote(channel: "whatsapp" | "email", text: string): string {
  const how = channel === "whatsapp" ? "WhatsApp" : "email";
  return `Told the customer the bike is ready (opened ${how} with this message):\n${text}`;
}
