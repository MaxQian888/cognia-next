import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import type { ChatStatus, SessionChatSlice } from "@/stores/chat/chat-store"
import { useChatStore } from "@/stores/chat"
import { extractAssistantText } from "@/hooks/chat/claude-chat-turn-tasks"
import { reportThreadToCoordinator, type ThreadOutcome, type ThreadReport } from "./report"
import { isThreadStopping, releaseThreadHold } from "./thread-runtime"

/**
 * Watches every known project thread's live slice and settles each turn that
 * ends: the result is reported to the coordinator and the background hold is
 * released. One observer for every way a turn ends — a sealed result, an
 * error, a dead sidecar — instead of a hook in each of those paths.
 *
 * A turn a person drives by opening the thread and typing reports too: the
 * coordinator tracks the thread's state, whoever moved it.
 */

export interface ThreadTurnSettled {
  thread: ChatSession
  outcome: ThreadOutcome
  summary: string
}

type SliceView = Pick<SessionChatSlice, "status" | "messages" | "errorMessage">

function isInFlight(status: ChatStatus | undefined): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

function lastAssistantText(messages: readonly UIMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "assistant")
  return extractAssistantText(last).trim()
}

/** Pure: the settled turns implied by one store transition. */
export function settledThreadTurns(
  previous: Readonly<Record<string, SliceView>>,
  next: Readonly<Record<string, SliceView>>,
  threadOf: (sessionId: string) => ChatSession | undefined
): ThreadTurnSettled[] {
  const settled: ThreadTurnSettled[] = []
  for (const [sessionId, slice] of Object.entries(next)) {
    if (!isInFlight(previous[sessionId]?.status) || isInFlight(slice.status)) continue
    const thread = threadOf(sessionId)
    if (!thread) continue
    if (slice.status === "error") {
      settled.push({ thread, outcome: "error", summary: slice.errorMessage ?? "" })
    } else {
      settled.push({ thread, outcome: "completed", summary: lastAssistantText(slice.messages) })
    }
  }
  return settled
}

export function toThreadReport(event: ThreadTurnSettled): ThreadReport | undefined {
  const coordinatorSessionId = event.thread.projectThread?.coordinatorSessionId
  if (!coordinatorSessionId) return undefined
  return {
    threadId: event.thread.id,
    coordinatorSessionId,
    title: event.thread.title,
    outcome: event.outcome,
    summary: event.summary,
    ...(event.thread.projectThread?.declaredState
      ? { declaredState: event.thread.projectThread.declaredState }
      : {}),
  }
}

export interface ThreadWatcherDeps {
  report: (report: ThreadReport) => void
  release: (threadId: string) => void
  isStopping: (threadId: string) => boolean
  onSettled?: (event: ThreadTurnSettled) => void
}

const defaultDeps: ThreadWatcherDeps = {
  report: (report) => reportThreadToCoordinator(report),
  release: (threadId) => releaseThreadHold(threadId),
  isStopping: isThreadStopping,
}

/**
 * Start watching. `threadOf` answers from the caller's live view of the
 * workspace's threads. Returns the unsubscribe.
 */
export function watchProjectThreadTurns(
  threadOf: (sessionId: string) => ChatSession | undefined,
  deps: ThreadWatcherDeps = defaultDeps
): () => void {
  return useChatStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    for (const event of settledThreadTurns(previous.sessions, state.sessions, threadOf)) {
      deps.onSettled?.(event)
      if (deps.isStopping(event.thread.id)) continue
      const report = toThreadReport(event)
      if (report) deps.report(report)
      deps.release(event.thread.id)
    }
  })
}
