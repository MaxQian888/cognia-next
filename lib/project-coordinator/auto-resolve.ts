import type { ChatSession } from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { shouldAutoResolve } from "./thread-state"

/**
 * The idle sweep (ADR-0204): a thread with nothing in flight and a week
 * without activity is resolved automatically, so the board stays about
 * current work. Resolution is reversible (reopen, or send it a message).
 */

export interface AutoResolveDeps {
  statusOf: (sessionId: string) => ChatStatus
  pendingApprovals: (sessionId: string) => number
  resolve: (threadId: string) => Promise<unknown>
  now: () => number
}

/** Resolve every thread due; returns how many were resolved. */
export async function sweepIdleThreads(
  threads: readonly ChatSession[],
  deps: AutoResolveDeps
): Promise<number> {
  const now = deps.now()
  const due = threads.filter((thread) =>
    shouldAutoResolve({
      thread,
      status: deps.statusOf(thread.id),
      pendingApprovals: deps.pendingApprovals(thread.id),
      now,
    })
  )
  for (const thread of due) await deps.resolve(thread.id)
  return due.length
}

/**
 * The coordinator stays live (background-held) while any of its threads is
 * working or started-but-undelivered, so a report can wake it with no pane
 * open. Once every thread is quiet the hold is released.
 */
export function coordinatorNeedsHold(
  threads: readonly ChatSession[],
  statusOf: (sessionId: string) => ChatStatus
): boolean {
  return threads.some(
    (thread) =>
      thread.projectThread?.resolvedAt === undefined &&
      (statusOf(thread.id) !== "idle" || thread.attachedChild?.status === "running")
  )
}
