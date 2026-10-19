/**
 * The longest name the database accepts (quotes_answered_name_check). In a
 * module of its own, with no imports, because the quote form reads it in
 * the browser: from quote-page.ts it brought zod with it, about 90 KB gzip
 * for one number.
 */
export const ANSWER_NAME_MAX = 100;

/**
 * The unanswered items, named for the quote form's refusal (U2-1):
 * "Brake pads and Chain", "Brake pads, Chain and Tyres", "Brake pads, Chain
 * and 3 more".
 */
export function missingItemsText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
