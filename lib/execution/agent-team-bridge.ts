import type { AgentEventEnvelope } from "@cognia/agent"

import {
  createExecutionRun,
  getExecutionRun,
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
      semanticRunEvent(
        "run.started",
        {},
        { ts: seed.startedAt, sourceEventId: `agent-team:${seed.sourceRunId}:started` }
      )
    )
  }
  return runId
}

export async function ensureAgentTeamExecutionRun(sourceRun: AgentTeamRunRecord): Promise<string> {
  return ensureTeamExecutionRun({
    sourceRunId: sourceRun.id,
    objective: sourceRun.objective,
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
