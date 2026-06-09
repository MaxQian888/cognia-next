/**
 * Plugin-facing Agent SDK contract (ADR-0026 §Agent-SDK).
 *
 * These types describe the embeddable agent runtime exposed to plugins via
 * `ctx.agent.run` / `ctx.agent.runStreamed` / `ctx.agent.invokeTool`. They are
 * the typed replacement for the legacy untyped
 * `ctx.agent.executeAgent(config: Record<string, unknown>)` entry point (kept as
 * a deprecated shim).
 *
 * Kept dependency-free (no imports from `lib/`) so the `types/` layer stays a
 * leaf — the runtime in `lib/plugin/agent-sdk/` adapts these to the executor's
 * `AgentTool` / `ExecuteAgentConfig` shapes.
 */

import type { PluginAgentHooks } from "./plugin-agent-hooks"

/**
 * Result of a `canUseTool` decision. Mirrors the sidecar's existing
 * rewrite-capable permission contract (`sidecar/dispatch/anthropic.mjs` +
 * `approveTool(..., updatedInput)`):
 *  - `allow` optionally returns `updatedInput` to REWRITE the tool arguments
 *    on the way through (the PII-redaction gate uses this to substitute
 *    placeholders instead of hard-denying).
 *  - `deny` aborts the single tool call and feeds `message` back to the model.
 */
export type PluginToolPermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }

/**
 * Per-tool-call permission gate. Consulted before a tool executes. May be
 * supplied at the run level (`PluginAgentRunOptions.canUseTool`) and/or per
 * tool (`PluginAgentToolInput.canUseTool`). When both are present the tool-level
 * gate runs first; a tool-level `deny` short-circuits, otherwise the
 * (possibly rewritten) input flows into the run-level gate.
 */
export type PluginToolPermissionFn = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal?: AbortSignal }
) => Promise<PluginToolPermissionResult> | PluginToolPermissionResult

/**
 * An inline tool a plugin hands to a single agent run. Structurally compatible
 * with the executor's `AgentTool` (the runtime adapts it). `canUseTool` lets a
 * tool self-gate regardless of channel.
 */
export interface PluginAgentToolInput {
  name: string
  description?: string
  /** JSON-Schema (or Zod) parameter definition for the tool-calling layer. */
  parameters?: Record<string, unknown>
  /** Alias for `parameters` kept for older plugin authors. */
  schema?: Record<string, unknown>
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown
  /** Optional per-tool permission gate (allow / deny / rewrite). */
  canUseTool?: PluginToolPermissionFn
}

/** Structured-output request — append a JSON instruction + parse the reply. */
export interface PluginAgentOutputFormat {
  type: "json_schema"
  /**
   * JSON-Schema-ish shape. Stringified into the system instruction and used to
   * validate the parsed result (validate→retry-once when the model drifts).
   */
  schema: Record<string, unknown>
}

export interface PluginAgentRunOptions {
  /** Replace the system prompt entirely. */
  system?: string
  /** Append to the resolved system prompt (preset-with-append; extend, don't replace). */
  appendSystem?: string
  model?: string
  provider?: string
  /** Inline tools available to this run. */
  tools?: PluginAgentToolInput[]
  /**
   * Opt into the tool-enabled sidecar loop. Requires the plugin's
   * `agent:control` permission. Degrades to the text channel when the desktop
   * sidecar is unavailable (`result.channel` reports which ran).
   */
  toolsEnabled?: boolean
  /** Reuse an existing persona's model/tools/skills/MCP. */
  characterId?: string
  /** Restrict the host tool surface for the run. */
  allowedTools?: string[]
  maxSteps?: number
  temperature?: number
  cwd?: string
  timeoutMs?: number
  abortSignal?: AbortSignal
  /** Request structured JSON output. */
  outputFormat?: PluginAgentOutputFormat
  /** Run-level permission gate (allow / deny / rewrite). */
  canUseTool?: PluginToolPermissionFn
  /** Per-run lifecycle hooks (PreToolUse / PostToolUse / Stop). */
  hooks?: PluginAgentHooks
}

export interface PluginAgentRunResult {
  text: string
  /** Parsed object when `outputFormat` was requested and parsing succeeded. */
  object?: unknown
  /** Set (never thrown) when structured parsing/validation failed. */
  parseError?: string
  finishReason?: string
  /** Which execution channel actually ran. */
  channel: "sidecar" | "text"
  /** Whether the tool-enabled loop was used (true only on the sidecar channel). */
  toolsAvailable: boolean
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Cancellation handle (also returned by `runStreamed`). */
  agentId: string
}

/** Typed events emitted by `runStreamed`. */
export type PluginAgentStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolName: string; input: Record<string, unknown> }
  | {
      type: "tool-result"
      toolName: string
      /** Tool arguments when the capture loop could correlate them; else absent. */
      input?: Record<string, unknown>
      result: unknown
      isError?: boolean
    }
  | { type: "result"; result: PluginAgentRunResult }

/**
 * Live handle for a streaming run. Async-iterate it for typed events; await
 * `result` for the final outcome; call `cancel()` to abort.
 */
export interface PluginAgentRun extends AsyncIterable<PluginAgentStreamEvent> {
  readonly agentId: string
  readonly result: Promise<PluginAgentRunResult>
  cancel(): void
}
