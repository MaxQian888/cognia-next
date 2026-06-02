/**
 * LangSmith dataset export rows → {@link EvalCase}s. Each row is
 * `{ inputs: object, outputs: object }`. `inputs` → `inputVars` (+ a
 * representative `input` string); `outputs` → reference `expectedOutput`.
 */

import type { EvalCase } from "@/types/eval/eval"
import type { ImportPreview } from "@/types/eval/import"
import type { MappingDeps } from "../field-mapping"
import { asArray, buildCase, str } from "./_shared"

function pickInput(inputs: Record<string, unknown>): string {
  for (const key of ["input", "question", "prompt", "query", "text"]) {
    if (typeof inputs[key] === "string") return inputs[key] as string
  }
  const vals = Object.values(inputs)
  if (vals.length === 1) return str(vals[0])
  return JSON.stringify(inputs)
}

function pickOutput(outputs: Record<string, unknown>): string {
  for (const key of ["output", "answer", "expected", "response", "text"]) {
    if (typeof outputs[key] === "string") return outputs[key] as string
  }
  const vals = Object.values(outputs)
  if (vals.length === 1) return str(vals[0])
  return JSON.stringify(outputs)
}

export function fromLangSmith(raw: unknown, deps: MappingDeps): ImportPreview {
  const items = asArray(raw)
  const cases: EvalCase[] = []
  const skipped: { row: number; reason: string }[] = []
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      skipped.push({ row: index, reason: "not an object" })
      return
    }
    const row = item as { inputs?: unknown; outputs?: unknown }
    const inputs =
      row.inputs && typeof row.inputs === "object" ? (row.inputs as Record<string, unknown>) : {}
    const input = Object.keys(inputs).length > 0 ? pickInput(inputs) : ""
    if (!input.trim()) {
      skipped.push({ row: index, reason: "no inputs" })
      return
    }
    const outputs =
      row.outputs && typeof row.outputs === "object" ? (row.outputs as Record<string, unknown>) : {}
    const expectedOutput = Object.keys(outputs).length > 0 ? pickOutput(outputs) : ""
    cases.push(
      buildCase(deps, {
        input,
        inputVars: inputs,
        ...(expectedOutput ? { reference: { expectedOutput } } : {}),
      })
    )
  })
  return { cases, skipped }
}
