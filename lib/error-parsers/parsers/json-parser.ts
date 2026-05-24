import type { ParsedError, ParsedNode } from "../types"

export const jsonParser = {
  name: "json",

  parse(text: string): ParsedError | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (
      !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
      !(trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }

    const nodes = [buildJsonNode(parsed)]
    return { nodes, parsed: true }
  },
}

function buildJsonNode(value: unknown): ParsedNode {
  const isArray = Array.isArray(value)
  const isObject = value !== null && typeof value === "object" && !isArray

  if (!isArray && !isObject) {
    return { kind: "text", content: formatPrimitive(value) }
  }

  const entries = isArray
    ? (value as unknown[]).map((entry, index) => [String(index), entry] as const)
    : Object.entries(value as Record<string, unknown>)

  return {
    kind: "json",
    content: isArray ? `[${entries.length} items]` : `{${entries.length} keys}`,
    children: entries.map(([label, val]) => ({
      kind: "text" as const,
      content: `${isArray ? `[${label}]` : `"${label}"`}: ${formatPrimitive(val)}`,
      ...(typeof val === "object" && val !== null ? { children: [buildJsonNode(val)] } : {}),
    })),
  }
}

function formatPrimitive(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  if (value === null) return "null"
  return String(value)
}
