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
import type { SubAgent } from "@/types/agent/sub-agent"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { createSubAgentNode, indeterminateSubagentProgress } from "@/lib/claude/subagent-projection"

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
  return createSubAgentNode({
    id: p.id,
    name: p.name,
    task: p.task,
    parentAgentId: p.parentAgentId ?? CHAT_PARENT,
    depth: p.depth,
    ...(p.parentSubagentId ? { parentSubagentId: p.parentSubagentId } : {}),
    ...(p.parentSessionId ? { sessionId: p.parentSessionId } : {}),
    ...(p.backgrounded ? { backgrounded: true } : {}),
  })
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

/** Record a subagent run cancelled by the user (abort). */
export function recordDispatchCancelled(id: string): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[id]
  if (!sa) return
  store.upsert({
    ...sa,
    status: "cancelled",
    backgrounded: false,
    completedAt: new Date(),
    lastActivityAt: new Date(),
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

/**
 * Indeterminate progress from the tool-call count — re-exported from the shared
 * {@link indeterminateSubagentProgress} so both subagent engines stay identical.
 * Kept as a named export for the existing callers/tests.
 */
export const dispatchProgressForToolCount = indeterminateSubagentProgress

/**
 * Build a {@link CaptureStreamEvent} sink for a single dispatched run. It folds
 * the child's live tool activity into the runtime store: each `tool-call` logs
 * the tool and advances the indeterminate progress bar; each `tool-result`
 * logs completion (a warning on error). Other event types (text/thinking/usage)
 * are ignored. Best-effort — a store error never propagates back into capture.
 */
export function createDispatchEventSink(id: string): (event: CaptureStreamEvent) => void {
  let toolCalls = 0
  // When the SDK omits a tool_use id, synthesize one and pair the next
  // result by tool name (best-effort) so the inline tool list still resolves.
  let synthSeq = 0
  const lastIdByName = new Map<string, string>()
  return (event) => {
    const store = useSubagentRuntimeStore.getState()
    if (event.type === "tool-call") {
      toolCalls += 1
      const callId = event.id ?? `tc-${id}-${(synthSeq += 1)}`
      lastIdByName.set(event.toolName, callId)
      // One batched store write (log + progress + toolUses + toolStart) per
      // tool-call — a single map spread + subscriber notification.
      store.applyRunEvent(id, {
        log: { timestamp: new Date(), level: "info", message: `Running ${event.toolName}` },
        progress: dispatchProgressForToolCount(toolCalls),
        toolUses: toolCalls,
        toolStart: { id: callId, name: event.toolName, input: event.input },
      })
    } else if (event.type === "tool-result") {
      const callId = event.id ?? lastIdByName.get(event.toolName)
      store.applyRunEvent(id, {
        log: {
          timestamp: new Date(),
          level: event.isError ? "warn" : "info",
          message: `${event.toolName} ${event.isError ? "failed" : "done"}`,
        },
        ...(callId
          ? { toolEnd: { id: callId, output: event.result, isError: event.isError } }
          : {}),
      })
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
