/**
 * promptfoo `tests:` → {@link EvalCase}s. Each test carries `vars` (prompt
 * interpolation) + `assert` (typed assertions). We map `vars` → `inputVars`,
 * a sensible var → `input`, and equality/contains assertions → reference.
 */

import type { EvalCase, EvalReference } from "@/types/eval/eval"
import type { ImportPreview } from "@/types/eval/import"
import type { MappingDeps } from "../field-mapping"
import { asArray, buildCase, str } from "./_shared"

interface PromptfooAssert {
  type?: string
  value?: unknown
}

const CONTAINS_TYPES = new Set(["contains", "icontains", "contains-any", "includes"])

function pickInput(vars: Record<string, unknown>): string {
  for (const key of ["input", "prompt", "question", "query", "text"]) {
    if (typeof vars[key] === "string") return vars[key] as string
  }
  const first = Object.values(vars)[0]
  return str(first)
}

function toReference(assert: PromptfooAssert[]): EvalReference | undefined {
  const ref: EvalReference = {}
  const contains: string[] = []
  for (const a of assert) {
    if (!a || typeof a.type !== "string") continue
    if (a.type === "equals" && typeof a.value === "string") ref.expectedOutput = a.value
    else if (CONTAINS_TYPES.has(a.type)) {
      if (typeof a.value === "string") contains.push(a.value)
      else if (Array.isArray(a.value))
        for (const v of a.value) if (typeof v === "string") contains.push(v)
    }
  }
  if (contains.length > 0) ref.expectedContains = contains
  return ref.expectedOutput || ref.expectedContains ? ref : undefined
}

export function fromPromptfoo(raw: unknown, deps: MappingDeps): ImportPreview {
  const items = asArray(raw)
  const cases: EvalCase[] = []
  const skipped: { row: number; reason: string }[] = []
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      skipped.push({ row: index, reason: "not an object" })
      return
    }
    const test = item as {
      vars?: Record<string, unknown>
      assert?: PromptfooAssert[]
      description?: string
    }
    const vars = test.vars && typeof test.vars === "object" ? test.vars : {}
    const input = pickInput(vars) || str(test.description)
    if (!input.trim()) {
      skipped.push({ row: index, reason: "no input/vars" })
      return
    }
    const reference = Array.isArray(test.assert) ? toReference(test.assert) : undefined
    cases.push(
      buildCase(deps, {
        input,
        ...(Object.keys(vars).length > 0 ? { inputVars: vars } : {}),
        ...(reference ? { reference } : {}),
        ...(test.description ? { metadata: { description: test.description } } : {}),
      })
    )
  })
  return { cases, skipped }
}
