// `{{fieldId}}` interpolation for tray-panel action effects.
//
// Custom actions are "an input box plus something to do with it", so every
// string in an effect (the prompt, a slash command's arguments, a route) is a
// template resolved against the form values. Kept deliberately tiny — this is a
// substitution pass, not an expression language: anything richer belongs in a
// slash command or a plugin command, which the effect kinds already reach.

import type { TrayPanelField, TrayPanelFieldValue, TrayPanelValues } from "./types"

/** Matches `{{ fieldId }}`; ids are `[A-Za-z0-9_-]`, whitespace tolerated. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g

export interface InterpolationResult {
  text: string
  /**
   * Placeholders that named a field the action does not declare. Surfaced as a
   * validation error rather than silently substituting an empty string: a typo
   * in a prompt template would otherwise ship a subtly wrong instruction to the
   * model with no visible sign anything went wrong.
   */
  missing: string[]
}

/** Render a field value the way a prompt should read it. */
export function formatFieldValue(value: TrayPanelFieldValue | undefined): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  return value
}

/**
 * Substitute every `{{fieldId}}` in `template` with the matching value.
 *
 * `known` is the set of ids the action actually declares — a placeholder
 * outside it is reported in `missing` instead of being replaced, so the caller
 * can refuse to run rather than send a half-formed prompt.
 */
export function interpolate(
  template: string,
  values: TrayPanelValues,
  known: ReadonlySet<string>
): InterpolationResult {
  const missing: string[] = []
  const text = template.replace(PLACEHOLDER_RE, (match, id: string) => {
    if (!known.has(id)) {
      if (!missing.includes(id)) missing.push(id)
      return match
    }
    return formatFieldValue(values[id])
  })
  return { text, missing }
}

/** The placeholder ids referenced by a template, in first-seen order. */
export function extractPlaceholders(template: string): string[] {
  const out: string[] = []
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const id = match[1]
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** Seed a value map from a field list's declared defaults. */
export function defaultValuesFor(fields: readonly TrayPanelField[]): TrayPanelValues {
  const values: TrayPanelValues = {}
  for (const field of fields) {
    switch (field.kind) {
      case "switch":
        values[field.id] = field.defaultValue ?? false
        break
      case "number":
        // `?? min ?? 0` rather than a bare 0: a field declared `min: 1` would
        // otherwise open already-invalid.
        values[field.id] = field.defaultValue ?? field.min ?? 0
        break
      default:
        values[field.id] = field.defaultValue ?? ""
    }
  }
  return values
}

/** True when a required field has nothing usable in it. */
export function isFieldEmpty(
  field: TrayPanelField,
  value: TrayPanelFieldValue | undefined
): boolean {
  if (value === undefined || value === null) return true
  if (field.kind === "switch") return false // a switch always holds a value
  if (field.kind === "number") return typeof value === "number" ? !Number.isFinite(value) : true
  return String(value).trim().length === 0
}
