"use client"

/**
 * MCPToolCard — router that dispatches tool calls with known names to a
 * structured sub-renderer. Returns `null` when the tool isn't in the
 * registry OR the structured renderer rejects the payload — the caller
 * (message-renderer) then falls back to the generic `<Tool>` block.
 *
 * The recognised set covers:
 *  - cognia's MCP server: `wiki_search`, `wiki_read`, `rag_search`, `runtime_query`
 *  - Claude built-ins: `Read`, `Glob`, `Grep`, `WebFetch`, … and the plan-mode
 *    signal tools `exit_plan_mode` / `ExitPlanMode`
 *
 * Plugin-provided MCP tools fall back to the plugin tool-result registry
 * (`lib/plugin/api/tool-result-renderers.ts`) when the host table above misses
 * — that is the seam a plugin uses to render its own tool's result richly.
 * The host table is consulted FIRST, so a plugin can never shadow a built-in.
 */

import { useSyncExternalStore } from "react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import { ToolBody, type ToolPart } from "@/components/ai-elements/tool"
import { hasMcpContent } from "@/lib/claude/parts-extensions"
import {
  getToolResultRenderer,
  getToolResultRenderersRevision,
  subscribeToolResultRenderers,
} from "@/lib/plugin/api/tool-result-renderers"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { McpContentBlocksCard } from "./mcp-renderers/mcp-content-blocks-card"
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
import { SpawnTaskCard } from "./mcp-renderers/spawn-task-card"
import { WorkflowProposalCard } from "@/components/workflow/editor/chat/workflow-proposal-card"
import { ManagedMcpAppCard } from "@/components/mcp-apps/managed-mcp-app-card"

type CardComponent = (props: { part: ToolUIPart; sessionId?: string }) => React.JSX.Element | null

const REGISTRY: Record<string, CardComponent> = {
  // cognia external bridge
  wiki_search: WikiSearchCard,
  wiki_read: WikiReadCard,
  rag_search: RagSearchCard,
  runtime_query: RuntimeQueryCard,
  spawn_task: SpawnTaskCard,
  "mcp__cognia-plugin-tools__spawn_task": SpawnTaskCard,
  // Plan-mode signal tools. `exit_plan_mode` also covers the namespaced
  // cognia form (`mcp__cognia-tools__exit_plan_mode`) via normalizeToolName;
  // `ExitPlanMode` is the native Anthropic equivalent. Both carry the plan as
  // markdown in `input.plan`.
  exit_plan_mode: PlanCard,
  ExitPlanMode: PlanCard,
  // Claude built-ins
  Read: ReadCard,
  Glob: GlobCard,
  Grep: GrepCard,
  WebFetch: WebFetchCard,
  WebSearch: WebSearchCard,
  web_fetch: WebFetchCard,
  web_search: WebSearchCard,
  NotebookEdit: NotebookEditCard,
  // Sidecar coreFiles suite (ai-sdk path registers these flat-named; the
  // Anthropic escape hatch namespaces them — normalizeToolName folds both
  // onto these keys). read/glob/grep reuse the SDK-built-in cards (payload
  // shapes already tolerate path/file_path + string output).
  read: ReadCard,
  glob: GlobCard,
  grep: GrepCard,
  ls: LsCard,
  // Native Anthropic directory-listing tool is PascalCase `LS`; the card
  // tolerates the same newline-delimited string output as bare `ls`.
  LS: LsCard,
  edit: EditCard,
  multi_edit: EditCard,
  write: WriteCard,
  Edit: EditCard,
  MultiEdit: EditCard,
  Write: WriteCard,
  // Workflow Copilot — proposal card (wf_propose_batch + wf_apply_template
  // share the same payload shape: { proposalId, summary, opCount, ... }).
  // These are plugin tools: the ai-sdk path keys them bare, but the default
  // Anthropic path namespaces them `mcp__cognia-plugin-tools__*`. Register
  // both forms (like computer_use below) so the proposal card renders on
  // every provider instead of falling back to the generic tool body.
  wf_propose_batch: WorkflowProposalCard,
  wf_apply_template: WorkflowProposalCard,
  "mcp__cognia-plugin-tools__wf_propose_batch": WorkflowProposalCard,
  "mcp__cognia-plugin-tools__wf_apply_template": WorkflowProposalCard,
  // ADR-0020 — app-session Computer Use tools. Registered under both the bare
  // names and the cognia-plugin-tools-prefixed ones so both sidecar bridge
  // variants land on the same card.
  //
  // These replaced a single `computer_use` registration that had outlived its
  // tool: nothing produced that name any more, so every computer-use call fell
  // through to the generic JSON block, base64 screenshot and all.
  get_app_state: ComputerUseCard,
  list_apps: ComputerUseCard,
  query_elements: ComputerUseCard,
  expand_element: ComputerUseCard,
  perform_action: ComputerUseCard,
  zoom: ComputerUseCard,
  find_text: ComputerUseCard,
  click_text: ComputerUseCard,
  "mcp__cognia-plugin-tools__get_app_state": ComputerUseCard,
  "mcp__cognia-plugin-tools__list_apps": ComputerUseCard,
  "mcp__cognia-plugin-tools__query_elements": ComputerUseCard,
  "mcp__cognia-plugin-tools__expand_element": ComputerUseCard,
  "mcp__cognia-plugin-tools__perform_action": ComputerUseCard,
  "mcp__cognia-plugin-tools__zoom": ComputerUseCard,
  "mcp__cognia-plugin-tools__find_text": ComputerUseCard,
  "mcp__cognia-plugin-tools__click_text": ComputerUseCard,
}

/**
 * Cards that read `part.mcpContent` themselves. Every other card renders off
 * the flattened `output` string, so a result carrying real content blocks must
 * bypass it (see `McpCardWithFallback`) — otherwise the card silently drops the
 * image / resource it never knew to look for.
 */
const RICH_CONTENT_AWARE = new Set([
  "Read",
  "read",
  // The Computer Use frame IS an MCP image block now, so the card must be
  // allowed to see it rather than being bypassed for carrying rich content.
  "get_app_state",
  "zoom",
  "mcp__cognia-plugin-tools__get_app_state",
  "mcp__cognia-plugin-tools__zoom",
])

/**
 * Fold namespaced cognia-tools names onto their bare registry keys so the
 * Anthropic escape-hatch registration (`mcp__cognia-tools__grep`) hits the
 * same card as the ai-sdk path's flat `grep`.
 */
export function normalizeToolName(toolName: string): string {
  const prefixes = ["mcp__cognia-tools__", "mcp__cognia-plugin-tools__"]
  const prefix = prefixes.find((candidate) => toolName.startsWith(candidate))
  return prefix ? toolName.slice(prefix.length) : toolName
}

/**
 * Registry key for a part. `dynamic-tool` is the AI SDK's shape for a tool the
 * client didn't declare statically (imported transcripts, CLI handoff): the
 * name rides on `toolName` instead of the type suffix.
 */
export function toolNameOf(part: ToolPart): string | null {
  const type = part.type
  if (type === "dynamic-tool") {
    const name = (part as DynamicToolUIPart).toolName
    return typeof name === "string" && name ? normalizeToolName(name) : null
  }
  if (typeof type !== "string" || !type.startsWith("tool-")) return null
  return normalizeToolName(type.slice("tool-".length))
}

/**
 * True when this part's tool has a dedicated card — built-in OR contributed by
 * an enabled plugin.
 *
 * The plugin arm is load-bearing, not decorative: `message-renderer.tsx` uses
 * this predicate to decide whether a tool call routes to `MCPToolCard` at all.
 * Without it a plugin's registered card would sit in the registry and never be
 * reached, because the part would take the generic-tool branch first.
 */
export function isStructuredMcpToolPart(part: ToolPart): boolean {
  const toolName = toolNameOf(part)
  if (toolName === null) return false
  return toolName in REGISTRY || getToolResultRenderer(toolName) !== undefined
}

/**
 * Returns the structured card for known tools when the payload parses; falls
 * back to the generic ToolBody otherwise so the user always sees *something*.
 */
export function MCPToolCard({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  // Subscribed, not read once: a plugin enabled AFTER this message rendered
  // must repaint its tool cards. Reading the registry during render without
  // subscribing is the classic "registered but never appears" bug.
  usePluginToolResultRenderers()

  const toolName = toolNameOf(part)
  if (toolName === null) return <McpToolBodyOrContent part={part} sessionId={sessionId} />

  const Card = REGISTRY[toolName]
  if (Card) {
    // A result with structured blocks outranks any card that can't read them.
    if (hasMcpContent(part) && !RICH_CONTENT_AWARE.has(toolName)) {
      return <McpToolBodyOrContent part={part} sessionId={sessionId} />
    }
    // The cards read `input` / `output` / `mcpContent`, which both part shapes
    // carry; only the name lives in a different field, resolved above.
    return <McpCardWithFallback Card={Card} part={part as ToolUIPart} sessionId={sessionId} />
  }

  // No built-in card — offer the tool to the plugin registry before falling
  // back to the generic rendering. Checked AFTER the host table, so a plugin
  // cannot shadow `Read` / `Grep` / … no matter what name it registers.
  const pluginEntry = getToolResultRenderer(toolName)
  if (pluginEntry) {
    const PluginCard = pluginEntry.component
    // Plugin cards are treated as rich-content-aware: registering for a tool IS
    // the claim that you understand its payload, `mcpContent` included.
    //
    // Unlike the built-in `McpCardWithFallback`, the plugin card is rendered as
    // JSX rather than invoked as a function. Calling it would let us detect a
    // `null` return and fall back — but it also breaks the moment a plugin
    // exports a `memo()` / `forwardRef()` component, which `React.ComponentType`
    // explicitly permits. Supporting every component kind matters more than the
    // fallback, so a plugin that can't render a payload owns its empty state.
    return (
      <PluginSurface
        pluginId={pluginEntry.pluginId}
        surfaceId={`tool-renderer:${pluginEntry.toolName}`}
        formFactor="block"
      >
        <PluginCard part={part as ToolUIPart} sessionId={sessionId} />
      </PluginSurface>
    )
  }

  return <McpToolBodyOrContent part={part} sessionId={sessionId} />
}

/** Re-render this card whenever the plugin tool-result registry mutates. */
function usePluginToolResultRenderers(): number {
  return useSyncExternalStore(
    subscribeToolResultRenderers,
    getToolResultRenderersRevision,
    getToolResultRenderersRevision
  )
}

function McpCardWithFallback({
  Card,
  part,
  sessionId,
}: {
  Card: CardComponent
  part: ToolUIPart
  sessionId?: string
}) {
  const rendered = Card({ part, sessionId })
  if (rendered) return rendered
  return <McpToolBodyOrContent part={part} sessionId={sessionId} />
}

/**
 * Generic tool-result renderer (gap3). When the result preserved structured
 * MCP content blocks (image / resource / audio / text), render them richly;
 * otherwise fall back to the stringified ToolBody. This is the fallback for
 * any tool with no dedicated card — including arbitrary third-party MCP tools.
 */
export function McpToolBodyOrContent({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const namespacedToolName = toolNameOf(part)
  const app =
    sessionId && namespacedToolName?.startsWith("mcp__") ? (
      <ManagedMcpAppCard
        part={part as ToolUIPart}
        namespacedToolName={namespacedToolName}
        sessionId={sessionId}
        blocks={hasMcpContent(part) ? part.mcpContent : undefined}
      />
    ) : null
  return (
    <div className="space-y-3">
      {hasMcpContent(part) ? (
        <McpContentBlocksCard part={part as ToolUIPart} blocks={part.mcpContent} />
      ) : (
        <ToolBody part={part} />
      )}
      {app}
    </div>
  )
}

export default MCPToolCard
