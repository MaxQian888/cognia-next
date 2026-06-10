/**
 * Pure command-history navigation for the composer (↑/↓). The live draft is
 * stashed when navigation begins and restored when the user steps back past the
 * newest entry. Returns the next history state plus the text to load into the
 * buffer.
 */
import type { HistoryState } from "../state/types"

export interface HistoryResult {
  history: HistoryState
  text: string
}

export function historyUp(h: HistoryState, currentText: string): HistoryResult {
  if (h.entries.length === 0) return { history: h, text: currentText }
  if (h.index === -1) {
    const index = h.entries.length - 1
    return { history: { entries: h.entries, index, draft: currentText }, text: h.entries[index] }
  }
  if (h.index > 0) {
    const index = h.index - 1
    return { history: { ...h, index }, text: h.entries[index] }
  }
  // Already at the oldest entry.
  return { history: h, text: h.entries[0] }
}

export function historyDown(h: HistoryState): HistoryResult {
  if (h.index === -1) return { history: h, text: h.draft }
  if (h.index < h.entries.length - 1) {
    const index = h.index + 1
    return { history: { ...h, index }, text: h.entries[index] }
  }
  // Stepping past the newest entry restores the stashed draft.
  return { history: { entries: h.entries, index: -1, draft: "" }, text: h.draft }
}

/** Whether history navigation is currently active (not editing the live draft). */
export function inHistory(h: HistoryState): boolean {
  return h.index !== -1
}
