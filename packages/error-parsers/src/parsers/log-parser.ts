import { ALL_LEVELS } from "@cognia/logging/level-theme"
import type { ParsedError, ParsedNode } from "../types"

const LEVEL_PATTERN = new RegExp(`^\\s*(${ALL_LEVELS.join("|")})[\\s:]`, "i")

export const logParser = {
  name: "log",

  parse(text: string): ParsedError | null {
    const lines = text.split("\n")
    const nodes: ParsedNode[] = []
    let hasMatch = false
    let currentLevel: ParsedNode["level"] = undefined

    for (const line of lines) {
      const match = line.match(LEVEL_PATTERN)
      if (match) {
        const level = match[1].toLowerCase() as ParsedNode["level"]
        currentLevel = level
        hasMatch = true
        nodes.push({ kind: "log", content: line, level })
      } else if (currentLevel && line.trim()) {
        // Inherit level from preceding line (for multi-line stack traces etc.)
        nodes.push({ kind: "log", content: line, level: currentLevel })
      } else {
        nodes.push({ kind: "text", content: line })
      }
    }

    if (!hasMatch) return null
    return { nodes, parsed: true }
  },
}
