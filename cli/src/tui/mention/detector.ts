/**
 * Detect the active `@` mention token under the cursor and classify it into a
 * popup mode. Pure — the `Input` component feeds it the text up to the cursor.
 *
 * Token grammar (mirrors the conventions in the design doc):
 *   - `@skill:<q>`  → skills only
 *   - `@agent:<q>`  → agents only
 *   - `@file:<q>`   → files only
 *   - `@<q>` where `<q>` contains `/` or `\` → files only (legacy `@path`)
 *   - bare `@<q>` (no recognised prefix, no slash) → mixed (file+skill+agent)
 */
import type { DetectedMention } from "./types"

/** The trailing `@token` regex — identical shape to `file-completer.activeAtToken`. */
const AT_TOKEN = /(^|\s)(@\S*)$/

/** Recognised explicit prefixes and the mode they select. */
const PREFIXES: Array<{ prefix: string; mode: DetectedMention["mode"] }> = [
  { prefix: "skill:", mode: "skill" },
  { prefix: "agent:", mode: "agent" },
  { prefix: "file:", mode: "file" },
]

/**
 * Parse the trailing `@token` in `beforeCursor`, or return null when the cursor
 * is not inside an `@` reference. `start` is the column of the `@`.
 */
export function detectMention(beforeCursor: string): DetectedMention | null {
  const match = AT_TOKEN.exec(beforeCursor)
  if (!match) return null
  const token = match[2]
  const start = beforeCursor.length - token.length
  // Body is the token without the leading `@`.
  const body = token.slice(1)

  for (const { prefix, mode } of PREFIXES) {
    if (body.toLowerCase().startsWith(prefix)) {
      return { query: body.slice(prefix.length), start, mode }
    }
  }

  // No explicit prefix: a path-shaped token (contains a separator) is a file;
  // anything else opens the mixed popup.
  if (body.includes("/") || body.includes("\\")) {
    return { query: body, start, mode: "file" }
  }
  return { query: body, start, mode: "mixed" }
}
