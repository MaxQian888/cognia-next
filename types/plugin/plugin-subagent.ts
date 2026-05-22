/**
 * Plugin Subagent Definitions.
 *
 * Plugins contributing the `subagent` capability ship Claude Code SDK
 * `AgentDefinition`-shaped entries through the manifest. The host registers
 * each entry into the `subagent-registry` overlay on enable and unregisters
 * on disable — identical lifecycle to `skills` / `mcp-server-preset`.
 *
 * Runtime resolution (see `lib/claude/agents/subagents/index.ts:resolveAllSubagents`)
 * unions the 4 host-bundled subagents (workflow-designer / workflow-debugger /
 * workflow-refactorer / workflow-doc-writer) with the plugin overlay. Plugin
 * subagent names are namespaced as `<pluginId>:<id>` at projection time so
 * they never collide with built-in dispatcher names.
 *
 * Fields mirror `AgentDefinition` in `lib/claude/agents/subagents/types.ts`
 * 1:1 — adding the `id` discriminator + display `name` is the only delta.
 * Kept narrow on purpose; broaden when a new manifest carries a field the
 * SDK actually consumes.
 */

/**
 * Subagent reasoning-effort dial. Mirrors the Claude Code SDK enum.
 */
export type PluginSubagentEffort = "low" | "medium" | "high" | "xhigh" | "max"

/**
 * A subagent contributed by a plugin.
 */
export interface PluginSubagentDef {
  /** Unique id within the plugin. Runtime id is `<pluginId>:<id>`. */
  id: string
  /** Display name shown in the subagent picker. */
  name: string
  /** Natural-language description shown to the dispatcher agent. */
  description: string
  /** System prompt the subagent runs with. */
  prompt: string
  /** Allowlist of tool names; omit to inherit the parent's tools. */
  tools?: string[]
  /** Tools to explicitly disallow. */
  disallowedTools?: string[]
  /** Model alias (`opus` / `sonnet` / `haiku`) or full id; defaults to the parent's model. */
  model?: string
  /** Max round-trips before the SDK stops looping the subagent. */
  maxTurns?: number
  /** Reasoning effort dial. */
  effort?: PluginSubagentEffort
}
