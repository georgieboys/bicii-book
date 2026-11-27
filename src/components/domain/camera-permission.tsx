import { Button } from "@/components/ui/button";
import { CameraIcon } from "@/components/ui/icons";
import { useIsFramed } from "@/lib/framed";

/**
 * Where the camera stands, for the scanner (SPEC §20). Phase 0's states
 * and messages, plus `insecure` (the camera needs HTTPS, or localhost) and
 * `failed` (it exists but would not start). Whatever the state, manual
 * entry stays available under it.
 */
export type CameraState =
  "unknown" | "prompt" | "granted" | "denied" | "unsupported" | "insecure" | "failed";

export const CAMERA_MESSAGES: Record<CameraState, string> = {
  unknown: "Checking camera access…",
  prompt: "Allow camera access so scanning works the moment it arrives.",
  granted: "Camera access is allowed.",
  denied:
    "Camera access is blocked. On iPhone: Settings → Safari → Camera → Allow, then reload this page.",
  unsupported:
    "This browser cannot use the camera here. Open the app over HTTPS in Safari or Chrome.",
  insecure:
    "The camera only works over a secure connection. Open the app over HTTPS (or on localhost).",
  failed: "The camera would not start. Close any other app using it, then try again.",
};

/**
 * Inside the Shopify admin's frame (D275) a refusal comes from the frame,
 * not from the phone's settings, so the Safari advice would not help
 * (R-136).
 */
export const FRAMED_DENIED_MESSAGE =
  "The camera doesn't work inside Shopify. Type the code below, or open BICII Admin at its own address to scan.";

/** The message for a camera state, framed or not. */
export function cameraMessage(state: CameraState, framed: boolean): string {
  return framed && state === "denied" ? FRAMED_DENIED_MESSAGE : CAMERA_MESSAGES[state];
}

/**
 * Maps a getUserMedia failure onto a camera state: refused permission is
 * `denied`, no usable camera is `unsupported`, a blocked or busy camera is
 * `failed`.
 */
export function cameraErrorState(error: unknown): CameraState {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "denied";
  if (name === "SecurityError") return "insecure";
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "TypeError" ||
    name === "DevicesNotFoundError"
  ) {
    return "unsupported";
  }
  return "failed";
}

/**
 * The camera's state when it is not showing a picture: the message, and
 * "Allow camera" (or "Try again") when pressing it can help. Nothing is
 * captured or uploaded.
 */
export function CameraPermission({ state, onStart }: { state: CameraState; onStart?: () => void }) {
  const framed = useIsFramed();
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-hairline bg-card px-4 py-6 text-center">
      <span
        aria-hidden="true"
        className="flex size-20 items-center justify-center rounded-full bg-yellow text-ink"
      >
        <CameraIcon className="size-9" />
      </span>
      <p role="status" className="measure text-dust-700">
        {cameraMessage(state, framed)}
      </p>
      {onStart && (state === "prompt" || state === "failed") ? (
        <Button variant="solid" onClick={onStart}>
          {state === "prompt" ? "Allow camera" : "Try again"}
        </Button>
      ) : null}
    </div>
  );
}
