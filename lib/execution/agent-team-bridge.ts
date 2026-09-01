import type { AgentEventEnvelope } from "@cognia/agent"

import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type { ChatSession } from "@cognia/agent-config-types"

import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { RunEventType } from "@/types/execution/run"

import { ensureConnectorRunBinding } from "./agent-state-bridge"

export function agentTeamExecutionRunId(sourceRunId: string): string {
  return `execution:team:${sourceRunId}`
}

/**
 * The minimum a team run has to say about itself to get an execution run.
 *
 * Taken as primitives rather than as an `AgentTeamRunRecord` so a caller that
 * has only just minted a run id — the IM dispatch path, which fires the
 * lifecycle and returns before any durable record exists — can create the same
 * row. The ids converge because both derive from `agentTeamExecutionRunId`, so
 * whichever path runs first wins and the second is a no-op.
 */
export interface TeamExecutionRunSeed {
  sourceRunId: string
  objective: string
  projectId?: string
  /**
   * The conversation that asked for this run.
   *
   * `ExecutionRun.sessionId` has been an indexed column all along and team
   * runs never filled it, so nothing could answer "which conversation started
   * this?" — not the run list, and not a gate trying to find its way back to
   * the thread that is waiting on it.
   */
  sessionId?: string
  /**
   * The Squad this run belongs to.
   *
   * `ExecutionRun` has no column for it, and `sourceId` is the LIFECYCLE run
   * id, so a row on its own could not answer "which Squad is this?". A durable
   * run could be asked via its `agentTeamRuns` record; a legacy run writes no
   * record, which is why the cockpit could stop a paused legacy run but never
   * resume it — resume needs a team id, not a run id.
   *
   * Recorded in the `run.started` payload rather than as a column: the payload
   * is the run's own opening statement, it needs no schema change, and an id is
   * exactly the kind of semantic value the journal is allowed to carry.
   */
  teamId?: string
  startedAt: number
  updatedAt: number
}

export async function ensureTeamExecutionRun(seed: TeamExecutionRunSeed): Promise<string> {
  const runId = agentTeamExecutionRunId(seed.sourceRunId)
  if (!(await getExecutionRun(runId))) {
    try {
      await createExecutionRun({
        id: runId,
        kind: "team",
        sourceId: seed.sourceRunId,
        ...(seed.projectId ? { projectId: seed.projectId } : {}),
        ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
        title: seed.objective,
        status: "running",
        currentRevision: 0,
        startedAt: seed.startedAt,
        updatedAt: seed.updatedAt,
      })
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    }
    await runEventJournal.append(
      runId,
      semanticRunEvent("run.started", seed.teamId ? { teamId: seed.teamId } : {}, {
        ts: seed.startedAt,
        sourceEventId: `agent-team:${seed.sourceRunId}:started`,
      })
    )
  }
  return runId
}

/**
 * Which Squad an execution run belongs to, read back from its opening event.
 *
 * The cockpit addresses a RUN. Resuming a legacy Squad addresses a TEAM, and
 * nothing on the row bridged the two, so Resume could only be refused. Rows
 * written before `teamId` was seeded return `undefined` and are still refused,
 * which is the honest answer for them rather than a guess.
 */
export async function teamIdForExecutionRun(executionRunId: string): Promise<string | undefined> {
  const events = await listExecutionRunEvents(executionRunId).catch(() => [])
  const started = events.find((event) => event.type === "run.started")
  const teamId = started?.payload?.teamId
  return typeof teamId === "string" && teamId.length > 0 ? teamId : undefined
}

/**
 * Re-open a paused run's row so it reads as running again.
 *
 * Only a resume calls this, and only a `paused` row is touched. It is NOT
 * folded into `ensureTeamExecutionRun`, which every projected remote event and
 * every settle also passes through: an unconditional re-open there would
 * resurrect a paused run on a stray late event.
 */
export async function reopenTeamExecutionRun(sourceRunId: string, ts = Date.now()): Promise<void> {
  const runId = agentTeamExecutionRunId(sourceRunId)
  const run = await getExecutionRun(runId).catch(() => undefined)
  if (run?.status !== "paused") return
  await runEventJournal
    .append(
      runId,
      semanticRunEvent(
        "run.resumed",
        {},
        { ts, sourceEventId: `agent-team:${sourceRunId}:resumed:${ts}` }
      )
    )
    .catch(() => undefined)
}

export async function ensureAgentTeamExecutionRun(sourceRun: AgentTeamRunRecord): Promise<string> {
  return ensureTeamExecutionRun({
    sourceRunId: sourceRun.id,
    objective: sourceRun.objective,
    teamId: sourceRun.teamId,
    ...(sourceRun.projectId ? { projectId: sourceRun.projectId } : {}),
    startedAt: sourceRun.startedAt ?? sourceRun.createdAt,
    updatedAt: sourceRun.updatedAt,
  })
}

/**
 * Create the execution run AND the IM binding for a team run started from a
 * conversation.
 *
 * `putExecutionRunBinding` had exactly three call sites and none of them was a
 * team run, so a team dispatched from IM produced no card, no progress, and no
 * reachable control surface — "hand off to a team" was invisible from the
 * platform that asked for it. The run row alone is not enough: the presentation
 * runner keys off the binding.
 */
export async function ensureImTeamExecutionRun(input: {
  seed: TeamExecutionRunSeed
  session: ChatSession
}): Promise<string> {
  const runId = await ensureTeamExecutionRun(input.seed)
  await ensureConnectorRunBinding(runId, input.seed.projectId, input.session)
  return runId
}

function remoteEventType(envelope: AgentEventEnvelope): RunEventType {
  if (envelope.event.kind === "tool-call") return "tool.started"
  if (envelope.event.kind === "tool-result") {
    return envelope.event.isError === true ? "tool.failed" : "tool.completed"
  }
  return "step.progress"
}

/** Project a redacted semantic remote event into the existing run journal. */
export async function projectRemoteAgentTeamEvent(input: {
  sourceRun: AgentTeamRunRecord
  childRunId: string
  taskId: string
  hostRef: string
  envelope: AgentEventEnvelope
  ts?: number
}): Promise<void> {
  const runId = await ensureAgentTeamExecutionRun(input.sourceRun)
  const event = input.envelope.event
  const toolName = typeof event.toolName === "string" ? event.toolName : undefined
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      remoteEventType(input.envelope),
      {
        stepId: input.taskId,
        activityId: toolCallId ?? input.envelope.eventId,
        hostRef: input.hostRef,
        childRunId: input.childRunId,
        ...(toolName ? { toolName, safeToolName: true } : {}),
      },
      {
        ts: input.ts ?? Date.now(),
        sourceEventId: `agent-team:${input.sourceRun.id}:remote:${input.envelope.eventId}`,
      }
    )
  )
}

export async function projectAgentTeamChildLifecycle(input: {
  sourceRun: AgentTeamRunRecord
  childRunId: string
  taskId: string
  state: "started" | "completed" | "failed" | "waiting" | "recovery_required"
  sourceEventId: string
  ts?: number
}): Promise<void> {
  const runId = await ensureAgentTeamExecutionRun(input.sourceRun)
  const type: RunEventType =
    input.state === "started"
      ? "step.started"
      : input.state === "completed"
        ? "step.completed"
        : input.state === "failed"
          ? "step.failed"
          : input.state === "recovery_required"
            ? "run.recovery_required"
            : "step.progress"
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      type,
      {
        stepId: input.taskId,
        childRunId: input.childRunId,
        ...(input.state === "waiting" ? { status: "blocked" } : {}),
      },
      { ts: input.ts ?? Date.now(), sourceEventId: input.sourceEventId }
    )
  )
}

export async function settleAgentTeamExecutionRun(
  sourceRun: AgentTeamRunRecord,
  status: "completed" | "failed" | "cancelled",
  ts = Date.now()
): Promise<void> {
  const runId = await ensureAgentTeamExecutionRun(sourceRun)
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      `run.${status}`,
      {},
      {
        ts,
        sourceEventId: `agent-team:${sourceRun.id}:terminal:${status}`,
      }
    )
  )
}
