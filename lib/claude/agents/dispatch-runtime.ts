/**
 * Producer that feeds nested-dispatch runs into the subagent runtime store
 * (A5). This is the "producer not yet wired" hook the store documents: when the
 * `dispatch_agent` host tool runs a subagent, it records start / completion /
 * rejection here, and the store's subscribers (the chat `SubagentPart` tree via
 * `subagent-bridge`, and the Settings runtime tab) render the live tree.
 *
 * Pure-ish: it only touches the Zustand store's vanilla `getState()` API, so it
 * is callable from the renderer IPC handler (non-React) and unit-testable.
 */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent, SubAgentLog } from "@/types/agent/sub-agent"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

export interface DispatchRunStartParams {
  /** Unique id for this run (also the tree node id). */
  id: string
  /** Display name (usually the subagent id). */
  name: string
  /** The prompt/task handed to the subagent. */
  task: string
  /** Nesting level (1 = dispatched by top-level chat). */
  depth: number
  /** Spawning subagent RUN id (the tree edge); undefined when dispatched by chat. */
  parentSubagentId?: string
  /** Parent agent identity (defaults to the chat sentinel). */
  parentAgentId?: string
  /** Originating chat session id — lets the chat-side bridge attach this run's
   *  tree to the right session's assistant turn. Undefined for non-chat callers. */
  parentSessionId?: string
  /** Whether the run was detached. */
  backgrounded?: boolean
}

const CHAT_PARENT = "__chat__"

function baseSubAgent(p: DispatchRunStartParams): SubAgent {
  const now = new Date()
  return {
    id: p.id,
    parentAgentId: p.parentAgentId ?? CHAT_PARENT,
    name: p.name,
    description: p.name,
    task: p.task,
    initialTask: p.task,
    threadId: p.id,
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: now,
    lastActivityAt: now,
    startedAt: now,
    retryCount: 0,
    order: 0,
    depth: p.depth,
    ...(p.parentSubagentId ? { parentSubagentId: p.parentSubagentId } : {}),
    ...(p.parentSessionId
      ? {
          context: {
            parentAgentId: p.parentAgentId ?? CHAT_PARENT,
            sessionId: p.parentSessionId,
            startTime: now,
            currentStep: 0,
          },
        }
      : {}),
    ...(p.backgrounded ? { backgrounded: true } : {}),
  }
}

/** Record a subagent run starting (running, progress 0). */
export function recordDispatchStart(p: DispatchRunStartParams): void {
  useSubagentRuntimeStore.getState().upsert(baseSubAgent(p))
}

/** Record a subagent run completing successfully with its final text + usage. */
export function recordDispatchComplete(
  id: string,
  result: {
    text: string
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  }
): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[id]
  if (!sa) return
  store.upsert({
    ...sa,
    status: "completed",
    progress: 100,
    backgrounded: false,
    completedAt: new Date(),
    lastActivityAt: new Date(),
    result: {
      success: true,
      finalResponse: result.text,
      steps: [],
      totalSteps: 0,
      duration: sa.startedAt ? Date.now() - sa.startedAt.getTime() : 0,
      ...(result.usage
        ? {
            tokenUsage: {
              promptTokens: result.usage.inputTokens,
              completionTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            },
          }
        : {}),
    },
  })
}

/** Record a subagent run that failed (error text). */
export function recordDispatchFailed(id: string, error: string): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[id]
  if (!sa) return
  store.upsert({
    ...sa,
    status: "failed",
    backgrounded: false,
    error,
    completedAt: new Date(),
    lastActivityAt: new Date(),
  })
}

/** Set a run's live progress (0..100; clamped by the store). */
export function recordDispatchProgress(id: string, progress: number): void {
  useSubagentRuntimeStore.getState().setProgress(id, progress)
}

/** Append a timestamped log line to a run (no-op for an unknown run). */
export function recordDispatchLog(id: string, level: SubAgentLog["level"], message: string): void {
  useSubagentRuntimeStore.getState().appendLog(id, { timestamp: new Date(), level, message })
}

/**
 * Heuristic "indeterminate" progress from the number of tool calls a run has
 * made so far — a real subagent has no completion percentage, so this rises
 * monotonically and is capped below 100 (only `recordDispatchComplete` reaches
 * 100). 10% per tool call, capped at 95%.
 */
export function dispatchProgressForToolCount(toolCalls: number): number {
  return Math.min(95, Math.max(0, toolCalls) * 10)
}

/**
 * Build a {@link CaptureStreamEvent} sink for a single dispatched run. It folds
 * the child's live tool activity into the runtime store: each `tool-call` logs
 * the tool and advances the indeterminate progress bar; each `tool-result`
 * logs completion (a warning on error). Other event types (text/thinking/usage)
 * are ignored. Best-effort — a store error never propagates back into capture.
 */
export function createDispatchEventSink(id: string): (event: CaptureStreamEvent) => void {
  let toolCalls = 0
  return (event) => {
    if (event.type === "tool-call") {
      toolCalls += 1
      recordDispatchLog(id, "info", `Running ${event.toolName}`)
      recordDispatchProgress(id, dispatchProgressForToolCount(toolCalls))
    } else if (event.type === "tool-result") {
      recordDispatchLog(
        id,
        event.isError ? "warn" : "info",
        `${event.toolName} ${event.isError ? "failed" : "done"}`
      )
    }
  }
}

/** Record a dispatch refused by a nesting guard (max-depth / cycle). */
export function recordDispatchRejected(
  params: DispatchRunStartParams & {
    rejection: { reason: "max-depth" | "cycle"; message: string; attemptedDepth?: number }
  }
): void {
  const sa = baseSubAgent(params)
  useSubagentRuntimeStore.getState().upsert({
    ...sa,
    status: "rejected",
    rejection: params.rejection,
    completedAt: new Date(),
  })
}
