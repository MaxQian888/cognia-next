/**
 * Delimited-table parsing for data assets (M3). RFC4180-shaped: comma
 * delimiter, double-quoted cells with "" escapes, quoted cells may contain
 * newlines, CRLF or LF row endings. Malformed input (unterminated quote,
 * ragged arity) is an INVALID_REQUEST naming the row — never a silent
 * truncation.
 */
import { ERROR_CODES, WorkbenchError } from "@latexwb/contracts";

export interface CsvColumn {
  /** Raw header text. */
  header: string;
  /** Header with the unit marker removed (`latency_ms` → `latency`). */
  field: string;
  unit: string | null;
  type: "number" | "string";
  /** Non-empty cell count. */
  count: number;
  missing: number;
  min?: number;
  max?: number;
  mean?: number;
  distinct?: number;
}

export interface CsvData {
  headerRow: string[];
  columns: CsvColumn[];
  /** Raw cell text per row, aligned to headerRow. */
  rows: string[][];
}

const KNOWN_UNITS = new Set([
  "percent", "%", "ms", "s", "min", "h", "kg", "g", "mg", "ug", "m", "mm", "cm",
  "km", "um", "nm", "b", "kb", "mb", "gb", "tb", "kib", "mib", "hz", "khz",
  "mhz", "ghz", "v", "mv", "kv", "a", "ma", "w", "kw", "mw", "j", "kj", "wh",
  "kwh", "db", "fps", "ns", "us", "px", "pt", "em", "count", "n", "ratio",
  "bpp", "ops", "mol", "l", "ml", "ul", "ppm", "usd", "eur", "cny", "degc",
  "degf", "celsius",
]);

/** `field (unit)`, `field [unit]`, or `field_unit` with a known unit token. */
export function splitHeaderUnit(header: string): { field: string; unit: string | null } {
  const paren = /^(.*?)\s*[(\[]([^)\]]+)[)\]]\s*$/.exec(header);
  if (paren !== null) {
    return { field: (paren[1] as string).trim(), unit: (paren[2] as string).trim() };
  }
  const idx = header.lastIndexOf("_");
  if (idx > 0) {
    const suffix = header.slice(idx + 1).toLowerCase();
    if (KNOWN_UNITS.has(suffix)) {
      return { field: header.slice(0, idx), unit: header.slice(idx + 1) };
    }
  }
  return { field: header, unit: null };
}

const NUMERIC_CELL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isNumericCell(text: string): boolean {
  return NUMERIC_CELL.test(text.trim());
}

function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuote = false;
  let i = 0;
  const n = text.length;
  const pushRow = (): void => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i] as string;
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      // A quote is only structural at field start; mid-field it's literal.
      if (field.length === 0) {
        inQuote = true;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuote) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "CSV has an unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop a trailing all-empty final row (file ends with newline).
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) {
    rows.pop();
  }
  return rows;
}

export function parseCsvText(text: string): CsvData {
  const rows = splitRows(text);
  if (rows.length === 0) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "CSV source is empty");
  }
  const headerRow = rows[0]!.map((h) => h.trim());
  if (headerRow.some((h) => h.length === 0)) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "CSV header contains an empty column name");
  }
  const dataRows = rows.slice(1);
  for (const [idx, r] of dataRows.entries()) {
    if (r.length !== headerRow.length) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `CSV row ${idx + 2} has ${r.length} fields; header has ${headerRow.length}`,
      );
    }
  }
  const columns: CsvColumn[] = headerRow.map((header, ci) => {
    const { field, unit } = splitHeaderUnit(header);
    const cells = dataRows.map((r) => (r[ci] as string).trim());
    const present = cells.filter((c) => c.length > 0);
    const numeric = present.length > 0 && present.every(isNumericCell);
    const col: CsvColumn = {
      header,
      field,
      unit,
      type: numeric ? "number" : "string",
      count: present.length,
      missing: cells.length - present.length,
    };
    if (numeric) {
      const nums = present.map((c) => Number.parseFloat(c));
      col.min = Math.min(...nums);
      col.max = Math.max(...nums);
      col.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    } else {
      col.distinct = new Set(present).size;
    }
    return col;
  });
  return { headerRow, columns, rows: dataRows };
}

export function parseCsv(bytes: Uint8Array): CsvData {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      "data asset is not UTF-8 text; only UTF-8 CSV/TSV sources are inspectable",
    );
  }
  return parseCsvText(text);
}
