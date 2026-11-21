"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Field } from "@/components/ui/field";
import { AlertIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  OTP_EXPIRY_MINUTES,
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  resendSecondsLeft,
} from "@/lib/auth/otp";
import { clearSignedInDeviceData } from "@/lib/device-data";

import { signInStep, type LoginState } from "./actions";

/**
 * Staff sign-in with an emailed code (PLAN D10, D70): the email, then the
 * 6-digit code, on one page with no navigation in between, so it works the
 * same inside the installed app (codes, never links). One action state for
 * both steps; every form posts `intent` and, when there is one, `next`.
 */
export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(signInStep, null);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Nobody is signed in here: remove what the device kept for the last
  // person (the intake draft, recent searches), which also covers a session
  // that expired or was revoked without "Sign out".
  useEffect(() => {
    clearSignedInDeviceData();
  }, []);

  // Focus follows the step: the Code field when step 2 opens or a code is
  // refused, the Email field after an error there or "Use a different email".
  useEffect(() => {
    if (!state) return;
    (state.step === "code" ? codeRef : emailRef).current?.focus();
  }, [state]);

  const nextField = next ? <input type="hidden" name="next" value={next} /> : null;

  if (state?.step === "code") {
    return (
      <CodeStep state={state} formAction={formAction} nextField={nextField} codeRef={codeRef} />
    );
  }
  return (
    <EmailStep state={state} formAction={formAction} nextField={nextField} emailRef={emailRef} />
  );
}

type FormAction = (formData: FormData) => void;

function ErrorAlert({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger-deep"
    >
      <AlertIcon className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}

function EmailStep({
  state,
  formAction,
  nextField,
  emailRef,
}: {
  state: Extract<LoginState, { step: "email" }> | null;
  formAction: FormAction;
  nextField: ReactNode;
  emailRef: RefObject<HTMLInputElement | null>;
}) {
  const errorId = useId();
  const invalid = state?.errorField === "email";
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="intent" value="request" />
      {nextField}
      <ErrorAlert id={errorId} message={state?.error} />
      <Field label="Email" required>
        <Input
          ref={emailRef}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid && state?.error ? errorId : undefined}
          defaultValue={state?.email ?? ""}
          key={state?.email ?? ""}
        />
      </Field>
      <SubmitButton fullWidth size="lg" pendingLabel="Sending…">
        Email me a code
      </SubmitButton>
    </form>
  );
}

/**
 * Whole seconds until "Send a new code" unlocks, counted on this device's
 * clock from when the screen saw this send (`sentAt` only identifies it),
 * so a phone whose clock disagrees with the server's still waits 60 s.
 */
function useResendSecondsLeft(sentAt: number): number {
  const [clock, setClock] = useState<{ sentAt: number; start: number; now: number } | null>(null);
  useEffect(() => {
    const start = Date.now();
    const tick = () => {
      const now = Date.now();
      setClock({ sentAt, start, now });
      if (resendSecondsLeft(start, now) === 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [sentAt]);
  return clock?.sentAt === sentAt
    ? resendSecondsLeft(clock.start, clock.now)
    : RESEND_COOLDOWN_SECONDS;
}

function CodeStep({
  state,
  formAction,
  nextField,
  codeRef,
}: {
  state: Extract<LoginState, { step: "code" }>;
  formAction: FormAction;
  nextField: ReactNode;
  codeRef: RefObject<HTMLInputElement | null>;
}) {
  const explainId = useId();
  const errorId = useId();
  const secondsLeft = useResendSecondsLeft(state.sentAt);
  const invalid = state.errorField === "code";
  const emailField = <input type="hidden" name="email" value={state.email} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl">Check your email</h2>
        {/* One text node, identical for staff and unknown emails (D70). */}
        <p id={explainId} className="break-words text-dust-700">
          {`If ${state.email} belongs to BICII staff, we've emailed a ${OTP_LENGTH}-digit code. It expires in ${OTP_EXPIRY_MINUTES} minutes.`}
        </p>
      </div>
      <p role="status" className="text-sm font-medium text-done-deep empty:hidden">
        {/* A new node per send, so a second resend is announced again. */}
        {state.notice ? <span key={state.sentAt}>{state.notice}</span> : null}
      </p>
      <ErrorAlert id={errorId} message={state.error} />
      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="intent" value="verify" />
        {emailField}
        {nextField}
        <Field label="Code" required>
          <Input
            ref={codeRef}
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={OTP_LENGTH * 3}
            className="font-mono text-xl tracking-[0.3em]"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid && state.error ? `${errorId} ${explainId}` : explainId}
          />
        </Field>
        <SubmitButton fullWidth size="lg" pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
      </form>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <form action={formAction} className="contents">
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="resend" value="1" />
          {emailField}
          {nextField}
          <SubmitButton variant="outline" disabled={secondsLeft > 0} pendingLabel="Sending…">
            {secondsLeft > 0
              ? `Send a new code in ${formatCountdown(secondsLeft)}`
              : "Send a new code"}
          </SubmitButton>
        </form>
        <form action={formAction} className="contents">
          <input type="hidden" name="intent" value="change_email" />
          {emailField}
          {nextField}
          <SubmitButton variant="ghost">Use a different email</SubmitButton>
        </form>
      </div>
    </div>
  );
}
