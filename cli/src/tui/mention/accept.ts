/**
 * Insert an accepted mention candidate into the composer buffer. Pure — replaces
 * the active `@token` (from `detected.start` to the cursor on the current line)
 * with the candidate's insert string, and returns the new buffer.
 *
 * Insertion rules (preserve the existing `@path` drilling behaviour):
 *   - A directory file candidate (path ends with `/`) is inserted WITHOUT a
 *     trailing space and the cursor stays right after it, so the popup re-derives
 *     for that folder and the user keeps drilling (`@src/` → `@src/tui/` → …).
 *   - Everything else (file, skill, agent) closes off with a trailing space.
 */
import type { InputBuffer } from "../state/types"
import type { DetectedMention, MentionCandidate } from "./types"

export function acceptMention(
  buffer: InputBuffer,
  detected: DetectedMention,
  candidate: MentionCandidate
): InputBuffer {
  const isDir = candidate.kind === "file" && candidate.insert.endsWith("/")
  const suffix = isDir ? "" : " "
  const line = buffer.lines[buffer.cursorRow]
  const before = line.slice(0, detected.start)
  const after = line.slice(buffer.cursorCol)
  const newLine = before + candidate.insert + suffix + after
  const lines = [...buffer.lines]
  lines[buffer.cursorRow] = newLine
  return {
    lines,
    cursorRow: buffer.cursorRow,
    cursorCol: detected.start + candidate.insert.length + suffix.length,
  }
}
