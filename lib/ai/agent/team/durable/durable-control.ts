import {
  appendAgentTeamTrajectory,
  getAgentTeamRun,
  listAgentTeamChildRuns,
  updateAgentTeamRun,
} from "@/lib/db/agent-team-runtime"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import { getDurableTeamCoordinator, type DurableTeamCoordinator } from "./durable-runtime"

export type DurableRunControlAction = "pause" | "resume" | "sleep" | "wake" | "stop" | "terminate"

const TERMINAL_CHILDREN = new Set(["completed", "failed", "cancelled", "terminated"])

export interface DurableRunControlOptions {
  coordinator?: DurableTeamCoordinator
  now?: () => number
}

/**
 * Run-wide control surface shared by the command center and team workspace.
 * Provider handles stay process-local; every requested and resulting state is
 * persisted so another renderer can project the same control outcome.
 */
export async function controlDurableRun(
  runId: string,
  action: DurableRunControlAction,
  options: DurableRunControlOptions = {}
): Promise<void> {
  const coordinator = options.coordinator ?? getDurableTeamCoordinator()
  const now = options.now ?? Date.now
  const run = await getAgentTeamRun(runId)
  if (!run) throw new Error(`Unknown durable AgentTeam run: ${runId}`)
  const children = (await listAgentTeamChildRuns(runId)).filter(
    (child) => !TERMINAL_CHILDREN.has(child.status)
  )
  const at = now()
  const requestedStatus: AgentTeamRunStatus =
    action === "pause"
      ? "pausing"
      : action === "sleep"
        ? "sleeping"
        : action === "stop"
          ? "cancelled"
          : action === "terminate"
            ? "terminated"
            : "running"
  await updateAgentTeamRun(runId, { status: requestedStatus, updatedAt: at })
  if (action === "pause" || action === "sleep") coordinator.setRunPaused(runId, true)
  if (action === "resume" || action === "wake") coordinator.setRunPaused(runId, false)
  const operation =
    action === "pause"
      ? coordinator.pauseChild
      : action === "resume"
        ? coordinator.resumeChild
        : action === "sleep"
          ? coordinator.sleepChild
          : action === "wake"
            ? coordinator.wakeChild
            : coordinator.terminateChild
  await Promise.all(children.map((child) => operation(child.id)))
  const finalStatus: AgentTeamRunStatus =
    action === "pause"
      ? "paused"
      : action === "sleep"
        ? "sleeping"
        : action === "stop"
          ? "cancelled"
          : action === "terminate"
            ? "terminated"
            : "running"
  const completedAt =
    finalStatus === "cancelled" || finalStatus === "terminated" ? now() : undefined
  await updateAgentTeamRun(runId, {
    status: finalStatus,
    ...(completedAt ? { completedAt } : {}),
    updatedAt: now(),
  })
  await appendAgentTeamTrajectory({
    runId,
    kind: "run_controlled",
    correlationId: `run-control:${runId}:${at}`,
    payload: { action, childCount: children.length },
    createdAt: now(),
  })
}

/**
 * Redirect a durable team run without stopping it.
 *
 * Fans out to every child that can still act, because a team's work is spread
 * across children — steering only the lead would leave the workers running on
 * the instruction the person just corrected.
 *
 * The coordinator's own `steer` owns the PII gate and the durable receipt, and
 * it is the receipt that makes this safe to call when nothing is live: an
 * undelivered steer stays `queued` and the next provider turn consumes it at
 * its next safe boundary. So "no live control attached" is not a failure here —
 * it is the durable path working. Only "no child can act at all" is.
 */
export async function steerDurableRun(
  runId: string,
  message: string,
  options: DurableRunControlOptions = {}
): Promise<{ receiptIds: string[]; childCount: number }> {
  const coordinator = options.coordinator ?? getDurableTeamCoordinator()
  const now = options.now ?? Date.now
  const run = await getAgentTeamRun(runId)
  if (!run) throw new Error(`Unknown durable AgentTeam run: ${runId}`)
  const children = (await listAgentTeamChildRuns(runId)).filter(
    (child) => !TERMINAL_CHILDREN.has(child.status)
  )
  if (children.length === 0) return { receiptIds: [], childCount: 0 }

  const receipts = await Promise.all(
    children.map(async (child) => {
      try {
        return (await coordinator.steer(child.id, message)).id
      } catch {
        // One refusing child must not swallow the correction for the others.
        return undefined
      }
    })
  )
  const receiptIds = receipts.filter((id): id is string => typeof id === "string")
  await appendAgentTeamTrajectory({
    runId,
    kind: "run_controlled",
    correlationId: `run-steer:${runId}:${now()}`,
    // Receipt ids only. The message text lives in the receipt rows, which are
    // redaction-gated; the trajectory is a projection surface.
    payload: { action: "steer", childCount: children.length, receiptIds },
    createdAt: now(),
  })
  return { receiptIds, childCount: children.length }
}

export async function controlDurableRuns(
  runIds: string[],
  action: DurableRunControlAction,
  options: DurableRunControlOptions = {}
): Promise<Array<{ runId: string; error?: string }>> {
  return Promise.all(
    [...new Set(runIds)].map(async (runId) => {
      try {
        await controlDurableRun(runId, action, options)
        return { runId }
      } catch (error) {
        return { runId, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}
