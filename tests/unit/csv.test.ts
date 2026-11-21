import { describe, expect, it } from "vitest";

import { CSV_BOM, csvCell, quoteCsv, toCsv, type CsvColumn } from "@/lib/csv";

type Row = { name: string | null; amount: string | null; qty: number; when: string; ok: boolean };

const columns: CsvColumn<Row>[] = [
  { header: "name", kind: "text", value: (r) => r.name },
  { header: "amount", kind: "money", value: (r) => r.amount },
  { header: "qty", kind: "integer", value: (r) => r.qty },
  { header: "when", kind: "datetime", value: (r) => r.when },
  { header: "ok", kind: "boolean", value: (r) => r.ok },
];

describe("toCsv", () => {
  it("starts with a BOM and ends every line with CRLF", () => {
    const csv = toCsv(columns, [
      { name: "Tan", amount: "200.00", qty: 1, when: "2026-10-05T02:05:00Z", ok: true },
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(CSV_BOM).toBe("\uFEFF");
    expect(csv.slice(1)).toBe("name,amount,qty,when,ok\r\nTan,200.00,1,2026-10-05 10:05,true\r\n");
  });

  it("writes only the header for no rows", () => {
    expect(toCsv(columns, [])).toBe(`${CSV_BOM}name,amount,qty,when,ok\r\n`);
  });

  it("quotes commas, quotes, CR and LF and doubles inner quotes (RFC 4180)", () => {
    expect(quoteCsv("plain")).toBe("plain");
    expect(quoteCsv("a,b")).toBe('"a,b"');
    expect(quoteCsv('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCsv("two\nlines")).toBe('"two\nlines"');
    expect(quoteCsv("cr\rhere")).toBe('"cr\rhere"');
  });

  it("writes null as an empty field", () => {
    const csv = toCsv(columns, [
      { name: null, amount: null, qty: 0, when: "2026-10-05T16:30:00Z", ok: false },
    ]);
    expect(csv.split("\r\n")[1]).toBe(",,0,2026-10-06 00:30,false");
  });

  it("guards text cells against formula injection, never numbers or money", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell("text", `${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
    }
    expect(csvCell("money", "-50.00")).toBe("-50.00");
    expect(csvCell("integer", -3)).toBe("-3");
    expect(csvCell("decimal", "-1.5")).toBe("-1.5");
    const csv = toCsv(columns, [
      { name: "=HYPERLINK(1)", amount: "-50.00", qty: -1, when: "2026-10-05T00:00:00Z", ok: true },
    ]);
    expect(csv.split("\r\n")[1]).toBe("'=HYPERLINK(1),-50.00,-1,2026-10-05 08:00,true");
  });

  it("guards a formula after leading whitespace or control characters", () => {
    for (const text of [" =1+1", "\n@SUM(A1)", " +1", "\u0000=1", "  \n -1", "\u000b=1"]) {
      expect(csvCell("text", text)).toBe(`'${text}`);
    }
    for (const text of ["Ana Lim", " Ana", "\nnote", "1-2", "a=b"]) {
      expect(csvCell("text", text)).toBe(text);
    }
  });

  it("keeps unicode names intact", () => {
    const csv = toCsv(columns, [
      { name: "Zoë Ng 黄", amount: "1.00", qty: 1, when: "2026-10-05T00:00:00Z", ok: true },
    ]);
    expect(csv.split("\r\n")[1].startsWith("Zoë Ng 黄,")).toBe(true);
  });

  it("writes dates as YYYY-MM-DD", () => {
    expect(csvCell("date", "2026-10-05")).toBe("2026-10-05");
  });
});
