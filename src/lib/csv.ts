/**
 * CSV for the report exports (SPEC §19.2 "exportable", §22; ADR-001 A7):
 * RFC 4180 text with a UTF-8 byte order mark (so Excel reads names with
 * accents correctly) and CRLF line ends. Pure: the Route Handler builds the
 * rows, this only writes them.
 *
 * Values are written as given; nothing here computes money. A money cell is
 * a plain decimal string ("-50.00", no symbol; the currency is its own
 * column), a date "YYYY-MM-DD", a datetime shop-local "YYYY-MM-DD HH:mm".
 *
 * Formula injection (OWASP "CSV Injection"): a TEXT cell that starts with
 * =, +, -, @ (also after leading whitespace or control characters, such as
 * a space or a line feed), a tab or a carriage return gets a leading single
 * quote, so a
 * spreadsheet shows it as text instead of running it. Numeric, money, date
 * and boolean cells are never altered, so a negative yield stays -50.00.
 */
import { toShopLocal } from "@/lib/dates";

export type CsvKind = "text" | "money" | "integer" | "decimal" | "date" | "datetime" | "boolean";

export type CsvColumn<T> = {
  header: string;
  kind: CsvKind;
  value: (row: T) => string | number | boolean | null | undefined;
};

export const CSV_BOM = "\uFEFF";
export const CSV_EOL = "\r\n";

/**
 * A formula start, also after leading whitespace or control characters
 * (some importers trim those before deciding a cell is a formula), or a
 * leading tab or carriage return.
 */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r]/;

/** RFC 4180: quote a field containing a comma, a quote, CR or LF; double the inner quotes. */
export function quoteCsv(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** One cell as text, per its kind (null → empty). */
export function csvCell(
  kind: CsvKind,
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "text": {
      const s = String(value);
      return FORMULA_START.test(s) ? `'${s}` : s;
    }
    case "boolean":
      return value ? "true" : "false";
    case "datetime":
      // An ISO instant from the database → shop-local wall clock.
      return toShopLocal(String(value)).replace("T", " ");
    case "date":
      return String(value).slice(0, 10);
    default:
      return String(value);
  }
}

/** The CSV for `rows`: BOM, a header line, one line per row, each ended by CRLF. */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const line = (cells: readonly string[]) => cells.map(quoteCsv).join(",") + CSV_EOL;
  let out = CSV_BOM + line(columns.map((c) => csvCell("text", c.header)));
  for (const row of rows) out += line(columns.map((c) => csvCell(c.kind, c.value(row))));
  return out;
}
