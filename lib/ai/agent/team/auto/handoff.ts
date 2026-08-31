/**
 * Handoff executors for auto-orchestration proposals.
 *
 * `chooseExecutor` can decide `background-handoff` / `external-handoff`, but
 * until now those kinds were labels only — every consumer just materialized
 * an ordinary team. This module gives them real semantics:
 *
 *  • background-handoff → materialize + enqueue a ONE-SHOT `agent-team`
 *    scheduler task (`lib/scheduler/executors/team-executor.ts` runs it).
 *    Completion / failure notifications come free from the scheduler's
 *    `notifyTaskEvent` integration — no second notifier here.
 *  • external-handoff → materialize + stamp `externalPickup.requestedAt` so
 *    the team shows as "awaiting external pickup" in the workspace and via
 *    the external bridge's `team_list`; an external agent claims it through
 *    the bridge's `team_run` (which stamps `claimedBy`/`claimedAt`).
 *
 * Store-bound (desktop / renderer) — same layer as `materialize.ts`. The
 * scheduler + notification center are lazy-imported so this module stays out
 * of paths that never hand off (and out of the web build until used).
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { loggers } from "@cognia/logging"
import type { AgentTeamTaskPayload } from "@/types/scheduler"
import { materializeProposal, type MaterializeOptions, type MaterializeResult } from "./materialize"
import type { AutoOrchestrationProposal } from "./types"

const log = loggers.agent

/** Delay before the one-shot background run fires. The scheduler's `once`
 *  trigger requires a strictly-future `runAt`, and a short grace window lets
 *  the operator cancel from the scheduler UI before the run starts. */
const DEFAULT_RUN_DELAY_MS = 15_000

export interface BackgroundHandoffOptions extends MaterializeOptions {
  /** Delay before the scheduled run fires. Defaults to 15 s. */
  runDelayMs?: number
}

export interface BackgroundHandoffResult extends MaterializeResult {
  /**
   * The one-shot scheduler task id. Absent when scheduling was unavailable
   * (e.g. web build) — the team still exists; the caller should tell the
   * operator to start it manually from the workspace.
   */
  scheduledTaskId?: string
}

/** Injectable seams so tests never touch the real scheduler / notifier. */
export interface HandoffDeps {
  materialize?: typeof materializeProposal
  getScheduler?: () => Promise<{
    createTask: (input: {
      name: string
      description?: string
      type: "agent-team"
      trigger: { type: "once"; runAt: Date }
      payload: AgentTeamTaskPayload
      notification?: { onStart?: boolean; onComplete?: boolean; onError?: boolean }
    }) => Promise<{ id: string }>
  }>
  notify?: (input: {
    source: "agent-team"
    level: "info"
    title: string
    body: string
    href?: string
    sourceRef?: { kind: string; id: string }
  }) => Promise<string>
}

async function defaultGetScheduler(): ReturnType<NonNullable<HandoffDeps["getScheduler"]>> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return getTaskScheduler()
}

async function defaultNotify(
  input: Parameters<NonNullable<HandoffDeps["notify"]>>[0]
): Promise<string> {
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input)
}

/**
 * Materialize the proposal and queue it as a one-shot background scheduler
 * run. Degrades honestly: if `createTask` throws, the team is still created
 * and the result carries no `scheduledTaskId`.
 */
export async function materializeBackgroundHandoff(
  proposal: AutoOrchestrationProposal,
  opts: BackgroundHandoffOptions = {},
  deps: HandoffDeps = {}
): Promise<BackgroundHandoffResult> {
  const materialize = deps.materialize ?? materializeProposal
  const result = materialize(proposal, opts)
  const teamName = useAgentTeamStore.getState().teams[result.teamId]?.name ?? "Auto team"

  try {
    const scheduler = await (deps.getScheduler ?? defaultGetScheduler)()
    const task = await scheduler.createTask({
      name: `Team: ${teamName}`,
      description: proposal.assessment.reason,
      type: "agent-team",
      trigger: {
        type: "once",
        // Strictly in the future — `normalizeTaskTrigger` rejects past times.
        runAt: new Date(Date.now() + (opts.runDelayMs ?? DEFAULT_RUN_DELAY_MS)),
      },
      payload: { teamId: result.teamId } satisfies AgentTeamTaskPayload,
      // Merged over DEFAULT_NOTIFICATION_CONFIG by createTask; completion /
      // failure delivery then flows through `notifyTaskEvent`.
      notification: { onComplete: true, onError: true },
    })
    return { ...result, scheduledTaskId: task.id }
  } catch (err) {
    log.warn("background-handoff: scheduler unavailable; team created without a queued run", {
      teamId: result.teamId,
      err: err instanceof Error ? err.message : String(err),
    })
    return result
  }
}

/**
 * Materialize the proposal and mark the team as awaiting external pickup.
 * Fires one info notification (runtime notifications are English by
 * precedent — see TeamNotifier) pointing at the team workspace.
 */
export async function materializeExternalHandoff(
  proposal: AutoOrchestrationProposal,
  opts: MaterializeOptions = {},
  deps: HandoffDeps = {}
): Promise<MaterializeResult> {
  const materialize = deps.materialize ?? materializeProposal
  const result = materialize(proposal, opts)
  const store = useAgentTeamStore.getState()
  store.updateTeam(result.teamId, { externalPickup: { requestedAt: new Date() } })
  const teamName = store.teams[result.teamId]?.name ?? "Auto team"

  try {
    await (deps.notify ?? defaultNotify)({
      source: "agent-team",
      level: "info",
      title: "Team awaiting external pickup",
      body: `"${teamName}" is marked for external pickup — an external agent can claim it via the Cognia bridge (team_list / team_run).`,
      href: `/squads?id=${result.teamId}`,
      sourceRef: { kind: "team-run", id: result.teamId },
    })
  } catch (err) {
    // Notification delivery is best-effort; the pickup stamp is the contract.
    log.warn("external-handoff: notification delivery failed", {
      teamId: result.teamId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return result
}
