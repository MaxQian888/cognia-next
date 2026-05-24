import type { ErrorPreset, ParsedNode } from "../types"
import { logParser } from "../parsers/log-parser"
import { pathUrlParser } from "../parsers/path-url-parser"
import { pythonTracebackParser } from "../parsers/python-traceback-parser"
import { rustPanicParser } from "../parsers/rust-panic-parser"
import { ansiParser } from "../parsers/ansi-parser"

const EXIT_CODE_RE = /(?:exit\s*code\s*[:=]?\s*|exited\s*with\s*code\s*)(\d+)/i

function processNodes(
  nodes: ParsedNode[],
  parser: { parse(text: string): ReturnType<typeof logParser.parse> }
): ParsedNode[] {
  const result: ParsedNode[] = []
  let changed = false
  for (const node of nodes) {
    if (node.kind !== "text" && node.kind !== "log") {
      result.push(node)
      continue
    }
    const parsed = parser.parse(node.content)
    if (parsed && parsed.parsed) {
      result.push(...parsed.nodes)
      changed = true
    } else {
      result.push(node)
    }
  }
  return changed ? result : nodes
}

export const bashPreset: ErrorPreset = {
  name: "bash",
  parsers: [ansiParser, pythonTracebackParser, rustPanicParser, logParser, pathUrlParser],
  parse(text: string) {
    const match = text.match(EXIT_CODE_RE)
    const exitCode = match ? Number(match[1]) : null

    // Remove the exit-code line from the text so the remaining content
    // can be parsed for logs / paths.
    const remaining = exitCode !== null ? text.replace(EXIT_CODE_RE, "").trim() : text

    let nodes: ParsedNode[] = [{ kind: "text", content: remaining }]

    // Strip/colourise ANSI first, then language-runtime parsers (so Python/Rust
    // frames win over raw path matching), then log + path parsers on the rest.
    for (const parser of [
      ansiParser,
      pythonTracebackParser,
      rustPanicParser,
      logParser,
      pathUrlParser,
    ]) {
      const next = processNodes(nodes, parser)
      if (next !== nodes) {
        nodes = next
      }
    }

    // Prepend the exit-code node when available
    if (exitCode !== null) {
      nodes.unshift({
        kind: "exitCode",
        content: `Exit code ${exitCode}`,
        exitCode,
      })
    }

    return {
      nodes,
      parsed: exitCode !== null || nodes.some((n) => n.kind !== "text"),
    }
  },
}
