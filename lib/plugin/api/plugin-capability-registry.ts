/**
 * Plugin capability enumeration — "what can plugin X do?" as one query.
 *
 * Contributions are scattered across the manager registry (tools / commands
 * / modes) and the per-domain overlay registries (skills, MCP presets,
 * workflow templates, subagents) plus the workflow node catalog and trigger
 * registry. Until now every consumer (inspector forms, settings panels,
 * quick menus) had to stitch those sources together by hand. This module
 * aggregates them into a uniform, typed {@link PluginCapabilities} bucket
 * per plugin.
 *
 * Named `plugin-capability-registry` (not `capabilities-api`) because
 * `lib/plugin/api/capabilities-api.ts` already holds the platform-flags
 * `ctx.capabilities` API.
 *
 * The workflow catalog / trigger registry and the plugin manager are
 * reached through lazy dynamic imports so importing this module from
 * non-workflow surfaces doesn't drag the whole workflow subsystem (or the
 * manager singleton) into their bundles — the same pattern as
 * `lib/plugin/core/invoke-plugin-tool.ts`.
 */

import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { PluginCommand, PluginTool } from "@/types/plugin"

import { listMcpServerPresetEntries } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listSkillEntries } from "@/lib/plugin/registries/skill-registry"
import { listSubagentEntries } from "@/lib/plugin/registries/subagent-registry"
import { listWorkflowTemplateEntries } from "@/lib/plugin/registries/workflow-template-registry"

export type PluginCapabilityKind =
  | "tool"
  | "command"
  | "mode"
  | "workflow-node"
  | "workflow-trigger"
  | "workflow-template"
  | "skill"
  | "mcp-preset"
  | "subagent"

export interface PluginCapability {
  kind: PluginCapabilityKind
  /** Tool name / command id / node kind / template id / … */
  id: string
  label: string
  description?: string
  /** Tool + workflow-node only: JSON schema describing the args/params. */
  argsSchema?: Record<string, unknown>
}

export interface PluginCapabilities {
  pluginId: string
  enabled: boolean
  tools: PluginCapability[]
  commands: PluginCapability[]
  modes: PluginCapability[]
  workflowNodes: PluginCapability[]
  workflowTriggers: PluginCapability[]
  workflowTemplates: PluginCapability[]
  skills: PluginCapability[]
  mcpPresets: PluginCapability[]
  subagents: PluginCapability[]
}

/**
 * Narrow view of the manager-backed sources. Injectable so jsdom tests can
 * run without the plugin-manager singleton; overlay registries are used
 * directly (they work standalone).
 */
export interface PluginCapabilityDeps {
  getRegistry: () => {
    getToolsByPlugin: (pluginId: string) => PluginTool[]
    getCommandsByPlugin: (pluginId: string) => PluginCommand[]
    getModesByPlugin: (pluginId: string) => AgentModeConfig[]
  }
  listPlugins: () => Array<{ id: string; status: string }>
}

let depsOverride: PluginCapabilityDeps | null = null

/** Test-only deps injection. Pass `null` to restore the defaults. */
export function __setPluginCapabilityDepsForTesting(deps: PluginCapabilityDeps | null): void {
  depsOverride = deps
}

async function defaultDeps(): Promise<PluginCapabilityDeps> {
  const [{ getPluginManager }, { usePluginStore }] = await Promise.all([
    import("@/lib/plugin/core/manager"),
    import("@/stores/plugin-runtime/plugin-store"),
  ])
  return {
    getRegistry: () => getPluginManager().getRegistry(),
    listPlugins: () =>
      Object.values(usePluginStore.getState().plugins).map((p) => ({
        id: p.manifest.id,
        status: p.status,
      })),
  }
}

function safeRegistry(
  deps: PluginCapabilityDeps
): ReturnType<PluginCapabilityDeps["getRegistry"]> | null {
  try {
    return deps.getRegistry()
  } catch {
    // Manager not initialised (early boot, headless test) — manager-backed
    // buckets degrade to empty; overlay-registry buckets still resolve.
    return null
  }
}

/** Enumerate every contribution `pluginId` currently has registered. */
export async function getPluginCapabilities(pluginId: string): Promise<PluginCapabilities> {
  const deps = depsOverride ?? (await defaultDeps())
  const registry = safeRegistry(deps)

  const tools: PluginCapability[] = (registry?.getToolsByPlugin(pluginId) ?? []).map((tool) => ({
    kind: "tool",
    id: tool.name,
    label: tool.name,
    description: tool.definition.description,
    argsSchema: tool.definition.parametersSchema,
  }))

  const commands: PluginCapability[] = (registry?.getCommandsByPlugin(pluginId) ?? []).map(
    (cmd) => ({
      kind: "command",
      id: cmd.id,
      label: cmd.name,
      description: cmd.description,
    })
  )

  const modes: PluginCapability[] = (registry?.getModesByPlugin(pluginId) ?? []).map((mode) => ({
    kind: "mode",
    id: mode.id,
    label: mode.name,
    description: mode.description,
  }))

  // Workflow sources — lazy so non-workflow bundles stay slim.
  const [{ getPluginCatalogSnapshot }, { listPluginTriggers }] = await Promise.all([
    import("@/lib/workflow/nodes/catalog"),
    import("@/lib/workflow/triggers/registry"),
  ])

  const workflowNodes: PluginCapability[] = getPluginCatalogSnapshot()
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => ({
      kind: "workflow-node",
      id: entry.kind,
      label: entry.label,
      description: entry.description,
      argsSchema: entry.paramsSchema,
    }))

  const workflowTriggers: PluginCapability[] = listPluginTriggers()
    .filter((reg) => reg.pluginId === pluginId)
    .map((reg) => ({
      kind: "workflow-trigger",
      id: reg.kind,
      label: reg.def.label,
      description: reg.def.description,
    }))

  const workflowTemplates: PluginCapability[] = listWorkflowTemplateEntries()
    .filter((e) => e.pluginId === pluginId)
    .map((e) => ({
      kind: "workflow-template",
      id: e.id,
      label: e.entry.name,
      description: e.entry.description,
    }))

  const skills: PluginCapability[] = listSkillEntries()
    .filter((e) => e.pluginId === pluginId)
    .map((e) => ({
      kind: "skill",
      id: e.id,
      label: e.entry.name,
      description: e.entry.description,
    }))

  const mcpPresets: PluginCapability[] = listMcpServerPresetEntries()
    .filter((e) => e.pluginId === pluginId)
    .map((e) => ({
      kind: "mcp-preset",
      id: e.id,
      label: e.entry.name,
      description: e.entry.description,
    }))

  const subagents: PluginCapability[] = listSubagentEntries()
    .filter((e) => e.pluginId === pluginId)
    .map((e) => ({
      kind: "subagent",
      id: e.id,
      label: e.entry.name,
      description: e.entry.description,
    }))

  return {
    pluginId,
    enabled: deps.listPlugins().some((p) => p.id === pluginId && p.status === "enabled"),
    tools,
    commands,
    modes,
    workflowNodes,
    workflowTriggers,
    workflowTemplates,
    skills,
    mcpPresets,
    subagents,
  }
}

/**
 * Enumerate capabilities for every plugin the host knows about — the union
 * of manager-tracked plugins and any pluginId tagged in the overlay
 * registries (covers contributions registered before the store hydrates).
 */
export async function listPluginCapabilities(): Promise<PluginCapabilities[]> {
  const deps = depsOverride ?? (await defaultDeps())
  const ids = new Set<string>()
  for (const plugin of deps.listPlugins()) ids.add(plugin.id)
  for (const e of listSkillEntries()) if (e.pluginId) ids.add(e.pluginId)
  for (const e of listMcpServerPresetEntries()) if (e.pluginId) ids.add(e.pluginId)
  for (const e of listWorkflowTemplateEntries()) if (e.pluginId) ids.add(e.pluginId)
  for (const e of listSubagentEntries()) if (e.pluginId) ids.add(e.pluginId)

  return Promise.all([...ids].sort().map((id) => getPluginCapabilities(id)))
}
