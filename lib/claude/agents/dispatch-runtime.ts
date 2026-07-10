/**
 * Producer that feeds nested-dispatch runs into the subagent runtime store
 * (A5). When the `dispatch_agent` host tool runs a subagent, it records start /
 * retry / completion / rejection here, and the store's subscribers (the chat
 * `SubagentPart` tree via `subagent-bridge`, and the Settings runtime tab)
 * render the live tree. `createDispatchRunTracker` is the per-run event sink:
 * it folds live tool activity, streamed text, and cumulative token usage into
 * the store, and retains the streamed text so the error path can salvage
 * partial output.
 *
 * Pure-ish: it only touches the Zustand store's vanilla `getState()` API, so it
 * is callable from the renderer IPC handler (non-React) and unit-testable.
 */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent, SubAgentTokenUsage } from "@/types/agent/sub-agent"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { PluginDispatchErrorEnvelope } from "@/types/plugin/plugin-agent-sdk"
import { createSubAgentNode } from "@/lib/claude/subagent-projection"

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

/** Record a subagent run that failed, with its structured envelope. */
export function recordDispatchFailed(id: string, envelope: PluginDispatchErrorEnvelope): void {
  const store = useSubagentRuntimeStore.getState()
  const sa = store.subAgents[id]
  if (!sa) return
  store.upsert({
    ...sa,
    status: "failed",
    backgrounded: false,
    error: envelope.message,
    errorEnvelope: {
      code: envelope.code,
      retryable: envelope.retryable,
      ...(envelope.partialText ? { partialText: envelope.partialText } : {}),
    },
    completedAt: new Date(),
    lastActivityAt: new Date(),
    // Salvage streamed output so the failed chat card still shows the last
    // text the run produced before dying (Claude Code parity).
    ...(envelope.partialText
      ? {
          result: {
            success: false,
            finalResponse: envelope.partialText,
            steps: [],
            totalSteps: 0,
            duration: sa.startedAt ? Date.now() - sa.startedAt.getTime() : 0,
          },
        }
      : {}),
  })
}

/**
 * Record a transient-failure retry: bumps the honest `retryCount`, keeps the
 * run `running`, and logs a warn line so the card's activity log shows why the
 * run restarted.
 */
export function recordDispatchRetry(
  id: string,
  attempt: number,
  envelope: PluginDispatchErrorEnvelope,
  maxRetries?: number
): void {
  useSubagentRuntimeStore.getState().applyRunEvent(id, {
    retry: { attempt },
    log: {
      timestamp: new Date(),
      level: "warn",
      message: `Retrying after ${envelope.code} (attempt ${attempt}${
        maxRetries !== undefined ? `/${maxRetries}` : ""
      }): ${envelope.message}`,
    },
  })
}

/** Cap on retained streamed text (tail-kept) for partial-output salvage. */
const PARTIAL_TEXT_CAP = 32 * 1024
/** Minimum growth between stream-text store writes (avoids per-token churn). */
const STREAM_TEXT_FLUSH_STEP = 64

export interface DispatchRunTracker {
  /** The `_onEvent` sink threaded into `dispatchSubagent`. */
  sink: (event: CaptureStreamEvent) => void
  /** Text the run streamed so far (tail-capped) — the error path's salvage. */
  partialText: () => string
  /** Cumulative live token usage, when any usage event arrived. */
  liveUsage: () => SubAgentTokenUsage | undefined
}

/**
 * Build the per-run tracker for a single dispatched run. Its `sink` folds the
 * child's live activity into the runtime store — each `tool-call` logs the
 * tool and bumps the honest tool-use count, each `tool-result` logs completion,
 * `text-delta` coalesces into the streamed-text log line, and `usage` updates
 * the live cumulative token figure (mid-run `partial` snapshots SUM; the final
 * authoritative end-of-turn usage REPLACES the sum). The tracker additionally
 * retains the streamed text so the dispatch error path can salvage partial
 * output. Best-effort — a store error never propagates back into capture.
 */
export function createDispatchRunTracker(id: string): DispatchRunTracker {
  let toolCalls = 0
  // When the SDK omits a tool_use id, synthesize one and pair the next
  // result by tool name (best-effort) so the inline tool list still resolves.
  let synthSeq = 0
  const lastIdByName = new Map<string, string>()
  let textBuffer = ""
  let lastFlushedLength = 0
  // Partial usage snapshots accumulate; a final non-partial usage replaces.
  let summed: SubAgentTokenUsage | undefined
  let authoritative: SubAgentTokenUsage | undefined

  const currentUsage = () => authoritative ?? summed

  const sink = (event: CaptureStreamEvent) => {
    const store = useSubagentRuntimeStore.getState()
    if (event.type === "tool-call") {
      toolCalls += 1
      const callId = event.id ?? `tc-${id}-${(synthSeq += 1)}`
      lastIdByName.set(event.toolName, callId)
      // One batched store write (log + toolUses + toolStart) per tool-call —
      // a single map spread + subscriber notification. gap9: no `progress`
      // (the pseudo-percentage) — the honest `toolUses` count drives the UI.
      store.applyRunEvent(id, {
        log: { timestamp: new Date(), level: "info", message: `Running ${event.toolName}` },
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
    } else if (event.type === "text-delta") {
      textBuffer = (textBuffer + event.delta).slice(-PARTIAL_TEXT_CAP)
      // Coalesced streamed-text log line (the store replaces a trailing
      // stream-text entry), throttled so per-token deltas don't churn the store.
      if (textBuffer.length - lastFlushedLength >= STREAM_TEXT_FLUSH_STEP) {
        lastFlushedLength = textBuffer.length
        store.pushStreamText(id, textBuffer)
      }
    } else if (event.type === "usage") {
      const partial = (event as { partial?: boolean }).partial === true
      const snapshot = toSubAgentUsage(event.usage)
      if (partial) {
        summed = summed ? addUsage(summed, snapshot) : snapshot
      } else {
        authoritative = snapshot
      }
      const usage = currentUsage()
      if (usage) store.applyRunEvent(id, { usage })
    }
  }

  return {
    sink,
    partialText: () => textBuffer,
    liveUsage: currentUsage,
  }
}

function toSubAgentUsage(usage: {
  inputTokens?: number
  outputTokens?: number
}): SubAgentTokenUsage {
  const promptTokens = usage.inputTokens ?? 0
  const completionTokens = usage.outputTokens ?? 0
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

function addUsage(a: SubAgentTokenUsage, b: SubAgentTokenUsage): SubAgentTokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/** Record a dispatch refused by a nesting guard (max-depth / cycle / policy). */
export function recordDispatchRejected(
  params: DispatchRunStartParams & {
    rejection: {
      reason: "max-depth" | "cycle" | "policy"
      message: string
      attemptedDepth?: number
    }
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
