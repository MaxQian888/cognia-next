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
import { createValidatingOverlayRegistry } from "./createValidatingOverlayRegistry"
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

const registry = createValidatingOverlayRegistry<
  PluginWorkflowTemplateDef,
  PluginWorkflowTemplateWarning
>({
  name: "workflow-template",
  validate: (template) => validateWorkflowTemplateRequires(template).warnings,
})

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
export const registerWorkflowTemplate = registry.register
/** Re-run `requires` validation for every registered template (called when
 * sibling overlay registries / the plugin catalog mutate). */
export const refreshAllWorkflowTemplateWarnings = registry.refreshAllWarnings
/** Drop a single dynamically-registered template by id. */
export const unregisterWorkflowTemplateById = registry.unregisterById
/** Drop every template contributed by `pluginId`. Returns the number removed. */
export const unregisterWorkflowTemplatesByPlugin = registry.unregisterByPlugin
export const getWorkflowTemplate = registry.get
export const getWorkflowTemplateEntry = registry.getEntry
export const listWorkflowTemplateIds = registry.list
export const listWorkflowTemplateEntries = registry.entries
/** Warnings collected at register time for a template (empty array when clean). */
export const getWorkflowTemplateWarnings = registry.getWarnings
/** Test-only: clear every dynamically registered template and its warnings. */
export const __resetWorkflowTemplatesForTesting = registry.__resetForTesting
