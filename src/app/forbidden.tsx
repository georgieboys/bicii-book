import { SignOutButton } from "@/components/shell/sign-out-button";
import { StatusScreen } from "@/components/shell/status-screen";
import { ButtonLink } from "@/components/ui/button";

/** 403: signed in, but not active staff or missing a permission (requireStaff). */
export default function Forbidden() {
  return (
    <StatusScreen
      code="403 · No access"
      title="You can't open this"
      actions={
        <>
          <ButtonLink href="/">Go to Today</ButtonLink>
          <SignOutButton />
        </>
      }
    >
      <p>
        Your account doesn&apos;t have permission for this page. Some pages are for admins only; for
        the others, if you need one for your work, ask an admin to grant it under Settings → Staff.
        If your access was removed, sign out.
      </p>
    </StatusScreen>
  );
}
