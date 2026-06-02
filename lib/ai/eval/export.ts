/**
 * Export canonical {@link EvalCase}s back out to JSONL / CSV (the inverse of
 * import) so datasets can be shared / versioned in git. JSONL preserves the
 * full case shape; CSV is a flat projection of the common columns.
 */

import type { EvalCase } from "@/types/eval/eval"

/** Full-fidelity JSONL: one JSON case per line. */
export function toJsonl(cases: EvalCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join("\n")
}

const CSV_COLUMNS = ["id", "input", "expectedOutput", "capability", "split", "tags"] as const

function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** Flat CSV projection (id, input, expectedOutput, capability, split, tags). */
export function toCsv(cases: EvalCase[]): string {
  const header = CSV_COLUMNS.join(",")
  const lines = cases.map((c) => {
    const cells: Record<(typeof CSV_COLUMNS)[number], string> = {
      id: c.id,
      input: c.input,
      expectedOutput: c.reference?.expectedOutput ?? "",
      capability: c.capability,
      split: c.split ?? "",
      tags: (c.tags ?? []).join("|"),
    }
    return CSV_COLUMNS.map((col) => escapeCsv(cells[col])).join(",")
  })
  return [header, ...lines].join("\n")
}
