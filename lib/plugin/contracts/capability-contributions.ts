// Capability → contribution mapping for the plugin management UI.
//
// A plugin's `capabilities[]` is just a tag set ("tools", "skills", "themes"…).
// The actual contributed entries live on dedicated manifest fields
// (`manifest.tools`, `manifest.skills`, `manifest.themes`…). This module
// resolves each capability tag into the concrete entries the plugin
// contributes for it, so the library row + detail header can show
// "4 tools · 2 skills · 1 theme" instead of bare tag chips.

import type { PluginCapability } from "@/types/plugin"

export interface CapabilityEntry {
  /** Stable identifier for the contributed entry. */
  id: string
  /** Display label — falls back to id if the manifest entry has no name. */
  label?: string
}

export interface CapabilityContribution {
  capability: PluginCapability | string
  entries: CapabilityEntry[]
  count: number
}

interface ContributionManifestShape {
  tools?: Array<{ id?: string; name?: string }>
  nativeAnthropicTools?: Array<{ name?: string; type?: string }>
  skills?: Array<{ id?: string; name?: string }>
  modes?: Array<{ id?: string; name?: string }>
  commands?: Array<{ id?: string; name?: string }>
  themes?: Array<{ id?: string; name?: string }>
  themePacks?: Array<{ id?: string; name?: string }>
  fonts?: Array<{ id?: string; family?: string; name?: string }>
  wallpapers?: Array<{ id?: string; name?: string }>
  densityPresets?: Array<{ id?: string; name?: string }>
  mcpServerPresets?: Array<{ id?: string; name?: string }>
  externalAgentPresets?: Array<{ id?: string; name?: string }>
  externalAgentAdapters?: Array<{ id?: string; label?: string }>
  ocrProviders?: Array<{ id?: string; name?: string }>
  aiProviders?: Array<{ id?: string; name?: string }>
  workspaceBackends?: Array<{ id?: string; label?: string; name?: string }>
  messageRenderers?: Array<{ partType?: string; id?: string; label?: string; name?: string }>
  modalMounts?: Array<{ id?: string; label?: string; name?: string }>
  terminalCompletionProviders?: Array<{ id?: string; label?: string; name?: string }>
  routingStrategies?: Array<{ id?: string; label?: string; name?: string }>
  deploymentFilters?: Array<{ id?: string; label?: string; name?: string }>
  protocolAdapters?: Array<{ id?: string; label?: string; name?: string }>
  toolRoutes?: Array<{ toolName?: string }>
  contextProviders?: Array<{ id?: string; label?: string; name?: string }>
  viewsContainers?: Array<{ id?: string; title?: string }>
  views?: Array<{ id?: string; title?: string }>
  webviews?: Array<{ id?: string; title?: string }>
  authProviders?: Array<{ id?: string; label?: string }>
  chatMiddlewares?: Array<{ id?: string; name?: string }>
  connectors?: Array<{ id?: string; name?: string; adapter?: string }>
  lspServers?: Array<{ id?: string; name?: string; language?: string }>
  a2uiComponents?: Array<{ id?: string; name?: string }>
  a2uiTemplates?: Array<{ id?: string; name?: string }>
  scheduledTasks?: Array<{ name?: string }>
  characterPacks?: Array<{ id?: string; name?: string }>
  subagents?: Array<{ id?: string; name?: string }>
  agentTeamTemplates?: Array<{ id?: string; name?: string }>
  sharedMemoryAdapters?: Array<{ id?: string; name?: string }>
  balanceAdapters?: Array<{ id?: string; name?: string; key?: string }>
  limitsSources?: Array<{ id?: string; name?: string; key?: string }>
  compactionStrategies?: Array<{ id?: string; label?: string }>
  workflowTemplates?: Array<{ id?: string; name?: string }>
  quickActions?: Array<{ id?: string; title?: string }>
  cliTools?: Array<{ id?: string; name?: string }>
  workflows?: {
    nodeExecutors?: Array<{ id?: string; name?: string }>
    triggers?: Array<{ id?: string; name?: string }>
  }
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function entry(id: string | undefined, label?: string): CapabilityEntry | null {
  if (!id) return null
  return label && label !== id ? { id, label } : { id }
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((v): v is T => v !== null)
}

/**
 * Return the concrete entries this plugin contributes for a single capability
 * tag. Unknown capabilities (or capabilities whose manifest field isn't yet
 * mapped) return an empty array — callers should treat that as "no rich data
 * available" rather than an error.
 */
export function getContributionsForCapability(
  manifest: unknown,
  capability: PluginCapability | string
): CapabilityEntry[] {
  const m = (manifest ?? {}) as ContributionManifestShape
  switch (capability) {
    case "tools":
      return compact(asArray(m.tools).map((t) => entry(t.id, t.name)))
    case "native-anthropic-tool":
      return compact(asArray(m.nativeAnthropicTools).map((t) => entry(t.name ?? t.type, t.type)))
    case "skills":
      return compact(asArray(m.skills).map((s) => entry(s.id, s.name)))
    case "modes":
      return compact(asArray(m.modes).map((s) => entry(s.id, s.name)))
    case "commands":
      return compact(asArray(m.commands).map((s) => entry(s.id, s.name)))
    case "themes":
      return compact(asArray(m.themes).map((s) => entry(s.id, s.name)))
    case "theme-pack":
      return compact(asArray(m.themePacks).map((s) => entry(s.id, s.name)))
    case "fonts":
      // Font contributions are keyed by `family` (no `id` field).
      return compact(asArray(m.fonts).map((s) => entry(s.family ?? s.name, s.family ?? s.name)))
    case "wallpapers":
      return compact(asArray(m.wallpapers).map((s) => entry(s.id, s.name)))
    case "mcp-server-preset":
      return compact(asArray(m.mcpServerPresets).map((s) => entry(s.id, s.name)))
    case "external-agent-preset":
      return compact(asArray(m.externalAgentPresets).map((s) => entry(s.id, s.name)))
    case "external-agent-adapter":
      // Adapters carry `label` (not `name`), mirroring authProviders/compactionStrategies.
      return compact(asArray(m.externalAgentAdapters).map((s) => entry(s.id, s.label)))
    case "ai-provider":
    case "providers":
      return compact(asArray(m.aiProviders).map((s) => entry(s.id, s.name)))
    case "media":
      // OCR providers are the most common media contribution surface.
      return compact(asArray(m.ocrProviders).map((s) => entry(s.id, s.name)))
    case "workspace-backend":
      return compact(asArray(m.workspaceBackends).map((s) => entry(s.id, s.label ?? s.name)))
    case "message-renderer":
      return compact(
        asArray(m.messageRenderers).map((s) => entry(s.partType ?? s.id, s.label ?? s.name))
      )
    case "density-preset":
      return compact(asArray(m.densityPresets).map((s) => entry(s.name ?? s.id, s.name)))
    case "modal-mount":
      return compact(asArray(m.modalMounts).map((s) => entry(s.id, s.label ?? s.name)))
    case "terminal-completion":
      return compact(
        asArray(m.terminalCompletionProviders).map((s) => entry(s.id, s.label ?? s.name))
      )
    case "routing-strategy":
      return compact(asArray(m.routingStrategies).map((s) => entry(s.id, s.label ?? s.name)))
    case "deployment-filter":
      return compact(asArray(m.deploymentFilters).map((s) => entry(s.id, s.label ?? s.name)))
    case "protocol-adapter":
      return compact(asArray(m.protocolAdapters).map((s) => entry(s.id, s.label ?? s.name)))
    case "tool-route":
      return compact(asArray(m.toolRoutes).map((s) => entry(s.toolName, s.toolName)))
    case "context-provider":
      return compact(asArray(m.contextProviders).map((s) => entry(s.id, s.label ?? s.name)))
    case "connectors":
      return compact(asArray(m.connectors).map((s) => entry(s.id, s.name ?? s.adapter)))
    case "lsp-server":
      return compact(asArray(m.lspServers).map((s) => entry(s.id, s.name ?? s.language)))
    case "a2ui":
    case "components":
      return compact(asArray(m.a2uiComponents).map((s) => entry(s.id, s.name)))
    case "scheduler":
      // Scheduled tasks are keyed by `name` (no `id` field).
      return compact(asArray(m.scheduledTasks).map((s) => entry(s.name, s.name)))
    case "workflow":
      return compact(asArray(m.workflows?.nodeExecutors).map((s) => entry(s.id, s.name)))
    case "workflow-trigger":
      return compact(asArray(m.workflows?.triggers).map((s) => entry(s.id, s.name)))
    case "character-pack":
      return compact(asArray(m.characterPacks).map((s) => entry(s.id, s.name)))
    case "subagent":
      return compact(asArray(m.subagents).map((s) => entry(s.id, s.name)))
    case "agent-team-template":
      return compact(asArray(m.agentTeamTemplates).map((s) => entry(s.id, s.name)))
    case "shared-memory-adapter":
      return compact(asArray(m.sharedMemoryAdapters).map((s) => entry(s.id, s.name)))
    case "balance-adapter":
      return compact(asArray(m.balanceAdapters).map((s) => entry(s.id, s.name ?? s.key)))
    case "limits-source":
      return compact(asArray(m.limitsSources).map((s) => entry(s.id, s.name ?? s.key)))
    case "compaction-strategy":
      return compact(asArray(m.compactionStrategies).map((s) => entry(s.id, s.label)))
    case "workflow-template":
      return compact(asArray(m.workflowTemplates).map((s) => entry(s.id, s.name)))
    case "quick-action":
      return compact(asArray(m.quickActions).map((s) => entry(s.id, s.title)))
    case "cli-tools":
      return compact(asArray(m.cliTools).map((s) => entry(s.id, s.name)))
    case "chat-middleware":
      return compact(asArray(m.chatMiddlewares).map((s) => entry(s.id, s.name)))
    case "view-container":
      return compact(asArray(m.viewsContainers).map((s) => entry(s.id, s.title)))
    case "tree-view":
      return compact(asArray(m.views).map((s) => entry(s.id, s.title)))
    case "webview":
      return compact(asArray(m.webviews).map((s) => entry(s.id, s.title)))
    case "auth-provider":
      return compact(asArray(m.authProviders).map((s) => entry(s.id, s.label)))
    default:
      return []
  }
}

/**
 * Resolve every capability tag the plugin declares into its contribution
 * entries. Preserves the order of `capabilities[]` so the UI can render
 * predictable summaries like "4 tools · 2 skills · 1 theme".
 */
export function getAllContributions(
  capabilities: ReadonlyArray<PluginCapability | string>,
  manifest: unknown
): CapabilityContribution[] {
  return capabilities.map((capability) => {
    const entries = getContributionsForCapability(manifest, capability)
    return { capability, entries, count: entries.length }
  })
}
