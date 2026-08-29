import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { compactBoundaryFromInner } from "@/lib/claude/run-and-capture"
import type { SDKMessage } from "@cognia/agent-config-types"
import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRuns,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { AgentRunEventProducer } from "@/lib/execution/sources/agent-turn"
import {
  __resetChatCanonicalSinkForTesting,
  closeChatCanonicalLog,
  openChatCanonicalLog,
  recordChatCanonicalEvents,
  recordChatSdkMessage,
} from "@/lib/chat/canonical-sink"
import { finishSharedSessionRun } from "@/lib/collab/shared-run-coordinator"

export interface StartDirectChatExecutionRunInput {
  sessionId: string
  runId: string
  projectId?: string
  workspaceRoot?: string
  startedAt?: number
  /**
   * The turn's prompt. Reaches the canonical log only while the `prompts` debug
   * tier is armed — `messages` already stores it verbatim.
   */
  prompt?: string
}

interface ActiveDirectChatRun {
  runId: string
  producer: AgentRunEventProducer
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>
  seenToolCalls: Set<string>
}

const activeRuns = new Map<string, ActiveDirectChatRun>()

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/**
 * Open the canonical execution journal for one direct-chat turn.
 *
 * Creation is idempotent because retry/fallback rails can re-enter the same
 * turn. The existing immutable row always wins; a terminal row is never
 * reopened.
 */
export async function startDirectChatExecutionRun(
  input: StartDirectChatExecutionRunInput
): Promise<void> {
  const alreadyActive = activeRuns.get(input.sessionId)
  if (alreadyActive?.runId === input.runId) return

  let run = await getExecutionRun(input.runId)
  const startedAt = input.startedAt ?? Date.now()
  if (!run) {
    try {
      run = await createExecutionRun({
        id: input.runId,
        kind: "agent-turn",
        sourceId: input.runId,
        sessionId: input.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        title: "Chat run",
        status: "queued",
        currentRevision: 0,
        startedAt,
        updatedAt: startedAt,
      })
    } catch {
      run = await getExecutionRun(input.runId)
      if (!run) throw new Error(`Unable to create execution run: ${input.runId}`)
    }
  }
  if (isTerminal(run.status)) return

  const producer = new AgentRunEventProducer(input.runId, undefined, {
    workspaceRoot: input.workspaceRoot,
  })
  activeRuns.set(input.sessionId, {
    runId: input.runId,
    producer,
    toolCalls: new Map(),
    seenToolCalls: new Set(),
  })
  // ADR-0090 canonical event log. Opened on the SAME run id as the execution
  // journal so a cost row, a span and an envelope for one turn share a join
  // key. Before this, a desktop chat turn produced no canonical log at all.
  openChatCanonicalLog({
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  })
  if (run.currentRevision === 0) {
    await producer.start(startedAt, { surface: "chat" })
  }
}

/**
 * Narrow the desktop SDK stream onto the same capture events used by headless
 * runs. Full text, thinking and tool results are deliberately discarded.
 */
export async function projectDirectChatSdkMessage(
  sessionId: string,
  message: SDKMessage,
  ts: number = Date.now()
): Promise<void> {
  const active = activeRuns.get(sessionId)
  if (!active) return

  // The canonical log takes EVERY frame, including the ones the execution
  // journal narrows away below — that narrowing is what makes the journal a
  // timeline rather than a record.
  recordChatSdkMessage(sessionId, message)

  const compact = compactBoundaryFromInner(message)
  if (compact) {
    await runEventJournal.append(
      active.runId,
      semanticRunEvent(
        "milestone.created",
        {
          milestoneId: `compact:${message.uuid}`,
          title: "Context compacted",
          safeTitle: true,
          trigger: compact.trigger,
        },
        { ts, sourceEventId: `compact:${message.uuid}` }
      )
    )
    return
  }

  if (message.type === "assistant") {
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const toolBlock = block as Record<string, unknown>
      if (
        toolBlock.type !== "tool_use" ||
        typeof toolBlock.id !== "string" ||
        typeof toolBlock.name !== "string" ||
        !toolBlock.input ||
        typeof toolBlock.input !== "object"
      ) {
        continue
      }
      const input = toolBlock.input as Record<string, unknown>
      active.toolCalls.set(toolBlock.id, { name: toolBlock.name, input })
      if (active.seenToolCalls.has(toolBlock.id)) continue
      active.seenToolCalls.add(toolBlock.id)
      await active.producer.onCaptureEvent(
        {
          type: "tool-call",
          id: toolBlock.id,
          toolName: toolBlock.name,
          input,
        },
        ts
      )
    }
    return
  }

  if (message.type === "user") {
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const resultBlock = block as Record<string, unknown>
      if (resultBlock.type !== "tool_result" || typeof resultBlock.tool_use_id !== "string") {
        continue
      }
      const call = active.toolCalls.get(resultBlock.tool_use_id)
      await active.producer.onCaptureEvent(
        {
          type: "tool-result",
          id: resultBlock.tool_use_id,
          toolName: call?.name ?? "unknown",
          ...(call?.input ? { input: call.input } : {}),
          result: undefined,
          isError: Boolean(resultBlock.is_error),
        },
        ts
      )
    }
  }
}

/** Project one already-normalized capture event without retaining raw output. */
export async function projectDirectChatCaptureEvent(
  sessionId: string,
  event: CaptureStreamEvent,
  ts: number = Date.now()
): Promise<void> {
  const active = activeRuns.get(sessionId)
  if (!active) return
  await active.producer.onCaptureEvent(event, ts)
}

/** Seal the current direct-chat run exactly once. */
export async function finishDirectChatExecutionRun(
  sessionId: string,
  status: "completed" | "failed" | "cancelled",
  ts: number = Date.now(),
  summary?: string
): Promise<void> {
  await finishSharedSessionRun(sessionId, status)
  const active = activeRuns.get(sessionId)
  if (!active) return
  activeRuns.delete(sessionId)
  // Recorded here rather than at each of the four call sites in the chat hook:
  // every terminal path already funnels through this function, so this is the
  // one place a failed turn cannot be sealed without saying it failed.
  if (status === "failed") {
    recordChatCanonicalEvents(sessionId, [
      { kind: "failure", code: "chat_turn_failed", message: summary ?? "chat turn failed" },
    ])
  }
  // Sealed first and awaited: the flush is what makes the buffered tail
  // durable, and an early return below must not skip it.
  await closeChatCanonicalLog(sessionId, status === "cancelled" ? "interrupted" : "ended")
  const run = await getExecutionRun(active.runId)
  if (!run || isTerminal(run.status)) return
  await active.producer.finish(status, ts, summary)
}

/**
 * Runs only during renderer boot. A direct-chat turn cannot keep executing
 * across a renderer restart, so an old non-terminal row requires explicit
 * recovery instead of an invented success/failure result.
 */
export async function recoverStaleDirectChatExecutionRuns(
  ts: number = Date.now()
): Promise<number> {
  const runs = await listExecutionRuns({
    kinds: ["agent-turn"],
    statuses: ["queued", "running", "waiting"],
    limit: Number.MAX_SAFE_INTEGER,
  })
  let recovered = 0
  for (const run of runs) {
    await runEventJournal.append(
      run.id,
      semanticRunEvent(
        "run.recovery_required",
        { reason: "renderer-restarted" },
        { ts, sourceEventId: `recovery:${run.id}` }
      )
    )
    recovered += 1
  }
  return recovered
}

export function __resetDirectChatExecutionRunsForTesting(): void {
  activeRuns.clear()
  __resetChatCanonicalSinkForTesting()
}
