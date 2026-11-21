/**
 * What the Admin keeps on a device for the person signed in (the intake
 * draft and recent searches, src/lib/device-data.ts) is removed when they
 * sign out and whenever the login page opens, so a shared device never
 * hands one person's intake or searches to the next (audit 2026-11-13).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn();
vi.mock("@/app/(auth)/login/actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
  signInStep: vi.fn(),
}));

import { LoginForm } from "@/app/(auth)/login/login-form";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { clearSignedInDeviceData } from "@/lib/device-data";
import { INTAKE_DRAFT_KEY } from "@/lib/intake-draft";
import { RECENT_SEARCHES_KEY } from "@/lib/recent-searches";

function seedDevice() {
  window.localStorage.setItem(INTAKE_DRAFT_KEY, JSON.stringify({ v: 2 }));
  window.localStorage.setItem("bicii.intake-draft.v1", JSON.stringify({ v: 1 }));
  window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["tan"]));
  window.localStorage.setItem("unrelated", "kept");
}

function signedInKeys(): string[] {
  return [INTAKE_DRAFT_KEY, "bicii.intake-draft.v1", RECENT_SEARCHES_KEY].filter(
    (k) => window.localStorage.getItem(k) !== null,
  );
}

beforeEach(() => {
  signOut.mockReset();
  signOut.mockResolvedValue(undefined);
  seedDevice();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("clearing the signed-in person's device data", () => {
  it("removes the intake draft and recent searches, and nothing else", () => {
    clearSignedInDeviceData();
    expect(signedInKeys()).toEqual([]);
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
  });

  it("Sign out clears them as it posts to signOut", async () => {
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signedInKeys()).toEqual([]);
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("the login page clears them when it opens", () => {
    render(<LoginForm />);
    expect(signedInKeys()).toEqual([]);
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
  });
});
