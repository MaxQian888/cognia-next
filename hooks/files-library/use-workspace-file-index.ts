"use client"

/**
 * The task-workspace ledger's resource index for the Files page (ADR-0223
 * §8). The ledger is not Dexie, so no live query sees it change; the index is
 * re-read when a turn settles (the code-adoption tracker writes its turn row
 * right after the ledger settles the run), when the page comes back into
 * view, and on mount.
 */

import { useEffect, useRef, useState } from "react"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getDb } from "@/lib/db/schema"
import { loadWorkspaceFileIndex } from "@/lib/files-library/workspace-files-io"
import type { TaskResourceIndexEntry } from "@/lib/task-workspace/types"

export interface WorkspaceFileIndexState {
  /** Null when the ledger could not be asked. */
  index: TaskResourceIndexEntry[] | null
}

/** A value that changes whenever a turn row is written. */
async function settledTurnsRevision(): Promise<string> {
  const table = getDb().codeAdoptionTurns
  const [count, newest] = await Promise.all([table.count(), table.orderBy("ts").last()])
  return `${count}:${newest?.ts ?? 0}`
}

/**
 * Undefined until the first read resolves, and always while `enabled` is
 * false (this device lists no workspace files of its own).
 */
export function useWorkspaceFileIndex(
  enabled: boolean,
  deps: { load?: () => Promise<TaskResourceIndexEntry[] | null> } = {}
): WorkspaceFileIndexState | undefined {
  const [state, setState] = useState<WorkspaceFileIndexState | undefined>(undefined)
  const [visibleTick, setVisibleTick] = useState(0)
  const generation = useRef(0)
  const load = deps.load ?? loadWorkspaceFileIndex
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const turns = useClientLiveQuery(() => (enabled ? settledTurnsRevision() : ""), [enabled], "")

  useEffect(() => {
    if (!enabled) return
    const onVisible = () => {
      if (document.visibilityState === "visible") setVisibleTick((tick) => tick + 1)
    }
    window.addEventListener("focus", onVisible)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", onVisible)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || turns === undefined) return
    const current = ++generation.current
    void loadRef.current().then((index) => {
      // A newer read started meanwhile: its answer is the one to keep.
      if (current === generation.current) setState({ index })
    })
  }, [enabled, turns, visibleTick])

  return enabled ? state : undefined
}
