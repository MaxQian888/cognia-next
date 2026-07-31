/**
 * Serialize a recording trace into compact text for the skill-generation LLM.
 *
 * Pure (no I/O, no model call) so it is fully unit-testable. CRITICALLY:
 * screenshots are NEVER inlined here — only element metadata + the lossy typed
 * "text hint" reach the model. Screenshots stay local (attached as resources).
 * Callers must still run the result through the PII gate before sending.
 */

import type { Observation, RecordingTrace } from "./types"

/** Hard cap on how many steps we serialize (keeps the prompt within context). */
export const MAX_PROMPT_STEPS = 80
/** Per-step typed-hint truncation. */
const MAX_HINT_CHARS = 120

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function describeElement(obs: Observation): string {
  const el = obs.element
  if (!el) return ""
  const parts: string[] = []
  if (el.name) parts.push(`"${el.name}"`)
  if (el.controlType) parts.push(el.controlType)
  if (el.automationId) parts.push(`#${el.automationId}`)
  const label = parts.join(" ")
  return label ? ` ${label}` : ""
}

function describeStep(obs: Observation): string {
  switch (obs.kind) {
    case "click": {
      const where = obs.point ? ` at (${obs.point.x}, ${obs.point.y})` : ""
      return `click${describeElement(obs)}${where}`
    }
    case "key": {
      const hint = obs.textHint ? ` "${truncate(obs.textHint, MAX_HINT_CHARS)}"` : ""
      const into = describeElement(obs)
      return `type${hint}${into ? ` into${into}` : ""}`
    }
    case "scroll": {
      const dir = (obs.scrollDy ?? 0) >= 0 ? "up" : "down"
      return `scroll ${dir}${describeElement(obs)}`
    }
    default:
      return obs.kind
  }
}

/**
 * Build the compact, model-facing transcript. Includes the active window title
 * whenever it changes (cheap context for "which app is this") and one line per
 * coalesced observation.
 */
export function traceToPromptText(trace: RecordingTrace): string {
  const lines: string[] = []
  const steps = trace.observations.slice(0, MAX_PROMPT_STEPS)
  let lastWindow: string | null = null
  steps.forEach((obs, i) => {
    const win = obs.element?.windowTitle ?? null
    if (win && win !== lastWindow) {
      lines.push(`# Window: ${win}`)
      lastWindow = win
    }
    lines.push(`${i + 1}. ${describeStep(obs)}`)
  })
  if (trace.observations.length > MAX_PROMPT_STEPS) {
    lines.push(`… (${trace.observations.length - MAX_PROMPT_STEPS} more steps omitted)`)
  }
  return lines.join("\n")
}
