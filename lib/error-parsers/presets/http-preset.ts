import type { ErrorPreset, ParsedNode } from "../types"
import { jsonParser } from "../parsers/json-parser"
import { pathUrlParser } from "../parsers/path-url-parser"

const STATUS_RE = /(?:HTTP\s+(\d{3})|status[:\s=]+(\d{3}))/i
const URL_RE = /https?:\/\/[^\s<>>"{}|\\^\[\]`]+/g

export const httpPreset: ErrorPreset = {
  name: "http",
  parsers: [jsonParser, pathUrlParser],
  parse(text: string) {
    const statusMatch = text.match(STATUS_RE)
    const status = statusMatch ? Number(statusMatch[1] ?? statusMatch[2]) : null

    // Extract the first URL
    URL_RE.lastIndex = 0
    const urlMatch = URL_RE.exec(text)
    const url = urlMatch ? urlMatch[0] : null

    // Build a cleaned text with status/URL lines removed so JSON parser
    // can find a payload further down in the body.
    let cleaned = text
    if (statusMatch) {
      cleaned = cleaned.replace(statusMatch[0], "")
    }
    if (urlMatch) {
      cleaned = cleaned.replace(urlMatch[0], "")
    }
    cleaned = cleaned.trim()

    // Try to parse JSON from the cleaned text
    const jsonResult = jsonParser.parse(cleaned)

    const nodes: ParsedNode[] = []

    if (status !== null) {
      nodes.push({
        kind: "statusCode",
        content: `HTTP ${status}`,
        status,
      })
    }

    if (url) {
      nodes.push({
        kind: "url",
        content: url,
        href: url,
      })
    }

    if (jsonResult?.parsed) {
      nodes.push(...jsonResult.nodes)
    }

    // If nothing matched, fall back to treating the whole text as plain
    if (nodes.length === 0) {
      nodes.push({ kind: "text", content: text })
    }

    return {
      nodes,
      parsed: nodes.some((n) => n.kind !== "text"),
    }
  },
}
