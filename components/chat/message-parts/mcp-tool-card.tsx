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
import { GrepCard } from "./mcp-renderers/grep-card"
import { WebFetchCard } from "./mcp-renderers/web-fetch-card"
import { WebSearchCard } from "./mcp-renderers/web-search-card"
import { NotebookEditCard } from "./mcp-renderers/notebook-edit-card"
import { ComputerUseCard } from "./mcp-renderers/computer-use-card"
import { EditCard } from "./mcp-renderers/edit-card"
import { WriteCard } from "./mcp-renderers/write-card"
import { LsCard } from "./mcp-renderers/ls-card"
import { WorkflowProposalCard } from "@/components/workflow/editor/chat/workflow-proposal-card"

type CardComponent = (props: { part: ToolUIPart }) => React.JSX.Element | null

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
  Grep: GrepCard,
  WebFetch: WebFetchCard,
  WebSearch: WebSearchCard,
  NotebookEdit: NotebookEditCard,
  // Sidecar coreFiles suite (ai-sdk path registers these flat-named; the
  // Anthropic escape hatch namespaces them — normalizeToolName folds both
  // onto these keys). read/glob/grep reuse the SDK-built-in cards (payload
  // shapes already tolerate path/file_path + string output).
  read: ReadCard,
  glob: GlobCard,
  grep: GrepCard,
  ls: LsCard,
  edit: EditCard,
  multi_edit: EditCard,
  write: WriteCard,
  Edit: EditCard,
  MultiEdit: EditCard,
  Write: WriteCard,
  // Workflow Copilot — proposal card (wf_propose_batch + wf_apply_template
  // share the same payload shape: { proposalId, summary, opCount, ... }).
  wf_propose_batch: WorkflowProposalCard,
  wf_apply_template: WorkflowProposalCard,
  // ADR-0020 W3 — Computer Use plugin MCP tool. Inline screenshot
  // rendering + compact action chip. Registered under both the bare
  // `computer_use` name and the cognia-plugin-tools-prefixed name so
  // both sidecar bridge variants land on the same card.
  computer_use: ComputerUseCard,
  "mcp__cognia-plugin-tools__computer_use": ComputerUseCard,
}

/**
 * Fold namespaced cognia-tools names onto their bare registry keys so the
 * Anthropic escape-hatch registration (`mcp__cognia-tools__grep`) hits the
 * same card as the ai-sdk path's flat `grep`.
 */
export function normalizeToolName(toolName: string): string {
  const CORE_PREFIX = "mcp__cognia-tools__"
  return toolName.startsWith(CORE_PREFIX) ? toolName.slice(CORE_PREFIX.length) : toolName
}

export function isStructuredMcpToolType(type: string): boolean {
  if (!type.startsWith("tool-")) return false
  const toolName = normalizeToolName(type.slice("tool-".length))
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
  const toolName = normalizeToolName(type.slice("tool-".length))
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
