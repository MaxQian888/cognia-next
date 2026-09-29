"use client"

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import type { ChatSession } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { useClientLiveQuery } from "@/hooks/data"
import { useSessionRunStatusMap } from "@/hooks/chat/use-session-run-status-map"
import { listProjectThreads } from "@/lib/project-coordinator/thread-runtime"
import { listSessionPrObservationsByProject } from "@/lib/db/session-pr-observations"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"
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
  /** Observed pull-request status, when the thread's PR is being watched. */
  pr?: PrDerivedStatus
  state: ThreadBoardState
}

export type ThreadPrStatuses = ReadonlyMap<string, PrDerivedStatus>

const NO_PR_STATUSES: ThreadPrStatuses = new Map()

/** The observed PR status of every watched thread in a workspace, by thread id. */
export function useThreadPrStatuses(projectId: string | undefined): ThreadPrStatuses {
  const rows = useClientLiveQuery(
    () => (projectId ? listSessionPrObservationsByProject(projectId) : []),
    [projectId],
    []
  )
  return useMemo(
    () =>
      rows?.length
        ? new Map(rows.map((row) => [row.sessionId, row.derivedStatus] as const))
        : NO_PR_STATUSES,
    [rows]
  )
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
  now: number,
  prStatuses: ThreadPrStatuses = NO_PR_STATUSES
): ProjectThreadRow[] | undefined {
  const statuses = useSessionRunStatusMap()
  const approvals = usePendingApprovalCounts()
  return useMemo(() => {
    if (!threads) return undefined
    return threads
      .map((thread) => {
        const status: ChatStatus = statuses.get(thread.id) ?? "idle"
        const pendingApprovals = approvals[thread.id] ?? 0
        const pr = prStatuses.get(thread.id)
        return {
          thread,
          status,
          pendingApprovals,
          ...(pr ? { pr } : {}),
          state: deriveThreadState({ thread, status, pendingApprovals, pr, now }),
        }
      })
      .sort(
        (a, b) =>
          THREAD_BOARD_ORDER.indexOf(a.state) - THREAD_BOARD_ORDER.indexOf(b.state) ||
          b.thread.updatedAt - a.thread.updatedAt
      )
  }, [threads, statuses, approvals, prStatuses, now])
}
