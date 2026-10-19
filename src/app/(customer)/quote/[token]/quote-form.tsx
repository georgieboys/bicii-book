"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatMoney, sumMoney } from "@/lib/money";
import { ANSWER_NAME_MAX, missingItemsText } from "@/lib/quote-answer";

import { answerQuoteAction } from "./actions";
import { markAnswered } from "./thank-you";

type Item = {
  id: string;
  kind: "part" | "service";
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

type Answer = "approve" | "decline";

const ERROR_ID = "quote-answer-error";
const groupId = (itemId: string) => `quote-answer-${itemId}`;

/** Focuses a group's tab-stop option (the one Tab would reach). */
function focusGroup(itemId: string) {
  document.getElementById(groupId(itemId))?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
}

/**
 * Per-item answers and the customer's name (D142). Nothing is chosen for
 * them: every item needs Approve or Decline before the answer can go; a
 * refusal names the items still unanswered, marks them and focuses the
 * first (and a missing name focuses the name field). On success the page
 * reloads into its answered state, whose thank-you takes focus.
 */
export function QuoteForm({
  token,
  currency,
  total,
  items,
}: {
  token: string;
  currency: string;
  total: string;
  items: Item[];
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [pending, start] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  const missing = items.filter((i) => !answers[i.id]);
  // After the paint that renders the message, so it is read out with the focus.
  const focusSoon = (focus: () => void) => requestAnimationFrame(focus);
  const approvedTotal = sumMoney(
    items.filter((i) => answers[i.id] === "approve").map((i) => i.lineTotal),
  );

  const submit = () => {
    if (missing.length > 0) {
      const names = missing.map((i) => i.description);
      setError(
        `Approve or decline every item: ${missingItemsText(names)} still ${missing.length === 1 ? "needs" : "need"} an answer.`,
      );
      setShowMissing(true);
      focusSoon(() => focusGroup(missing[0].id));
      return;
    }
    if (name.trim() === "") {
      setNameError("Type your name.");
      setError(null);
      focusSoon(() => nameRef.current?.focus());
      return;
    }
    setError(null);
    setNameError(null);
    start(async () => {
      try {
        const result = await answerQuoteAction({
          token,
          name,
          decisions: items.map((i) => ({ itemId: i.id, approve: answers[i.id] === "approve" })),
        });
        if (result.ok) {
          markAnswered(token);
          router.refresh();
          return;
        }
        const fieldError = result.fieldErrors?.name?.[0] ?? null;
        setNameError(fieldError);
        setError(result.error);
        if (fieldError) focusSoon(() => nameRef.current?.focus());
      } catch {
        // A dropped connection: say so here instead of an error page.
        setError("We couldn't reach the shop. Check your connection and try again.");
      }
    });
  };

  return (
    <form
      className="flex flex-col gap-6"
      // Our own messages, in the page's words, rather than the browser's.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card title="Items">
        <ul aria-label="Quote items" className="flex flex-col divide-y divide-hairline">
          {items.map((i) => (
            <li key={i.id} aria-label={i.description} className="flex flex-col gap-3 py-4">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{i.description}</span>
                  <span className="text-sm text-dust-500">
                    {i.kind === "service" ? "Labour" : "Part"} · {i.quantity} ×{" "}
                    {formatMoney(i.unitPrice, currency)}
                  </span>
                </span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(i.lineTotal, currency)}
                </span>
              </div>
              <SegmentedControl<Answer>
                id={groupId(i.id)}
                label={`Your answer for ${i.description}`}
                required
                invalid={showMissing && !answers[i.id]}
                describedBy={ERROR_ID}
                value={answers[i.id] ?? null}
                onValueChange={(v) => {
                  setAnswers((prev) => ({ ...prev, [i.id]: v }));
                  setError(null);
                }}
                options={[
                  { value: "approve", label: "Approve" },
                  { value: "decline", label: "Decline" },
                ]}
              />
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-hairline pt-3 tabular-nums">
          <dt className="text-dust-700">Quote total</dt>
          <dd className="text-right">{formatMoney(total, currency)}</dd>
          <dt className="font-semibold">You approve</dt>
          <dd className="text-right font-bold">
            <output aria-label="Approved total">{formatMoney(approvedTotal, currency)}</output>
          </dd>
        </dl>
      </Card>

      <Field
        label="Your name"
        hint="So the shop knows who answered."
        error={nameError ?? undefined}
        required
      >
        <Input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={ANSWER_NAME_MAX}
          autoComplete="name"
        />
      </Field>

      {error ? (
        <p id={ERROR_ID} role="alert" className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} pendingLabel="Sending…">
        Send my answer
      </Button>
    </form>
  );
}
