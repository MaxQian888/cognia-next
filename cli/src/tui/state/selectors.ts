/**
 * Small pure derivations over `TuiState` used by the components. Anything more
 * than a one-liner (usage/context math) lives in `format/usage.ts`.
 */
import type { TuiState } from "./types"

/** A turn is in progress (streaming or aborting). */
export function isBusy(state: TuiState): boolean {
  return state.turnStatus !== "idle"
}

/** A modal overlay is open. */
export function hasOverlay(state: TuiState): boolean {
  return state.overlay.kind !== "none"
}

/** The composer accepts a new submission (idle, no modal). */
export function canSubmit(state: TuiState): boolean {
  return state.turnStatus === "idle" && state.overlay.kind === "none"
}

/** There is in-flight reasoning or text to show below the transcript. */
export function hasInflight(state: TuiState): boolean {
  return state.inflight.text.length > 0 || state.inflight.thinking.length > 0
}

/** The most recent user prompt in the transcript, or null when there is none. */
export function lastUserText(state: TuiState): string | null {
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i]
    if (c.kind === "user") return c.text
  }
  return null
}

/** The most recent committed assistant reply (raw markdown), or null. */
export function lastAssistantText(state: TuiState): string | null {
  return nthAssistantText(state, 1)
}

/**
 * The Nth-most-recent committed assistant reply (1 = latest, 2 = the one before
 * it, …), or null when there are fewer than `n`. Powers `/copy [n]`.
 */
export function nthAssistantText(state: TuiState, n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return null
  let seen = 0
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i]
    if (c.kind === "assistant") {
      seen++
      if (seen === n) return c.raw
    }
  }
  return null
}

/** Matches fenced code blocks; group 1 is the inner body. */
const FENCED_CODE = /```[^\n]*\n([\s\S]*?)```/g

/**
 * The last fenced code block of the most recent assistant reply that contains
 * one (inner body, trailing newline trimmed), or null. Powers `/copy code`.
 */
export function lastCodeBlock(state: TuiState): string | null {
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i]
    if (c.kind !== "assistant") continue
    let last: string | null = null
    for (const m of c.raw.matchAll(FENCED_CODE)) last = m[1]
    if (last !== null) return last.replace(/\n$/, "")
  }
  return null
}

/**
 * The most recent tool result rendered as plain text (strings verbatim, other
 * shapes pretty-printed JSON), or null when no tool has produced a result.
 * Powers `/copy tool`.
 */
export function lastToolResultText(state: TuiState): string | null {
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i]
    if (c.kind !== "tool") continue
    if (c.result === undefined || c.result === null) continue
    return toolResultToText(c.result)
  }
  return null
}

/** Render a tool result as plain text: strings verbatim, content-block arrays
 * (`[{type:"text",text}]`, as Claude tools emit) joined, else pretty JSON. */
function toolResultToText(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) {
    const texts = result
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string"
      )
      .map((b) => b.text)
    if (texts.length > 0) return texts.join("\n")
  }
  return JSON.stringify(result, null, 2)
}
