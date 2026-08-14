// Unified tool catalog — a single searchable view over every tool/MCP source
// the agent can be granted. Aggregates five sources:
//
//   1. builtin  — the in-process `cognia-tools` MCP server (category-toggled),
//                 from `lib/settings/builtin-tools.ts`.
//   2. mcp      — user-configured MCP servers (server granularity: an MCP
//                 server's tool list is only known at connect time, so the
//                 filterable unit is the server — matching `Character.mcpServerIds`).
//   3. plugin   — tools contributed by enabled plugins (surfaced to the SDK
//                 via the synthetic `cognia-plugin-tools` server).
//   4. native-anthropic — plugin-contributed first-party Anthropic tools
//                 (computer/bash/text_editor) from the overlay registry.
//   5. sdk-native — tools the Claude Agent SDK provides itself (Read/Bash/
//                 Task/EnterWorktree/…). Not registered at runtime, so they
//                 must be enumerated; without them the filtering UI presented
//                 an inventory that silently omitted the SDK's own tools.
//
// This is the data layer behind the tool-search / filtering UI and behind the
// `resolveSendOptions` filtering step. It is i18n-agnostic: builtin entries
// carry an i18n `descriptionKey` (resolved by the UI under `toolSettings.*`);
// every other source carries a raw `description`. Search therefore matches
// name + raw description + server name (builtin descriptions live in i18n, so
// builtins are matched by their self-descriptive names).

import {
  BUILTIN_SERVER_NAME,
  BUILTIN_TOOL_CATEGORIES,
  namespaced as namespacedBuiltin,
} from "@/lib/settings/builtin-tools"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { usePluginStore } from "@/stores/plugin-runtime"
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { SDK_CORE_TOOL_NAMES } from "@/lib/skills/recording/tool-catalog"
import type { AnthropicNativeToolType } from "@/types/plugin/plugin-native-tool"

export type ToolSource = "builtin" | "mcp" | "plugin" | "native-anthropic" | "sdk-native"

export type ToolRiskLevel = "low" | "medium" | "high"

export interface ToolCatalogEntry {
  /**
   * Stable, SDK-namespaced identifier. For builtin/plugin tools this is the
   * `mcp__<server>__<tool>` form the SDK exposes (and the form
   * `Character.allowedTools` / `disallowedTools` use). For MCP servers it is
   * the server id; for native tools the registry id.
   */
  id: string
  /** Bare tool (or server) name as shown to the model / user. */
  name: string
  source: ToolSource
  /** Raw human-readable description. Empty for builtins (see `descriptionKey`). */
  description: string
  /** i18n key under `toolSettings.*` for builtin tools; undefined otherwise. */
  descriptionKey?: string
  /** Owning MCP server id (mcp) or plugin id (plugin / native-anthropic). */
  ownerId?: string
  /** Human-readable owner label (server name / plugin server name). */
  ownerName?: string
  riskLevel?: ToolRiskLevel
  requiresApproval?: boolean
  /**
   * Mirror of the SDK `alwaysLoad` flag — when true the tool/server is never
   * deferred behind tool search. Drives the runtime-ToolSearch always-load set.
   */
  alwaysLoad?: boolean
  /**
   * Whether the source is currently active (MCP server enabled / plugin
   * enabled). Builtin + native entries are always considered available; the
   * per-category builtin toggle is a separate concern.
   */
  enabled: boolean
}

export interface ToolCatalogFilters {
  /** Restrict to these sources. Empty/undefined = all sources. */
  sources?: ToolSource[]
  /** Restrict to these risk levels. Empty/undefined = all. */
  riskLevels?: ToolRiskLevel[]
  /** "enabled" / "disabled" / undefined (= any). */
  status?: "enabled" | "disabled"
}

/** Bare-name → namespaced id for the synthetic plugin-tools server. */
export const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

export function namespacedPluginTool(toolName: string): string {
  return `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${toolName}`
}

/** Default human-readable label for an Anthropic native tool type. */
function nativeToolDescription(type: AnthropicNativeToolType): string {
  switch (type) {
    case "computer_20251124":
      return "Anthropic computer-use tool (screenshots, mouse, keyboard)."
    case "bash_20250124":
      return "Anthropic bash tool (run shell commands)."
    case "text_editor_20250728":
      return "Anthropic text-editor tool (view/create/edit files)."
  }
}

/** Pure: build catalog entries for the builtin `cognia-tools` server. */
export function buildBuiltinCatalogEntries(): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = []
  for (const category of BUILTIN_TOOL_CATEGORIES) {
    for (const tool of category.tools) {
      entries.push({
        id: namespacedBuiltin(tool.name),
        name: tool.name,
        source: "builtin",
        description: "",
        descriptionKey: tool.descriptionKey,
        ownerName: BUILTIN_SERVER_NAME,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        alwaysLoad: tool.alwaysLoad,
        enabled: true,
      })
    }
  }
  return entries
}

/** Pure: build catalog entries (one per server) for user MCP servers. */
export function buildMcpCatalogEntries(
  servers: Awaited<ReturnType<typeof listMcpServers>>
): ToolCatalogEntry[] {
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    source: "mcp" as const,
    description: `MCP server (${s.transport})${s.pluginId ? " — plugin-provided" : ""}`,
    ownerId: s.id,
    ownerName: s.name,
    enabled: s.enabled,
  }))
}

/** Pure: build catalog entries from the live plugin store snapshot. */
export function buildPluginCatalogEntries(
  plugins: ReturnType<typeof usePluginStore.getState>["plugins"]
): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = []
  for (const plugin of Object.values(plugins)) {
    if (!plugin.tools?.length) continue
    const enabled = plugin.status === "enabled"
    for (const tool of plugin.tools) {
      entries.push({
        id: namespacedPluginTool(tool.name),
        name: tool.name,
        source: "plugin",
        description: tool.definition.description ?? "",
        ownerId: plugin.manifest.id,
        ownerName: plugin.manifest.id,
        enabled,
      })
    }
  }
  return entries
}

/** Pure: build catalog entries from the native-anthropic overlay registry. */
export function buildNativeCatalogEntries(
  registryEntries: ReturnType<typeof listNativeAnthropicToolEntries>
): ToolCatalogEntry[] {
  return registryEntries.map((e) => ({
    id: e.entry.id,
    name: e.entry.name,
    source: "native-anthropic" as const,
    description: nativeToolDescription(e.entry.type),
    ownerId: e.pluginId,
    ownerName: e.pluginId,
    requiresApproval: (e.entry.permissionPolicy ?? "always-ask") !== "preauth",
    enabled: true,
  }))
}

/**
 * Pure: build catalog entries for the tools the Claude Agent SDK provides
 * itself (`Read`, `Bash`, `Task`, `EnterWorktree`, `TaskStop`, …).
 *
 * These are NOT registered anywhere at runtime — the SDK owns them — so they
 * were absent from a catalog the filtering UI presents as the complete tool
 * inventory. In allow-mode, `resolveSendOptions` rebuilds `allowedTools` from
 * that catalog, so a user scoping an agent could neither see nor grant the
 * SDK's own tools. Sourced from `SDK_CORE_TOOL_NAMES`, whose docblock records
 * why that list is a floor rather than a complete roster.
 *
 * Bare names (not `mcp__`-namespaced) because that is how the SDK exposes them
 * and how `Character.allowedTools` must spell them.
 */
export function buildSdkNativeCatalogEntries(): ToolCatalogEntry[] {
  return SDK_CORE_TOOL_NAMES.map((name) => ({
    id: name,
    name,
    source: "sdk-native" as const,
    description: "",
    ownerName: "Claude Agent SDK",
    enabled: true,
  }))
}

/**
 * Aggregate every source into a single catalog. Best-effort: a failing source
 * (e.g. Dexie unavailable in SSR) contributes nothing rather than throwing.
 */
export async function getToolCatalog(): Promise<ToolCatalogEntry[]> {
  const out: ToolCatalogEntry[] = []
  out.push(...buildBuiltinCatalogEntries())
  out.push(...buildSdkNativeCatalogEntries())
  try {
    out.push(...buildMcpCatalogEntries(await listMcpServers()))
  } catch {
    // Dexie not available (SSR/web edge) — skip MCP servers.
  }
  try {
    out.push(...buildPluginCatalogEntries(usePluginStore.getState().plugins))
  } catch {
    // Plugin store not initialised — skip plugin tools.
  }
  try {
    out.push(...buildNativeCatalogEntries(listNativeAnthropicToolEntries()))
  } catch {
    // Registry not ready — skip native tools.
  }
  return out
}

/**
 * Pure: filter + free-text search over a catalog. Matches `query` (case-
 * insensitive substring) against the tool name, raw description, and owner
 * name. Empty query = no text filter. Filters compose with AND.
 */
export function searchToolCatalog(
  entries: ToolCatalogEntry[],
  query: string,
  filters: ToolCatalogFilters = {}
): ToolCatalogEntry[] {
  const q = query.trim().toLowerCase()
  const sources = filters.sources && filters.sources.length > 0 ? new Set(filters.sources) : null
  const risks =
    filters.riskLevels && filters.riskLevels.length > 0 ? new Set(filters.riskLevels) : null

  return entries.filter((e) => {
    if (sources && !sources.has(e.source)) return false
    if (risks && (!e.riskLevel || !risks.has(e.riskLevel))) return false
    if (filters.status === "enabled" && !e.enabled) return false
    if (filters.status === "disabled" && e.enabled) return false
    if (q) {
      const haystack = `${e.name}\n${e.description}\n${e.ownerName ?? ""}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}
