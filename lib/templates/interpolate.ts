// Putting an input's value where the payload says it goes.
//
// `contracts.ts` has always CHECKED that every `{{inputId}}` in a payload names
// a declared input, refused unbalanced markers, and blocked a plan whose
// required inputs are unbound. The Studio collects a value for each one. What
// nothing did was substitute them: `definition.payload` went to the adapter
// verbatim, so an imported template that parameterised a team's task or a
// character's prompt created a resource containing the literal characters
// `{{teamName}}`. Every guard around the feature worked; the feature did not.
//
// The rule that makes this safe to run over an arbitrary payload is narrow on
// purpose: ONLY a token naming a declared input is replaced. Workflow payloads
// legitimately carry `{{ }}` expressions that are evaluated when the workflow
// RUNS (`allowWorkflowExpressions` in the validator), and rewriting one of
// those here would silently turn a live expression into a dead string.

import type { TemplateInputSpec, TemplateJson } from "./contracts"

/** Matches the validator's own token shape, including the tolerated padding. */
const TOKEN = /\{\{([^{}]+)\}\}/g

/**
 * The value each declared input contributes, keyed by input id.
 *
 * A binding wins over a declared default — the default exists so an optional
 * input has something to say when nobody chose. An input with neither is absent
 * from the result, which is what leaves its token untouched below.
 */
export function resolveTemplateInputs(
  inputs: readonly TemplateInputSpec[],
  bindings: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const input of inputs) {
    const bound = bindings[input.id]
    if (typeof bound === "string" && bound.length > 0) {
      out[input.id] = bound
      continue
    }
    const fallback = (input as { defaultValue?: string | number | boolean }).defaultValue
    if (fallback !== undefined && fallback !== null) out[input.id] = String(fallback)
  }
  return out
}

/**
 * Replace `{{inputId}}` throughout a payload with the resolved values.
 *
 * A token whose id is not in `values` is left exactly as written. That covers
 * three different cases with one rule, and each of them wants the same answer:
 * a workflow expression that belongs to the workflow engine, an optional input
 * nobody supplied and that declared no default, and — should a payload ever get
 * past the validator — an id that does not exist. Leaving the token visible in
 * the created resource is the honest outcome; quietly collapsing it to an empty
 * string produces a sentence with a hole in it that reads as finished.
 *
 * Returns the same object when nothing matched, so callers can tell a
 * parameterised template from a plain one without a deep compare.
 */
export function interpolateTemplatePayload<T extends TemplateJson>(
  payload: T,
  values: Readonly<Record<string, string>>
): T {
  if (Object.keys(values).length === 0) return payload
  return walk(payload, values) as T
}

function walk(value: TemplateJson, values: Readonly<Record<string, string>>): TemplateJson {
  if (typeof value === "string") return substitute(value, values)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const replaced = walk(item, values)
      if (replaced !== item) changed = true
      return replaced
    })
    return changed ? next : value
  }
  if (value && typeof value === "object") {
    let changed = false
    const next: { [key: string]: TemplateJson } = {}
    for (const [key, nested] of Object.entries(value)) {
      const replaced = walk(nested, values)
      if (replaced !== nested) changed = true
      next[key] = replaced
    }
    return changed ? next : value
  }
  return value
}

function substitute(text: string, values: Readonly<Record<string, string>>): string {
  if (!text.includes("{{")) return text
  let changed = false
  const next = text.replace(TOKEN, (whole, expression: string) => {
    const value = values[expression.trim()]
    if (value === undefined) return whole
    changed = true
    return value
  })
  return changed ? next : text
}
