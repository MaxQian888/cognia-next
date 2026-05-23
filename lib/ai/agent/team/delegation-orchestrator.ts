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
 *     `ExternalAgentManager`. Today this stops at the manager.execute call
 *     and trusts the manager to settle; the orchestrator listens for the
 *     reply via a one-shot promise so the same status updates flow.
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
  reason: string
  metadata?: Record<string, unknown>
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
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
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const signal = getBackgroundAgentManager().registerAgent(agentId, {
    label: `team-delegation:${delegation.id}`,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (deferred) {
      // The operator transitions out of awaiting_approval via
      // `approveDelegation` / `cancelDelegation`.
      return delegation
    }
    try {
      const result = await executeAgent(input.prompt, {
        systemPrompt: input.systemPrompt,
        abortSignal: signal,
      })
      const finalStatus: TeamDelegationStatus = signal.aborted ? "cancelled" : "completed"
      store.updateDelegationStatus(delegation.id, finalStatus, result.text)
      getBackgroundAgentManager().finishAgent(agentId)
      hooks.dispatchOnTeamDelegationComplete({
        delegationId: delegation.id,
        status: finalStatus,
      })
      return useAgentTeamStore.getState().delegations[delegation.id] ?? delegation
    } catch (err) {
      const status: TeamDelegationStatus = signal.aborted ? "cancelled" : "failed"
      const message = err instanceof Error ? err.message : String(err)
      store.updateDelegationStatus(delegation.id, status, message)
      getBackgroundAgentManager().finishAgent(agentId)
      hooks.dispatchOnTeamDelegationComplete({ delegationId: delegation.id, status })
      return useAgentTeamStore.getState().delegations[delegation.id] ?? delegation
    }
  })()

  return { delegation, completionPromise }
}

/**
 * Delegate to an external agent (Claude Code / Codex / etc.). Persists +
 * fires the start hook; settlement happens when the caller invokes
 * `completeExternalDelegation(id, status, result?)` after the external
 * runtime returns. This matches the asynchronous, out-of-process nature
 * of the external manager — the orchestrator does not wait for an
 * external reply itself.
 */
export function delegateToExternal(input: DelegateToExternalInput): TeamDelegationRecord {
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
  getPluginLifecycleHooks().dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })
  return delegation
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
 * Transitions to `active` and re-dispatches the background run when the
 * original delegation targeted the background runtime.
 */
export function approveDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current || current.status !== "awaiting_approval") return current
  store.updateDelegationStatus(delegationId, "active")
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
  if (current.targetType === "background" && current.targetId) {
    getBackgroundAgentManager().cancelAgent(current.targetId)
  }
  store.updateDelegationStatus(delegationId, "cancelled")
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({
    delegationId,
    status: "cancelled",
  })
  return useAgentTeamStore.getState().delegations[delegationId] ?? current
}
