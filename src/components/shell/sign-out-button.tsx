"use client";

import type { ReactNode } from "react";

import { signOut } from "@/app/(auth)/login/actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { clearSignedInDeviceData } from "@/lib/device-data";

/**
 * "Sign out": removes what this device keeps for the person signed in (the
 * intake draft and recent searches, src/lib/device-data.ts) as the form
 * posts, then the signOut Server Action ends the session.
 */
export function SignOutButton({ icon }: { icon?: ReactNode }) {
  return (
    <form action={signOut} onSubmit={clearSignedInDeviceData}>
      <SubmitButton variant="outline" icon={icon} pendingLabel="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  );
}
