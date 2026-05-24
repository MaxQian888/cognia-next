import type { ErrorPreset, ParsedError, ParsedNode } from "./types"
import { jsonParser } from "./parsers/json-parser"
import { logParser } from "./parsers/log-parser"
import { stackTraceParser } from "./parsers/stack-trace-parser"
import { pathUrlParser } from "./parsers/path-url-parser"
import { pythonTracebackParser } from "./parsers/python-traceback-parser"
import { rustPanicParser } from "./parsers/rust-panic-parser"
import { anthropicErrorParser } from "./parsers/anthropic-error-parser"
import { ansiParser } from "./parsers/ansi-parser"
import { compileErrorParser } from "./parsers/compile-error-parser"

function processTextNodes(
  nodes: ParsedNode[],
  parser: { parse(text: string): ParsedError | null }
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

export const defaultPreset: ErrorPreset = {
  name: "default",
  parsers: [
    anthropicErrorParser,
    jsonParser,
    ansiParser,
    pythonTracebackParser,
    rustPanicParser,
    stackTraceParser,
    compileErrorParser,
    logParser,
    pathUrlParser,
  ],
  parse(text: string): ParsedError {
    // Structured Anthropic API error envelope — more specific than generic
    // JSON, so try it before the JSON tree renderer claims the whole payload.
    const apiResult = anthropicErrorParser.parse(text)
    if (apiResult && apiResult.parsed) {
      return apiResult
    }

    // Try JSON next — if the whole text is valid JSON, treat it as such
    const jsonResult = jsonParser.parse(text)
    if (jsonResult && jsonResult.parsed) {
      return jsonResult
    }

    // Otherwise start with a single text node and run remaining parsers.
    // Python/Rust run before the generic stack/path parsers so their
    // structured frames/locations win over raw path matching.
    let nodes: ParsedNode[] = [{ kind: "text", content: text }]
    let parsed = false

    for (const parser of [
      ansiParser,
      pythonTracebackParser,
      rustPanicParser,
      stackTraceParser,
      compileErrorParser,
      pathUrlParser,
      logParser,
    ]) {
      const next = processTextNodes(nodes, parser)
      if (next !== nodes) {
        parsed = true
        nodes = next
      }
    }

    return { nodes, parsed }
  },
}
