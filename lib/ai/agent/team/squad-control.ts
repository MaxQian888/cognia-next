/**
 * The one control state machine for a Squad run (ADR-0168).
 *
 * Every surface that pauses, resumes, stops or retries a Squad lands here:
 * the cockpit's control plane (`control-handlers.ts`), the fleet inspector,
 * the Settings panel, a paired phone's command, the CLI and the connectors.
 * There used to be two implementations (a legacy one over the in-process
 * abort controller and a durable one over the coordinator), chosen by a
 * runtime selector that no longer exists.
 *
 *   pause   cooperative. The coordinator stops admitting children and each
 *           one checkpoints at its next safe boundary. Resumable.
 *   resume  continues from the latest VERIFIED SAFE checkpoint only. A live
 *           lifecycle is simply unpaused. A lifecycle that exited (restart,
 *           earlier abort) is re-entered over the remaining work, unless a
 *           child's last checkpoint is uncertain, in which case the run is
 *           parked on a `team_recovery` decision instead of being replayed.
 *   stop    terminal. Cascades to every child and denies every pending
 *           interrupt. Not resumable. The visible destructive action.
 *   retry   creates a linked replacement run through `startSquadRun`. The
 *           settled history is never touched (see `run-control.ts`).
 *   steer   queues durable receipts through the coordinator, which owns the
 *           PII gate for the text (`durable-control.ts`).
 *
 * Everything requested and everything that resulted is persisted, so another
 * renderer projects the same outcome.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  getAgentTeamRun,
  getLatestAgentTeamCheckpoint,
  listAgentTeamChildRuns,
  updateAgentTeamRun,
} from "@/lib/db/agent-team-runtime"
import { getExecutionRun, runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import type { AgentTeamRunRecord, AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import { abortTeam } from "../agent-team-runtime"
import { controlDurableRun } from "./durable-control"
import { isTerminalSquadRunStatus } from "./squad-run-records"
import { getTeamRunContext } from "./team-run-context"

export type SquadControlAction = "pause" | "resume" | "stop"

export type SquadControlRefusal =
  | "run_not_found"
  | "already_terminal"
  | "not_pausable"
  | "not_resumable"
  /** The latest checkpoint is not verified safe. A `team_recovery` decision is required. */
  | "recovery_required"

export interface SquadControlResult {
  ok: boolean
  reason?: SquadControlRefusal
  status?: AgentTeamRunStatus
}

const PAUSABLE: ReadonlySet<AgentTeamRunStatus> = new Set(["queued", "running", "recovering"])
const RESUMABLE: ReadonlySet<AgentTeamRunStatus> = new Set([
  "paused",
  "pausing",
  "sleeping",
  "needs_input",
])

export interface SquadControlDeps {
  now?: () => number
  /** Re-enter the lifecycle over the remaining work (the resume path). */
  reenter?: (input: { teamId: string; runId: string }) => Promise<unknown>
  /** Whether a lifecycle for this run is alive in this process. */
  isLive?: (runId: string) => boolean
  /** Deny every pending interrupt of the run (stop). */
  denyPendingInterrupts?: (executionRunId: string, now: number) => Promise<void>
}

async function journal(
  runId: string,
  type: "run.paused" | "run.resumed" | "run.cancelled" | "run.waiting",
  reason: string,
  now: number
): Promise<void> {
  const executionRunId = agentTeamExecutionRunId(runId)
  const executionRun = await getExecutionRun(executionRunId).catch(() => undefined)
  if (!executionRun) return
  if (["completed", "failed", "cancelled"].includes(executionRun.status)) return
  await runEventJournal
    .append(
      executionRunId,
      semanticRunEvent(
        type,
        { reason },
        { ts: now, sourceEventId: `agent-team:${runId}:${type}:${now}` }
      )
    )
    .catch(() => undefined)
}

async function defaultDenyPendingInterrupts(executionRunId: string, now: number): Promise<void> {
  const { getDb } = await import("@/lib/db/schema")
  const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
  const pending = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([executionRunId, "pending"])
    .toArray()
  for (const interrupt of pending) {
    await expireRunInterruptFromSource(executionRunId, interrupt.id, now).catch(() => undefined)
  }
}

async function defaultReenter(input: { teamId: string; runId: string }): Promise<unknown> {
  const { prepareSquadResume, resumeTaskFilter, runSquadLifecycle } =
    await import("./squad-lifecycle-runner")
  const { remaining } = await prepareSquadResume(input.teamId)
  if (remaining === 0) {
    const now = Date.now()
    await updateAgentTeamRun(input.runId, { status: "completed", completedAt: now, updatedAt: now })
    const { settleAgentTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
    const run = await getAgentTeamRun(input.runId)
    if (run) await settleAgentTeamExecutionRun(run, "completed", now).catch(() => undefined)
    useAgentTeamStore.getState().setTeamStatus(input.teamId, "completed")
    const { emitTeamCompletedSchedulerEvent } = await import("./squad-lifecycle-runner")
    void emitTeamCompletedSchedulerEvent(input.teamId, "completed")
    return undefined
  }
  return runSquadLifecycle({
    teamId: input.teamId,
    runId: input.runId,
    taskFilter: resumeTaskFilter,
  })
}

/**
 * Whether every child of the run can be replayed from a verified safe point.
 *
 * The same rule the coordinator applies at restart: a child with no
 * checkpoint, a `needs_input` checkpoint, or an unknown/unsafe pending side
 * effect is uncertain, and an uncertain run is never silently replayed.
 */
export async function assessSquadRunReplay(
  runId: string
): Promise<{ safe: boolean; uncertainChildIds: string[] }> {
  const children = await listAgentTeamChildRuns(runId)
  const uncertain: string[] = []
  for (const child of children) {
    if (["completed", "cancelled", "terminated"].includes(child.status)) continue
    const checkpoint = await getLatestAgentTeamCheckpoint(child.id)
    const unsafe =
      !checkpoint ||
      checkpoint.replay === "needs_input" ||
      checkpoint.sideEffects.some(
        (effect) =>
          effect.state === "unknown" || (effect.state === "intent" && effect.replay !== "safe")
      )
    // A child that never started has nothing to replay and is safe to re-queue.
    if (unsafe && child.status !== "queued") uncertain.push(child.id)
  }
  return { safe: uncertain.length === 0, uncertainChildIds: uncertain }
}

export async function controlSquadRun(
  runId: string,
  action: SquadControlAction,
  deps: SquadControlDeps = {}
): Promise<SquadControlResult> {
  const now = deps.now ?? Date.now
  const isLive = deps.isLive ?? ((id: string) => getTeamRunContext(id) !== undefined)
  const run = await getAgentTeamRun(runId)
  if (!run) return { ok: false, reason: "run_not_found" }
  if (isTerminalSquadRunStatus(run.status)) {
    return { ok: false, reason: "already_terminal", status: run.status }
  }

  if (action === "pause") {
    if (!PAUSABLE.has(run.status)) return { ok: false, reason: "not_pausable", status: run.status }
    await controlDurableRun(runId, "pause", { now })
    await journal(runId, "run.paused", "operator_pause", now())
    useAgentTeamStore.getState().setTeamStatus(run.teamId, "paused")
    return { ok: true, status: "paused" }
  }

  if (action === "resume") {
    if (!RESUMABLE.has(run.status)) {
      return { ok: false, reason: "not_resumable", status: run.status }
    }
    if (isLive(runId)) {
      await controlDurableRun(runId, "resume", { now })
      await journal(runId, "run.resumed", "operator_resume", now())
      useAgentTeamStore.getState().setTeamStatus(run.teamId, "executing")
      return { ok: true, status: "running" }
    }
    const replay = await assessSquadRunReplay(runId)
    if (!replay.safe) {
      const at = now()
      await updateAgentTeamRun(runId, {
        status: "needs_input",
        recoveryReason: "uncertain_side_effect",
        updatedAt: at,
      })
      await journal(runId, "run.waiting", "team_recovery", at)
      useAgentTeamStore.getState().setTeamStatus(run.teamId, "paused")
      return { ok: false, reason: "recovery_required", status: "needs_input" }
    }
    const at = now()
    await updateAgentTeamRun(runId, { status: "running", recoveryReason: undefined, updatedAt: at })
    await journal(runId, "run.resumed", "operator_resume", at)
    // Fire-and-forget, like a start: a re-entered lifecycle can run for
    // minutes and every caller has something to acknowledge quickly.
    void (deps.reenter ?? defaultReenter)({ teamId: run.teamId, runId }).catch(() => undefined)
    return { ok: true, status: "running" }
  }

  // stop: terminal cancellation. Abort the in-process lifecycle (its `finally`
  // journals the terminal event when it is alive), cascade to the children and
  // deny whatever was waiting on a person.
  const at = now()
  abortTeam(run.teamId, new Error("shutdown"))
  await controlDurableRun(runId, "stop", { now })
  await (deps.denyPendingInterrupts ?? defaultDenyPendingInterrupts)(
    agentTeamExecutionRunId(runId),
    at
  ).catch(() => undefined)
  await journal(runId, "run.cancelled", "operator_stop", at)
  useAgentTeamStore.getState().setTeamStatus(run.teamId, "cancelled")
  return { ok: true, status: "cancelled" }
}

/** Address a TEAM rather than a run: the fleet console and the companion do. */
export async function controlSquadTeam(
  teamId: string,
  action: SquadControlAction,
  deps: SquadControlDeps = {}
): Promise<SquadControlResult> {
  const { findLiveSquadRun } = await import("./squad-run-records")
  const live: AgentTeamRunRecord | undefined = await findLiveSquadRun(teamId)
  if (!live) return { ok: false, reason: "run_not_found" }
  return controlSquadRun(live.id, action, deps)
}
