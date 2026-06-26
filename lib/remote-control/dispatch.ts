/**
 * Remote command dispatch registry (renderer side).
 *
 * The Rust inbound server authenticates + emits a generic
 * `remote-control://command` event; this module routes it to each subsystem's
 * existing headless run entry. Every handler is fire-and-forget: it kicks the
 * run off and returns synchronously with the server-supplied runId so the
 * inbound HTTP caller's 202 stays fast.
 *
 * Rust cannot execute Goals / Workflows / Team / Plan / chat directly (that
 * logic lives here in the renderer), which is exactly why the routing layer is
 * in TS.
 *
 * The registry is a `Record<RemoteCommandTarget, …>` rather than a `switch` so
 * that (a) adding a target to the `RemoteCommandTarget` union is a compile
 * error until a handler exists, and (b) `Object.keys(HANDLERS)` is enumerable
 * for the parity test against `REMOTE_COMMAND_TARGETS` + the OpenAPI enum.
 */

import type {
  RemoteCommand,
  RemoteCommandResult,
  RemoteCommandTarget,
} from "@/types/remote-control"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

function reject(runId: string, detail: string): RemoteCommandResult {
  return { runId, status: "rejected", detail }
}
function accept(runId: string, detail?: string): RemoteCommandResult {
  return { runId, status: "accepted", detail }
}

/** Read a required non-empty string arg, or null. */
function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Workflow run statuses past which a soft-cancel is a no-op. Mirrors the set
 * in `lib/companion/desktop-write-source.ts`. */
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"])

type RemoteCommandHandler = (command: RemoteCommand) => Promise<RemoteCommandResult>

/**
 * One handler per target. Keyed by the `RemoteCommandTarget` union so the type
 * checker enforces exhaustiveness — a new union member won't compile until it
 * has an entry here.
 */
const HANDLERS: Record<RemoteCommandTarget, RemoteCommandHandler> = {
  "scheduler.task.run": async ({ args, runId }) => {
    const taskId = str(args, "taskId")
    if (!taskId) return reject(runId, "taskId required")
    const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
    void useSchedulerStore.getState().runTaskNow(taskId, { triggerSource: "remote" })
    return accept(runId, `task ${taskId}`)
  },

  "scheduler.event": async ({ args, runId }) => {
    const eventType = str(args, "eventType")
    if (!eventType) return reject(runId, "eventType required")
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    void emitSchedulerEvent(
      eventType as never,
      (args.data as Record<string, unknown>) ?? {},
      str(args, "eventSource") ?? undefined
    )
    return accept(runId, eventType)
  },

  "workflow.run": async ({ args, runId }) => {
    const workflowId = str(args, "workflowId")
    if (!workflowId) return reject(runId, "workflowId required")
    const { startWorkflowFromRemote } = await import("@/lib/workflow/runtime/start-from-remote")
    const r = await startWorkflowFromRemote({
      workflowId,
      runParams: (args.runParams as Record<string, unknown>) ?? {},
      runId,
    })
    return r.ok ? accept(runId, `workflow ${workflowId}`) : reject(runId, r.reason)
  },

  "team.dispatch": async ({ args, runId }) => {
    const teamId = str(args, "teamId")
    if (!teamId) return reject(runId, "teamId required")
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    // Fire-and-forget: agentTeamManager.start awaits the full run, so we
    // intentionally do NOT await it here (the dispatchAgentTeam wrapper
    // would block the inbound 202 for the entire run).
    void agentTeamManager.start(teamId)
    return accept(runId, `team ${teamId}`)
  },

  "plan.run": async ({ args, runId }) => {
    const planId = str(args, "planId")
    if (!planId) return reject(runId, "planId required")
    const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
    void getPlanRuntime().runPlan(planId)
    return accept(runId, `plan ${planId}`)
  },

  "goal.continue": async ({ args, runId }) => {
    const goalId = str(args, "goalId")
    if (!goalId) return reject(runId, "goalId required")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    getGoalRuntime().requestManualContinue(goalId)
    return accept(runId, `goal ${goalId}`)
  },

  "goal.create": async ({ args, runId }) => {
    const rawObjective = str(args, "rawObjective")
    const sessionId = str(args, "sessionId")
    if (!rawObjective) return reject(runId, "rawObjective required")
    // v1 keeps goal.create honest: the remote caller must name a background
    // session it owns. "Mint a fresh session" is intentionally out of scope
    // (YAGNI) — add a session-mint step here if product wants it.
    if (!sessionId) return reject(runId, "sessionId required")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    void getGoalRuntime().createGoal({ sessionId, rawObjective })
    return accept(runId, "goal created")
  },

  "goal.pause": async ({ args, runId }) => {
    const goalId = str(args, "goalId")
    if (!goalId) return reject(runId, "goalId required")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    const goal = await getGoalRuntime().pauseGoal(goalId)
    return goal ? accept(runId, `goal ${goalId} paused`) : reject(runId, "goal not found")
  },

  "goal.resume": async ({ args, runId }) => {
    const goalId = str(args, "goalId")
    if (!goalId) return reject(runId, "goalId required")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    const goal = await getGoalRuntime().resumeGoal(goalId)
    return goal ? accept(runId, `goal ${goalId} resumed`) : reject(runId, "goal not found")
  },

  "goal.stop": async ({ args, runId }) => {
    const goalId = str(args, "goalId")
    if (!goalId) return reject(runId, "goalId required")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    const goal = await getGoalRuntime().stopGoal(goalId)
    return goal ? accept(runId, `goal ${goalId} stopped`) : reject(runId, "goal not found")
  },

  "workflow.cancel": async ({ args, runId }) => {
    const targetRunId = str(args, "runId")
    if (!targetRunId) return reject(runId, "runId required")
    const { requestCancelRun } = await import("@/lib/workflow/runtime/run-cancel-registry")
    // Abort a run executing in this runtime, if any.
    const live = requestCancelRun(targetRunId, "cancelled via remote control")
    if (live) return accept(runId, `workflow run ${targetRunId} aborted`)
    // Soft-cancel: when the run is not live here (already finished, or owned by
    // another process) mark a non-terminal row as cancelled so the UI reflects
    // it. Mirrors `workflowCancelRun` in desktop-write-source.ts.
    const { getDb } = await import("@/lib/db/schema")
    const row = await getDb().workflowRuns.get(targetRunId)
    if (row && !TERMINAL_RUN_STATUSES.has(row.status)) {
      await getDb().workflowRuns.update(targetRunId, {
        status: "cancelled",
        completedAt: Date.now(),
      })
      return accept(runId, `workflow run ${targetRunId} soft-cancelled`)
    }
    return reject(runId, "run not found or already terminal")
  },

  "team.stop": async ({ args, runId }) => {
    const teamId = str(args, "teamId")
    if (!teamId) return reject(runId, "teamId required")
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    // shutdown aborts the run + flips the store status; it's quick (no full-run
    // await), so we surface its result rather than fire-and-forget.
    await agentTeamManager.shutdown(teamId)
    return accept(runId, `team ${teamId} stopped`)
  },

  "chat.send": async (command) => {
    const { args, runId } = command
    const sessionId = str(args, "sessionId")
    const prompt = str(args, "prompt")
    if (!sessionId) return reject(runId, "sessionId required")
    if (!prompt) return reject(runId, "prompt required")
    // PII red-line: the prompt drives a model turn (text leaves the device).
    const { isPiiSafeSendContent } = await import("@/lib/connectors/ai-loop/safe-send-prompt")
    if (!isPiiSafeSendContent(prompt)) return reject(runId, "pii_blocked")
    const { runAndCaptureAssistantReply } = await import("@/lib/claude/run-and-capture")
    // Fire-and-forget: a full turn is 90s+, so we do NOT await it — the inbound
    // 202 already went out. The execution broker governs + can cancel the leg.
    void runAndCaptureAssistantReply(sessionId, prompt, undefined, {
      execution: { kind: "subagent", runId, label: `remote chat ${sessionId.slice(0, 8)}` },
    }).catch((error) => log.warn("remote chat.send turn failed", { error }))
    return accept(runId, `chat ${sessionId}`)
  },

  "connector.send": async (command) => {
    const { args, runId } = command
    const adapterId = str(args, "adapterId")
    const conversationKey = str(args, "conversationKey")
    const text = str(args, "text")
    if (!adapterId) return reject(runId, "adapterId required")
    if (!conversationKey) return reject(runId, "conversationKey required")
    if (!text) return reject(runId, "text required")
    // PII red-line: the message is delivered to an external IM platform.
    const { hasNoLeakingPii } = await import("@/lib/twin/ingest/redact")
    if (!hasNoLeakingPii(text)) return reject(runId, "pii_blocked")
    const { parseConversationKey } = await import("@/types/connectors/event")
    const { enqueueOutbound } = await import("@/lib/db/outbound-jobs")
    const { platform } = parseConversationKey(conversationKey)
    // `source: "manual"` — a remote-operator-initiated send (not an AI reply).
    // The Idempotency-Key (or runId) dedupes a retry storm at the queue.
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { platform, adapterId },
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: command.idempotencyKey ?? runId },
      },
      source: "manual",
    })
    return accept(runId, `connector ${adapterId} job ${job.id}`)
  },
}

/** The canonical runtime list of dispatchable targets (parity test source). */
export function dispatchableTargets(): RemoteCommandTarget[] {
  return Object.keys(HANDLERS) as RemoteCommandTarget[]
}

export async function dispatchRemoteCommand(command: RemoteCommand): Promise<RemoteCommandResult> {
  const { target, runId } = command
  const handler = HANDLERS[target] as RemoteCommandHandler | undefined
  if (!handler) return reject(runId, `unknown target: ${String(target)}`)
  try {
    return await handler(command)
  } catch (error) {
    log.error("remote command dispatch failed", error as Error)
    return reject(runId, error instanceof Error ? error.message : String(error))
  }
}
