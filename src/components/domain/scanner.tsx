"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { interpretScan, truncateScan } from "@/lib/scan";

import { CameraPermission, cameraErrorState, type CameraState } from "./camera-permission";

/** At most ~6 decodes a second: enough for a label held still, light on the battery. */
const DECODE_INTERVAL_MS = 166;
/** The same unrecognised code is ignored for this long (no flicker while it stays in view). */
const FOREIGN_REPEAT_MS = 2_000;

type DetectedCode = { rawValue: string };
type Detector = { detect(source: HTMLVideoElement): Promise<DetectedCode[]> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type VideoWithFrames = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * The QR scanner (SPEC §20, PLAN D9). The rear camera feeds a muted inline
 * <video> under a square viewfinder. Decoding uses the browser's
 * BarcodeDetector when it supports QR codes (throttled to ~6 a second on
 * requestVideoFrameCallback, or requestAnimationFrame), and otherwise
 * ZXing, imported only then so it never weighs on the first load.
 *
 * A code is read with interpretScan against the accepted public QR bases
 * (src/lib/qr.ts scanBases: the database QR base, the environment's
 * public site URL and the retired bases) and the Admin's own origin. A BICII label vibrates, stops the camera and opens
 * /q/{shortId}, which redirects to the record. Anything else shows "Not a
 * BICII label" with the text cut short; it is never opened, followed or
 * linked, and the same text is ignored for 2 s while scanning continues.
 *
 * The camera stops on unmount, when the page is hidden and on pagehide,
 * and restarts when the page is visible again. A torch toggle appears when
 * the camera has one. Camera problems show CameraPermission's messages;
 * typing the code always works, with no camera at all.
 */
export function Scanner({ publicBases }: { publicBases: readonly string[] }) {
  const router = useRouter();
  const videoRef = useRef<VideoWithFrames>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopDecodingRef = useRef<(() => void) | null>(null);
  /** Bumped on every start and stop, so a late async step of an old start gives up. */
  const sessionRef = useRef(0);
  /** Set once a label is recognised: nothing else happens on this screen. */
  const leavingRef = useRef(false);
  const wantedRef = useRef(false);
  const lastForeignRef = useRef<{ raw: string; at: number } | null>(null);
  // Read through a ref, so a server refresh handing a new (equal) array
  // never restarts the camera.
  const basesRef = useRef(publicBases);
  useEffect(() => {
    basesRef.current = publicBases;
  }, [publicBases]);
  const [camera, setCamera] = useState<CameraState>("unknown");
  const [streaming, setStreaming] = useState(false);
  const [foreign, setForeign] = useState<string | null>(null);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({
    supported: false,
    on: false,
  });

  const stop = useCallback(() => {
    sessionRef.current += 1;
    stopDecodingRef.current?.();
    stopDecodingRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
    setStreaming(false);
    setTorch({ supported: false, on: false });
  }, []);

  const open = useCallback(
    (shortId: string) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      wantedRef.current = false;
      navigator.vibrate?.(30);
      stop();
      router.push(`/q/${shortId}`);
    },
    [router, stop],
  );

  const handle = useCallback(
    (raw: string) => {
      if (leavingRef.current) return;
      const result = interpretScan(raw, {
        publicBases: basesRef.current,
        adminOrigin: window.location.origin,
      });
      if (result.kind === "record") {
        open(result.shortId);
        return;
      }
      const now = Date.now();
      const last = lastForeignRef.current;
      if (last && last.raw === raw && now - last.at < FOREIGN_REPEAT_MS) return;
      lastForeignRef.current = { raw, at: now };
      setForeign(raw);
    },
    [open],
  );

  const startDecoding = useCallback(
    async (video: VideoWithFrames, session: number) => {
      const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      let detector: Detector | null = null;
      if (Native) {
        try {
          const formats = await Native.getSupportedFormats();
          if (formats.includes("qr_code")) detector = new Native({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      if (session !== sessionRef.current) return;

      if (detector) {
        let active = true;
        let busy = false;
        let last = -Infinity;
        let frameHandle = 0;
        let rafHandle = 0;
        const tick = (now: number) => {
          if (!active) return;
          if (!busy && now - last >= DECODE_INTERVAL_MS && video.readyState >= 2) {
            busy = true;
            last = now;
            detector
              .detect(video)
              .then((codes) => {
                if (active) for (const code of codes) handle(code.rawValue);
              })
              .catch(() => undefined)
              .finally(() => {
                busy = false;
              });
          }
          schedule();
        };
        const schedule = () => {
          if (!active) return;
          if (video.requestVideoFrameCallback) {
            frameHandle = video.requestVideoFrameCallback(tick);
          } else {
            rafHandle = window.requestAnimationFrame(tick);
          }
        };
        schedule();
        stopDecodingRef.current = () => {
          active = false;
          if (frameHandle) video.cancelVideoFrameCallback?.(frameHandle);
          if (rafHandle) window.cancelAnimationFrame(rafHandle);
        };
        return;
      }

      // No native QR detection (iOS before 17, Firefox): ZXing, loaded now.
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (session !== sessionRef.current) return;
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: DECODE_INTERVAL_MS,
        });
        const controls = await reader.decodeFromVideoElement(video, (result) => {
          if (result) handle(result.getText());
        });
        if (session !== sessionRef.current) {
          controls.stop();
          return;
        }
        stopDecodingRef.current = () => controls.stop();
      } catch {
        if (session === sessionRef.current) setCamera("failed");
      }
    },
    [handle],
  );

  const start = useCallback(async () => {
    if (leavingRef.current) return;
    if (!window.isSecureContext) return setCamera("insecure");
    if (!navigator.mediaDevices?.getUserMedia) return setCamera("unsupported");
    stop();
    wantedRef.current = true;
    const session = sessionRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (error) {
      if (session === sessionRef.current) {
        wantedRef.current = false;
        setCamera(cameraErrorState(error));
      }
      return;
    }
    const video = videoRef.current;
    if (session !== sessionRef.current || !video || document.visibilityState === "hidden") {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;
    video.srcObject = stream;
    setCamera("granted");
    setStreaming(true);
    try {
      await video.play();
    } catch {
      // Autoplay of a muted inline video is allowed; a refusal here means
      // the page was hidden meanwhile, and the visibility handler restarts.
    }
    if (session !== sessionRef.current) return;
    const [track] = stream.getVideoTracks();
    const caps = (track?.getCapabilities?.() ?? {}) as TorchCapabilities;
    setTorch({ supported: caps.torch === true, on: false });
    void startDecoding(video, session);
  }, [startDecoding, stop]);

  // Ask once on arrival: start straight away when access is already
  // granted; otherwise say why not, or offer "Allow camera".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.isSecureContext) return setCamera("insecure");
      if (!navigator.mediaDevices?.getUserMedia) return setCamera("unsupported");
      let state: PermissionState | "unknown" = "unknown";
      try {
        const status = await navigator.permissions.query({ name: "camera" as PermissionName });
        state = status.state;
      } catch {
        // Safari before 16 and Firefox cannot query camera permission.
        state = "prompt";
      }
      if (cancelled) return;
      if (state === "granted") void start();
      else setCamera(state === "denied" ? "denied" : "prompt");
    })();
    return () => {
      cancelled = true;
    };
  }, [start]);

  // Stop the camera whenever the page is not in front; resume on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        const wanted = wantedRef.current;
        stop();
        wantedRef.current = wanted;
      } else if (wantedRef.current && !leavingRef.current) {
        void start();
      }
    };
    const onPageHide = () => {
      const wanted = wantedRef.current;
      stop();
      wantedRef.current = wanted;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      wantedRef.current = false;
      stop();
    };
  }, [start, stop]);

  const toggleTorch = async () => {
    const [track] = streamRef.current?.getVideoTracks() ?? [];
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on: next });
    } catch {
      setTorch({ supported: false, on: false });
    }
  };

  const showVideo = camera === "granted" || camera === "unknown";

  return (
    <div className="flex flex-col gap-6">
      <div className={showVideo ? "flex flex-col gap-3" : "hidden"}>
        <div className="relative mx-auto aspect-square w-full overflow-hidden rounded-2xl bg-ink md:max-w-md">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            aria-label="Camera"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-[14%] rounded-2xl border-4 border-yellow shadow-[0_0_0_100vmax_rgba(5,7,7,0.45)]"
          />
          {!streaming ? (
            <p className="absolute inset-x-0 bottom-4 text-center text-sm text-paper">
              Starting camera…
            </p>
          ) : null}
        </div>
        <p role="status" className="text-center text-sm text-dust-700">
          {streaming ? "Hold the label inside the square." : ""}
        </p>
        {torch.supported ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={torch.on}
              onClick={() => void toggleTorch()}
            >
              {torch.on ? "Torch off" : "Torch on"}
            </Button>
          </div>
        ) : null}
      </div>

      {!showVideo ? <CameraPermission state={camera} onStart={() => void start()} /> : null}

      {foreign !== null ? (
        <div role="alert" className="rounded-xl bg-waiting-soft p-3 text-waiting-deep">
          <p className="font-semibold">Not a BICII label</p>
          <p className="text-sm break-all">“{truncateScan(foreign)}”</p>
          <p className="text-sm">Scanning continues. Point the camera at a BICII QR label.</p>
        </div>
      ) : null}

      <ManualEntry publicBases={publicBases} onOpen={open} />
    </div>
  );
}

/**
 * Typing the code printed under the QR (works with no camera at all): a
 * short ID in any case, or a pasted BICII label URL; anything else asks
 * for a code like P-000123.
 */
function ManualEntry({
  publicBases,
  onOpen,
}: {
  publicBases: readonly string[];
  onOpen: (shortId: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = interpretScan(value, { publicBases, adminOrigin: window.location.origin });
    if (result.kind !== "record") {
      setError("Enter a code like P-000123");
      return;
    }
    setError(undefined);
    onOpen(result.shortId);
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="sr-only">
        Type a code
      </h2>
      <Field label="Or type the code on the label" error={error}>
        <Input
          name="code"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(undefined);
          }}
          placeholder="P-000123"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
      </Field>
      <Button type="submit" className="self-start">
        Open
      </Button>
    </form>
  );
}
