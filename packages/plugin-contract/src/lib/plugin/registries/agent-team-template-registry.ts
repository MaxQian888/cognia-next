/**
 * The plugin contract's share of `lib/plugin/registries/agent-team-template-registry.ts`, which re-exports these.
 */
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
