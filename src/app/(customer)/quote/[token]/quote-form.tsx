"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatMoney, sumMoney } from "@/lib/money";
import { ANSWER_NAME_MAX } from "@/lib/quote-answer";

import { answerQuoteAction } from "./actions";

type Item = {
  id: string;
  kind: "part" | "service";
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

type Answer = "approve" | "decline";

/**
 * Per-item answers and the customer's name (D142). Nothing is chosen for
 * them: every item needs Approve or Decline before the answer can go. On
 * success the page reloads into its answered state.
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
  const [pending, start] = useTransition();

  const unanswered = items.filter((i) => !answers[i.id]).length;
  const approvedTotal = sumMoney(
    items.filter((i) => answers[i.id] === "approve").map((i) => i.lineTotal),
  );

  const submit = () => {
    if (unanswered > 0) {
      setError(
        `Approve or decline every item (${unanswered} still ${unanswered === 1 ? "needs" : "need"} an answer).`,
      );
      return;
    }
    if (name.trim() === "") {
      setNameError("Type your name.");
      setError(null);
      return;
    }
    setError(null);
    setNameError(null);
    start(async () => {
      const result = await answerQuoteAction({
        token,
        name,
        decisions: items.map((i) => ({ itemId: i.id, approve: answers[i.id] === "approve" })),
      });
      if (result.ok) {
        router.refresh();
        return;
      }
      setNameError(result.fieldErrors?.name?.[0] ?? null);
      setError(result.error);
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
                label={`Your answer for ${i.description}`}
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={ANSWER_NAME_MAX}
          autoComplete="name"
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger-deep">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" pending={pending} pendingLabel="Sending…">
        Send my answer
      </Button>
    </form>
  );
}
