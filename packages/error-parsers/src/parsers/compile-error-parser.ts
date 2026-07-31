import type { ParsedError, ParsedNode } from "../types"

// `tsc` pretty output: `src/file.ts(10,5): error TS2345: message`. The
// parenthesised `(line,col)` location is NOT caught by the generic
// `file:line:col` path matcher, so tsc errors would otherwise lose their
// clickable jump-to-source. The colon form (`file:line:col - error …`) and
// cargo's `--> file:line:col` are already handled by pathUrlParser.
const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+(TS\d+):\s*(.*)$/

/**
 * Parse `tsc` parenthesised compile diagnostics into a `path` node (clickable
 * jump-to-source) plus a `text` node carrying the `TS####: message`. Lines that
 * don't match are coalesced back into plain text so surrounding context is
 * preserved. Returns `null` when no tsc diagnostic is present.
 */
export const compileErrorParser = {
  name: "compile-error",

  parse(text: string): ParsedError | null {
    const lines = text.split("\n")
    const nodes: ParsedNode[] = []
    let pending: string[] = []
    let matched = false

    const flush = () => {
      if (pending.length === 0) return
      nodes.push({ kind: "text", content: pending.join("\n") })
      pending = []
    }

    for (const line of lines) {
      const m = line.match(TSC_RE)
      if (!m) {
        pending.push(line)
        continue
      }
      matched = true
      flush()
      nodes.push({
        kind: "path",
        content: `${m[1]}:${m[2]}:${m[3]}`,
        href: m[1],
        line: Number(m[2]),
        column: Number(m[3]),
      })
      nodes.push({ kind: "text", content: `${m[4]}: ${m[5]}` })
    }
    flush()

    if (!matched) return null
    return { nodes, parsed: true }
  },
}
