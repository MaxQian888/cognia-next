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
 * This is NOT a 1:1 mirror of `AgentDefinition`
 * (`lib/claude/agents/subagents/types.ts`), and the doc here used to claim it
 * was. It is a deliberately narrower subset, plus the `id` discriminator and a
 * display `name`.
 *
 * What a plugin may NOT declare, and why:
 *
 *  - `permissionMode`. A subagent that names its own permission mode could
 *    declare `bypassPermissions` and run ungated, so a plugin manifest is the
 *    wrong place to set it. The session's mode governs.
 *  - `background` and `observer` / `observerMessage`. Both spawn work the host
 *    does not budget for: a fire-and-forget task and an auto-spawned second
 *    agent per invocation. They need run accounting before a manifest can ask
 *    for them.
 *  - `memory`. Names a filesystem scope under `~/.claude` or the project, which
 *    is a capability grant rather than an agent field.
 *  - `skills`, `initialPrompt`, `mcpServers`,
 *    `criticalSystemReminder_EXPERIMENTAL`. Not wired on the plugin path. They
 *    would ride to the SDK and be honoured by native Task while the renderer's
 *    own dispatch ignored them, which is the split this file exists to avoid.
 *
 * Broadening the set is a security and accounting decision per field, not a
 * type edit. `projectPluginSubagent` copies exactly what is declared here.
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
  /**
   * Hide from UI pickers / @-mention autocomplete while staying dispatchable
   * (OpenCode `hidden` semantics). Model-facing discovery is unaffected.
   */
  hidden?: boolean
  /** Fully off: excluded from dispatch, discovery, and every picker. */
  disabled?: boolean
}
