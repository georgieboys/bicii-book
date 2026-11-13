"use client";

import { useActionState, useState } from "react";

import { decideAdventureReviewAction } from "@/app/(staff)/adventures/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useFocusFirstInvalid } from "@/components/ui/use-focus-invalid";
import type { ActionResult } from "@/lib/actions";
import { DECISION_LABELS, REVIEW_CHECKS, type AdventureReviewDecision } from "@/lib/adventures";
import { callAction } from "@/lib/call-action";

type State = ActionResult<unknown> | null;

/**
 * The reviewer's decision (D178): the checklist, the accepted distance and
 * completion day (approvals), a message the rider reads (required unless
 * approved) and an internal note. The figures are prefilled from the
 * parsed tracks; the reviewer confirms or corrects them.
 */
export function ReviewDecisionForm({
  submissionId,
  suggestedDistanceKm,
  suggestedCompletedOn,
}: {
  submissionId: string;
  suggestedDistanceKm: string | null;
  suggestedCompletedOn: string | null;
}) {
  const { toast } = useToast();
  const [decision, setDecision] = useState<AdventureReviewDecision>("approved");
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, formData) => {
    const result = await callAction(
      () =>
        decideAdventureReviewAction(
          prev as ActionResult<{ decision: AdventureReviewDecision }> | null,
          formData,
        ),
      formData,
    );
    if (result.ok) toast({ title: DECISION_LABELS[decision], tone: "success" });
    return result;
  }, null);
  const formRef = useFocusFirstInvalid(state);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const values = state && !state.ok ? state.values : undefined;
  const approving = decision === "approved";

  return (
    <Card title="Decision">
      <form ref={formRef} action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="submissionId" value={submissionId} />
        {state && !state.ok ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {state.error}
          </p>
        ) : null}
        <Field label="Decision" error={errors?.decision?.[0]} required>
          <Select
            name="decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value as AdventureReviewDecision)}
          >
            <option value="approved">Approve and certify</option>
            <option value="changes_requested">Ask the rider for changes</option>
            <option value="rejected">Do not certify</option>
          </Select>
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold">
            Checklist{approving ? " (every item must hold to certify)" : ""}
          </legend>
          {REVIEW_CHECKS.map((c) => (
            <Checkbox
              key={c.key}
              name={c.key}
              label={c.label}
              defaultChecked={values?.[c.key] === "on"}
            />
          ))}
        </fieldset>

        {approving ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Accepted distance (km)"
              hint="From the recording; correct it if the track has gaps or detours."
              error={errors?.acceptedDistanceKm?.[0]}
              required
            >
              <Input
                name="acceptedDistanceKm"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={values?.acceptedDistanceKm ?? suggestedDistanceKm ?? ""}
              />
            </Field>
            <Field
              label="Completed on"
              hint="The day the ride finished, in Singapore."
              error={errors?.completedOn?.[0]}
              required
            >
              <Input
                name="completedOn"
                type="date"
                defaultValue={values?.completedOn ?? suggestedCompletedOn ?? ""}
              />
            </Field>
          </div>
        ) : null}

        <Field
          label="Message to the rider"
          hint={
            approving
              ? "Optional. The rider sees it with their certificate."
              : "The rider sees this. Say what to change, or why the ride is not certified."
          }
          error={errors?.messageToRider?.[0]}
          required={!approving}
        >
          <Textarea name="messageToRider" rows={3} defaultValue={values?.messageToRider} />
        </Field>
        <Field label="Internal note" hint="Staff only." error={errors?.internalNote?.[0]}>
          <Textarea name="internalNote" rows={2} defaultValue={values?.internalNote} />
        </Field>
        <div>
          <Button
            type="submit"
            variant={decision === "rejected" ? "danger" : undefined}
            pending={pending}
            pendingLabel="Saving…"
          >
            {approving
              ? "Certify this ride"
              : decision === "changes_requested"
                ? "Send back to the rider"
                : "Do not certify"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
