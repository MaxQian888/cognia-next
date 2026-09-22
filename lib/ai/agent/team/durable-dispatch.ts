import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  aggregateAgentTeamRunUsage,
  appendAgentTeamTrajectory,
  findLatestAgentTeamChildRun,
  getAgentTeamRun,
  getAgentTeamChildRun,
  getAgentTeamContent,
  getLatestAgentTeamCheckpoint,
  listAgentTeamChildRuns,
  listAgentTeamTrajectory,
  listPendingAgentTeamSteering,
  updateAgentTeamSteeringReceipt,
  updateAgentTeamChildRun,
  updateAgentTeamChildRunIfCurrent,
  updateAgentTeamRunIfCurrent,
} from "@/lib/db/agent-team-runtime"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getDb } from "@/lib/db/schema"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamSideEffect } from "@/types/agent/agent-team-runtime"
import { createEvidenceBundle } from "./evidence-bundle"
import { createDecisionLedger } from "./decision-ledger"
import type { AgentExecutionEnvironment } from "../execution/local-tauri-environment"
import type { DurableChildControl, DurableTeamCoordinator } from "./durable-runtime"
import { CHILD_ADMISSION_WAITING_REASON, isDurableChildReplaySafe } from "./durable-runtime"
import { tokenize } from "@/lib/terminal/completion/tokenize"

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
  if (
    !/^(?:bash|shell|shell_command|exec_command|shell_execute(?:_advanced)?|run_terminal_cmd)$/i.test(
      event.toolName
    )
  )
    return false
  const command = typeof event.input?.command === "string" ? event.input.command : ""
  // Only simple foreground commands qualify; shell composition or redirection
  // can mask the verifier's result or mutate the revision being certified.
  if (/[;&|`\n\r$<>\\]/.test(command)) return false
  // Reuse quote-aware tokenization for flags, not as a shell security parser.
  if (
    tokenize(command).some(({ value }) =>
      /^--?(?:h|help|v|version|list|listTests|list-tests|showConfig|show-config|dry-run|no-run|watch|watchAll|ui|fix|write|update|updateSnapshot|u|passWithNoTests|if-present)(?:=|$)/i.test(
        value
      )
    )
  )
    return false
  return /^(?:rtk\s+)?(?:(?:pnpm|npm|yarn|bun)(?:\s+(?:exec|run))?\s+(?:test(?::[\w-]+)?|vitest|jest|playwright\s+test|lint|typecheck|tsc|build)|(?:npx\s+)?(?:vitest|jest|tsc)|cargo\s+(?:test|check|build))(?=\s|$)/i.test(
    command.trim()
  )
}

function redactedJson(value: unknown): string {
  const redacted = redactText(JSON.stringify(value) ?? "null").redacted
  return hasNoLeakingPii(redacted) ? redacted : JSON.stringify({ redacted: true })
}

class DispatchControlConflictError extends Error {}

export async function beginDurableDispatch(input: BeginDurableDispatchInput) {
  const now = input.now ?? Date.now
  let childRunId = id()
  let retryTargetHostRef: string | undefined
  let attempt = 1
  let previousFailures = 0
  const startedAt = now()
  try {
    const db = getDb()
    await db.transaction(
      "rw",
      [db.agentTeamRuns, db.agentTeamChildRuns, db.agentTeamTrajectory, db.agentTeamContentObjects],
      async () => {
        const previous = await findLatestAgentTeamChildRun(
          input.runId,
          input.taskId,
          input.teammateId
        )
        if (
          previous &&
          ["pausing", "paused", "sleeping", "needs_input"].includes(previous.status)
        ) {
          throw new DispatchControlConflictError(
            `Child is not accepting dispatch while ${previous.status}`
          )
        }
        if (
          previous &&
          (previous.status === "running" ||
            (previous.status === "queued" &&
              previous.waitingReason === CHILD_ADMISSION_WAITING_REASON))
        ) {
          throw new DispatchControlConflictError("Child already has an active dispatch")
        }
        const resumable =
          previous && !["completed", "cancelled", "terminated"].includes(previous.status)
            ? previous
            : undefined
        childRunId = resumable?.id ?? childRunId
        retryTargetHostRef = resumable?.waitingReason?.startsWith("retry_host:")
          ? resumable.waitingReason.slice("retry_host:".length)
          : undefined
        attempt = resumable ? resumable.attempt + 1 : 1
        previousFailures = resumable?.resourceUsage.failures ?? 0
        const run = await getAgentTeamRun(input.runId)
        if (!run || !["running", "queued", "recovering"].includes(run.status)) {
          throw new DispatchControlConflictError("Run is not accepting dispatch")
        }
        if (resumable) {
          const resumed = await updateAgentTeamChildRunIfCurrent(childRunId, resumable, {
            status: "running",
            attempt,
            decisionVersion: run?.decisionVersion ?? resumable.decisionVersion,
            error: undefined,
            waitingReason: undefined,
            completedAt: undefined,
            updatedAt: startedAt,
          })
          if (!resumed)
            throw new DispatchControlConflictError("Child control changed before dispatch")
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
      }
    )
  } catch (error) {
    if (error instanceof DispatchControlConflictError) throw error
    const parking = await Promise.allSettled([
      (async () => {
        const child = await getAgentTeamChildRun(childRunId)
        if (child && ["running", "queued", "recovering"].includes(child.status)) {
          await updateAgentTeamChildRunIfCurrent(childRunId, child, {
            status: "needs_input",
            waitingReason: "recovery_required",
            error: "Dispatch initialization could not be persisted",
            updatedAt: now(),
          })
        }
      })(),
      (async () => {
        const run = await getAgentTeamRun(input.runId)
        if (run && ["running", "queued", "recovering"].includes(run.status)) {
          await updateAgentTeamRunIfCurrent(input.runId, run, {
            status: "needs_input",
            recoveryReason: "dispatch_initialization_failed",
            updatedAt: now(),
          })
        }
      })(),
    ])
    const failures = parking.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Dispatch initialization and recovery persistence failed",
        { cause: error }
      )
    throw error
  }

  const sideEffects = new Map<string, AgentTeamSideEffect>()
  const toolStartedAt = new Map<string, number>()
  const toolInputs = new Map<string, Record<string, unknown>>()
  const toolResults: Array<Extract<CaptureStreamEvent, { type: "tool-result" }>> = []
  let toolTimeMs = 0
  let writes = Promise.resolve()
  let writeError: unknown
  const persistenceAbort = new AbortController()
  let pendingSteeringIds: string[] = []
  let detachControl: (() => void) | undefined
  let providerControl: DurableChildControl | undefined
  let executionEnvironment: AgentExecutionEnvironment | undefined
  let turnContextPrepared = false
  const enqueue = (operation: () => Promise<unknown>): void => {
    writes = writes.then(async () => {
      if (persistenceAbort.signal.aborted) return
      try {
        await ownedChild()
        await operation()
      } catch (error) {
        writeError = error
        persistenceAbort.abort(error)
      }
    })
  }
  const flush = async (): Promise<void> => {
    await writes
    if (persistenceAbort.signal.aborted) throw writeError
  }
  const parkRun = async (reason: string, at: number): Promise<void> => {
    const run = await getAgentTeamRun(input.runId)
    if (!run || ["completed", "failed", "cancelled", "terminated"].includes(run.status)) return
    await updateAgentTeamRunIfCurrent(input.runId, run, {
      status: "needs_input",
      recoveryReason: reason,
      updatedAt: at,
    })
  }
  const ownedChild = async () => {
    const child = await getAgentTeamChildRun(childRunId)
    if (!child || child.attempt !== attempt) {
      const error = new Error("Dispatch no longer owns this child attempt")
      error.name = "AbortError"
      throw error
    }
    return child
  }
  const currentChild = async () => {
    const child = await ownedChild()
    if (!["running", "queued"].includes(child.status)) {
      const error = new Error("Child is no longer active")
      error.name = "AbortError"
      throw error
    }
    return child
  }
  const hasUnsafeRemoteHistory = async (): Promise<boolean> => {
    const [checkpoint, trajectory] = await Promise.all([
      getLatestAgentTeamCheckpoint(childRunId),
      listAgentTeamTrajectory(input.runId),
    ])
    if (
      !trajectory.some((event) => event.childRunId === childRunId && event.kind === "remote_event")
    ) {
      return false
    }
    return !(await isDurableChildReplaySafe(childRunId, checkpoint, trajectory))
  }

  const capture = (event: CaptureStreamEvent): void => {
    if (event.type === "tool-call") {
      const effectId = event.id ?? `tool-${sideEffects.size + 1}`
      toolStartedAt.set(effectId, now())
      if (event.input) toolInputs.set(effectId, event.input)
      sideEffects.set(effectId, {
        id: effectId,
        kind: event.toolName,
        state: "intent",
        replay: "unknown",
      })
      const checkpointEffects = [...sideEffects.values()].map((effect) => ({ ...effect }))
      enqueue(async () => {
        const safeInput = redactedJson(event.input)
        const large = safeInput.length > 8192
        const trajectory = await appendAgentTeamTrajectory(
          {
            runId: input.runId,
            childRunId,
            kind: "tool_intent",
            correlationId: effectId,
            payload: {
              toolName: event.toolName,
              ...(large ? { contentAddressed: true } : { input: JSON.parse(safeInput) }),
            },
            createdAt: now(),
          },
          large ? { data: safeInput, mimeType: "application/json" } : undefined
        )
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
      toolResults.push({ ...event, input: event.input ?? toolInputs.get(effectId) })
      enqueue(async () => {
        const safeResult = redactedJson({ input: event.input, result: event.result })
        const large = safeResult.length > 8192
        const trajectory = await appendAgentTeamTrajectory(
          {
            runId: input.runId,
            childRunId,
            kind: "tool_result",
            correlationId: effectId,
            payload: {
              toolName: event.toolName,
              isError: event.isError,
              ...(large ? { contentAddressed: true } : JSON.parse(safeResult)),
            },
            createdAt: now(),
          },
          large ? { data: safeResult, mimeType: "application/json" } : undefined
        )
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
        const safe = await providerControl?.pause?.()
        await executionEnvironment?.suspend(childRunId)
        return safe
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
    await ownedChild()
    if (sessionId) await updateAgentTeamChildRun(childRunId, { sessionId, updatedAt: now() })
    providerControl = control
    refreshControl()
    return () => detachControl?.()
  }

  const evidence = createEvidenceBundle({
    runId: input.runId,
    childRunId,
    taskId: input.taskId,
    attempt,
    policy: input.team.config.evidencePolicy,
    now,
  })

  const recordToolEvidence = async (revision?: string): Promise<void> => {
    // Inspect the stream backwards once. A later edit invalidates previous
    // checks; a failed latest check cannot be hidden by a different passing one.
    const statuses = new Map<number, "passed" | "failed" | "unknown">()
    const latestChecks = new Map<string, "passed" | "failed" | "unknown">()
    let changedLater = false
    for (let index = toolResults.length - 1; index >= 0; index--) {
      const event = toolResults[index]
      if (!isVerificationCommand(event)) {
        if (!/^(Read|Glob|Grep|Search|WebSearch|WebFetch)$/i.test(event.toolName))
          changedLater = true
        continue
      }
      const result = event.result as { exitCode?: number; exit_code?: number } | undefined
      const exitCode =
        result && typeof result === "object" ? (result.exitCode ?? result.exit_code) : undefined
      const status =
        event.isError === true || (exitCode !== undefined && exitCode !== 0)
          ? "failed"
          : !changedLater && (exitCode === 0 || event.isError === false)
            ? "passed"
            : "unknown"
      statuses.set(index, status)
      const command = String(event.input?.command).trim()
      if (!latestChecks.has(command)) latestChecks.set(command, status)
    }
    const hasUnverifiedCheck = [...latestChecks.values()].some((status) => status !== "passed")
    for (const [index, event] of toolResults.entries()) {
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
      const status = statuses.get(index)
      if (status) {
        await evidence.record({
          kind: "test",
          title: event.toolName,
          content,
          mimeType: "application/json",
          status: status === "passed" && hasUnverifiedCheck ? "unknown" : status,
          ...(revision ? { revision } : {}),
        })
      }
    }
  }

  return {
    childRunId,
    retryTargetHostRef,
    capture,
    flush,
    signal: persistenceAbort.signal,
    dispose(): void {
      detachControl?.()
      detachControl = undefined
    },
    attachControl,
    attachEnvironment(environment: AgentExecutionEnvironment): void {
      executionEnvironment = environment
      refreshControl()
    },
    async setWorkspace(input: { workspacePath: string; branch?: string }): Promise<void> {
      await ownedChild()
      await updateAgentTeamChildRun(childRunId, {
        workspacePath: input.workspacePath,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: now(),
      })
    },
    async prepareTurnContext(): Promise<string> {
      await currentChild()
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
      const relevant = await Promise.all(
        trajectory
          .filter(
            (event) =>
              (!event.childRunId || event.childRunId === childRunId) &&
              event.sequence > (checkpoint?.trajectorySequence ?? 0)
          )
          .slice(-24)
          .map(async (event) => {
            const content = event.contentHash
              ? await getAgentTeamContent(event.contentHash)
              : undefined
            return {
              sequence: event.sequence,
              kind: event.kind,
              payload: event.payload,
              ...(content
                ? { content: new TextDecoder().decode(content.data).slice(0, 8192) }
                : {}),
            }
          })
      )
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
      pendingSteeringIds = pending.map((receipt) => receipt.id)
      for (const receipt of pending) {
        const deliveredAt = now()
        await updateAgentTeamSteeringReceipt(receipt.id, "delivered", deliveredAt)
        await appendAgentTeamTrajectory({
          runId: input.runId,
          childRunId,
          kind: "steering_delivered",
          correlationId: receipt.id,
          createdAt: deliveredAt,
        })
      }
      return redacted
    },
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await currentChild()
      return input.coordinator.withChildAdmission(
        childRunId,
        (admissionSignal) =>
          input.coordinator.withWorkspaceLease(
            {
              childRunId,
              runId: input.runId,
              repositoryId: input.repositoryId,
              access: input.access,
              ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
            },
            async () => {
              await currentChild()
              return operation()
            },
            admissionSignal
          ),
        signal ? AbortSignal.any([signal, persistenceAbort.signal]) : persistenceAbort.signal
      )
    },

    async wait(waitingReason: string, hostRef?: string): Promise<void> {
      await flush()
      const waitingAt = now()
      try {
        const changed = await updateAgentTeamChildRunIfCurrent(childRunId, await currentChild(), {
          status: "queued",
          waitingReason,
          ...(hostRef ? { hostRef } : {}),
          error: undefined,
          updatedAt: waitingAt,
        })
        if (changed) await parkRun(`worker_waiting:${waitingReason}`, waitingAt)
      } finally {
        detachControl?.()
      }
    },

    async checkpointPause(): Promise<boolean> {
      await flush()
      await ownedChild()
      const pausedAt = now()
      const effects = [...sideEffects.values()]
      const safe =
        !(await hasUnsafeRemoteHistory()) &&
        effects.every(
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
      workspaceRevision?: string
      diffContent?: string
      environmentEvidence?: Array<{
        kind: import("@/types/agent/agent-team-runtime").AgentTeamEvidenceKind
        title: string
        content?: string | Uint8Array
        url?: string
        status?: "passed" | "failed" | "unknown"
        revision?: string
      }>
    }): Promise<void> {
      await flush()
      const child = await currentChild()
      const completedAt = now()
      if (
        [...sideEffects.values()].some(
          (effect) => effect.state === "intent" || effect.state === "unknown"
        )
      ) {
        const reason = "Cannot complete dispatch with an unsettled tool result"
        const parked = await updateAgentTeamChildRunIfCurrent(childRunId, child, {
          status: "needs_input",
          waitingReason: "recovery_required",
          error: reason,
          updatedAt: completedAt,
        })
        if (parked) await parkRun("uncertain_side_effect", completedAt)
        throw new Error(reason)
      }
      const safeText = redactText(result.text).redacted
      if (!hasNoLeakingPii(safeText)) {
        throw new Error("Durable AgentTeam outcome still contains PII after redaction")
      }
      const terminal = await appendAgentTeamTrajectory(
        {
          runId: input.runId,
          childRunId,
          kind: "model_turn_completed",
          correlationId: childRunId,
          payload: { usage: result.usage },
          createdAt: completedAt,
        },
        { data: safeText, mimeType: "text/markdown" }
      )
      const revision = result.workspaceRevision ?? result.commitSha
      await evidence.record({ kind: "activity", title: "Agent execution completed", revision })
      await evidence.record({ kind: "outcome", title: "Agent result", content: safeText, revision })
      await recordToolEvidence(revision)
      for (const item of result.environmentEvidence ?? []) {
        await evidence.record({
          ...item,
          ...(typeof item.content === "string"
            ? { content: redactText(item.content).redacted }
            : {}),
        })
      }
      if (result.diffContent) {
        await evidence.record({
          kind: "diff",
          title: "Workspace changes",
          content: redactText(result.diffContent).redacted,
          mimeType: "application/json",
          revision,
        })
      }
      if (result.commitSha) {
        await evidence.record({
          kind: "commit",
          title: result.commitSha,
          metadata: { sha: result.commitSha },
          revision,
        })
      }
      const validation = await evidence.validate({
        taskKind: input.taskKind ?? (input.access === "write" ? "code" : "general"),
        visualSupported: input.taskKind === "ui",
        revision,
        requireRevision: true,
      })
      if (!validation.complete) {
        const reason = `Evidence gate requires: ${validation.missing.join(", ")}`
        await updateAgentTeamChildRunIfCurrent(childRunId, await currentChild(), {
          status: "needs_input",
          error: reason,
          updatedAt: completedAt,
        })
        await parkRun("evidence_incomplete", completedAt)
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
      const completed = await updateAgentTeamChildRunIfCurrent(childRunId, await currentChild(), {
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
      if (!completed) throw new Error("Child control changed during completion")
      await aggregateAgentTeamRunUsage(input.runId, completedAt)
      for (const receiptId of pendingSteeringIds) {
        await updateAgentTeamSteeringReceipt(receiptId, "applied", completedAt)
      }
      detachControl?.()
    },

    async fail(error: unknown): Promise<void> {
      await writes
      try {
        const current = await getAgentTeamChildRun(childRunId)
        if (
          !current ||
          current.attempt !== attempt ||
          ["completed", "cancelled", "terminated", "paused", "needs_input"].includes(current.status)
        )
          return
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
        const needsInput =
          persistenceAbort.signal.aborted ||
          (await hasUnsafeRemoteHistory()) ||
          effects.some((effect) => effect.state === "unknown" && effect.replay !== "safe")
        await input.coordinator.checkpoint(childRunId, {
          trajectorySequence: event.sequence,
          replay: needsInput ? "needs_input" : "safe",
          sideEffects: effects,
        })
        const latest = await getAgentTeamChildRun(childRunId)
        if (
          !latest ||
          latest.attempt !== attempt ||
          ["completed", "cancelled", "terminated", "paused", "needs_input"].includes(latest.status)
        )
          return
        await updateAgentTeamChildRunIfCurrent(childRunId, latest, {
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
          await parkRun("uncertain_side_effect", failedAt)
        }
        await aggregateAgentTeamRunUsage(input.runId, failedAt)
      } finally {
        detachControl?.()
        detachControl = undefined
      }
    },
  }
}

export type DurableDispatch = Awaited<ReturnType<typeof beginDurableDispatch>>
