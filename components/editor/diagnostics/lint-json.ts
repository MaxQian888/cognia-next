/**
 * JSON diagnostics via the native parser — zero dependency, precise position.
 *
 * `JSON.parse` throws a single `SyntaxError` for the first problem; we extract
 * the offset from the message. V8 wording has changed across Node versions, so
 * we accept both the legacy `at position N` form and the newer
 * `line L column C` form, falling back to the document start if neither is
 * present (the message still tells the user what's wrong).
 */

import { lineColToOffset } from "./offset"
import type { EditorDiagnostic } from "./types"

const POSITION_RE = /at position (\d+)/
const LINE_COL_RE = /line (\d+) column (\d+)/

export function lintJson(text: string): EditorDiagnostic[] {
  if (text.trim() === "") return []
  try {
    JSON.parse(text)
    return []
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON"
    const offset = locate(text, message)
    return [
      {
        from: offset,
        to: Math.min(offset + 1, text.length),
        severity: "error",
        message,
        source: "json",
      },
    ]
  }
}

function locate(text: string, message: string): number {
  const byPos = POSITION_RE.exec(message)
  if (byPos) {
    const pos = Number(byPos[1])
    return Number.isFinite(pos) ? Math.min(Math.max(pos, 0), text.length) : 0
  }
  const byLineCol = LINE_COL_RE.exec(message)
  if (byLineCol) {
    const line = Number(byLineCol[1])
    const column = Number(byLineCol[2])
    // JSON error columns are 1-based; lineColToOffset expects 0-based.
    return lineColToOffset(text, line, column - 1)
  }
  return 0
}
