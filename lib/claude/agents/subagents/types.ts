/**
 * Re-export of the claude-agent-sdk `AgentDefinition` shape so the
 * Cognia-side subagent files do not pull the SDK package directly
 * (it's a sidecar-side dependency; the renderer bundle should not
 * import from `@anthropic-ai/claude-agent-sdk`).
 *
 * Mirrors the shape documented at
 * `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:38`,
 * now in full: every field the pinned SDK's `AgentDefinition` declares is
 * expressible here. It used to be a deliberate subset ("add them here if a
 * new subagent needs them"), which meant `background`, `memory`, `observer`,
 * `skills`, `initialPrompt` and `permissionMode` could not be set at all — a
 * subagent could not be declared as a background task or given a memory
 * scope, and nothing said so.
 *
 * Two populations share this interface, and the split matters:
 *
 *  - **SDK fields** go to `query({ agents })` verbatim and are interpreted by
 *    the CLI's native Task tool.
 *  - **Cognia-only fields** (`provider`, `externalPresetId`, `mcpServerIds`,
 *    `allowNesting`, `maxDepth`, `hidden`, `disabled`) are honoured by the
 *    renderer's own dispatch path. They ride along to the SDK, which ignores
 *    what it does not recognise; the native Task tool therefore does NOT
 *    respect them (cross-provider runs go through the `dispatch_agent` plugin
 *    tool instead).
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
  /**
   * Reasoning effort dial. The SDK also accepts a raw integer here; the named
   * levels are what every Cognia surface offers, so the union stays named.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"

  // ---- SDK fields with no Cognia-side equivalent -----------------------------

  /**
   * Run this agent as a fire-and-forget background task when invoked, instead
   * of blocking the turn. The dispatching turn continues immediately and a
   * `task_notification` arrives when the agent settles.
   */
  background?: boolean
  /**
   * Scope for auto-loading this agent's memory files:
   * `user` → `~/.claude/agent-memory/<agentType>/`,
   * `project` → `.claude/agent-memory/<agentType>/`,
   * `local` → `.claude/agent-memory-local/<agentType>/`.
   * Unset means no memory is loaded — the SDK does not pick a default.
   */
  memory?: "user" | "project" | "local"
  /** Permission mode for this agent's tool calls, overriding the session's. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
  /**
   * Agent type auto-spawned as a background OBSERVER whenever this agent runs.
   * The observer gets read-only activity digests and reports through the
   * ObserverReport tool; it never participates in the task itself.
   */
  observer?: string
  /** Extra postamble appended to each digest sent to {@link observer}. Blank is ignored. */
  observerMessage?: string
  /** Skill names preloaded into the agent's context. */
  skills?: string[]
  /**
   * Auto-submitted as the first user turn when this agent is the MAIN thread
   * agent (i.e. via `@agent`), prepended to anything the user typed. Slash
   * commands in it are processed. Ignored when the agent is dispatched as a
   * subagent rather than being the main thread.
   */
  initialPrompt?: string
  /**
   * MCP servers this agent may reach: either a server name already known to
   * the session, or an inline process-transport config.
   *
   * Distinct from {@link mcpServerIds}, which is the Cognia-side list used
   * when routing to an EXTERNAL agent preset. Both can be set; they are read
   * by different dispatch paths.
   */
  mcpServers?: Array<string | Record<string, unknown>>
  /** Experimental: critical reminder appended to this agent's system prompt. */
  criticalSystemReminder_EXPERIMENTAL?: string
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
  /**
   * Hide from UI pickers / @-mention autocomplete while staying dispatchable
   * (OpenCode `hidden` semantics). Model-facing discovery is unaffected.
   */
  hidden?: boolean
  /** Fully off: excluded from dispatch, discovery, and every picker. */
  disabled?: boolean
}
