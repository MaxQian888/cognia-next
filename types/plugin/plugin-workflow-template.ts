/**
 * Plugin Workflow Template Definitions.
 *
 * Plugins contributing the `workflow-template` capability ship complete visual
 * workflow blueprints (nodes + edges + settings) through the manifest. The host
 * registers each entry into the `workflow-template-registry` overlay on enable
 * and unregisters on disable — identical lifecycle to `agent-team-template`
 * (ADR-0032). Templates surface in the editor's Settings tab → "Plugins &
 * capabilities" and instantiate into a fresh `VisualWorkflow` via
 * `projectPluginWorkflowTemplate`.
 *
 * The `requires` block declares cross-capability dependencies; missing ones
 * become non-blocking warnings (mirrors the agent-team-template `requires`
 * pattern). Unlike teams, workflow templates can also depend on plugin-
 * contributed node/trigger kinds — declared as the runtime-PREFIXED kind
 * (`<pluginId>.<kind>`), which is how `lib/plugin/core/context.ts:prefixKind`
 * names them in the catalog + executor registry.
 */

import type { WorkflowSettings } from "@/types/workflow/visual"

/**
 * Cross-capability dependencies declared by a plugin workflow template. Each
 * id list points into another overlay registry (or, for the workflow-specific
 * lists, the node-executor / trigger registries + plugin catalog).
 */
export interface WorkflowTemplateRequires {
  /** Skill ids contributed by other plugins (consumed by `action.skill.invoke`). */
  skillIds?: string[]
  /** MCP server preset ids (consumed by `action.mcp.invokeTool`). */
  mcpServerPresetIds?: string[]
  /** Native Anthropic tool ids. */
  nativeAnthropicToolIds?: string[]
  /** Subagent ids: built-in names or `<pluginId>:<subagentId>`. */
  subagentIds?: string[]
  /** Plugin node kinds the template uses — declared PREFIXED (`<pluginId>.<kind>`). */
  pluginNodeKinds?: string[]
  /** Plugin trigger kinds the template uses — declared PREFIXED (`<pluginId>.<kind>`). */
  pluginTriggerKinds?: string[]
}

/** A graph node in a template blueprint. Mirrors the author-supplied fields of
 * `WorkflowNode` (the runtime adds ids/timestamps at instantiation time). */
export interface PluginWorkflowTemplateNode {
  id: string
  /** Node kind — built-in (`action.character.send`) or plugin (`<pluginId>.<kind>`). */
  type: string
  typeVersion: number
  position: { x: number; y: number }
  data: { label: string; params?: Record<string, unknown>; notes?: string }
}

/** A graph edge in a template blueprint. Mirrors `WorkflowEdge`. */
export interface PluginWorkflowTemplateEdge {
  id: string
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
  label?: string
  data?: { kind?: "default" | "conditional" | "parallel" | "loop" | "error" }
}

/** Category mirrors the editor's template-picker buckets. */
export type PluginWorkflowTemplateCategory =
  | "automation"
  | "integration"
  | "ai"
  | "data"
  | "github"
  | "general"

/**
 * Plugin-contributed visual workflow template — a self-contained blueprint
 * (distinct from the host `WorkflowTemplate`, which points at a stored
 * `workflowId`).
 */
export interface PluginWorkflowTemplateDef {
  /** Unique id within the plugin. Runtime template id is `<pluginId>:<id>`. */
  id: string
  /** Display name shown in the template list. */
  name: string
  /** One-line description. */
  description: string
  /** Template category — drives sorting/filtering. */
  category: PluginWorkflowTemplateCategory
  /** Lucide icon name shown on the template card. */
  icon?: string
  /** Optional complexity hint (matches `VisualWorkflow.complexity`). */
  complexity?: "starter" | "intermediate" | "advanced"
  /** The blueprint's nodes. */
  nodes: PluginWorkflowTemplateNode[]
  /** The blueprint's edges. */
  edges: PluginWorkflowTemplateEdge[]
  /** Default run-settings overrides merged over the host defaults. */
  settings?: Partial<WorkflowSettings>
  /**
   * Cross-capability dependencies. Missing dependencies surface as warnings via
   * `validateWorkflowTemplateRequires(def)` — non-blocking.
   */
  requires?: WorkflowTemplateRequires
}

/**
 * Manifest-side mirror. Identical to {@link PluginWorkflowTemplateDef} because
 * templates carry no runtime functions (unlike `PluginNodeDef.execute`).
 */
export type PluginManifestWorkflowTemplateDef = PluginWorkflowTemplateDef
