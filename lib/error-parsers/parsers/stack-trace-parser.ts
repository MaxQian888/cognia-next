import { parseStackTrace } from "@/lib/terminal/stack-trace"
import type { ParsedError, ParsedNode } from "../types"

export const stackTraceParser = {
  name: "stack-trace",

  parse(text: string): ParsedError | null {
    // Quick heuristic: must contain "at ", "@", or "Error:" to be a stack trace
    if (!text.includes("at ") && !text.includes("@") && !text.includes("Error:")) {
      return null
    }

    const frames = parseStackTrace(text)
    if (frames.length === 0) return null

    // Find the message portion (everything before the first "at " line)
    const lines = text.split("\n")
    let messageEnd = 0
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*at\s+/.test(lines[i])) {
        messageEnd = i
        break
      }
    }
    const message = messageEnd > 0 ? lines.slice(0, messageEnd).join("\n").trim() : ""

    const nodes: ParsedNode[] = []
    if (message) {
      nodes.push({ kind: "text", content: message })
    }
    nodes.push({
      kind: "stack",
      content: `${frames.length} frame${frames.length === 1 ? "" : "s"}`,
      frames,
    })

    return { nodes, parsed: true }
  },
}
