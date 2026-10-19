"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SegmentOption<V extends string = string> = {
  value: V;
  label: ReactNode;
  /** Optional count, e.g. jobs in that status. */
  count?: number;
  /** Not selectable (arrow keys skip it); say why next to the control. */
  disabled?: boolean;
};

export type SegmentedControlProps<V extends string = string> = {
  /** Accessible name for the group, e.g. "Status filter". */
  label: string;
  options: readonly SegmentOption<V>[];
  /**
   * The chosen value. `null` is controlled with nothing chosen yet (a
   * choice that has no default, e.g. who bears a charge, D4): no option is
   * checked and Tab enters at the first enabled one.
   */
  value?: V | null;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  /** Submits the chosen value under this name inside a form. */
  name?: string;
  /** The group's id, e.g. to focus its tab stop from a form's error. */
  id?: string;
  /** An answer is required (aria-required on the group). */
  required?: boolean;
  /** Marks the group as needing an answer: aria-invalid and a danger outline. */
  invalid?: boolean;
  /** Id of the message that says why, for aria-describedby. */
  describedBy?: string;
  className?: string;
};

/**
 * One-of-few choice shown inline (filters, view switches). ARIA radiogroup
 * with roving tabindex: Tab enters at the checked option, arrows move and
 * select, Home/End jump. Scrolls horizontally on narrow screens rather than
 * wrapping.
 */
export function SegmentedControl<V extends string = string>({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  id,
  required,
  invalid,
  describedBy,
  className,
}: SegmentedControlProps<V>) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState<V | undefined>(defaultValue ?? options[0]?.value);
  const current = controlled ? value : inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (!controlled) setInner(option.value);
    onValueChange?.(option.value);
    refs.current[index]?.focus();
  };

  // The next enabled option from `from`, stepping by `delta` and wrapping.
  const enabledFrom = (from: number, delta: 1 | -1): number | null => {
    const n = options.length;
    for (let step = 0; step < n; step++) {
      const i = (((from + delta * step) % n) + n) % n;
      if (!options[i]?.disabled) return i;
    }
    return null;
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? enabledFrom(index === last ? 0 : index + 1, 1)
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? enabledFrom(index === 0 ? last : index - 1, -1)
          : e.key === "Home"
            ? enabledFrom(0, 1)
            : e.key === "End"
              ? enabledFrom(last, -1)
              : null;
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  const found = options.findIndex((o) => o.value === current);
  // Nothing chosen (value null): none is checked; the first enabled option
  // takes the roving tab stop.
  const checkedIndex = found >= 0 ? found : current === null ? -1 : 0;
  const tabStop = checkedIndex >= 0 ? checkedIndex : (enabledFrom(0, 1) ?? 0);

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-required={required || undefined}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? describedBy : undefined}
      className={cn(
        "inline-flex max-w-full [scrollbar-width:none] gap-1 overflow-x-auto rounded-full border-2 border-ink bg-card p-1",
        "aria-invalid:border-danger aria-invalid:shadow-[0_0_0_1px_var(--color-danger)]",
        className,
      )}
    >
      {options.map((option, i) => {
        const checked = i === checkedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              // Inset ring: the group scrolls horizontally and so clips.
              "inline-flex min-h-tap shrink-0 items-center gap-2 rounded-full px-4 font-display text-xs font-bold tracking-wide whitespace-nowrap uppercase focus-inset",
              "transition-colors duration-150",
              // One branch per state: cn() does not resolve conflicting
              // utilities, so stacking them leaves the winner to CSS order.
              checked
                ? "cursor-pointer bg-ink text-paper"
                : option.disabled
                  ? "cursor-not-allowed text-dust-500"
                  : "cursor-pointer text-ink hover:bg-dust-100",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[0.6875rem] tabular-nums",
                  checked ? "bg-paper/20" : "bg-dust-100",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </div>
  );
}
