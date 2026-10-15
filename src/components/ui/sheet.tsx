"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";
import { InSheetBodyContext } from "./sheet-context";

/** CSS variable the toast viewport uses as its bottom inset while a sheet is open. */
export const TOAST_INSET_VAR = "--toast-inset-bottom";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true",
  );
}

export type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Sticky action row (Cancel / Save). */
  footer?: ReactNode;
  /** Element to focus on open; defaults to the first focusable in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Keep Escape and backdrop taps from closing it, e.g. while a stock commit
   * is pending. The close button is disabled too.
   */
  dismissible?: boolean;
  className?: string;
};

/**
 * Modal dialog: a bottom sheet on phones, a side panel from md up.
 *
 * Accessibility, following the public site's nav sheet: everything outside
 * the sheet is made `inert` (not focusable, not read), Tab cycles within the
 * sheet, Escape closes, page scroll is locked, and focus returns to whatever
 * opened it when it closes.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  initialFocus,
  dismissible = true,
  className,
}: SheetProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const portal = portalRef.current;
    if (!panel || !portal) return;

    const opener = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Inert every sibling of the portal; leave anything already inert alone
    // so nested sheets restore correctly. The toast region opts out so a
    // result announced while the sheet is open is still heard.
    const outside = [...document.body.children].filter(
      (el) => el !== portal && !el.hasAttribute("inert") && !el.hasAttribute("data-sheet-exempt"),
    );
    outside.forEach((el) => el.setAttribute("inert", ""));

    const target =
      initialFocus?.current ??
      focusables(panel).find((el) => !el.dataset.sheetClose) ??
      focusables(panel)[0] ??
      panel;
    target.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (dismissibleRef.current) onOpenChangeRef.current(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      outside.forEach((el) => el.removeAttribute("inert"));
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, initialFocus]);

  // Toasts confirm what a sheet just did; keep them above its action row
  // instead of on top of Save/Cancel. The toast viewport reads this
  // variable (src/components/ui/toast.tsx). A sheet opened over another
  // (Fit from the settle checklist) puts the outer sheet's inset back when
  // it closes, so the toast it raises stays clear of the outer footer.
  const hasFooter = Boolean(footer);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue(TOAST_INSET_VAR);
    const restore = () => {
      if (previous) root.style.setProperty(TOAST_INSET_VAR, previous);
      else root.style.removeProperty(TOAST_INSET_VAR);
    };
    const footerEl = footerRef.current;
    if (!hasFooter || !footerEl) {
      root.style.setProperty(TOAST_INSET_VAR, "env(safe-area-inset-bottom)");
      return restore;
    }
    const update = () =>
      root.style.setProperty(TOAST_INSET_VAR, `${footerEl.getBoundingClientRect().height}px`);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(footerEl);
    return () => {
      observer?.disconnect();
      restore();
    };
  }, [open, hasFooter]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div ref={portalRef} className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 animate-[fade-in_200ms_var(--ease-glide)] bg-ink/40"
        onClick={() => dismissible && onOpenChange(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={cn(
          "absolute flex flex-col bg-paper shadow-[0_-8px_40px_rgb(5_7_7/0.18)] outline-none",
          // Phone: bottom sheet, rounded top, never taller than the viewport
          "inset-x-0 bottom-0 max-h-[92dvh] animate-[sheet-up_var(--duration-soft)_var(--ease-soft)] rounded-t-3xl",
          // md+: side panel
          "md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[30rem] md:animate-[sheet-in-right_var(--duration-soft)_var(--ease-soft)] md:rounded-none md:rounded-l-3xl",
          className,
        )}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-dust-300 md:hidden"
        />
        <header className="flex items-start justify-between gap-3 px-5 pt-3 pb-2 md:px-6 md:pt-6">
          <div className="flex min-w-0 flex-col gap-1 pt-2">
            <h2 id={`${id}-title`} className="text-2xl leading-tight">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-desc`} className="text-sm text-dust-500">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton
            aria-label="Close"
            data-sheet-close="true"
            icon={<CloseIcon />}
            disabled={!dismissible}
            onClick={() => onOpenChange(false)}
            className="-mr-2"
          />
        </header>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 md:px-6",
            // Without a footer the body is the bottom edge: clear the iPhone
            // home indicator (viewport-fit=cover), as the footer does.
            footer ? "pb-5" : "pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          )}
        >
          <InSheetBodyContext value={true}>{children}</InSheetBodyContext>
        </div>
        {footer ? (
          <footer
            ref={footerRef}
            className="flex flex-wrap justify-end gap-2 border-t border-hairline bg-paper px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6"
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
