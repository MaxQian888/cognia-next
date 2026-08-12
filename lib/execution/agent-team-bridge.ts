import type { AgentEventEnvelope } from "@cognia/agent"

import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { RunEventType } from "@/types/execution/run"

export function agentTeamExecutionRunId(sourceRunId: string): string {
  return `execution:team:${sourceRunId}`
}

export async function ensureAgentTeamExecutionRun(sourceRun: AgentTeamRunRecord): Promise<string> {
  const runId = agentTeamExecutionRunId(sourceRun.id)
  if (!(await getExecutionRun(runId))) {
    try {
      await createExecutionRun({
        id: runId,
        kind: "team",
        sourceId: sourceRun.id,
        ...(sourceRun.projectId ? { projectId: sourceRun.projectId } : {}),
        title: sourceRun.objective,
        status: "running",
        currentRevision: 0,
        startedAt: sourceRun.startedAt ?? sourceRun.createdAt,
        updatedAt: sourceRun.updatedAt,
      })
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    }
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        "run.started",
        {},
        {
          ts: sourceRun.startedAt ?? sourceRun.createdAt,
          sourceEventId: `agent-team:${sourceRun.id}:started`,
        }
      )
    )
  }
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
