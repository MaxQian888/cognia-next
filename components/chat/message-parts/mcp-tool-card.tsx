"use client"

/**
 * MCPToolCard — router that dispatches tool calls with known names to a
 * structured sub-renderer. Returns `null` when the tool isn't in the
 * registry OR the structured renderer rejects the payload — the caller
 * (message-renderer) then falls back to the generic `<Tool>` block.
 *
 * The recognised set covers:
 *  - cognia's MCP server: `wiki_search`, `wiki_read`, `rag_search`, `runtime_query`
 *  - Claude built-ins: `Plan`, `Read`, `Glob`
 *
 * Plugin-provided MCP tools are NOT handled here — they go through
 * `registerMessagePartRenderer` (P2.1) instead.
 */

import type { ToolUIPart } from "ai"
import { ToolBody } from "@/components/ai-elements/tool"
import { WikiSearchCard } from "./mcp-renderers/wiki-search-card"
import { WikiReadCard } from "./mcp-renderers/wiki-read-card"
import { RagSearchCard } from "./mcp-renderers/rag-search-card"
import { RuntimeQueryCard } from "./mcp-renderers/runtime-query-card"
import { PlanCard } from "./mcp-renderers/plan-card"
import { ReadCard } from "./mcp-renderers/read-card"
import { GlobCard } from "./mcp-renderers/glob-card"

type CardComponent = (props: { part: ToolUIPart }) => JSX.Element | null

const REGISTRY: Record<string, CardComponent> = {
  // cognia external bridge
  wiki_search: WikiSearchCard,
  wiki_read: WikiReadCard,
  rag_search: RagSearchCard,
  runtime_query: RuntimeQueryCard,
  // Claude built-ins
  Plan: PlanCard,
  Read: ReadCard,
  Glob: GlobCard,
}

export function isStructuredMcpToolType(type: string): boolean {
  if (!type.startsWith("tool-")) return false
  const toolName = type.slice("tool-".length)
  return toolName in REGISTRY
}

/**
 * Returns the structured card for known tools when the payload parses; falls
 * back to the generic ToolBody otherwise so the user always sees *something*.
 */
export function MCPToolCard({ part }: { part: ToolUIPart }) {
  const type = part.type
  if (typeof type !== "string" || !type.startsWith("tool-")) {
    return <ToolBody part={part} />
  }
  const toolName = type.slice("tool-".length)
  const Card = REGISTRY[toolName]
  if (!Card) return <ToolBody part={part} />

  return <McpCardWithFallback Card={Card} part={part} />
}

function McpCardWithFallback({ Card, part }: { Card: CardComponent; part: ToolUIPart }) {
  const rendered = Card({ part })
  if (rendered) return rendered
  return <ToolBody part={part} />
}

export default MCPToolCard
