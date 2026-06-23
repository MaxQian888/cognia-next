/**
 * Delegation orchestrator — thin business logic on top of the store's
 * `upsertDelegation` / `updateDelegationStatus` / `clearTeamDelegations`
 * actions, bridging team-side delegations into the existing background-agent
 * and external-agent runtimes.
 *
 * What it adds beyond plain store CRUD:
 *   - `delegateToBackground`: builds a `TeamDelegationRecord`, persists it,
 *     fires `onTeamDelegationStart`, then dispatches the task through
 *     `executeAgent` with the background-agent manager's abort signal.
 *     When the run settles, calls `updateDelegationStatus` and fires
 *     `onTeamDelegationComplete`.
 *   - `delegateToExternal`: same lifecycle but routes to the
 *     `ExternalAgentManager`. Mirrors `delegateToBackground`: persists the
 *     record, fires the start hook, then awaits `manager.execute` behind a
 *     watchdog timeout and self-settles (`completed` / `failed` / `timeout`).
 *     `completeExternalDelegation` remains as a manual escape hatch for
 *     out-of-band runtimes that settle themselves.
 *   - `approveDelegation`: releases an `awaiting_approval` delegation and
 *     RE-DISPATCHES the original run (background or external) using the run
 *     params stashed at create time, so a quiet-hours / approval-gated
 *     delegation actually executes once approved.
 *   - `cancelDelegation`: aborts an in-flight delegation and flips status
 *     to `cancelled`. No new hook fires (consumers tail
 *     `selectActiveTeamDelegations` for status flips).
 *
 * Thin by design — every store mutation funnels through existing actions
 * so persistence / event-log wiring stays in one place.
 */

import { nanoid } from "nanoid"
import type {
  AgentSystemType,
  TeamDelegationRecord,
  TeamDelegationStatus,
} from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { getBackgroundAgentManager } from "@/lib/ai/agent/background-agent-manager"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { abortTeam } from "@/lib/ai/agent/agent-team-runtime"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"

/**
 * True when the team has a quiet-hours window configured and `now` falls
 * inside it. Returns false when no policy is set so the common path is free.
 */
function isDelegationQuietGated(sourceTeamId: string, nowMs: number = Date.now()): boolean {
  const quietHours =
    useAgentTeamStore.getState().teams[sourceTeamId]?.config.governancePolicy?.delivery?.quietHours
  if (!quietHours) return false
  return isInQuietHours(nowMs, quietHours.from, quietHours.to, quietHours.tz)
}

/** Default watchdog for a delegated run before it is settled as `timeout`. */
const DEFAULT_DELEGATION_TIMEOUT_MS = 600_000

/**
 * Non-persisted run params for delegations that may be (re-)dispatched later —
 * notably ones deferred to `awaiting_approval` by quiet hours / approval gates.
 * Kept in memory (NOT in the persisted store) so raw prompts never hit disk;
 * the trade-off is that an approval surviving a reload can no longer auto-run
 * (it stays `awaiting_approval` for the operator to re-issue). Keyed by
 * delegationId.
 */
interface PendingRun {
  kind: "background" | "external"
  prompt: string
  systemPrompt?: string
  /** background: the registered agent id; external: the target agent id. */
  targetId: string
  sourceTeamId: string
  timeoutMs?: number
}
const pendingRuns = new Map<string, PendingRun>()

/** Test-only: drop all stashed pending runs so suites start clean. */
export function __resetPendingDelegationRunsForTesting(): void {
  pendingRuns.clear()
}

/**
 * Run a background-agent delegation to terminal: register the abort signal,
 * drive `executeAgent`, then settle the record + fire the complete hook.
 * Shared by `delegateToBackground` (immediate path) and `approveDelegation`
 * (gated path released later).
 */
function runBackgroundDelegation(
  delegationId: string,
  agentId: string,
  prompt: string,
  systemPrompt: string | undefined
): Promise<TeamDelegationRecord | undefined> {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()
  const signal = getBackgroundAgentManager().registerAgent(agentId, {
    label: `team-delegation:${delegationId}`,
  })
  return (async (): Promise<TeamDelegationRecord | undefined> => {
    try {
      const result = await executeAgent(prompt, { systemPrompt, abortSignal: signal })
      const finalStatus: TeamDelegationStatus = signal.aborted ? "cancelled" : "completed"
      store.updateDelegationStatus(delegationId, finalStatus, result.text)
      getBackgroundAgentManager().finishAgent(agentId)
      hooks.dispatchOnTeamDelegationComplete({ delegationId, status: finalStatus })
    } catch (err) {
      const status: TeamDelegationStatus = signal.aborted ? "cancelled" : "failed"
      const message = err instanceof Error ? err.message : String(err)
      store.updateDelegationStatus(delegationId, status, message)
      getBackgroundAgentManager().finishAgent(agentId)
      hooks.dispatchOnTeamDelegationComplete({ delegationId, status })
    } finally {
      pendingRuns.delete(delegationId)
    }
    return useAgentTeamStore.getState().delegations[delegationId]
  })()
}

/**
 * Run an external-agent delegation to terminal: drive `manager.execute` behind
 * a watchdog timeout, then settle the record. Shared by `delegateToExternal`
 * (immediate path) and `approveDelegation` (gated path released later).
 */
function runExternalDelegation(
  delegationId: string,
  targetAgentId: string,
  prompt: string,
  systemPrompt: string | undefined,
  sourceTeamId: string,
  timeoutMs: number = DEFAULT_DELEGATION_TIMEOUT_MS
): Promise<TeamDelegationRecord | undefined> {
  return (async (): Promise<TeamDelegationRecord | undefined> => {
    let timedOut = false
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    timeoutSignal.addEventListener("abort", () => {
      timedOut = true
    })
    try {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const workingDirectory = useAgentTeamStore.getState().teams[sourceTeamId]?.config?.workingDir
      const result = await getExternalAgentManager().execute(targetAgentId, prompt, {
        systemPrompt,
        ...(workingDirectory ? { workingDirectory } : {}),
        signal: timeoutSignal,
      })
      if (!result.success) {
        return settleTeamDelegation(
          delegationId,
          "failed",
          result.error || `external agent ${targetAgentId} returned a failure`
        )
      }
      return settleTeamDelegation(delegationId, "completed", result.finalResponse ?? "")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return settleTeamDelegation(delegationId, timedOut ? "timeout" : "failed", message)
    } finally {
      pendingRuns.delete(delegationId)
    }
  })()
}

export interface DelegateToBackgroundInput {
  sourceTeamId: string
  sourceTaskId: string
  prompt: string
  /** Optional system prompt for the spawned background agent. */
  systemPrompt?: string
  /** Free-form reason — surfaced in workspace UI + audit log. */
  reason: string
  /** When true, the delegation requires approval before run starts. */
  awaitingApproval?: boolean
  /** Optional ad-hoc tag attached to the delegation record metadata. */
  metadata?: Record<string, unknown>
  /** Optional id of the background-agent run; defaults to nanoid. */
  backgroundAgentId?: string
  /**
   * Operator override — when true, launch even inside the team's quiet-hours
   * window. Default false: a quiet-hours-gated delegation is deferred to
   * `awaiting_approval` for the operator to release later.
   */
  force?: boolean
}

export interface DelegateToExternalInput {
  sourceTeamId: string
  sourceTaskId: string
  /** Target external agent id (e.g. "claude-code" / "codex"). */
  targetAgentId: string
  /** The prompt handed to the external agent. */
  prompt: string
  /** Optional system prompt for the external run. */
  systemPrompt?: string
  reason: string
  metadata?: Record<string, unknown>
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
  /** Watchdog timeout (ms) before the run is settled as `timeout`. */
  timeoutMs?: number
}

/** Build a fresh delegation record with the canonical lifecycle defaults. */
function buildDelegation(input: {
  sourceTeamId: string
  sourceTaskId: string
  targetType: AgentSystemType
  targetId?: string
  reason: string
  manual?: boolean
  metadata?: Record<string, unknown>
  status?: TeamDelegationStatus
}): TeamDelegationRecord {
  const now = new Date()
  return {
    id: nanoid(),
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: input.targetType,
    targetId: input.targetId,
    status: input.status ?? "active",
    reason: input.reason,
    manual: input.manual ?? true,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
  }
}

/**
 * Delegate a task to a background agent. The orchestrator:
 *   1. Persists a `TeamDelegationRecord` in `active` status (or
 *      `awaiting_approval` when the input says so).
 *   2. Fires `onTeamDelegationStart`.
 *   3. Registers the background-agent abort signal.
 *   4. Calls `executeAgent`. On settle, transitions the delegation to
 *      `completed` / `failed` / `cancelled` and fires
 *      `onTeamDelegationComplete`.
 *
 * Returns the initial delegation record synchronously; callers await
 * `delegation.completionPromise` for the final state.
 */
export function delegateToBackground(input: DelegateToBackgroundInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()
  const agentId = input.backgroundAgentId ?? `bg_${nanoid(10)}`
  // Defer to awaiting_approval when launched inside quiet hours without an
  // explicit operator override — the operator releases it later.
  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const deferred = Boolean(input.awaitingApproval) || quietDeferred
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "background",
    targetId: agentId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: deferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  // Stash the run params so a gated delegation can be re-dispatched on approval.
  pendingRuns.set(delegation.id, {
    kind: "background",
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetId: agentId,
    sourceTeamId: input.sourceTeamId,
  })
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (deferred) {
      // The operator transitions out of awaiting_approval via
      // `approveDelegation` (which re-dispatches) / `cancelDelegation`.
      return delegation
    }
    const settled = await runBackgroundDelegation(
      delegation.id,
      agentId,
      input.prompt,
      input.systemPrompt
    )
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

/**
 * Delegate to an external agent (Claude Code / Codex / etc.). Mirrors
 * `delegateToBackground`: persists the record, fires the start hook, then
 * awaits `manager.execute` behind a watchdog timeout and self-settles. When
 * deferred by quiet hours, stays `awaiting_approval` and is re-dispatched by
 * `approveDelegation`. `completeExternalDelegation` remains as a manual escape
 * hatch for runtimes that settle out-of-band.
 *
 * Returns the initial record synchronously; callers await `completionPromise`
 * for the final state.
 */
export function delegateToExternal(input: DelegateToExternalInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "sub_agent",
    targetId: input.targetAgentId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: quietDeferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  pendingRuns.set(delegation.id, {
    kind: "external",
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetId: input.targetAgentId,
    sourceTeamId: input.sourceTeamId,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  })
  getPluginLifecycleHooks().dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (quietDeferred) return delegation
    const settled = await runExternalDelegation(
      delegation.id,
      input.targetAgentId,
      input.prompt,
      input.systemPrompt,
      input.sourceTeamId,
      input.timeoutMs
    )
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

export interface DelegateToTeamInput {
  sourceTeamId: string
  sourceTaskId: string
  /** The team that will run this delegated work. */
  targetTeamId: string
  reason: string
  metadata?: Record<string, unknown>
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
  /** Force ultracode orchestration on the target team run. */
  ultracode?: boolean
}

/**
 * True when delegating `source → target` would close a cycle in the ACTIVE
 * team-delegation graph (target already reaches source, or target === source).
 * Walks only `team`-typed delegations in a non-terminal status, so resolved
 * delegations never block a fresh one.
 */
export function wouldCreateTeamCycle(sourceTeamId: string, targetTeamId: string): boolean {
  if (sourceTeamId === targetTeamId) return true
  const delegations = Object.values(useAgentTeamStore.getState().delegations)
  const edges = new Map<string, Set<string>>()
  for (const d of delegations) {
    if (
      d.targetType === "team" &&
      d.targetId &&
      (d.status === "active" || d.status === "awaiting_approval")
    ) {
      if (!edges.has(d.sourceTeamId)) edges.set(d.sourceTeamId, new Set())
      edges.get(d.sourceTeamId)!.add(d.targetId)
    }
  }
  // Is `source` reachable FROM `target`? If so, target→…→source→target cycles.
  const seen = new Set<string>()
  const stack = [targetTeamId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === sourceTeamId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return false
}

/**
 * Delegate a task to ANOTHER team (team → team). Runs the target team to
 * terminal via `agentTeamManager.start`, then settles the delegation with the
 * target team's terminal status + `finalResult`. Rejects cycles up front, honors
 * the quiet-hours gate (defers to `awaiting_approval`), and fires the same
 * start / complete hooks as the other delegation paths.
 *
 * Returns the initial record synchronously; callers await `completionPromise`.
 */
export function delegateToTeam(input: DelegateToTeamInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()

  if (wouldCreateTeamCycle(input.sourceTeamId, input.targetTeamId)) {
    const failed = buildDelegation({
      sourceTeamId: input.sourceTeamId,
      sourceTaskId: input.sourceTaskId,
      targetType: "team",
      targetId: input.targetTeamId,
      reason: input.reason,
      metadata: { ...input.metadata, error: "team delegation cycle rejected" },
      status: "failed",
    })
    store.upsertDelegation(failed)
    return { delegation: failed, completionPromise: Promise.resolve(failed) }
  }

  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "team",
    targetId: input.targetTeamId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: quietDeferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (quietDeferred) return delegation
    try {
      // Lazy import keeps the heavy team runtime out of this module's graph.
      const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
      if (!agentTeamManager.get(input.targetTeamId)) {
        return settleTeamDelegation(
          delegation.id,
          "failed",
          `target team not found: ${input.targetTeamId}`
        )
      }
      await agentTeamManager.start(
        input.targetTeamId,
        input.ultracode !== undefined ? { ultracode: input.ultracode } : undefined
      )
      const target = useAgentTeamStore.getState().teams[input.targetTeamId]
      const ok = target?.status === "completed" || target?.status === "idle"
      return settleTeamDelegation(delegation.id, ok ? "completed" : "failed", target?.finalResult)
    } catch (err) {
      return settleTeamDelegation(
        delegation.id,
        "failed",
        err instanceof Error ? err.message : String(err)
      )
    }
  })()

  return { delegation, completionPromise }
}

function settleTeamDelegation(
  delegationId: string,
  status: "completed" | "failed" | "cancelled" | "timeout",
  result?: string
): TeamDelegationRecord {
  const store = useAgentTeamStore.getState()
  store.updateDelegationStatus(delegationId, status, result)
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({ delegationId, status })
  return useAgentTeamStore.getState().delegations[delegationId]
}

/**
 * Settle an external delegation once the external runtime returns. The
 * external manager / UI calls this when the run completes; we update the
 * store and fire `onTeamDelegationComplete`.
 */
export function completeExternalDelegation(
  delegationId: string,
  status: "completed" | "failed" | "cancelled" | "timeout",
  result?: string
): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current) return undefined
  store.updateDelegationStatus(delegationId, status, result)
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({
    delegationId,
    status,
  })
  return useAgentTeamStore.getState().delegations[delegationId] ?? current
}

/**
 * Approve a delegation that was created in `awaiting_approval` status.
 * Transitions to `active` and RE-DISPATCHES the original run (background or
 * external) using the run params stashed at create time. When no pending run
 * is found (e.g. the app reloaded and the in-memory params were lost) the
 * status still flips to `active` for an operator to re-issue manually.
 *
 * Returns the record synchronously after flipping to `active`; the re-dispatch
 * settles asynchronously via the same complete hook as the immediate paths.
 */
export function approveDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current || current.status !== "awaiting_approval") return current
  store.updateDelegationStatus(delegationId, "active")

  const pending = pendingRuns.get(delegationId)
  if (pending?.kind === "background") {
    void runBackgroundDelegation(
      delegationId,
      pending.targetId,
      pending.prompt,
      pending.systemPrompt
    )
  } else if (pending?.kind === "external") {
    void runExternalDelegation(
      delegationId,
      pending.targetId,
      pending.prompt,
      pending.systemPrompt,
      pending.sourceTeamId,
      pending.timeoutMs
    )
  }
  return useAgentTeamStore.getState().delegations[delegationId]
}

/**
 * Cancel an in-flight delegation. Aborts the background-agent signal when
 * applicable, transitions status to `cancelled`. Fires the complete hook
 * so consumers can clean up.
 */
export function cancelDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current) return undefined
  if (current.status === "completed" || current.status === "failed") return current
  // Drop any stashed run params so a cancelled (esp. deferred) delegation can
  // never be re-dispatched by a later approval.
  pendingRuns.delete(delegationId)
  if (current.targetType === "background" && current.targetId) {
    getBackgroundAgentManager().cancelAgent(current.targetId)
  } else if (current.targetType === "team" && current.targetId) {
    abortTeam(current.targetId, "team delegation cancelled")
  }
  store.updateDelegationStatus(delegationId, "cancelled")
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({
    delegationId,
    status: "cancelled",
  })
  return useAgentTeamStore.getState().delegations[delegationId] ?? current
}
