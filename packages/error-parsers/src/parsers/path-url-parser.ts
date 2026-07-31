import { matchFileLinks } from "@/lib/terminal/terminal-links"
import type { ParsedError, ParsedNode } from "../types"

const URL_RE = /https?:\/\/[^\s<>"{}|\\^\[\]`]+/g

export const pathUrlParser = {
  name: "path-url",

  parse(text: string): ParsedError | null {
    const nodes: ParsedNode[] = []
    let hasMatch = false

    // Process URLs
    let lastIndex = 0
    let urlMatch: RegExpExecArray | null
    URL_RE.lastIndex = 0

    while ((urlMatch = URL_RE.exec(text)) !== null) {
      if (urlMatch.index > lastIndex) {
        nodes.push({ kind: "text", content: text.slice(lastIndex, urlMatch.index) })
      }
      nodes.push({
        kind: "url",
        content: urlMatch[0],
        href: urlMatch[0],
      })
      hasMatch = true
      lastIndex = urlMatch.index + urlMatch[0].length
    }

    if (lastIndex < text.length) {
      nodes.push({ kind: "text", content: text.slice(lastIndex) })
    }

    // Process file paths in remaining text nodes
    const result = processPaths(nodes)
    if (result.hasMatch) hasMatch = true

    if (!hasMatch) return null
    return { nodes: result.nodes, parsed: true }
  },
}

function processPaths(nodes: ParsedNode[]): { nodes: ParsedNode[]; hasMatch: boolean } {
  let hasMatch = false
  const result: ParsedNode[] = []

  for (const node of nodes) {
    if (node.kind !== "text") {
      result.push(node)
      continue
    }

    const links = matchFileLinks(node.content)
    if (links.length === 0) {
      result.push(node)
      continue
    }

    hasMatch = true
    let lastIndex = 0
    for (const link of links) {
      if (link.start > lastIndex) {
        result.push({ kind: "text", content: node.content.slice(lastIndex, link.start) })
      }
      result.push({
        kind: "path",
        content: node.content.slice(link.start, link.start + link.length),
        href: link.path,
        line: link.line,
        column: link.column,
      })
      lastIndex = link.start + link.length
    }
    if (lastIndex < node.content.length) {
      result.push({ kind: "text", content: node.content.slice(lastIndex) })
    }
  }

  return { nodes: result, hasMatch }
}
