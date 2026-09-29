"use client"

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import type { ChatSession } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { useClientLiveQuery } from "@/hooks/data"
import { useSessionRunStatusMap } from "@/hooks/chat/use-session-run-status-map"
import { listProjectThreads } from "@/lib/project-coordinator/thread-runtime"
import {
  THREAD_BOARD_ORDER,
  deriveThreadState,
  type ThreadBoardState,
} from "@/lib/project-coordinator/thread-state"

/**
 * A coordinator's threads with their live board state (ADR-0204). One Dexie
 * live query for the rows plus one store read for every row's turn state and
 * pending asks, the same shape the conversation lists use.
 */

export interface ProjectThreadRow {
  thread: ChatSession
  status: ChatStatus
  pendingApprovals: number
  state: ThreadBoardState
}

const EMPTY: ChatSession[] = []

/** `undefined` while loading; `[]` with no coordinator. */
export function useProjectThreads(coordinatorSessionId: string | undefined) {
  return useClientLiveQuery(
    () => (coordinatorSessionId ? listProjectThreads(coordinatorSessionId) : EMPTY),
    [coordinatorSessionId],
    EMPTY
  )
}

function usePendingApprovalCounts(): Readonly<Record<string, number>> {
  return useChatStore(
    useShallow((state) => {
      const out: Record<string, number> = {}
      for (const [id, slice] of Object.entries(state.sessions ?? {})) {
        if (slice?.pendingApprovals?.length) out[id] = slice.pendingApprovals.length
      }
      return out
    })
  )
}

/** Board rows, ordered by what needs the user first, then most recent. */
export function useProjectThreadRows(
  threads: readonly ChatSession[] | undefined,
  now: number
): ProjectThreadRow[] | undefined {
  const statuses = useSessionRunStatusMap()
  const approvals = usePendingApprovalCounts()
  return useMemo(() => {
    if (!threads) return undefined
    return threads
      .map((thread) => {
        const status = statuses.get(thread.id) ?? "idle"
        const pendingApprovals = approvals[thread.id] ?? 0
        return {
          thread,
          status,
          pendingApprovals,
          state: deriveThreadState({ thread, status, pendingApprovals, now }),
        }
      })
      .sort(
        (a, b) =>
          THREAD_BOARD_ORDER.indexOf(a.state) - THREAD_BOARD_ORDER.indexOf(b.state) ||
          b.thread.updatedAt - a.thread.updatedAt
      )
  }, [threads, statuses, approvals, now])
}
