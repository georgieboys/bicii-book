"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useArmed } from "@/components/ui/use-armed";
import {
  PERMISSION_LABELS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type PermissionKey,
  type StaffRole,
} from "@/lib/auth/permissions";
import { roleChangeSummary, roleWithArticle } from "@/lib/auth/role-change";
import { REASON_MAX_LENGTH } from "@/lib/reasons";
import { callAction } from "@/lib/call-action";

import { setStaffActive, setStaffPermission, setStaffRole } from "../actions";

/**
 * One switch per "Extra access" exception the person's role does not
 * already include (PLAN D92): `permissions` lists them; what the role
 * includes is summarised above, never offered as a switch. Each change
 * applies immediately through the grant/revoke RPCs; the switch moves
 * optimistically and snaps back with an error toast if the server refuses.
 * A permission the viewer may not change (delegation ceiling, D11, D93) is
 * disabled with the reason underneath.
 */
export function PermissionSwitches({
  staffId,
  permissions,
  granted,
  disabled,
  blockers,
}: {
  staffId: string;
  permissions: readonly PermissionKey[];
  granted: PermissionKey[];
  disabled: boolean;
  blockers: Partial<Record<PermissionKey, string | null>>;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [optimistic, apply] = useOptimistic(
    granted,
    (state: PermissionKey[], change: { permission: PermissionKey; on: boolean }) =>
      change.on
        ? [...new Set([...state, change.permission])]
        : state.filter((p) => p !== change.permission),
  );

  const toggle = (permission: PermissionKey, on: boolean) => {
    startTransition(async () => {
      apply({ permission, on });
      const result = await callAction(() =>
        setStaffPermission({ staffId, permission, granted: on }),
      );
      if (!result.ok) {
        toast({ title: "Extra access not changed", description: result.error, tone: "error" });
      } else {
        toast({
          title: `${PERMISSION_LABELS[permission].label} ${on ? "granted" : "removed"}`,
          tone: "success",
        });
      }
    });
  };

  return (
    <div className="flex flex-col divide-y divide-hairline" aria-busy={pending || undefined}>
      {permissions.map((p) => (
        <Switch
          key={p}
          label={PERMISSION_LABELS[p].label}
          description={
            blockers[p] ? (
              <>
                {PERMISSION_LABELS[p].description}
                <span className="mt-0.5 block font-medium text-dust-700">{blockers[p]}</span>
              </>
            ) : (
              PERMISSION_LABELS[p].description
            )
          }
          checked={optimistic.includes(p)}
          onCheckedChange={(on) => toggle(p, on)}
          disabled={disabled || Boolean(blockers[p])}
        />
      ))}
    </div>
  );
}

/**
 * The role picker (PLAN D90, D93) for an admin viewing someone else:
 * Admin, Manager or Mechanic, then "Change role…" opens a sheet that says
 * what changes, takes an optional reason and confirms. `blocker` (e.g.
 * "You can't change your own role.") disables the picker with the reason
 * underneath. The page keys this by the current role, so a change that
 * went through starts the picker afresh.
 */
export function RoleControl({
  staffId,
  name,
  role,
  exceptions,
  blocker,
}: {
  staffId: string;
  name: string;
  role: StaffRole;
  exceptions: PermissionKey[];
  blocker: string | null;
}) {
  const [choice, setChoice] = useState<StaffRole>(role);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl<StaffRole>
        label="Role"
        value={choice}
        onValueChange={setChoice}
        options={ROLES.map((r) => ({
          value: r,
          label: ROLE_LABELS[r],
          disabled: blocker !== null,
        }))}
      />
      {choice !== role ? (
        <p className="text-sm text-dust-700">{ROLE_DESCRIPTIONS[choice]}.</p>
      ) : null}
      {blocker ? <p className="text-sm font-medium text-dust-700">{blocker}</p> : null}
      <div>
        <Button
          variant="outline"
          disabled={blocker !== null || choice === role}
          onClick={() => setOpen(true)}
        >
          Change role…
        </Button>
      </div>
      {open ? (
        <ChangeRoleSheet
          staffId={staffId}
          name={name}
          from={role}
          to={choice}
          exceptions={exceptions}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ChangeRoleSheet({
  staffId,
  name,
  from,
  to,
  exceptions,
  onClose,
}: {
  staffId: string;
  name: string;
  from: StaffRole;
  to: StaffRole;
  exceptions: PermissionKey[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  // A double tap on "Change role…" must not reach "Change role" (DESIGN.md "Forms").
  const armed = useArmed(true);
  // Focus starts on Cancel: the admin reads "What changes" first (removed
  // extra access does not come back), and the reason is optional.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const summary = roleChangeSummary(from, to, exceptions);

  const confirm = () => {
    if (!armed) return;
    startTransition(async () => {
      const result = await callAction(() =>
        setStaffRole({
          staffId,
          role: to,
          expected: from,
          reason: reason || undefined,
        }),
      );
      if (!result.ok) {
        const fieldError = result.fieldErrors?.reason?.[0];
        setReasonError(fieldError);
        setFormError(fieldError ? null : result.error);
        return;
      }
      toast({ title: `${name} is now ${roleWithArticle(to)}`, tone: "success" });
      onClose();
    });
  };

  return (
    <Sheet
      open
      onOpenChange={(next) => (next ? null : onClose())}
      dismissible={!pending}
      initialFocus={cancelRef}
      title={`Change ${name} to ${ROLE_LABELS[to]}?`}
      description={`From ${ROLE_LABELS[from]} to ${ROLE_LABELS[to]}. Kept in their history.`}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!armed} pending={pending} pendingLabel="Changing…" onClick={confirm}>
            Change role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {formError ? (
          <p role="alert" className="text-sm font-medium text-danger-deep">
            {formError}
          </p>
        ) : null}
        <ul aria-label="What changes" className="flex list-disc flex-col gap-2 pl-5 text-dust-700">
          {summary.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Field label="Why?" hint="Optional. Kept in their history." error={reasonError}>
          <Textarea
            name="reason"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(undefined);
            }}
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** Clicks this soon after the confirm step opens are ignored (a double tap on "Deactivate"). */
const CONFIRM_GUARD_MS = 400;

/**
 * Deactivate (two steps, with a required reason: SPEC §22) or reactivate.
 * The confirm step is a different element in a different place from the
 * first button, with focus moved to the reason field, so a double tap or a
 * repeated Enter on "Deactivate" cannot confirm by itself.
 */
export function AccessControl({
  staffId,
  name,
  active,
  blocker,
}: {
  staffId: string;
  name: string;
  active: boolean;
  /** Why the viewer may not change this person's access, or null. */
  blocker: string | null;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const openedAt = useRef(0);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
  }, [confirming]);

  const openConfirm = () => {
    openedAt.current = Date.now();
    setReason("");
    setReasonError(undefined);
    setConfirming(true);
  };

  const change = (next: boolean) => {
    if (!next) {
      if (Date.now() - openedAt.current < CONFIRM_GUARD_MS) return;
      if (reason.trim() === "") {
        setReasonError("Say why you are deactivating them.");
        reasonRef.current?.focus();
        return;
      }
    }
    startTransition(async () => {
      const result = await callAction(() =>
        setStaffActive({
          staffId,
          active: next,
          reason: next ? undefined : reason,
        }),
      );
      if (!result.ok) {
        const fieldError = result.fieldErrors?.reason?.[0];
        if (fieldError) {
          setReasonError(fieldError);
          reasonRef.current?.focus();
        } else {
          toast({ title: "Access not changed", description: result.error, tone: "error" });
        }
        return;
      }
      setConfirming(false);
      toast({ title: next ? `${name} reactivated` : `${name} deactivated`, tone: "success" });
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-dust-700">
        {active
          ? "Deactivating removes all of their access at once. Their name stays on past work."
          : "Reactivating restores their login and the permissions they had."}
      </p>
      {blocker ? <p className="text-sm text-dust-500">{blocker}</p> : null}
      {active && confirming ? (
        <div key="confirm" className="flex flex-col gap-3">
          <Field
            label={`Why are you deactivating ${name}?`}
            hint="Kept in their history."
            error={reasonError}
            required
          >
            <Textarea
              ref={reasonRef}
              name="reason"
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(undefined);
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button key="cancel" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              key="confirm-deactivate"
              variant="danger"
              pending={pending}
              pendingLabel="Deactivating…"
              onClick={() => change(false)}
            >
              Deactivate {name}
            </Button>
          </div>
        </div>
      ) : (
        <div key="start" className="flex flex-wrap gap-2">
          {active ? (
            <Button
              key="deactivate"
              variant="danger"
              disabled={blocker !== null}
              onClick={openConfirm}
            >
              Deactivate…
            </Button>
          ) : (
            <Button
              key="reactivate"
              variant="solid"
              disabled={blocker !== null}
              pending={pending}
              pendingLabel="Reactivating…"
              onClick={() => change(true)}
            >
              Reactivate
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
