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
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i]
    if (c.kind === "assistant") return c.raw
  }
  return null
}
