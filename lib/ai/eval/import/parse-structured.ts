/**
 * JSON / JSONL / YAML → {@link ParsedRows}. Accepts a top-level array, a
 * `{rows|data|examples|tests:[...]}` envelope, or (JSONL) one object per line.
 * Columns are the union of row keys in first-seen order. YAML uses the
 * already-present `yaml` dependency.
 */

import { parse as parseYaml } from "yaml"
import type { ParsedRows } from "@/types/eval/import"

function toRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    for (const key of ["rows", "data", "examples", "tests"]) {
      if (Array.isArray(obj[key])) return toRows(obj[key])
    }
    // single object → single row
    return [obj]
  }
  return []
}

function unionColumns(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        cols.push(key)
      }
    }
  }
  return cols
}

export function parseStructured(text: string, format: "json" | "jsonl" | "yaml"): ParsedRows {
  if (!text || !text.trim()) return { columns: [], rows: [] }
  let rows: Record<string, unknown>[]
  if (format === "jsonl") {
    rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
  } else if (format === "yaml") {
    rows = toRows(parseYaml(text))
  } else {
    rows = toRows(JSON.parse(text))
  }
  return { columns: unionColumns(rows), rows }
}
