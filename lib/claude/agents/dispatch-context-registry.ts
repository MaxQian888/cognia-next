/**
 * Per-session nested-dispatch context registry (renderer-side).
 *
 * The `dispatch_agent` host tool round-trips through the existing
 * `plugin_tool_exec` wire (see `lib/claude/plugin-tool-ipc.ts`). That wire only
 * carries `{sessionId, toolUseId, name, args}` — it has no notion of how deep
 * the calling agent is nested. This registry closes that gap: when a subagent
 * run starts, `agent-executor` registers its {depth, maxDepth, parentChain}
 * keyed by the run's ephemeral `sessionId`; when the model (running AS that
 * subagent) calls `dispatch_agent`, the renderer handler looks the context back
 * up by `request.sessionId` and threads depth/parentChain into the next
 * `dispatchSubagent` call.
 *
 * A missing entry means "top-level chat" (depth 0, empty chain).
 *
 * Pure module — no React, no store. Registration is balanced by the executor's
 * `finally` so a re-used sessionId never inherits a stale context.
 */

import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"

export interface DispatchContext {
  /** Nesting level the agent owning this session runs at. Top-level chat = 0. */
  depth: number
  /** Effective max nesting level for this dispatch subtree. */
  maxDepth: number
  /** Subagent ids already on the ancestor path (for cycle detection). */
  parentChain: string[]
  /** Absolute epoch-ms wall-clock deadline shared by the whole subtree. */
  deadlineMs?: number
  /** Key locating the shared token-budget guard for this subtree. */
  budgetRootRunId?: string
  /**
   * The run id of the agent owning this session (this subagent's own run). When
   * it dispatches a child, the child's `parentSubagentId` (the tree edge) = this.
   */
  selfRunId?: string
}

const registry = new Map<string, DispatchContext>()

/** Register (or replace) the dispatch context for a running subagent session. */
export function registerDispatchContext(sessionId: string, ctx: DispatchContext): void {
  if (!sessionId) return
  registry.set(sessionId, ctx)
}

/** Look up the dispatch context for a session, or `undefined` for top-level chat. */
export function getDispatchContext(sessionId: string): DispatchContext | undefined {
  return registry.get(sessionId)
}

/** Remove a session's context. Called from the executor `finally` to avoid leaks. */
export function clearDispatchContext(sessionId: string): void {
  registry.delete(sessionId)
}

// ── Resolved permission-ceiling registry ─────────────────────────────────────
// `resolveSendOptions` deposits the permission spec each session ACTUALLY runs
// with (post-clamp) keyed by session id. When that session dispatches a
// subagent, `dispatch-agent-handler` reads this back as the child's parent
// ceiling and clamps the child against it via `deriveExternalSessionPermission`
// (fail-closed, monotonic across depth). One registry serves both the long-lived
// top-level chat session and a subagent's ephemeral session — both flow through
// `resolveSendOptions`, so neither needs special-casing.

const resolvedCeilings = new Map<string, ExternalSessionPermissionSpec>()

/** Record the permission ceiling a session resolved to (called by resolveSendOptions). */
export function recordResolvedPermissionCeiling(
  sessionId: string,
  spec: ExternalSessionPermissionSpec
): void {
  if (!sessionId) return
  resolvedCeilings.set(sessionId, spec)
}

/** Read a session's resolved ceiling, or `undefined` when it has none (no restriction). */
export function getResolvedPermissionCeiling(
  sessionId: string
): ExternalSessionPermissionSpec | undefined {
  return resolvedCeilings.get(sessionId)
}

/** Drop a session's resolved ceiling. Called from the executor/team `finally`. */
export function clearResolvedPermissionCeiling(sessionId: string): void {
  resolvedCeilings.delete(sessionId)
}

// ── Team-dispatch identity registry ──────────────────────────────────────────
// When a teammate runs through `dispatchTeammate.runToolEnabled`, it gets a
// fresh ephemeral session. Host-routed team-collaboration tools
// (`team-builtin-tools.ts`) need to know WHICH teammate (and team/run) issued a
// call, but the `plugin_tool_exec` wire only carries `sessionId`. `runToolEnabled`
// registers the identity here keyed by the session id and clears it in `finally`;
// `plugin-tool-ipc` reads it back to bind the tool call to its caller.

export interface TeamDispatchContext {
  teamId: string
  teammateId: string
  teammateName: string
  runId?: string
}

const teamContexts = new Map<string, TeamDispatchContext>()

/** Record the team identity a dispatch session runs as (called by runToolEnabled). */
export function registerTeamDispatchContext(sessionId: string, ctx: TeamDispatchContext): void {
  if (!sessionId) return
  teamContexts.set(sessionId, ctx)
}

/** Look up the team identity for a session, or `undefined` for a non-team session. */
export function getTeamDispatchContext(sessionId: string): TeamDispatchContext | undefined {
  return teamContexts.get(sessionId)
}

/** Drop a session's team identity. Called from the dispatch `finally`. */
export function clearTeamDispatchContext(sessionId: string): void {
  teamContexts.delete(sessionId)
}

/** Test-only: wipe the whole registry between cases. */
export function __clearAllDispatchContextsForTesting(): void {
  registry.clear()
  resolvedCeilings.clear()
  teamContexts.clear()
}
