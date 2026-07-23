/**
 * Map parsed rows onto canonical {@link EvalCase}s via a {@link FieldSpec}
 * (Inspect-style column→field mapping). Decouples a case's schema from the
 * source file's column names so any CSV/JSON/YAML imports without reshaping.
 */

import type { EvalCase } from "@/types/eval/eval"
import type { FieldSpec, ImportPreview, ParsedRows } from "@/types/eval/import"

export interface MappingDeps {
  datasetId: string
  capability: string
  now: () => number
  id: () => string
}

function cell(row: Record<string, unknown>, col: string): string {
  const v = row[col]
  if (v === undefined || v === null) return ""
  return typeof v === "string" ? v : JSON.stringify(v)
}

/** Resolve the `input` field + optional structured `inputVars`. */
function resolveInput(
  row: Record<string, unknown>,
  spec: FieldSpec
): { input: string; inputVars?: Record<string, unknown> } {
  if (typeof spec.input === "string") {
    return { input: cell(row, spec.input) }
  }
  const cols = spec.input
  if (spec.combine === "json") {
    const vars: Record<string, unknown> = {}
    for (const c of cols) vars[c] = row[c]
    return { input: JSON.stringify(vars), inputVars: vars }
  }
  const joined = cols
    .map((c) => cell(row, c))
    .filter((s) => s.length > 0)
    .join("\n")
  return { input: joined }
}

/**
 * Resolve the optional reference (expected) fields, including the grading rule.
 *
 * One `expected` column → `expectedOutput` (a golden answer). Several →
 * `expectedContains` (an alias set). The grading spec rides along on both, so a
 * deterministic scorer knows HOW to compare — without it `expectedOutput` is
 * inert outside the LLM judge, which is exactly why importing a benchmark used
 * to grade nothing.
 */
function resolveReference(
  row: Record<string, unknown>,
  spec: FieldSpec
): EvalCase["reference"] | undefined {
  const grading = spec.grading ? { grading: spec.grading } : {}
  if (!spec.expected) {
    // A grading rule with nothing to compare against is not worth persisting.
    return undefined
  }
  if (typeof spec.expected === "string") {
    const out = cell(row, spec.expected)
    return out ? { expectedOutput: out, ...grading } : undefined
  }
  const contains = spec.expected.map((c) => cell(row, c)).filter((s) => s.length > 0)
  return contains.length > 0 ? { expectedContains: contains, ...grading } : undefined
}

export function mapRowsToCases(
  parsed: ParsedRows,
  spec: FieldSpec,
  deps: MappingDeps
): ImportPreview {
  const cases: EvalCase[] = []
  const skipped: { row: number; reason: string }[] = []

  parsed.rows.forEach((row, index) => {
    const { input, inputVars } = resolveInput(row, spec)
    if (!input.trim()) {
      skipped.push({ row: index, reason: "empty input" })
      return
    }
    const reference = resolveReference(row, spec)
    const metadata =
      spec.metadata && spec.metadata.length > 0
        ? Object.fromEntries(spec.metadata.map((c) => [c, row[c]]))
        : undefined
    // A column split wins over the literal, so a file that carries its own
    // train/test column beats whatever the source URI said.
    const split = spec.split ? cell(row, spec.split) || spec.splitLiteral : spec.splitLiteral
    const ts = deps.now()
    cases.push({
      id: spec.id ? cell(row, spec.id) || deps.id() : deps.id(),
      datasetId: deps.datasetId,
      input,
      capability: deps.capability,
      source: spec.sourceKind ?? "handwritten",
      createdAt: ts,
      updatedAt: ts,
      ...(reference ? { reference } : {}),
      ...(inputVars ? { inputVars } : {}),
      ...(metadata ? { metadata } : {}),
      ...(split ? { split } : {}),
    })
  })

  return { cases, skipped }
}
