import type { MemoryExternalContextSource } from "./policy"

interface PartLike {
  type?: unknown
  toolName?: unknown
  name?: unknown
}

const LOCAL_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "git",
  "terminal",
  "lsp",
])

function toolName(part: PartLike): string | undefined {
  if (typeof part.toolName === "string") return part.toolName
  if (typeof part.name === "string") return part.name
  if (typeof part.type === "string" && part.type.startsWith("tool-")) return part.type.slice(5)
  return undefined
}

function classifyTool(name: string): MemoryExternalContextSource | undefined {
  const normalized = name.toLocaleLowerCase()
  const leaf = normalized.split("__").at(-1) ?? normalized
  const trustedLocalMcp = normalized.startsWith("mcp__cognia-tools__")
  if ((normalized.startsWith("mcp__") || normalized.includes("mcp")) && !trustedLocalMcp) {
    return "mcp"
  }
  if (
    LOCAL_TOOL_NAMES.has(leaf) ||
    [...LOCAL_TOOL_NAMES].some((tool) => leaf.startsWith(`${tool}_`))
  ) {
    return "local-tool"
  }
  if (normalized.includes("tool_search") || normalized.includes("tool-search")) {
    return "tool-search"
  }
  if (
    normalized.includes("screenshot") ||
    normalized.includes("screen") ||
    normalized.includes("computer_use")
  ) {
    return "screen"
  }
  if (
    normalized.includes("connector") ||
    normalized.includes("slack") ||
    normalized.includes("lark") ||
    normalized.includes("gmail") ||
    normalized.includes("notion")
  ) {
    return "connector"
  }
  if (
    normalized.includes("web_search") ||
    normalized.includes("web-search") ||
    normalized.includes("websearch") ||
    normalized.includes("webfetch") ||
    normalized.includes("browser") ||
    normalized.includes("fetch_url") ||
    normalized.includes("fetchurl")
  ) {
    return "web-search"
  }
  // Tool output is untrusted unless it is an explicitly recognised local tool.
  return "mcp"
}

/** Inspect persisted UI parts without reading their content. */
export function detectMemoryExternalContext(
  messages: readonly { parts?: readonly unknown[] }[]
): MemoryExternalContextSource[] {
  const sources = new Set<MemoryExternalContextSource>()
  for (const message of messages) {
    for (const rawPart of message.parts ?? []) {
      if (!rawPart || typeof rawPart !== "object") continue
      const part = rawPart as PartLike
      if (part.type === "source-url") {
        sources.add("web-search")
        continue
      }
      if (part.type === "source-document") {
        sources.add("document")
        continue
      }
      const name = toolName(part)
      if (!name) continue
      const source = classifyTool(name)
      if (source) sources.add(source)
    }
  }
  return [...sources]
}
