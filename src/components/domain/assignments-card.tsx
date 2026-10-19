"use client";

import { useState, useTransition } from "react";

import { assignStaff, unassignStaff } from "@/app/(staff)/jobs/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChipRadioGroup } from "@/components/ui/chip";
import { PlusIcon } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import type { AssignmentRole } from "@/lib/domain/workshop";
import { callAction } from "@/lib/call-action";

type Person = { staffId: string; name: string; role: AssignmentRole };

/**
 * Who is on a job (SPEC §7.2; D22): the lead and any additional staff,
 * each with Remove, and "Assign" (a sheet: an active staff member and the
 * role). Making someone lead replaces the current lead, who leaves the job.
 * Every change is in the timeline. Read-only once the job is collected or
 * cancelled.
 */
export function AssignmentsCard({
  workOrderId,
  assignments,
  staff,
  editable,
}: {
  workOrderId: string;
  assignments: Person[];
  /** Active staff, by name: who can be assigned. */
  staff: { id: string; name: string }[];
  editable: boolean;
}) {
  const { toast } = useToast();
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const lead = assignments.find((a) => a.role === "lead") ?? null;
  const additional = assignments.filter((a) => a.role === "additional");

  const remove = (person: Person) => {
    setRemoving(person.staffId);
    startTransition(async () => {
      const result = await callAction(() =>
        unassignStaff({ workOrderId, staffId: person.staffId }),
      );
      setRemoving(null);
      if (!result.ok) {
        toast({ title: `${person.name} not removed`, description: result.error, tone: "error" });
        return;
      }
      toast({ title: `${person.name} removed from the job`, tone: "success" });
    });
  };

  const row = (person: Person) => (
    <li key={person.staffId} className="flex min-h-tap items-center justify-between gap-3">
      <span className="font-medium">{person.name}</span>
      {editable ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${person.name}`}
          pending={removing === person.staffId}
          pendingLabel="Removing…"
          disabled={removing !== null}
          onClick={() => remove(person)}
        >
          Remove
        </Button>
      ) : null}
    </li>
  );

  return (
    <Card
      title="People"
      actions={
        editable ? (
          <Button
            variant="outline"
            size="sm"
            icon={<PlusIcon className="size-4" />}
            onClick={() => setAssigning(true)}
          >
            Assign
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="eyebrow text-dust-500">Lead</h3>
          {lead ? (
            <ul aria-label="Lead">{row(lead)}</ul>
          ) : (
            <p className="flex min-h-tap items-center font-medium text-waiting-deep">Unassigned</p>
          )}
        </div>
        {additional.length > 0 ? (
          <div>
            <h3 className="eyebrow text-dust-500">Also on the job</h3>
            <ul aria-label="Also on the job" className="divide-y divide-hairline">
              {additional.map(row)}
            </ul>
          </div>
        ) : null}
        {editable ? null : (
          <p className="text-sm text-dust-500">
            This job is closed; its people can&rsquo;t change.
          </p>
        )}
      </div>
      {assigning ? (
        <AssignSheet
          workOrderId={workOrderId}
          lead={lead}
          assignments={assignments}
          staff={staff}
          onClose={() => setAssigning(false)}
        />
      ) : null}
    </Card>
  );
}

function AssignSheet({
  workOrderId,
  lead,
  assignments,
  staff,
  onClose,
}: {
  workOrderId: string;
  lead: Person | null;
  assignments: Person[];
  staff: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [staffId, setStaffId] = useState<string | null>(null);
  const [role, setRole] = useState<AssignmentRole>(lead ? "additional" : "lead");
  const [error, setError] = useState<string | null>(null);
  const chosen = staff.find((s) => s.id === staffId) ?? null;
  const current = (id: string) => assignments.find((a) => a.staffId === id) ?? null;

  const submit = () => {
    if (!chosen) {
      setError("Choose who to assign.");
      return;
    }
    startTransition(async () => {
      const result = await callAction(() => assignStaff({ workOrderId, staffId: chosen.id, role }));
      if (!result.ok) {
        setError(result.fieldErrors?.staffId?.[0] ?? result.error);
        return;
      }
      toast({
        title:
          role === "lead" ? `${chosen.name} is now the lead` : `${chosen.name} added to the job`,
        tone: "success",
      });
      onClose();
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      title="Assign"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} pending={pending} pendingLabel="Assigning…">
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <p id="assign-who" className="font-display text-xs font-bold tracking-wide uppercase">
            Who
          </p>
          <ChipRadioGroup
            labelledBy="assign-who"
            value={staffId ?? undefined}
            onChange={(id) => {
              setStaffId(id);
              setError(null);
            }}
            options={staff.map((s) => {
              const on = current(s.id);
              return {
                value: s.id,
                children: (
                  <>
                    {s.name}
                    {on ? (
                      <span className="text-xs font-normal opacity-80">
                        ({on.role === "lead" ? "lead" : "on the job"})
                      </span>
                    ) : null}
                  </>
                ),
              };
            })}
          />
          <p className="text-sm text-dust-500">Active staff only.</p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-display text-xs font-bold tracking-wide uppercase">Role</p>
          <SegmentedControl<AssignmentRole>
            label="Role"
            options={[
              { value: "lead", label: "Lead" },
              { value: "additional", label: "Additional" },
            ]}
            value={role}
            onValueChange={setRole}
          />
          {role === "lead" && lead && lead.staffId !== staffId ? (
            <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
              Replaces {lead.name} as lead; they leave the job.
            </p>
          ) : null}
          {role === "additional" && chosen && current(chosen.id)?.role === "lead" ? (
            <p className="rounded-xl bg-waiting-soft p-3 text-sm text-waiting-deep">
              {chosen.name} stops being the lead and stays on the job; the job has no lead until you
              assign one.
            </p>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
