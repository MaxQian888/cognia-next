import type { ParsedError, ParsedNode } from "../types"

// Rust ≥ 1.65: `thread 'main' panicked at src/main.rs:10:5:` then the message
// on the following line. `[ \t]*` (not `\s*`) so the optional group — not the
// gap — consumes the newline and captures the message line.
const RUST_NEW_RE = /thread\s+'[^']*'\s+panicked\s+at\s+(.+?):(\d+):(\d+):?[ \t]*(?:\r?\n([^\n]*))?/
// Older rustc: `thread 'main' panicked at 'message', src/main.rs:10:5`.
const RUST_OLD_RE = /thread\s+'[^']*'\s+panicked\s+at\s+'([\s\S]*?)',\s*(.+?):(\d+):(\d+)/

/**
 * Parse a Rust panic into a `text` node (the panic message) plus a `path` node
 * (`file:line:col`, clickable in the file viewer). Handles both the modern
 * `panicked at <loc>:` layout and the legacy `panicked at '<msg>', <loc>` one.
 */
export const rustPanicParser = {
  name: "rust-panic",

  parse(text: string): ParsedError | null {
    if (!text.includes("panicked at")) return null

    const old = text.match(RUST_OLD_RE)
    if (old) {
      return build(old[1].trim(), old[2], old[3], old[4])
    }

    const next = text.match(RUST_NEW_RE)
    if (next) {
      return build((next[4] ?? "").trim(), next[1], next[2], next[3])
    }

    return null
  },
}

function build(message: string, file: string, line: string, col: string): ParsedError {
  const nodes: ParsedNode[] = []
  if (message) nodes.push({ kind: "text", content: message })
  nodes.push({
    kind: "path",
    content: `${file}:${line}:${col}`,
    href: file,
    line: Number(line),
    column: Number(col),
  })
  return { nodes, parsed: true }
}
