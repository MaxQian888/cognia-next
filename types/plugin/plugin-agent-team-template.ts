/**
 * Plugin Agent Team Template Definitions.
 *
 * Plugins contributing the `agent-team-template` capability ship complete
 * agent team blueprints through the manifest. The host registers each entry
 * into the `agent-team-template-registry` overlay on enable and unregisters
 * on disable — identical lifecycle to `skills` / `mcp-server-preset` /
 * `character-pack`.
 *
 * Templates are surfaced alongside the 8 built-in `BUILT_IN_TEAM_TEMPLATES`
 * (see `types/agent/agent-team.ts`) in the `agent-team-templates-section`
 * settings UI. The `requires` block declares cross-capability dependencies
 * (other manifest contributions the template needs to function). When a
 * declared dependency is missing from the live overlay registries,
 * `validateTemplateRequires(def)` returns warnings that the UI renders as
 * disabled badges + "install missing plugin" hints (mirrors the ADR-0030
 * character-pack `requires` pattern).
 */

import type { AgentTeamConfig, TeammateConfig } from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"

/**
 * Cross-capability dependencies declared by a plugin team template. Each
 * id list points into another overlay registry. Missing ids become
 * non-blocking warnings surfaced in the template picker.
 *
 * Subagent ids inside `subagentIds[]` may be either a built-in dispatcher
 * name (e.g. `"workflow-designer"`) or a plugin-namespaced id (e.g.
 * `"my-plugin:my-subagent"`) — both forms resolve through
 * `resolveAllSubagents`.
 */
export interface TeamAgentTemplateRequires {
  /** MCP server preset ids contributed by other plugins. */
  mcpServerPresetIds?: string[]
  /** Skill ids contributed by other plugins. */
  skillIds?: string[]
  /** Character pack ids the template's roster depends on. */
  characterPackIds?: string[]
  /** Native Anthropic tool ids (e.g. `computer_20251124`). */
  nativeAnthropicToolIds?: string[]
  /** External agent preset ids (Claude Code / Codex / Gemini-CLI / Cursor-CLI). */
  externalAgentPresetIds?: string[]
  /** Subagent ids: built-in names or `<pluginId>:<subagentId>`. */
  subagentIds?: string[]
}

/**
 * A single teammate slot in the template's roster. Mirrors the inline
 * shape inside `AgentTeamTemplate.teammates[]`.
 */
export interface PluginAgentTeamTemplateTeammate {
  name: string
  description: string
  specialization?: string
  config?: TeammateConfig
}

/**
 * A single task in the template's pre-seeded task list. Mirrors
 * `AgentTeamTemplate.taskTemplates[]`.
 */
export interface PluginAgentTeamTemplateTask {
  title: string
  description: string
  priority: SubAgentPriority
  /** Index into the `teammates[]` array that should claim this task. */
  assignedToIndex?: number
}

/**
 * Category enum mirrors `AgentTeamTemplate.category` — kept exported so
 * plugin authors get autocomplete from the SDK helper.
 */
export type PluginAgentTeamTemplateCategory =
  | "review"
  | "research"
  | "development"
  | "debugging"
  | "analysis"
  | "general"
  | "documentation"
  | "security"

/**
 * Plugin-contributed agent team template.
 */
export interface PluginAgentTeamTemplateDef {
  /** Unique id within the plugin. Runtime template id is `<pluginId>:<id>`. */
  id: string
  /** Display name shown in the template picker. */
  name: string
  /** One-line description. */
  description: string
  /** Template category — drives sorting/filtering in the picker. */
  category: PluginAgentTeamTemplateCategory
  /** Roster of teammates the template instantiates. */
  teammates: PluginAgentTeamTemplateTeammate[]
  /** Pre-seeded tasks. */
  taskTemplates?: PluginAgentTeamTemplateTask[]
  /** Default team config overrides. */
  config?: Partial<AgentTeamConfig>
  /** Lucide icon name shown on the template card. */
  icon?: string
  /**
   * Cross-capability dependencies. Missing dependencies surface as warnings
   * via `validateTemplateRequires(def)` — non-blocking. The UI shows a
   * disabled badge + "install missing plugin" hint on the affected cards.
   */
  requires?: TeamAgentTemplateRequires
}
