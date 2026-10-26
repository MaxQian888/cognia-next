/**
 * The one template syntax an editable prompt body may use (ADR-0236).
 *
 * A body is literal text plus `{{name}}` placeholders drawn from the
 * definition's declared variables. There is deliberately nothing else: no
 * expressions, conditionals, includes, object traversal or recursive
 * evaluation. A substituted value is inserted once and never re-scanned, so
 * task data that happens to contain `{{x}}` cannot pull in another value.
 * Dynamic branching stays in the owning builder.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { PromptDefinitionV1 } from "./types"

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g
/** A `{{` that does not open a well-formed placeholder. */
const STRAY_OPEN = /\{\{(?!\s*[A-Za-z][A-Za-z0-9_]*\s*\}\})/

/** Placeholder names in body order, duplicates kept. */
export function listPlaceholders(body: string): string[] {
  return Array.from(body.matchAll(PLACEHOLDER), (match) => match[1])
}

/**
 * Substitute declared values. Unknown placeholders are left verbatim (a
 * validated body has none); a declared variable with no value renders empty.
 * Values are clipped to the variable's `maxChars`.
 */
export function renderPromptTemplate(
  def: Pick<PromptDefinitionV1, "variables">,
  body: string,
  values: Readonly<Record<string, string | undefined>> = {}
): string {
  if (def.variables.length === 0) return body
  const specs = new Map(def.variables.map((spec) => [spec.name, spec]))
  return body.replace(PLACEHOLDER, (whole, name: string) => {
    const spec = specs.get(name)
    if (!spec) return whole
    return (values[name] ?? "").slice(0, spec.maxChars)
  })
}

export type PromptValidationIssue =
  | { code: "empty" }
  | { code: "too-long"; limit: number; length: number }
  | { code: "malformed-placeholder" }
  | { code: "unknown-variable"; name: string }
  | { code: "missing-variable"; name: string }
  | { code: "missing-fragment"; fragment: string }
  | { code: "pii" }
  | { code: "not-editable" }

/**
 * Every reason `body` cannot be published for `def`. An empty list means the
 * body is valid. Validation is deterministic and makes no model call: it
 * proves the body fits the consumer's contract, not that a model will follow
 * it well.
 */
export function validatePromptBody(def: PromptDefinitionV1, body: string): PromptValidationIssue[] {
  if (def.operation === "inspect-only") return [{ code: "not-editable" }]
  const issues: PromptValidationIssue[] = []
  if (body.trim().length === 0) issues.push({ code: "empty" })
  if (body.length > def.maxChars) {
    issues.push({ code: "too-long", limit: def.maxChars, length: body.length })
  }
  if (STRAY_OPEN.test(body)) issues.push({ code: "malformed-placeholder" })
  const declared = new Set(def.variables.map((spec) => spec.name))
  const used = new Set(listPlaceholders(body))
  for (const name of used) {
    if (!declared.has(name)) issues.push({ code: "unknown-variable", name })
  }
  for (const spec of def.variables) {
    if (spec.required && !used.has(spec.name)) {
      issues.push({ code: "missing-variable", name: spec.name })
    }
  }
  for (const fragment of def.requiredFragments) {
    if (!body.includes(fragment)) issues.push({ code: "missing-fragment", fragment })
  }
  if (!hasNoLeakingPii(body)) issues.push({ code: "pii" })
  return issues
}
