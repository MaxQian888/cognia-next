import type { ParsedError, ParsedNode } from "../types"

/**
 * Recognise a JSON object/array — whether the whole text is JSON or a JSON
 * payload embedded after a prose/log prefix (e.g. a CLI that prints
 * `Exit code 1\nerror: …\n{ … }`). The matched block becomes a single `json`
 * node carrying the parsed value (rendered as a collapsible tree); any
 * surrounding prose is preserved as `text` nodes so the remaining parsers
 * (log / path / category) can still enrich it. Returns `null` when the text
 * holds no parseable JSON object/array (root-level primitives are ignored — a
 * bare `42` or `"hi"` is not worth a tree).
 */
export const jsonParser = {
  name: "json",

  parse(text: string): ParsedError | null {
    const block = findJsonBlock(text)
    if (!block) return null

    const nodes: ParsedNode[] = []

    const before = text.slice(0, block.start).replace(/\s+$/, "")
    if (before) nodes.push({ kind: "text", content: before })

    nodes.push({ kind: "json", content: summarize(block.value), value: block.value })

    const after = text.slice(block.end).replace(/^\s+/, "")
    if (after) nodes.push({ kind: "text", content: after })

    return { nodes, parsed: true }
  },
}

/**
 * Locate the first balanced, parseable JSON object/array embedded anywhere in
 * `text`, returning its value and `[start, end)` source span. Brace runs that
 * are balanced but not valid JSON are skipped so a later valid block can win.
 */
function findJsonBlock(text: string): { value: unknown; start: number; end: number } | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "{" && ch !== "[") continue

    const end = scanBalanced(text, i)
    if (end === -1) continue

    let value: unknown
    try {
      value = JSON.parse(text.slice(i, end))
    } catch {
      continue
    }
    if (value !== null && typeof value === "object") {
      return { value, start: i, end }
    }
  }
  return null
}

/**
 * From the opening bracket at `start`, return the index just past its matching
 * close, honouring nesting and skipping bracket characters inside double-quoted
 * strings (with backslash escapes). Returns -1 when the bracket never closes.
 */
function scanBalanced(text: string, start: number): number {
  const open = text[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return i + 1
  }
  return -1
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} items]`
  return `{${Object.keys(value as Record<string, unknown>).length} keys}`
}
