import type { Metadata } from "next";

import { signOut } from "@/app/(auth)/login/actions";
import { ExtraAccessBadge, RoleBadge } from "@/components/domain/role-badge";
import { Card } from "@/components/ui/card";
import { CheckIcon, SignOutIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  PERMISSION_LABELS,
  ROLE_DESCRIPTIONS,
  canRecordCounterPayment,
  canRecordRefund,
  isExceptionFor,
} from "@/lib/auth/permissions";
import { requireStaff } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Your profile" };

/** One thing the person can do: a check, a label, a description and an optional badge. */
function Capability({
  label,
  description,
  extra = false,
}: {
  label: string;
  description: string;
  extra?: boolean;
}) {
  return (
    <li className="flex items-start gap-3">
      <CheckIcon className="mt-0.5 size-5 shrink-0 text-done-deep" />
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {label}
          {extra ? <ExtraAccessBadge /> : null}
        </span>
        <span className="text-sm text-dust-500">{description}</span>
      </span>
    </li>
  );
}

/**
 * The signed-in person's role and what it lets them do (PLAN D90-D94): the
 * role's one line, every effective permission (an exception on top of the
 * role marked "Extra access", D92), refunds for admins and managers (D94)
 * and, for admins, counter payments (D161a) and the admin-only settings
 * (D91). The database enforces
 * each of these again; this page only explains them.
 */
export default async function ProfilePage() {
  const staff = await requireStaff();
  const admin = staff.role === "admin";
  const refunds = canRecordRefund(staff);
  const counter = canRecordCounterPayment(staff);
  const nothingExtra = staff.permissions.length === 0 && !refunds && !counter && !admin;
  return (
    <>
      <PageHeader eyebrow="Settings" title={staff.displayName} description={staff.email} />
      <Card title="Your role and access" actions={<RoleBadge role={staff.role} />}>
        <p className="mb-3 text-dust-700">{ROLE_DESCRIPTIONS[staff.role]}.</p>
        {nothingExtra ? (
          <p className="text-dust-700">
            Workshop access only: jobs, intake, notes, photos, parts, services, scanning and labels.
            Ask an admin if you need more.
          </p>
        ) : (
          <ul aria-label="Your permissions" className="flex flex-col gap-3">
            {staff.permissions.map((p) => (
              <Capability
                key={p}
                label={PERMISSION_LABELS[p].label}
                description={PERMISSION_LABELS[p].description}
                extra={isExceptionFor(staff.role, p)}
              />
            ))}
            {refunds ? (
              <Capability
                label="Record refunds"
                description="Give money back on a retail sale, with a reason. Admins and managers."
              />
            ) : null}
            {counter ? (
              <Capability
                label="Record counter payments"
                description="Record money the shop took at the counter on a job, and void one recorded in error or given back. Admins only."
              />
            ) : null}
            {admin ? (
              <Capability
                label="Admin settings"
                description="Shop settings, hours, appointment types, Cult Commons rates, staff and roles."
              />
            ) : null}
          </ul>
        )}
      </Card>
      <form action={signOut}>
        <SubmitButton
          variant="outline"
          icon={<SignOutIcon className="size-5" />}
          pendingLabel="Signing out…"
        >
          Sign out
        </SubmitButton>
      </form>
    </>
  );
}
