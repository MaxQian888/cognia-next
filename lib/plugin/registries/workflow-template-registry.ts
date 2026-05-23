/**
 * Workflow Template Registry — dynamic overlay for plugin-contributed visual
 * workflow blueprints (ADR-0032 parity for the Visual Workflows subsystem).
 *
 * Plugins shipping the `workflow-template` capability call
 * `registerWorkflowTemplate` on enable via the `OVERLAY_REGISTRY_CAPABILITIES`
 * dispatch loop, and `unregisterWorkflowTemplatesByPlugin` on disable. Per-
 * template `requires` validation mirrors `agent-team-template-registry`:
 * missing cross-capability dependencies become non-blocking warnings the
 * Settings UI surfaces.
 */

import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
import { createOverlayRegistry } from "./createOverlayRegistry"
import { listSkillIds } from "./skill-registry"
import { listMcpServerPresetIds } from "./mcp-server-preset-registry"
import { listNativeAnthropicToolIds } from "./native-anthropic-tool-registry"
import { listSubagentEntries } from "./subagent-registry"
import { getPluginCatalogSnapshot } from "@/lib/workflow/nodes/catalog"

/**
 * Built-in subagent dispatcher names always available — kept in sync with
 * `lib/claude/agents/subagents/index.ts:workflowEditorSubagents`.
 */
const BUILT_IN_SUBAGENT_IDS: readonly string[] = [
  "workflow-designer",
  "workflow-debugger",
  "workflow-refactorer",
  "workflow-doc-writer",
]

export type PluginWorkflowTemplateWarningCode =
  | "missing-skill"
  | "missing-mcp-preset"
  | "missing-native-tool"
  | "missing-subagent"
  | "missing-plugin-node"
  | "missing-plugin-trigger"

export interface PluginWorkflowTemplateWarning {
  code: PluginWorkflowTemplateWarningCode
  missingId: string
}

export interface WorkflowTemplateValidationResult {
  warnings: PluginWorkflowTemplateWarning[]
  ok: boolean
}

const registry = createOverlayRegistry<PluginWorkflowTemplateDef>({ name: "workflow-template" })

const warningsByTemplateId = new Map<string, readonly PluginWorkflowTemplateWarning[]>()

/** Resolve a subagent id (bare or `<pluginId>:<id>`) against built-ins + overlay. */
function subagentIdExists(id: string): boolean {
  if (BUILT_IN_SUBAGENT_IDS.includes(id)) return true
  for (const entry of listSubagentEntries()) {
    if (entry.id === id) return true
    if (entry.pluginId && `${entry.pluginId}:${entry.id}` === id) return true
  }
  return false
}

/** True when a plugin-contributed node/trigger kind is present in the catalog. */
function catalogHasKind(kind: string): boolean {
  return getPluginCatalogSnapshot().some((entry) => entry.kind === kind)
}

/**
 * Inspect a template's declared dependencies and return the missing ids.
 * Mirrors `validateTemplateRequires` for agent-team templates.
 */
export function validateWorkflowTemplateRequires(
  template: PluginWorkflowTemplateDef
): WorkflowTemplateValidationResult {
  const warnings: PluginWorkflowTemplateWarning[] = []
  const requires = template.requires
  if (!requires) return { warnings, ok: true }

  const skillIds = new Set(listSkillIds())
  const mcpIds = new Set(listMcpServerPresetIds())
  const nativeToolIds = new Set(listNativeAnthropicToolIds())

  for (const id of requires.skillIds ?? []) {
    if (!skillIds.has(id)) warnings.push({ code: "missing-skill", missingId: id })
  }
  for (const id of requires.mcpServerPresetIds ?? []) {
    if (!mcpIds.has(id)) warnings.push({ code: "missing-mcp-preset", missingId: id })
  }
  for (const id of requires.nativeAnthropicToolIds ?? []) {
    if (!nativeToolIds.has(id)) warnings.push({ code: "missing-native-tool", missingId: id })
  }
  for (const id of requires.subagentIds ?? []) {
    if (!subagentIdExists(id)) warnings.push({ code: "missing-subagent", missingId: id })
  }
  for (const kind of requires.pluginNodeKinds ?? []) {
    if (!catalogHasKind(kind)) warnings.push({ code: "missing-plugin-node", missingId: kind })
  }
  for (const kind of requires.pluginTriggerKinds ?? []) {
    if (!catalogHasKind(kind)) warnings.push({ code: "missing-plugin-trigger", missingId: kind })
  }

  return { warnings, ok: warnings.length === 0 }
}

/** Register a plugin-contributed workflow template and stamp `requires` warnings. */
export function registerWorkflowTemplate(
  id: string,
  template: PluginWorkflowTemplateDef,
  opts?: { pluginId?: string }
): { entry: PluginWorkflowTemplateDef; pluginId?: string } | undefined {
  const previous = registry.register(id, template, opts)
  const result = validateWorkflowTemplateRequires(template)
  if (result.warnings.length > 0) {
    warningsByTemplateId.set(id, Object.freeze(result.warnings))
  } else {
    warningsByTemplateId.delete(id)
  }
  return previous
}

/** Re-run `requires` validation for every registered template (called when
 * sibling overlay registries / the plugin catalog mutate). */
export function refreshAllWorkflowTemplateWarnings(): void {
  for (const { id, entry } of registry.entries()) {
    const result = validateWorkflowTemplateRequires(entry)
    if (result.warnings.length > 0) {
      warningsByTemplateId.set(id, Object.freeze(result.warnings))
    } else {
      warningsByTemplateId.delete(id)
    }
  }
}

/** Drop a single dynamically-registered template by id. */
export function unregisterWorkflowTemplateById(id: string): boolean {
  warningsByTemplateId.delete(id)
  return registry.unregisterById(id)
}

/** Drop every template contributed by `pluginId`. Returns the number removed. */
export function unregisterWorkflowTemplatesByPlugin(pluginId: string): number {
  for (const { id, pluginId: tag } of registry.entries()) {
    if (tag === pluginId) warningsByTemplateId.delete(id)
  }
  return registry.unregisterByPlugin(pluginId)
}

export const getWorkflowTemplate = registry.get
export const getWorkflowTemplateEntry = registry.getEntry
export const listWorkflowTemplateIds = registry.list
export const listWorkflowTemplateEntries = registry.entries

/** Warnings collected at register time for a template (empty array when clean). */
export function getWorkflowTemplateWarnings(
  templateId: string
): readonly PluginWorkflowTemplateWarning[] {
  return warningsByTemplateId.get(templateId) ?? []
}

/** Test-only: clear every dynamically registered template and its warnings. */
export function __resetWorkflowTemplatesForTesting(): void {
  warningsByTemplateId.clear()
  registry.__resetForTesting()
}
