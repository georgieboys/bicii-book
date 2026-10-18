/**
 * The longest name the database accepts (quotes_answered_name_check). In a
 * module of its own, with no imports, because the quote form reads it in
 * the browser: from quote-page.ts it brought zod with it, about 90 KB gzip
 * for one number.
 */
export const ANSWER_NAME_MAX = 100;
