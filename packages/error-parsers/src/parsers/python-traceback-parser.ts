import type { ParsedError, ParsedNode } from "../types"
import type { StackFrame } from "@/lib/terminal/stack-trace"

// `  File "/path/script.py", line 10, in func` (the `, in func` tail is absent
// for the bottom-most C-extension / module frame in some tracebacks).
const PY_FRAME_RE = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?\s*$/

/**
 * Parse a CPython traceback into a `stack` node (one frame per `File "…", line N`
 * entry) plus a `text` node for the trailing exception line. Reuses the shared
 * {@link StackFrame} shape and the existing `stack` node renderer, so frames are
 * clickable in the file viewer exactly like JS stack frames.
 */
export const pythonTracebackParser = {
  name: "python-traceback",

  parse(text: string): ParsedError | null {
    if (!text.includes("Traceback (most recent call last):")) return null

    const lines = text.split("\n")
    const frames: StackFrame[] = []
    for (const line of lines) {
      const m = line.match(PY_FRAME_RE)
      if (m) {
        frames.push({
          fn: m[3]?.trim() || "<module>",
          file: m[1],
          line: Number(m[2]),
          col: null,
        })
      }
    }
    if (frames.length === 0) return null

    // The exception line (e.g. `ValueError: boom`) is the last non-empty line
    // that is not indented and not the "Traceback (…)" header.
    let message = ""
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]
      const trimmed = raw.trim()
      if (!trimmed) continue
      if (/^\s/.test(raw)) continue
      if (trimmed.startsWith("Traceback (")) continue
      message = trimmed
      break
    }

    const nodes: ParsedNode[] = []
    if (message) nodes.push({ kind: "text", content: message })
    nodes.push({
      kind: "stack",
      content: `${frames.length} frame${frames.length === 1 ? "" : "s"}`,
      frames,
    })
    return { nodes, parsed: true }
  },
}
