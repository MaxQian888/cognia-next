/**
 * Re-export of the claude-agent-sdk `AgentDefinition` shape so the
 * Cognia-side subagent files do not pull the SDK package directly
 * (it's a sidecar-side dependency; the renderer bundle should not
 * import from `@anthropic-ai/claude-agent-sdk`).
 *
 * Mirrors the shape documented at
 * `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:38`.
 * Kept narrow — fields we don't currently use are omitted; add them
 * here if a new subagent needs them.
 */

export interface AgentDefinition {
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
   * Provider id this subagent runs on (`anthropic` / `openai` / `deepseek` / …).
   * Honored by the renderer dispatch path (`executeAgent` / `runCliSubagent`),
   * which can route a subagent to a DIFFERENT provider than the parent session.
   * NOTE: the SDK-native Task tool (Anthropic channel) ignores this — cross-
   * provider runs flow through the `dispatch_agent` plugin tool, not native Task.
   */
  provider?: string
  /** Max round-trips before the SDK stops looping the subagent. */
  maxTurns?: number
  /** Reasoning effort dial. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  /**
   * Optional external-agent preset id backing this subagent (Thread A2). When
   * set, `dispatchSubagent` routes the run to the external CLI agent via the
   * {@link ExternalAgentManager} instead of the built-in executor; `prompt` /
   * `tools` remain advisory (the dispatcher still advertises the def by
   * `description`). Honored at execute-time only.
   */
  externalPresetId?: string
  /**
   * MCP server ids/names forwarded into the external agent's ACP session when
   * this subagent runs on an external preset (see {@link PluginSubagentDef}).
   * Ignored by the built-in executor. Honored at execute-time only.
   */
  mcpServerIds?: string[]
  /**
   * Opt this subagent into nested dispatch — when it runs, expose the
   * `dispatch_agent` tool so it can dispatch further subagents (up to the
   * effective depth cap). Default `false` (leaf). Gated by app-level
   * `subagentNesting.enabled`.
   */
  allowNesting?: boolean
  /** Per-subagent override of the max nesting level (combined via `min`). */
  maxDepth?: number
}
