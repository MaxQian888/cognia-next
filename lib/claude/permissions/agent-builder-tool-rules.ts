/**
 * Baked-in consent tier for the Agent Builder tools (ADR-0220).
 *
 * The builder edits a draft the user watches change beside the conversation
 * and can edit or discard, so reading it, listing catalogs and writing fields
 * are allowed without a prompt. Creating the agent makes something that
 * outlives the conversation and can be started or assigned work, so it asks,
 * which is the "approval" the builder protocol promises the user.
 *
 * Merged as the LOWEST layer of the ruleset, so an explicit user rule in
 * Settings → Agent → Permissions overrides it either way.
 */
import { AGENT_BUILDER_TOOL_NAMES } from "@/lib/claude/agent-builder-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/** Mirrors `PLUGIN_TOOLS_SERVER_NAME` (see artifact-tool-rules.ts for why both keys). */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === AGENT_BUILDER_TOOL_NAMES.createAgent ? "ask" : "allow"
}

export function buildAgentBuilderToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of Object.values(AGENT_BUILDER_TOOL_NAMES)) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
