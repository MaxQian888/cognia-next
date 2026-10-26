/**
 * Plugin Agent SDK — per-run lifecycle hooks (ADR-0026 §Agent-SDK).
 *
 * Hooks let a plugin observe and shape its OWN agent runs around tool calls and
 * completion, mirroring the Claude Agent SDK's PreToolUse / PostToolUse / Stop
 * surface. They are supplied per-run via {@link PluginAgentRunOptions.hooks}
 * (not a global registry) so the lifetime is exactly the run.
 *
 * Dependency-free leaf: only references sibling `types/plugin` contracts. The
 * runtime in `lib/plugin/agent-sdk/` adapts these to the executor + capture
 * seams (`canUseTool` round-trip for PreToolUse, the tool-result observation /
 * review round-trip for PostToolUse).
 */

import type { PluginToolPermissionFn } from "./plugin-agent-sdk"

/**
 * Input handed to {@link PluginPostToolUseFn} after a tool returns. `input` is
 * the (possibly rewritten) tool arguments when the capture loop could correlate
 * them; it is `{}` when unavailable (e.g. native Anthropic tools whose call is
 * not surfaced to the renderer). `result` is the tool output the model is about
 * to see; `isError` flags an errored tool result.
 */
export interface PluginPostToolUseInput {
  toolName: string
  input: Record<string, unknown>
  result: unknown
  isError: boolean
}

/**
 * Result of a {@link PluginPostToolUseFn}. Return `{ updatedToolOutput }` to
 * REWRITE the output the model sees (sanitize / redact). Omit or return void to
 * observe only. Rewrite is honored only where the tool result is materialized
 * in-process (the ai-sdk channel + in-process MCP tools); native Anthropic
 * tools (Bash/Read/Edit/Grep) are observe-only — see the SDK docs.
 */
export interface PluginPostToolUseResult {
  updatedToolOutput?: unknown
}

/** PostToolUse lifecycle hook. */
export type PluginPostToolUseFn = (
  input: PluginPostToolUseInput,
  ctx: { signal?: AbortSignal }
) => Promise<PluginPostToolUseResult | void> | PluginPostToolUseResult | void

/** Input handed to {@link PluginStopFn} once a run completes (either channel). */
export interface PluginStopInput {
  text: string
  finishReason?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Which execution channel actually ran. */
  channel: "sidecar" | "text"
}

/** Stop lifecycle hook — fired exactly once when the run resolves. Observational. */
export type PluginStopFn = (
  input: PluginStopInput,
  ctx: { signal?: AbortSignal }
) => void | Promise<void>

/**
 * Per-run lifecycle hooks. All optional.
 *
 * - `onPreToolUse` — fired before a tool runs; may deny or REWRITE the tool
 *   input. Reuses the same result contract as `canUseTool`. When both a
 *   `canUseTool` (tool-level then run-level) and `onPreToolUse` are present, the
 *   hook runs LAST and sees the already-rewritten input; any `deny` wins.
 * - `onPostToolUse` — fired after a tool returns; observe and optionally rewrite
 *   the output (see {@link PluginPostToolUseResult}).
 * - `onStop` — fired once the run completes, on BOTH channels (graceful
 *   degradation: tool hooks never fire on the text channel, but `onStop` does).
 */
export interface PluginAgentHooks {
  onPreToolUse?: PluginToolPermissionFn
  onPostToolUse?: PluginPostToolUseFn
  onStop?: PluginStopFn
}
