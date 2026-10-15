"use client";

import { voidLine } from "@/app/(staff)/jobs/actions";
import { voidIndentNote, type FittedIndentLine } from "@/lib/indent";

import { ReasonConfirm } from "./reason-confirm";

/**
 * Void one line, with a required reason (two steps, ReasonConfirm). The
 * line stays on the job, struck through, with who voided it, when and why;
 * nothing is deleted (D15: only while the job is open). On a part line it
 * says what goes back to stock: void_line writes the linked reversal (D16)
 * and a unit returns to available (D25). On a line a fitted indent item
 * became (D160) it also says the item goes back to approved (or ordered)
 * and must be fitted again or cancelled before the job completes: the
 * database un-fits it in the void's transaction.
 */
export function VoidLineControl({
  lineId,
  description,
  stockReturn,
  indent,
}: {
  lineId: string;
  description: string;
  /**
   * A part line: what voiding puts back ("2 to Shop floor"), so the
   * confirmation says it before it happens (void_line writes the reversal).
   */
  stockReturn?: string | null;
  /** The fitted indent item this line is (D160), if any. */
  indent?: FittedIndentLine | null;
}) {
  const stock = stockReturn
    ? `Voiding returns ${stockReturn} (a reversal is recorded; nothing is deleted).`
    : stockReturn === null
      ? "Voiding returns the part to stock (a reversal is recorded; nothing is deleted)."
      : null;
  return (
    <ReasonConfirm
      startLabel="Void…"
      startVariant="ghost"
      startSize="sm"
      question={`Why are you voiding ${description}?`}
      hint="Kept on the line and the job's timeline."
      confirmLabel="Void line"
      dismissLabel="Keep line"
      pendingLabel="Voiding…"
      failureTitle="Line not voided"
      successTitle={
        indent
          ? `${indent.description} is back to ${indent.backTo}`
          : stockReturn !== undefined
            ? "Returned to stock"
            : `${description} voided`
      }
      onConfirm={(reason) => voidLine({ lineId, reason })}
    >
      {indent ? (
        <>
          {voidIndentNote(indent)}
          {stock ? ` ${stock}` : null}
        </>
      ) : (
        (stock ?? undefined)
      )}
    </ReasonConfirm>
  );
}
