/**
 * Projects a plugin-contributed workflow template (an overlay-registry entry)
 * into a concrete `VisualWorkflow` ready to instantiate. Namespaces the id to
 * `<pluginId>:<id>`, merges the template's settings over the host defaults, and
 * stamps `isTemplate`. The output flows through the same `validateWorkflow` +
 * `lib/db/workflows.ts` create path as built-in templates, so a user's "Use
 * template" clone survives the plugin being disabled (the overlay entry does not).
 *
 * Mirrors `lib/agent-team/project-plugin-template.ts` for the team subsystem.
 */

import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "@/types/workflow/visual"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"

export interface WorkflowTemplateEntry {
  id: string
  entry: PluginWorkflowTemplateDef
  pluginId?: string
}

export function projectPluginWorkflowTemplate(input: WorkflowTemplateEntry): VisualWorkflow {
  const { entry, pluginId } = input
  const runtimeId = pluginId ? `${pluginId}:${entry.id}` : entry.id
  const now = Date.now()

  const nodes: WorkflowNode[] = entry.nodes.map((n) => ({
    id: n.id,
    type: n.type as WorkflowNode["type"],
    typeVersion: n.typeVersion,
    position: { x: n.position.x, y: n.position.y },
    data: { label: n.data.label, params: n.data.params ?? {}, notes: n.data.notes },
  }))

  const edges: WorkflowEdge[] = entry.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    label: e.label,
    data: e.data,
  }))

  return {
    id: runtimeId,
    schemaVersion: 1,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    complexity: entry.complexity,
    isTemplate: true,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...entry.settings },
  }
}
