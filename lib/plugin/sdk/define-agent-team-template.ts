/**
 * Plugin SDK helper for the `agent-team-template` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineAgentTeamTemplate()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches
 * `PluginAgentTeamTemplateDef`, including the `requires` block that
 * declares cross-capability dependencies (mcp / skill / character-pack /
 * native-tool / external-agent-preset / subagent ids).
 *
 * Usage:
 *   const team = defineAgentTeamTemplate({
 *     id: "github-pr-review-team",
 *     name: "GitHub PR Review",
 *     description: "Multi-reviewer PR walk-through",
 *     category: "review",
 *     teammates: [...],
 *     requires: {
 *       mcpServerPresetIds: ["my-plugin:github-mcp"],
 *       skillIds: ["my-plugin:git-conventions"],
 *     },
 *   })
 */

import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"

export function defineAgentTeamTemplate(
  def: PluginAgentTeamTemplateDef
): PluginAgentTeamTemplateDef {
  return def
}
