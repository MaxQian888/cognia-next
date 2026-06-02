/**
 * OpenAI Evals JSONL samples → {@link EvalCase}s. A sample is
 * `{ input: string | ChatMessage[], ideal: string | string[] }`. The last user
 * message (or the string) becomes `input`; `ideal` becomes the reference.
 */

import type { EvalCase, EvalReference } from "@/types/eval/eval"
import type { ImportPreview } from "@/types/eval/import"
import type { MappingDeps } from "../field-mapping"
import { asArray, buildCase, str } from "./_shared"

interface ChatMessage {
  role?: string
  content?: unknown
}

function pickInput(input: unknown): string {
  if (typeof input === "string") return input
  if (Array.isArray(input)) {
    const msgs = input as ChatMessage[]
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")
    const chosen = lastUser ?? msgs[msgs.length - 1]
    return chosen ? str(chosen.content) : ""
  }
  return ""
}

function toReference(ideal: unknown): EvalReference | undefined {
  if (typeof ideal === "string" && ideal) return { expectedOutput: ideal }
  if (Array.isArray(ideal)) {
    const contains = ideal.filter((v): v is string => typeof v === "string" && v.length > 0)
    if (contains.length > 0) return { expectedContains: contains }
  }
  return undefined
}

export function fromOpenAiEvals(raw: unknown, deps: MappingDeps): ImportPreview {
  const items = asArray(raw)
  const cases: EvalCase[] = []
  const skipped: { row: number; reason: string }[] = []
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      skipped.push({ row: index, reason: "not an object" })
      return
    }
    const sample = item as { input?: unknown; ideal?: unknown }
    const input = pickInput(sample.input)
    if (!input.trim()) {
      skipped.push({ row: index, reason: "no input" })
      return
    }
    const reference = toReference(sample.ideal)
    cases.push(buildCase(deps, { input, ...(reference ? { reference } : {}) }))
  })
  return { cases, skipped }
}
