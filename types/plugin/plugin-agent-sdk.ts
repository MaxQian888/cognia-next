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
import type { PluginGuardrail } from "./plugin-agent-guardrails"

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
  /**
   * Input/output guardrails run around this turn. Inline guardrail objects or
   * ids of guardrails registered via `ctx.agent.guardrails`. A tripped
   * guardrail aborts the run with a `PluginGuardrailTripwireError`.
   */
  guardrails?: Array<PluginGuardrail | string>
  // ── Robustness (Package F) ────────────────────────────────────────────────
  /** Retry the run once with this model if the primary run errors. */
  fallbackModel?: string
  /** Cap agentic steps for this turn (alias of `maxSteps`; `maxSteps` wins). */
  maxTurns?: number
  /** Emit a per-run agent-trace span (start/end + usage + error). */
  trace?: boolean
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
  /** Frozen runtime adapter id that ran the turn (ADR-0090; resolver flag on). */
  runtime?: string
  /** Route kind of the frozen execution spec (ADR-0090; resolver flag on). */
  routeKind?: "gateway" | "direct"
  /** Set when the run degraded to a lesser rail than requested (ADR-0090). */
  degradedReason?: string
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

// ── Programmatic dispatch (Package C) ────────────────────────────────────────

/** Options for {@link PluginAgentAPI.dispatchSubagent}. */
export interface PluginDispatchSubagentOptions {
  /** Run with the tool-enabled sidecar loop (default true). Degrades to text. */
  toolsEnabled?: boolean
  /** Absolute working directory for the dispatched run. */
  cwd?: string
  abortSignal?: AbortSignal
  /**
   * Route the dispatch to an external CLI agent backed by this preset id
   * (Thread A2). Overrides the subagent def's own `externalPresetId` when set.
   */
  externalAgentId?: string
  /**
   * Detach the run: return `{ runId, backgrounded: true }` immediately and let
   * the result be collected later via the background registry. Default false
   * (the call awaits the run to completion).
   */
  background?: boolean

  // ── Nested-dispatch threading (internal; underscore-prefixed) ──────────────
  // These are populated by the host's `dispatch_agent` tool as it walks the
  // nesting chain. Plugins normally leave them unset (a top-level dispatch).
  /**
   * Nesting level of the agent issuing THIS dispatch (the parent). Top-level
   * chat = 0. `dispatchSubagent` runs the child at `_depth + 1` and rejects
   * when that would exceed `_maxDepth`.
   */
  _depth?: number
  /** Effective max nesting level. A child at level > `_maxDepth` is rejected. */
  _maxDepth?: number
  /**
   * Subagent ids already on the ancestor path (excludes the one being
   * dispatched). Used for cycle detection (A→B→A is rejected).
   */
  _parentChain?: string[]
  /** Absolute epoch-ms wall-clock deadline shared by the whole dispatch subtree. */
  _deadlineMs?: number
  /** Key locating the shared token-budget guard for this dispatch subtree. */
  _budgetRootRunId?: string
  /**
   * The dispatching (parent) agent's RESOLVED permission ceiling. The child run
   * is clamped against it in `resolveSendOptions` (allow-list intersect,
   * deny-list union, mode clamp) so a child can never widen beyond the parent —
   * fail-closed and monotonic across nesting depth. Populated by the host's
   * `dispatch_agent` tool from the caller's recorded ceiling.
   */
  _permissionCeiling?: import("@/lib/ai/agent/external/permission-cascade").ExternalSessionPermissionSpec
  /** Explicit run id (defaults to a generated one) — also the background key. */
  _runId?: string
  /**
   * Live capture-stream sink for the child run, populated by the host's
   * `dispatch_agent` tool. Forwarded into `executeAgent` so tool-call /
   * tool-result events stream into the subagent runtime store as the run
   * progresses (lights up `SubagentPart`'s live progress + logs).
   */
  _onEvent?: (event: import("@/lib/claude/run-and-capture").CaptureStreamEvent) => void
  /**
   * Permission-ask routing for the child run, populated by the host's
   * `dispatch_agent` tool. Registered under the child's ephemeral session id so
   * a `permission_request` from the child surfaces in the PARENT chat session
   * instead of being auto-denied against the unopened ephemeral session.
   */
  _approvalRoute?: PluginDispatchApprovalRoute
}

/** Why a nested dispatch was refused. */
export interface PluginSubagentDispatchRejection {
  reason: "max-depth" | "cycle" | "policy"
  message: string
  /** The level the rejected child would have run at (max-depth case). */
  attemptedDepth?: number
}

/**
 * Structured failure envelope for a dispatched subagent run. Never thrown —
 * it rides on {@link PluginSubagentDispatchResult.errorEnvelope} so callers
 * (retry loop, journal, chat card, the parent model) can distinguish transient
 * from permanent failures instead of parsing collapsed error text.
 *
 * `code` is the shared provider taxonomy (`ProviderErrorClass` from
 * `@cognia/provider-types/error-class`) plus dispatch-local codes; string-typed
 * here so `types/` stays a leaf layer.
 */
export interface PluginDispatchErrorEnvelope {
  code:
    | "rate-limit"
    | "timeout"
    | "network"
    | "server-error" // transient (retryable)
    | "auth"
    | "invalid-request"
    | "context-window-exceeded"
    | "content-policy"
    | "unknown" // permanent
    | "sidecar-exited" // retryable (the sidecar respawns)
    | "aborted" // never retried
    | "rejection-cycle"
    | "rejection-max-depth"
    | "rejection-policy"
    | "budget-exhausted" // guard refusals, never retried
    | "deadline-exceeded"
    | "interrupted" // never retried
  retryable: boolean
  message: string
  /** Text the child streamed before dying (fed from the dispatch run tracker). */
  partialText?: string
  /** Provider Retry-After hint (ms) when the classifier extracted one. */
  retryAfterMs?: number
  /** 1-based attempt count that produced this envelope (set by the retry loop). */
  attempts?: number
}

/**
 * Where a dispatched subagent's permission asks should surface. Registered by
 * the dispatch handler under the child's ephemeral session id so the renderer's
 * `permission_request` listener can re-bucket the ask into the PARENT chat
 * session (instead of auto-denying against the unopened ephemeral session).
 */
export interface PluginDispatchApprovalRoute {
  /** The chat session the user is actually looking at. */
  parentSessionId: string
  /** Subagent runtime-store run id (cancel handle + card focus). */
  runId: string
  /** Display label for "Asked by <subagent>". */
  subagentId: string
  /** Whether the run was detached (`background: true`). */
  backgrounded: boolean
}

/** Result of dispatching a subagent (a single agent turn). */
export interface PluginSubagentDispatchResult {
  text: string
  channel: "sidecar" | "text" | "external"
  toolsAvailable: boolean
  finishReason?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Run id (always set; the background-collection key when backgrounded). */
  runId?: string
  /** True when the run was detached; `text` is empty and the result lands later. */
  backgrounded?: boolean
  /** Set (never thrown) when the dispatch was refused by a nesting guard. */
  rejection?: PluginSubagentDispatchRejection
  /** Convenience flag mirroring `rejection?.reason === "max-depth"`. */
  depthExhausted?: boolean
  /**
   * Structured failure detail when `finishReason === "error"` (and for guard
   * rejections). Lets the retry loop / journal / parent model distinguish
   * transient from permanent failures; `text` stays the collapsed message for
   * back-compat.
   */
  errorEnvelope?: PluginDispatchErrorEnvelope
  /** Frozen runtime adapter id that ran the child (ADR-0090; resolver flag on). */
  runtime?: string
  /** Route kind of the child's frozen execution spec (ADR-0090; resolver flag on). */
  routeKind?: "gateway" | "direct"
  /** Set when the child degraded to a lesser rail than requested (ADR-0090). */
  degradedReason?: string
}

/** Options for {@link PluginAgentAPI.runTeam}. */
export interface PluginRunTeamOptions {
  /** Force ("force") or disable ("off") ultracode orchestration for this run. */
  ultracode?: boolean
  /**
   * Trigger origin for HITL gate policy (see lib/ai/agent/team/gate-policy).
   * Defaults to "plugin"; the external bridge passes "external".
   */
  origin?: import("@/types/agent/agent-team").TeamRunOrigin
}

/** Terminal outcome of a programmatic team run. */
export interface PluginRunTeamResult {
  teamId: string
  /** Terminal team status ("completed" | "failed" | "cancelled" | …). */
  status: string
}
