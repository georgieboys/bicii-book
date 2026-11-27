import { describe, expect, it } from "vitest";

import {
  CAMERA_MESSAGES,
  FRAMED_DENIED_MESSAGE,
  cameraErrorState,
  cameraMessage,
} from "@/components/domain/camera-permission";
import { isFramed } from "@/lib/framed";

describe("camera inside the Shopify frame (D275, R-136)", () => {
  it("replaces the Safari advice when the frame blocks the camera", () => {
    expect(cameraMessage("denied", true)).toBe(FRAMED_DENIED_MESSAGE);
    expect(FRAMED_DENIED_MESSAGE).toContain("inside Shopify");
    expect(FRAMED_DENIED_MESSAGE).not.toContain("Settings");
  });

  it("keeps every other message, and denied outside a frame", () => {
    expect(cameraMessage("denied", false)).toBe(CAMERA_MESSAGES.denied);
    expect(cameraMessage("failed", true)).toBe(CAMERA_MESSAGES.failed);
    expect(cameraMessage("prompt", true)).toBe(CAMERA_MESSAGES.prompt);
  });

  it("tells a framed window from a top-level one", () => {
    const top = {} as Window;
    expect(isFramed({ self: top, top } as Window)).toBe(false);
    expect(isFramed({ self: {} as Window, top } as Window)).toBe(true);
    const unreadable = {
      self: top,
      get top(): Window {
        throw new DOMException("blocked", "SecurityError");
      },
    } as Window;
    expect(isFramed(unreadable)).toBe(true);
  });
});

const err = (name: string) => new DOMException("x", name);

describe("cameraErrorState", () => {
  it("maps getUserMedia failures onto the scanner's camera messages", () => {
    expect(cameraErrorState(err("NotAllowedError"))).toBe("denied");
    expect(cameraErrorState(err("SecurityError"))).toBe("insecure");
    expect(cameraErrorState(err("NotFoundError"))).toBe("unsupported");
    expect(cameraErrorState(err("OverconstrainedError"))).toBe("unsupported");
    expect(cameraErrorState(err("NotReadableError"))).toBe("failed");
    expect(cameraErrorState("weird")).toBe("failed");
  });

  it("keeps Phase 0's permission messages", () => {
    expect(CAMERA_MESSAGES.denied).toContain("Settings → Safari → Camera → Allow");
    expect(CAMERA_MESSAGES.unsupported).toContain("HTTPS");
    expect(CAMERA_MESSAGES.insecure).toContain("HTTPS");
  });
});
