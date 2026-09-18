/**
 * Convert a stored JSONL transcript (see `cli/src/agent/transcript.ts`) into TUI
 * cells, for the session-resume flow. Pure: ids are index-derived so replay is
 * deterministic.
 */
import type { TranscriptEntry } from "../../agent/transcript"
import type { Cell } from "../state/types"

export function transcriptToCells(entries: Iterable<TranscriptEntry>): Cell[] {
  const cells: Cell[] = []
  let i = 0
  // Accepts any iterable so resume can stream `iterTranscriptEntries` straight
  // into cells without an intermediate entries array duplicating the history.
  for (const entry of entries) {
    const id = `r${i++}`
    if (entry.role === "user") {
      cells.push({ id, kind: "user", text: entry.content })
    } else if (entry.role === "assistant") {
      cells.push({ id, kind: "assistant", raw: entry.content })
    } else {
      cells.push({ id, kind: "notice", message: entry.content })
    }
  }
  return cells
}
