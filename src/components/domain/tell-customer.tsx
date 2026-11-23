"use client";

import { useState } from "react";

import { addWorkOrderNote } from "@/app/(staff)/jobs/actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { callAction } from "@/lib/call-action";
import { whatsappHref } from "@/lib/indent";
import { readyMailtoHref, readySubject, toldCustomerNote } from "@/lib/ready-message";
import { newId } from "@/lib/uuid";

type Channel = "whatsapp" | "email";

/**
 * "Tell the customer" (completed and ready-for-collection jobs): the
 * message that the bike is ready, naming the job, the bike, the balance due
 * and the shop's address, editable, then opened in WhatsApp (wa.me with the
 * customer's phone) or the mail app, or copied. Opening it leaves a note in
 * the job's timeline (add_work_order_note, one per channel and opening of
 * the sheet, so a second tap adds no second note). BICII sends nothing.
 */
export function TellCustomerButton({
  workOrderId,
  jobNumber,
  phone,
  email,
  message: initialMessage,
}: {
  workOrderId: string;
  jobNumber: string;
  phone: string | null;
  email: string | null;
  message: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Tell the customer
      </Button>
      {open ? (
        <TellCustomerSheet
          workOrderId={workOrderId}
          jobNumber={jobNumber}
          phone={phone}
          email={email}
          initialMessage={initialMessage}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function TellCustomerSheet({
  workOrderId,
  jobNumber,
  phone,
  email,
  initialMessage,
  onClose,
}: {
  workOrderId: string;
  jobNumber: string;
  phone: string | null;
  email: string | null;
  initialMessage: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [message, setMessage] = useState(initialMessage);
  // The idempotency keys: one timeline note per channel for this opening.
  const [noteIds] = useState(() => ({ whatsapp: newId(), email: newId() }));
  const whatsapp = whatsappHref(phone, message);
  const mailto = readyMailtoHref(email, readySubject(jobNumber), message);

  // The link opens at once; the note follows and never holds it up.
  const logIt = (channel: Channel) => {
    void callAction(() =>
      addWorkOrderNote({
        noteId: noteIds[channel],
        workOrderId,
        kind: "note",
        body: toldCustomerNote(channel, message),
      }),
    ).then((result) => {
      if (!result.ok) {
        toast({ title: "The message opened, but the timeline note wasn't saved.", tone: "error" });
      }
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast({ title: "Message copied", tone: "success" });
    } catch {
      const box = document.getElementById("tell-customer-message");
      if (box instanceof HTMLTextAreaElement) {
        box.focus();
        box.select();
      }
      toast({ title: "Select the text and copy it", tone: "neutral" });
    }
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      title="Tell the customer"
      description="Opens your WhatsApp or mail app with the message filled in. Change it before you send."
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Message">
          <Textarea
            id="tell-customer-message"
            rows={6}
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          {whatsapp ? (
            <a
              href={whatsapp}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses({ variant: "solid" })}
              onClick={() => logIt("whatsapp")}
            >
              Open WhatsApp
            </a>
          ) : null}
          {mailto ? (
            <a
              href={mailto}
              className={buttonClasses({ variant: "outline" })}
              onClick={() => logIt("email")}
            >
              Email
            </a>
          ) : null}
          <Button variant="outline" onClick={copy}>
            Copy message
          </Button>
        </div>
        {!whatsapp && !mailto ? (
          <p className="text-sm text-dust-700">
            The customer has no WhatsApp number or email on file. Copy the message and send it
            another way, or add their phone or email on their customer page.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
