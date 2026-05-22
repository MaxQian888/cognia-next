/**
 * Agent Team Template Registry — dynamic overlay for plugin-contributed
 * complete team blueprints.
 *
 * Plugins shipping the `agent-team-template` capability call
 * `registerAgentTeamTemplate` on enable through the
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the plugin manager calls
 * `unregisterAgentTeamTemplatesByPlugin(pluginId)` to drop every template
 * the plugin contributed in a single shot.
 *
 * Per-template `requires` validation mirrors the ADR-0030 character-pack
 * pattern: missing cross-capability dependencies become non-blocking
 * warnings stamped on the registry entry. The UI (`agent-team-templates-section`)
 * reads them via `getTemplateWarnings(templateId)` and surfaces them as
 * disabled badges + "install missing plugin" hints. Refresh hooks rerun
 * validation when sibling overlay registries mutate so a template clears
 * its missing-dep state once the dependency arrives.
 */

import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
import { createOverlayRegistry } from "./createOverlayRegistry"
import { listSkillIds } from "./skill-registry"
import { listMcpServerPresetIds } from "./mcp-server-preset-registry"
import { listNativeAnthropicToolIds } from "./native-anthropic-tool-registry"
import { listCharacterPackIds } from "./character-pack-registry"
import { listSubagentEntries } from "./subagent-registry"
import { getAvailablePresets } from "@/lib/ai/agent/external/presets"

/**
 * Built-in subagent dispatcher names always available in the team runtime.
 * Kept in sync with `lib/claude/agents/subagents/index.ts:workflowEditorSubagents`.
 */
const BUILT_IN_SUBAGENT_IDS: readonly string[] = [
  "workflow-designer",
  "workflow-debugger",
  "workflow-refactorer",
  "workflow-doc-writer",
]

export type PluginAgentTeamTemplateWarningCode =
  | "missing-mcp-preset"
  | "missing-skill"
  | "missing-character-pack"
  | "missing-native-tool"
  | "missing-external-agent-preset"
  | "missing-subagent"

export interface PluginAgentTeamTemplateWarning {
  /** Stable id used to dedupe warnings on the UI. */
  code: PluginAgentTeamTemplateWarningCode
  /** The id we couldn't resolve. */
  missingId: string
}

export interface AgentTeamTemplateValidationResult {
  warnings: PluginAgentTeamTemplateWarning[]
  /** True when nothing's missing. */
  ok: boolean
}

const registry = createOverlayRegistry<PluginAgentTeamTemplateDef>({
  name: "agent-team-template",
})

/**
 * Sidecar map keyed by template id, storing `requires`-validation warnings
 * collected at register time. Kept separate from the overlay registry's
 * Map so the warning surface can be cleared / refreshed without
 * unregistering the template itself.
 */
const warningsByTemplateId = new Map<string, readonly PluginAgentTeamTemplateWarning[]>()

/**
 * Resolve a plugin subagent id (bare `<id>` or namespaced `<pluginId>:<id>`).
 * Returns true if either the built-in list or the overlay registry contains
 * a matching entry.
 */
function subagentIdExists(id: string): boolean {
  if (BUILT_IN_SUBAGENT_IDS.includes(id)) return true
  for (const entry of listSubagentEntries()) {
    if (entry.id === id) return true
    if (entry.pluginId && `${entry.pluginId}:${entry.id}` === id) return true
  }
  return false
}

/**
 * Inspect a template's declared dependencies and return the missing ids.
 * Mirrors `validatePackRequires` for character-packs.
 */
export function validateTemplateRequires(
  template: PluginAgentTeamTemplateDef
): AgentTeamTemplateValidationResult {
  const warnings: PluginAgentTeamTemplateWarning[] = []
  const requires = template.requires
  if (!requires) {
    return { warnings, ok: true }
  }

  const skillIds = new Set(listSkillIds())
  const mcpIds = new Set(listMcpServerPresetIds())
  const nativeToolIds = new Set(listNativeAnthropicToolIds())
  const characterPackIds = new Set(listCharacterPackIds())
  const externalPresetIds = new Set(getAvailablePresets())

  for (const id of requires.mcpServerPresetIds ?? []) {
    if (!mcpIds.has(id)) warnings.push({ code: "missing-mcp-preset", missingId: id })
  }
  for (const id of requires.skillIds ?? []) {
    if (!skillIds.has(id)) warnings.push({ code: "missing-skill", missingId: id })
  }
  for (const id of requires.characterPackIds ?? []) {
    if (!characterPackIds.has(id)) warnings.push({ code: "missing-character-pack", missingId: id })
  }
  for (const id of requires.nativeAnthropicToolIds ?? []) {
    if (!nativeToolIds.has(id)) warnings.push({ code: "missing-native-tool", missingId: id })
  }
  for (const id of requires.externalAgentPresetIds ?? []) {
    if (!externalPresetIds.has(id))
      warnings.push({ code: "missing-external-agent-preset", missingId: id })
  }
  for (const id of requires.subagentIds ?? []) {
    if (!subagentIdExists(id)) warnings.push({ code: "missing-subagent", missingId: id })
  }

  return { warnings, ok: warnings.length === 0 }
}

/**
 * Register a plugin-contributed agent team template and stamp `requires`
 * warnings. Warnings are non-blocking — the template is registered
 * regardless; consumers read the warnings via `getTemplateWarnings(id)`
 * and surface them as chips on the affected rows.
 */
export function registerAgentTeamTemplate(
  id: string,
  template: PluginAgentTeamTemplateDef,
  opts?: { pluginId?: string }
): { entry: PluginAgentTeamTemplateDef; pluginId?: string } | undefined {
  const previous = registry.register(id, template, opts)
  const result = validateTemplateRequires(template)
  if (result.warnings.length > 0) {
    warningsByTemplateId.set(id, Object.freeze(result.warnings))
  } else {
    warningsByTemplateId.delete(id)
  }
  return previous
}

/**
 * Re-run `requires` validation for every registered template. Called when
 * sibling overlay registries (skill / mcp / native-tool / character-pack /
 * subagent) mutate so a template that previously had a missing-dep
 * warning clears it once the dependency arrives.
 */
export function refreshAllTemplateWarnings(): void {
  for (const { id, entry } of registry.entries()) {
    const result = validateTemplateRequires(entry)
    if (result.warnings.length > 0) {
      warningsByTemplateId.set(id, Object.freeze(result.warnings))
    } else {
      warningsByTemplateId.delete(id)
    }
  }
}

/** Drop a single dynamically-registered template by id. */
export function unregisterAgentTeamTemplateById(id: string): boolean {
  warningsByTemplateId.delete(id)
  return registry.unregisterById(id)
}

/**
 * Drop every template contributed by `pluginId`. Returns the number
 * removed.
 */
export function unregisterAgentTeamTemplatesByPlugin(pluginId: string): number {
  for (const { id, pluginId: tag } of registry.entries()) {
    if (tag === pluginId) warningsByTemplateId.delete(id)
  }
  return registry.unregisterByPlugin(pluginId)
}

/** Get a template by id. Returns undefined when not registered. */
export const getAgentTeamTemplate = registry.get
/** Get the full registry entry (template + pluginId tag) for an id. */
export const getAgentTeamTemplateEntry = registry.getEntry
/** List every registered template id in registration order. */
export const listAgentTeamTemplateIds = registry.list
/**
 * List every registered entry (id + template + pluginId) in registration
 * order. This is the snapshot consumed by `agent-team-templates-section`
 * and `validateTemplateRequires` callers.
 */
export const listAgentTeamTemplateEntries = registry.entries

/**
 * Return the warnings collected at register time for a template. Returns
 * an empty array (not undefined) for clean templates so consumers can
 * map without null checks.
 */
export function getTemplateWarnings(templateId: string): readonly PluginAgentTeamTemplateWarning[] {
  return warningsByTemplateId.get(templateId) ?? []
}

/** Test-only: clear every dynamically registered template and its warnings. */
export function __resetAgentTeamTemplatesForTesting(): void {
  warningsByTemplateId.clear()
  registry.__resetForTesting()
}
