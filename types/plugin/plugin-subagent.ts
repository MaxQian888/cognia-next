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
  /**
   * Provider id (`anthropic` / `openai` / `deepseek` / …) this subagent runs on.
   * When set AND configured, the subagent runs on this provider with its own
   * credentials — so a subagent can use a DIFFERENT provider than the parent
   * session (e.g. a DeepSeek chat delegating to a Claude reviewer). Pairs with
   * `model`; omit to inherit the parent's provider. An unconfigured provider
   * falls back to the parent's (so a stale id never breaks dispatch).
   */
  provider?: string
  /** Max round-trips before the SDK stops looping the subagent. */
  maxTurns?: number
  /** Reasoning effort dial. */
  effort?: PluginSubagentEffort
  /**
   * Optional external-agent preset id backing this subagent (Thread A2). When
   * set, `dispatchSubagent` routes the run to the external CLI agent instead of
   * the built-in executor. `prompt` / `tools` remain advisory.
   */
  externalPresetId?: string
  /**
   * MCP server ids/names to forward into the external agent's ACP session
   * (`session/new` `mcpServers`) when this subagent runs on an external preset.
   * Resolved through `resolveAcpMcpServers`; ignored for the built-in executor
   * (which inherits the parent session's MCP config). Only the explicitly-listed
   * enabled servers are forwarded — never "all".
   */
  mcpServerIds?: string[]
  /**
   * Opt this subagent into nested dispatch — i.e. when it runs, expose the
   * `dispatch_agent` tool so it can itself dispatch further subagents (up to the
   * effective depth cap). Default `false`: a subagent is a leaf unless it opts
   * in. Ignored unless app-level `subagentNesting.enabled` is on.
   */
  allowNesting?: boolean
  /**
   * Per-subagent override of the max nesting level. The effective cap is
   * `min(appSettings.subagentNesting.maxDepth, this)`.
   */
  maxDepth?: number
}
