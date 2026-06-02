/**
 * CSV → {@link ParsedRows}. Hand-rolled RFC-4180-ish parser (quoted fields,
 * escaped `""`, embedded newlines, CRLF). No CSV dependency — the eval import
 * surface stays self-contained. First non-empty record is the header row;
 * remaining records become objects keyed by header.
 */

import type { ParsedRows } from "@/types/eval/import"

/** Split CSV text into an array of records, each an array of cell strings. */
function tokenize(text: string): string[][] {
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let inQuotes = false
  let started = false

  const pushField = () => {
    record.push(field)
    field = ""
  }
  const pushRecord = () => {
    pushField()
    records.push(record)
    record = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    started = true
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      pushField()
    } else if (ch === "\r") {
      // swallow — handle on the \n (or treat lone \r as newline)
      if (text[i + 1] !== "\n") pushRecord()
    } else if (ch === "\n") {
      pushRecord()
    } else {
      field += ch
    }
  }
  // flush trailing field/record (unless the input ended on a clean newline)
  if (started && (field.length > 0 || record.length > 0)) pushRecord()
  return records
}

export function parseCsv(text: string): ParsedRows {
  if (!text || !text.trim()) return { columns: [], rows: [] }
  const records = tokenize(text).filter((r) => !(r.length === 1 && r[0] === ""))
  if (records.length === 0) return { columns: [], rows: [] }
  const columns = records[0].map((c) => c.trim())
  const rows = records.slice(1).map((rec) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, idx) => {
      obj[col] = rec[idx] ?? ""
    })
    return obj
  })
  return { columns, rows }
}
