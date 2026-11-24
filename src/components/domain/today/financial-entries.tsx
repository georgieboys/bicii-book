import { ShortIdLink, ShortId } from "@/components/domain/short-id";
import { Badge } from "@/components/ui/badge";
import { formatQuantity, formatMoney, toDecimal } from "@/lib/money";
import { documentHref, formatSignedMoney, groupEntries, type FinancialEntry } from "@/lib/reports";

/**
 * "What makes up these figures" (server): the day's recognised entries
 * (D32) grouped by job, each with its description, quantity and sale, and
 * its yield and Cult Commons when the database returned them (view_costs,
 * D30). A loss-making line says "Sold at a loss"; a line without a cost
 * says "Cost pending" (D14). It lists; it adds nothing up.
 *
 * D273: a completed job's Stripe fee entry (view_costs only; the database
 * leaves it out otherwise) is not a line: it is shown under its job as the
 * deduction it is, "Stripe fees (less GST)" and what Cult Commons bore,
 * and the count in the header counts lines only (as lines_recognised).
 */
export function FinancialEntries({
  entries,
  open = false,
}: {
  entries: readonly FinancialEntry[];
  open?: boolean;
}) {
  const groups = groupEntries(entries);
  const lineCount = entries.filter((e) => e.entryKind === "line").length;
  return (
    <details
      id="financial-entries"
      open={open}
      className="group scroll-mt-20 rounded-2xl border border-hairline bg-card"
    >
      <summary className="flex min-h-tap cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-2 font-semibold focus-inset">
        What makes up these figures
        <span className="text-sm font-normal text-dust-500 tabular-nums">
          {lineCount === 1 ? "1 line" : `${lineCount} lines`}
        </span>
      </summary>
      <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
        {groups.length === 0 ? (
          <p className="text-sm text-dust-500">No job was completed on this day.</p>
        ) : (
          groups.map((g) => {
            const href = documentHref(g);
            return (
              <div key={`${g.source}:${g.documentId}`} className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2">
                  {href ? (
                    <ShortIdLink href={href} value={g.documentNumber} />
                  ) : (
                    <ShortId value={g.documentNumber} />
                  )}
                </h3>
                <ul
                  aria-label={`Lines of ${g.documentNumber}`}
                  className="flex flex-col divide-y divide-hairline text-dense"
                >
                  {g.entries.map((e) =>
                    e.entryKind === "stripe_fee" ? (
                      <li key={e.entryKey} className="flex flex-col gap-0.5 py-1.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0">Stripe fees (less GST)</span>
                          <span className="shrink-0 font-semibold tabular-nums">
                            {e.stripeFeePending && toDecimal(e.stripeFee ?? "0").isZero()
                              ? "Not reported yet"
                              : formatMoney(e.stripeFee ?? "0", e.currency)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dust-500 tabular-nums">
                          {e.cultCommons !== null ? (
                            <span>
                              Borne by Cult Commons {formatSignedMoney(e.cultCommons, e.currency)}
                            </span>
                          ) : null}
                          {e.stripeFeePending ? (
                            <Badge tone="waiting">Fee not reported yet</Badge>
                          ) : null}
                        </div>
                      </li>
                    ) : (
                      <li key={e.entryKey} className="flex flex-col gap-0.5 py-1.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0">
                            {e.description}
                            {formatQuantity(e.quantity) !== "1" ? (
                              <span className="text-dust-500"> × {formatQuantity(e.quantity)}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 font-semibold tabular-nums">
                            {formatMoney(e.saleTotal, e.currency)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dust-500 tabular-nums">
                          {e.yield !== null ? (
                            <span>Yield {formatSignedMoney(e.yield, e.currency)}</span>
                          ) : null}
                          {e.cultCommons !== null ? (
                            <span>Cult Commons {formatMoney(e.cultCommons, e.currency)}</span>
                          ) : null}
                          {e.isLoss ? <Badge tone="danger">Sold at a loss</Badge> : null}
                          {e.costPending ? <Badge tone="waiting">Cost pending</Badge> : null}
                        </div>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}
