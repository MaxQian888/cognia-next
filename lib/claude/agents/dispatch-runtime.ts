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
