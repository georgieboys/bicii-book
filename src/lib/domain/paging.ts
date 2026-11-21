import { unwrap, type DbErrorLike } from "@/lib/db-errors";

/**
 * PostgREST's max-rows (supabase/config.toml): no single response holds
 * more, whatever `.limit()` asks for, so a read that may exceed it pages.
 */
export const READ_PAGE = 1000;

/**
 * Every row of a read, in pages of READ_PAGE by `.range()` until a short
 * page (as getFinancialEntriesOn does). `page(from, to)` builds a fresh
 * query each time and must order it stably (a unique last key), or rows
 * can repeat or go missing between pages. With `max`, reading stops once
 * more than `max` rows are in hand, so the caller can refuse instead of
 * reading without end.
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbErrorLike | null }>,
  max = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const rows = unwrap(await page(from, from + READ_PAGE - 1)) ?? [];
    out.push(...rows);
    if (rows.length < READ_PAGE || out.length > max) return out;
  }
}
