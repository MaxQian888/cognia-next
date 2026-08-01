/**
 * Turning the things the user typed into skill inputs.
 *
 * A recording of "search for invoices from March" should become a skill that
 * takes a search term, not one hard-coded to that phrase. But which typed values
 * are parameters is a judgement call the recorder cannot make, so every
 * suggestion here starts **unconfirmed** and blocks generation until the user
 * says which it is.
 *
 * The three outcomes:
 *
 * - `variable` — becomes `{{name}}` in the skill. The recorded sample stays on
 *   device: it is the user's actual data and has no business in a skill body or
 *   in a model prompt.
 * - `literal` — the recorded value is genuinely part of the procedure (a menu
 *   name, a fixed URL) and is written into the skill verbatim.
 * - `sensitive` — a parameter whose value must never be captured at all. The
 *   recorder already refused to transcribe it; this records the *shape* so the
 *   skill can ask for it at run time.
 */

import type { RecordedStepView } from "./step-model"

export type InputVariableKind = "variable" | "literal" | "sensitive"

export interface InputVariable {
  /** Placeholder name as it appears in the skill body. */
  name: string
  kind: InputVariableKind
  /** The step this was derived from. */
  seq: number
  /**
   * What the user actually typed. Local-only: excluded from the model payload
   * and from the saved skill unless the user converts it to a `literal`.
   * Absent for `sensitive`, always.
   */
  sample?: string
  /** Suggestions must be confirmed one by one before generation may run. */
  confirmed: boolean
}

const MAX_SAMPLE_CHARS = 120

/** `Search term` → `search_term`; falls back to a positional name. */
export function slugifyVariableName(source: string, index: number): string {
  const slug = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
  return slug.length > 0 ? slug : `input_${index + 1}`
}

/**
 * Propose one variable per typed step.
 *
 * Named from the field the text went into rather than from the text itself: the
 * field label is stable across runs, the value is exactly what varies.
 */
export function deriveInputVariables(views: readonly RecordedStepView[]): InputVariable[] {
  const out: InputVariable[] = []
  const used = new Set<string>()

  for (const view of views) {
    if (view.excluded) continue
    const text = view.captured?.text
    if (!text) continue

    const label =
      view.captured?.element?.name ?? view.captured?.element?.automationId ?? view.intent ?? "input"

    let name = slugifyVariableName(label, out.length)
    // Two fields with the same label in one recording is common (a from/to date
    // pair). Suffixing keeps the placeholders distinguishable.
    if (used.has(name)) {
      let suffix = 2
      while (used.has(`${name}_${suffix}`)) suffix += 1
      name = `${name}_${suffix}`
    }
    used.add(name)

    if (text.kind === "sensitive") {
      out.push({ name, kind: "sensitive", seq: view.seq, confirmed: false })
      continue
    }
    if (text.kind === "keys") continue // a shortcut is not an input

    out.push({
      name,
      kind: "variable",
      seq: view.seq,
      sample: text.value.slice(0, MAX_SAMPLE_CHARS),
      confirmed: false,
    })
  }
  return out
}

/**
 * Merge freshly derived suggestions with what the user already decided.
 *
 * Confirmations survive a re-derivation (which happens whenever the timeline
 * changes); otherwise editing one step would silently un-answer every question
 * the user had already answered.
 */
export function mergeInputVariables(
  derived: readonly InputVariable[],
  existing: readonly InputVariable[]
): InputVariable[] {
  const bySeq = new Map(existing.map((v) => [v.seq, v]))
  return derived.map((next) => {
    const prior = bySeq.get(next.seq)
    if (!prior) return next
    return {
      ...next,
      name: prior.name,
      kind: prior.kind,
      confirmed: prior.confirmed,
      sample: prior.kind === "sensitive" ? undefined : next.sample,
    }
  })
}

export function confirmVariable(
  variables: readonly InputVariable[],
  seq: number,
  patch: Partial<Pick<InputVariable, "name" | "kind">>
): InputVariable[] {
  return variables.map((variable) =>
    variable.seq === seq
      ? {
          ...variable,
          ...patch,
          // Converting to sensitive drops the sample rather than hiding it: the
          // point is that the value must not exist here at all.
          sample: (patch.kind ?? variable.kind) === "sensitive" ? undefined : variable.sample,
          confirmed: true,
        }
      : variable
  )
}

/**
 * Substitute confirmed variables into a step's rendered text.
 *
 * `literal` deliberately passes through unchanged — the user said the recorded
 * value *is* the procedure.
 */
export function applyVariableMapping(
  text: string,
  variables: readonly InputVariable[],
  seq: number
): string {
  const variable = variables.find((v) => v.seq === seq && v.confirmed)
  if (!variable) return text
  switch (variable.kind) {
    case "variable":
      return variable.sample && text.includes(variable.sample)
        ? text.split(variable.sample).join(`{{${variable.name}}}`)
        : `{{${variable.name}}}`
    case "sensitive":
      return `{{${variable.name}}}`
    case "literal":
      return text
  }
}

/** The `## Inputs` rows: name, kind, and nothing the user typed. */
export function inputsForSkillBody(
  variables: readonly InputVariable[]
): { name: string; sensitive: boolean }[] {
  return variables
    .filter((v) => v.confirmed && v.kind !== "literal")
    .map((v) => ({ name: v.name, sensitive: v.kind === "sensitive" }))
}
