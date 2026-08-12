import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  aggregateAgentTeamRunUsage,
  appendAgentTeamTrajectory,
  findLatestAgentTeamChildRun,
  getAgentTeamRun,
  getLatestAgentTeamCheckpoint,
  listAgentTeamChildRuns,
  listAgentTeamTrajectory,
  listPendingAgentTeamSteering,
  putAgentTeamContent,
  updateAgentTeamSteeringReceipt,
  updateAgentTeamChildRun,
  updateAgentTeamRun,
} from "@/lib/db/agent-team-runtime"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamSideEffect } from "@/types/agent/agent-team-runtime"
import { createEvidenceBundle } from "./evidence-bundle"
import { createDecisionLedger } from "./decision-ledger"
import type { AgentExecutionEnvironment } from "../execution/local-tauri-environment"
import type { DurableChildControl, DurableTeamCoordinator } from "./durable-runtime"

export interface BeginDurableDispatchInput {
  coordinator: DurableTeamCoordinator
  team: AgentTeam
  runId: string
  teammateId: string
  taskId: string
  access: "read" | "write"
  taskKind?: "general" | "code" | "ui"
  repositoryId: string
  fileOwnership?: string[]
  runtime?: string
  now?: () => number
}

function id(): string {
  return `team-child-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function isVerificationCommand(
  event: Extract<CaptureStreamEvent, { type: "tool-result" }>
): boolean {
  const command = typeof event.input?.command === "string" ? event.input.command : ""
  return /(^|\s)(test|vitest|jest|playwright|lint|typecheck|tsc|cargo test|build)(\s|$|:)/i.test(
    command
  )
}

function redactedJson(value: unknown): string {
  const redacted = redactText(JSON.stringify(value)).redacted
  return hasNoLeakingPii(redacted) ? redacted : JSON.stringify({ redacted: true })
}

export async function beginDurableDispatch(input: BeginDurableDispatchInput) {
  const now = input.now ?? Date.now
  const previous = await findLatestAgentTeamChildRun(input.runId, input.taskId, input.teammateId)
  const resumable =
    previous && !["completed", "cancelled", "terminated"].includes(previous.status)
      ? previous
      : undefined
  const childRunId = resumable?.id ?? id()
  const retryTargetHostRef = resumable?.waitingReason?.startsWith("retry_host:")
    ? resumable.waitingReason.slice("retry_host:".length)
    : undefined
  const attempt = resumable ? resumable.attempt + 1 : 1
  const previousFailures = resumable?.resourceUsage.failures ?? 0
  const startedAt = now()
  if (resumable) {
    const run = await getAgentTeamRun(input.runId)
    await updateAgentTeamChildRun(childRunId, {
      status: "running",
      attempt,
      decisionVersion: run?.decisionVersion ?? resumable.decisionVersion,
      error: undefined,
      waitingReason: undefined,
      completedAt: undefined,
      updatedAt: startedAt,
    })
  } else {
    await input.coordinator.registerChild({
      runId: input.runId,
      childRunId,
      teammateId: input.teammateId,
      taskId: input.taskId,
      repositoryId: input.repositoryId,
      access: input.access,
      ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
    })
  }
  await appendAgentTeamTrajectory({
    runId: input.runId,
    childRunId,
    kind: "model_turn_started",
    correlationId: childRunId,
    createdAt: startedAt,
  })

  const sideEffects = new Map<string, AgentTeamSideEffect>()
  const toolStartedAt = new Map<string, number>()
  const toolResults: Array<Extract<CaptureStreamEvent, { type: "tool-result" }>> = []
  let toolTimeMs = 0
  let writes = Promise.resolve()
  let detachControl: (() => void) | undefined
  let providerControl: DurableChildControl | undefined
  let executionEnvironment: AgentExecutionEnvironment | undefined
  let turnContextPrepared = false
  const enqueue = (operation: () => Promise<unknown>): void => {
    writes = writes.then(operation).then(() => undefined)
  }

  const capture = (event: CaptureStreamEvent): void => {
    if (event.type === "tool-call") {
      const effectId = event.id ?? `tool-${sideEffects.size + 1}`
      toolStartedAt.set(effectId, now())
      sideEffects.set(effectId, {
        id: effectId,
        kind: event.toolName,
        state: "intent",
        replay: "unknown",
      })
      const checkpointEffects = [...sideEffects.values()].map((effect) => ({ ...effect }))
      enqueue(async () => {
        const safeInput = redactedJson(event.input)
        const object =
          safeInput.length > 8192
            ? await putAgentTeamContent(safeInput, "application/json", now())
            : undefined
        const trajectory = await appendAgentTeamTrajectory({
          runId: input.runId,
          childRunId,
          kind: "tool_intent",
          correlationId: effectId,
          payload: {
            toolName: event.toolName,
            ...(object ? { contentAddressed: true } : { input: JSON.parse(safeInput) }),
          },
          ...(object ? { contentHash: object.hash } : {}),
          createdAt: now(),
        })
        await input.coordinator.checkpoint(childRunId, {
          trajectorySequence: trajectory.sequence,
          replay: "needs_input",
          sideEffects: checkpointEffects,
        })
      })
      return
    }
    if (event.type === "tool-result") {
      const effectId = event.id ?? `tool-result-${toolResults.length + 1}`
      const toolStart = toolStartedAt.get(effectId)
      if (toolStart !== undefined) {
        toolTimeMs += Math.max(0, now() - toolStart)
        toolStartedAt.delete(effectId)
      }
      const existing = sideEffects.get(effectId)
      sideEffects.set(effectId, {
        id: effectId,
        kind: event.toolName,
        state: event.isError ? "failed" : "completed",
        replay: existing?.replay ?? "unknown",
      })
      const checkpointEffects = [...sideEffects.values()].map((effect) => ({ ...effect }))
      const checkpointReplay = checkpointEffects.some((effect) => effect.state === "intent")
        ? "needs_input"
        : "safe"
      toolResults.push(event)
      enqueue(async () => {
        const safeResult = redactedJson({ input: event.input, result: event.result })
        const object =
          safeResult.length > 8192
            ? await putAgentTeamContent(safeResult, "application/json", now())
            : undefined
        const trajectory = await appendAgentTeamTrajectory({
          runId: input.runId,
          childRunId,
          kind: "tool_result",
          correlationId: effectId,
          payload: {
            toolName: event.toolName,
            isError: event.isError,
            ...(object ? { contentAddressed: true } : JSON.parse(safeResult)),
          },
          ...(object ? { contentHash: object.hash } : {}),
          createdAt: now(),
        })
        await input.coordinator.checkpoint(childRunId, {
          trajectorySequence: trajectory.sequence,
          replay: checkpointReplay,
          sideEffects: checkpointEffects,
        })
      })
    }
  }

  const refreshControl = (): void => {
    detachControl?.()
    if (!providerControl && !executionEnvironment) {
      detachControl = undefined
      return
    }
    detachControl = input.coordinator.attachLiveControl(childRunId, {
      async steer(message, sourceMessageId) {
        if (!providerControl) throw new Error("The active child runtime does not support steering")
        await providerControl.steer(message, sourceMessageId)
      },
      async pause() {
        await providerControl?.pause?.()
        await executionEnvironment?.suspend(childRunId)
      },
      async resume() {
        await executionEnvironment?.resume(childRunId)
        await providerControl?.resume?.()
      },
      async terminate() {
        await providerControl?.terminate?.()
        await executionEnvironment?.terminate(childRunId)
      },
    })
  }

  const attachControl = async (
    control: DurableChildControl,
    sessionId?: string
  ): Promise<() => void> => {
    if (sessionId) await updateAgentTeamChildRun(childRunId, { sessionId, updatedAt: now() })
    providerControl = control
    refreshControl()
    return () => detachControl?.()
  }

  const evidence = createEvidenceBundle({
    runId: input.runId,
    childRunId,
    taskId: input.taskId,
    policy: input.team.config.evidencePolicy,
    now,
  })

  const recordToolEvidence = async (): Promise<void> => {
    for (const event of toolResults) {
      const content = redactedJson({
        input: event.input,
        result: event.result,
        isError: event.isError,
      })
      await evidence.record({
        kind: "command",
        title: event.toolName,
        content,
        mimeType: "application/json",
      })
      if (isVerificationCommand(event)) {
        await evidence.record({
          kind: "test",
          title: event.toolName,
          content,
          mimeType: "application/json",
        })
      }
    }
  }

  return {
    childRunId,
    retryTargetHostRef,
    capture,
    attachControl,
    attachEnvironment(environment: AgentExecutionEnvironment): void {
      executionEnvironment = environment
      refreshControl()
    },
    async setWorkspace(input: { workspacePath: string; branch?: string }): Promise<void> {
      await updateAgentTeamChildRun(childRunId, {
        workspacePath: input.workspacePath,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: now(),
      })
    },
    async prepareTurnContext(): Promise<string> {
      if (turnContextPrepared) return ""
      turnContextPrepared = true
      const [run, checkpoint, trajectory, pending, attempts] = await Promise.all([
        getAgentTeamRun(input.runId),
        getLatestAgentTeamCheckpoint(childRunId),
        listAgentTeamTrajectory(input.runId),
        listPendingAgentTeamSteering(childRunId),
        listAgentTeamChildRuns(input.runId),
      ])
      if (!run) throw new Error(`Unknown durable AgentTeam run: ${input.runId}`)
      const decisionContext = await createDecisionLedger({
        runId: input.runId,
        leadId: input.team.leadId,
        now,
      }).context()
      await updateAgentTeamChildRun(childRunId, {
        decisionVersion: run.decisionVersion,
        updatedAt: now(),
      })
      const relevant = trajectory
        .filter(
          (event) =>
            (!event.childRunId || event.childRunId === childRunId) &&
            event.sequence > (checkpoint?.trajectorySequence ?? 0)
        )
        .slice(-24)
        .map((event) => ({ sequence: event.sequence, kind: event.kind, payload: event.payload }))
      const attemptHistory = attempts
        .filter((child) => child.taskId === input.taskId)
        .map((child) => ({ attempt: child.attempt, status: child.status, error: child.error }))
      const raw = [
        `Frozen objective: ${run.objective}`,
        `Recovery checkpoint: ${checkpoint?.id ?? "none"}`,
        `Attempt history: ${JSON.stringify(attemptHistory)}`,
        decisionContext
          ? `Frozen run constraints and accepted decisions — do not override them:\n${decisionContext}`
          : "",
        relevant.length > 0 ? `Relevant local trajectory: ${JSON.stringify(relevant)}` : "",
        pending.length > 0
          ? `Operator steering to apply now:\n${pending.map((item) => `- ${item.message}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
      const redacted = redactText(raw).redacted
      if (!hasNoLeakingPii(redacted)) {
        for (const receipt of pending) {
          await updateAgentTeamSteeringReceipt(receipt.id, "rejected", now(), "pii_gate")
        }
        throw new Error("Durable AgentTeam recovery context still contains PII after redaction")
      }
      for (const receipt of pending) {
        const appliedAt = now()
        await updateAgentTeamSteeringReceipt(receipt.id, "applied", appliedAt)
        await appendAgentTeamTrajectory({
          runId: input.runId,
          childRunId,
          kind: "steering_applied",
          correlationId: receipt.id,
          createdAt: appliedAt,
        })
      }
      return redacted
    },
    run<T>(operation: () => Promise<T>): Promise<T> {
      return input.coordinator.withChildAdmission(childRunId, () =>
        input.coordinator.withWorkspaceLease(
          {
            runId: input.runId,
            repositoryId: input.repositoryId,
            access: input.access,
            ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
          },
          operation
        )
      )
    },

    async wait(waitingReason: string, hostRef?: string): Promise<void> {
      await writes
      const waitingAt = now()
      await Promise.all([
        updateAgentTeamChildRun(childRunId, {
          status: "queued",
          waitingReason,
          ...(hostRef ? { hostRef } : {}),
          error: undefined,
          updatedAt: waitingAt,
        }),
        updateAgentTeamRun(input.runId, {
          status: "needs_input",
          recoveryReason: `worker_waiting:${waitingReason}`,
          updatedAt: waitingAt,
        }),
      ])
      detachControl?.()
    },

    async checkpointPause(): Promise<boolean> {
      await writes
      const pausedAt = now()
      const effects = [...sideEffects.values()]
      const safe = effects.every(
        (effect) =>
          effect.state !== "unknown" && !(effect.state === "intent" && effect.replay !== "safe")
      )
      const event = await appendAgentTeamTrajectory({
        runId: input.runId,
        childRunId,
        kind: "checkpoint",
        correlationId: `pause:${childRunId}:${pausedAt}`,
        payload: { replay: safe ? "safe" : "needs_input", paused: true },
        createdAt: pausedAt,
      })
      await input.coordinator.checkpoint(childRunId, {
        trajectorySequence: event.sequence,
        replay: safe ? "safe" : "needs_input",
        sideEffects: effects,
      })
      return safe
    },

    async complete(result: {
      text: string
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
      costUsd?: number
      commitSha?: string
      diffContent?: string
      environmentEvidence?: Array<{
        kind: import("@/types/agent/agent-team-runtime").AgentTeamEvidenceKind
        title: string
        content?: string | Uint8Array
        url?: string
      }>
    }): Promise<void> {
      await writes
      const completedAt = now()
      const safeText = redactText(result.text).redacted
      if (!hasNoLeakingPii(safeText)) {
        throw new Error("Durable AgentTeam outcome still contains PII after redaction")
      }
      const content = await putAgentTeamContent(safeText, "text/markdown", completedAt)
      const terminal = await appendAgentTeamTrajectory({
        runId: input.runId,
        childRunId,
        kind: "model_turn_completed",
        correlationId: childRunId,
        contentHash: content.hash,
        payload: { usage: result.usage },
        createdAt: completedAt,
      })
      await evidence.record({ kind: "activity", title: "Agent execution completed" })
      await evidence.record({ kind: "outcome", title: "Agent result", content: safeText })
      await recordToolEvidence()
      for (const item of result.environmentEvidence ?? []) {
        await evidence.record(item)
      }
      if (result.diffContent) {
        await evidence.record({
          kind: "diff",
          title: "Workspace changes",
          content: result.diffContent,
          mimeType: "application/json",
        })
      }
      if (result.commitSha) {
        await evidence.record({
          kind: "commit",
          title: result.commitSha,
          metadata: { sha: result.commitSha },
        })
      }
      const validation = await evidence.validate({
        taskKind: input.taskKind ?? (input.access === "write" ? "code" : "general"),
        visualSupported: input.taskKind === "ui",
      })
      if (!validation.complete) {
        const reason = `Evidence gate requires: ${validation.missing.join(", ")}`
        await updateAgentTeamChildRun(childRunId, {
          status: "needs_input",
          error: reason,
          updatedAt: completedAt,
        })
        await updateAgentTeamRun(input.runId, {
          status: "needs_input",
          recoveryReason: "evidence_incomplete",
          updatedAt: completedAt,
        })
        throw new Error(reason)
      }
      const checkpointEvent = await appendAgentTeamTrajectory({
        runId: input.runId,
        childRunId,
        kind: "checkpoint",
        correlationId: `checkpoint:${childRunId}`,
        payload: { replay: "safe", terminalSequence: terminal.sequence },
        createdAt: completedAt,
      })
      await input.coordinator.checkpoint(childRunId, {
        trajectorySequence: checkpointEvent.sequence,
        replay: "safe",
        sideEffects: [...sideEffects.values()],
        ...(result.commitSha ? { workspaceCommit: result.commitSha } : {}),
      })
      await updateAgentTeamChildRun(childRunId, {
        status: "completed",
        waitingReason: undefined,
        completedAt,
        updatedAt: completedAt,
        resourceUsage: {
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          wallTimeMs: Math.max(0, completedAt - startedAt),
          toolTimeMs,
          attempts: attempt,
          failures: previousFailures,
        },
      })
      await aggregateAgentTeamRunUsage(input.runId, completedAt)
      detachControl?.()
    },

    async fail(error: unknown): Promise<void> {
      await writes
      const failedAt = now()
      const message = redactText(error instanceof Error ? error.message : String(error)).redacted
      const event = await appendAgentTeamTrajectory({
        runId: input.runId,
        childRunId,
        kind: "child_failed",
        correlationId: childRunId,
        payload: { error: message },
        createdAt: failedAt,
      })
      const effects = [...sideEffects.values()].map((effect) =>
        effect.state === "intent" ? { ...effect, state: "unknown" as const } : effect
      )
      const needsInput = effects.some(
        (effect) => effect.state === "unknown" && effect.replay !== "safe"
      )
      await input.coordinator.checkpoint(childRunId, {
        trajectorySequence: event.sequence,
        replay: needsInput ? "needs_input" : "safe",
        sideEffects: effects,
      })
      await updateAgentTeamChildRun(childRunId, {
        status: needsInput ? "needs_input" : "failed",
        waitingReason: needsInput ? "recovery_required" : undefined,
        error: message,
        completedAt: failedAt,
        updatedAt: failedAt,
        resourceUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          wallTimeMs: Math.max(0, failedAt - startedAt),
          toolTimeMs,
          attempts: attempt,
          failures: previousFailures + 1,
        },
      })
      if (needsInput) {
        await updateAgentTeamRun(input.runId, {
          status: "needs_input",
          recoveryReason: "uncertain_side_effect",
          updatedAt: failedAt,
        })
      }
      await aggregateAgentTeamRunUsage(input.runId, failedAt)
      detachControl?.()
    },
  }
}

export type DurableDispatch = Awaited<ReturnType<typeof beginDurableDispatch>>
