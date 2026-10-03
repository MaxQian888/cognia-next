"use client"

/**
 * The files a conversation's task workspaces changed, with line totals.
 *
 * Extracted from `SessionResultsSection` so the dock's results section, the
 * session summary card and the dock's changes badge read one loader instead
 * of each opening their own workspace subscription. The behaviour is the one
 * that section always had: subscribe to workspace events first, then list
 * every task workspace bound to the session (plus the active run's), and
 * re-list whenever the active run moves or publishes a new provisional
 * revision. A response for a superseded request is discarded.
 */

import { useEffect, useMemo, useState } from "react"

import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import {
  installTaskWorkspaceEventListener,
  listTaskResources,
  listTaskWorkspaces,
} from "@/lib/task-workspace/client"
import type { ResourceChange } from "@/lib/task-workspace/types"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"

export interface SessionChangeTotals {
  files: number
  insertions: number
  deletions: number
  /**
   * False when at least one changed file reported no line counts (binary files,
   * captures that recorded only a hash). The totals then undercount, so a
   * surface shows the file count alone rather than a precise-looking lie.
   */
  linesKnown: boolean
}

export interface SessionResourceChanges {
  /** False on hosts with no workspace filesystem backend (the web shell). */
  available: boolean
  /** Latest list, or the store's cached one while a refresh is in flight. */
  resources: ResourceChange[] | undefined
  /** True once a task workspace is known to track this session. */
  tracked: boolean
  /** No response yet for the current request and nothing cached. */
  loading: boolean
  /** A successful response arrived for the current request. */
  settled: boolean
  /** The last listing or the event subscription failed. */
  failed: boolean
  totals: SessionChangeTotals
  retry: () => void
}

/** Sum line counts; any unknown count makes the line totals unknown. */
export function summarizeResourceChanges(
  resources: readonly ResourceChange[] | undefined
): SessionChangeTotals {
  let insertions = 0
  let deletions = 0
  let linesKnown = true
  for (const resource of resources ?? []) {
    if (resource.insertions === null || resource.deletions === null) linesKnown = false
    insertions += resource.insertions ?? 0
    deletions += resource.deletions ?? 0
  }
  return { files: resources?.length ?? 0, insertions, deletions, linesKnown }
}

/**
 * `sessionId` is null on a surface with no conversation (an empty dock): the
 * hook then lists nothing and reports no changes.
 */
export function useSessionResourceChanges(sessionId: string | null): SessionResourceChanges {
  const available = hasWorkspaceFsBackend() && sessionId !== null
  const active = useTaskWorkspaceStore((state) =>
    sessionId ? state.activeBySession[sessionId] : undefined
  )
  const cached = useTaskWorkspaceStore((state) =>
    active ? state.resourcesByTask[active.taskId] : undefined
  )
  const provisional = useTaskWorkspaceStore((state) =>
    active ? state.provisionalByRun[active.runId] : undefined
  )
  const taskId = active?.taskId
  const requestKey = active
    ? `${sessionId}:${active.taskId}:${active.runId}:${active.state}:${provisional?.revision ?? 0}`
    : (sessionId ?? "")
  const [loaded, setLoaded] = useState<{
    key: string
    resources?: ResourceChange[]
    failed?: boolean
    tracked?: boolean
  } | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [listenerFailed, setListenerFailed] = useState(false)

  useEffect(() => {
    if (!available) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void installTaskWorkspaceEventListener().then(
      (stop) => {
        if (disposed) stop()
        else {
          unlisten = stop
          setListenerFailed(false)
        }
      },
      () => {
        if (!disposed) setListenerFailed(true)
      }
    )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [retryCount, available])

  useEffect(() => {
    if (!available || !sessionId) return
    let cancelled = false
    void listTaskWorkspaces(sessionId)
      .then(async (workspaces) => {
        const ids = new Set(
          workspaces
            .filter((workspace) => workspace.sessionId === sessionId)
            .map((workspace) => workspace.taskId)
        )
        if (taskId) ids.add(taskId)
        const batches = await Promise.all([...ids].map((id) => listTaskResources(id)))
        return { resources: batches.flat(), tracked: ids.size > 0 }
      })
      .then(
        ({ resources, tracked }) => {
          if (!cancelled) setLoaded({ key: requestKey, resources, tracked })
        },
        () => {
          if (!cancelled) setLoaded({ key: requestKey, failed: true })
        }
      )
    return () => {
      cancelled = true
    }
  }, [sessionId, taskId, requestKey, retryCount, cached, available])

  const current = loaded?.key === requestKey ? loaded : null
  const resources = current?.resources ?? cached
  const totals = useMemo(() => summarizeResourceChanges(resources), [resources])

  return {
    available,
    resources,
    tracked: Boolean(active) || Boolean(current?.tracked),
    loading: available && !current && !resources,
    settled: Boolean(current && !current.failed),
    failed: Boolean(current?.failed) || listenerFailed,
    totals,
    retry: () => setRetryCount((value) => value + 1),
  }
}
