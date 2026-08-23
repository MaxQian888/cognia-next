"use client"

/**
 * Workspace changes for one remote session, read from the host's patch set.
 *
 * A phone cannot derive this from anything local. `resource.changed` events
 * are `visibility: "private"` and never sync, and the run snapshot that DOES
 * sync deliberately carries no paths. What a paired device may ask for is the
 * task-workspace ledger: `task_workspace_list`, `task_workspace_list_runs` and
 * `task_workspace_get_patch_set` are all read-only companion RPCs, so the whole
 * chain resolves client-side and no new host command is needed for it.
 *
 * Bodies are fetched one file at a time, only on demand, and only for files
 * {@link projectPatchSetChanges} already judged renderable — see that module
 * for why an empty diff body is the failure mode this guards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  getTaskPatchSet,
  listTaskRuns,
  listTaskWorkspaces,
  readTaskResourceDiff,
} from "@/lib/task-workspace/client"
import { projectPatchSetChanges, type RunChangeSet } from "@/lib/task-workspace/run-changes"
import type { TaskRunState } from "@/lib/task-workspace/types"

export interface SessionRunOption {
  runId: string
  createdAt: number
  /**
   * Load-bearing, not decoration: a run still `running` or `settling` has no
   * patch set yet, and an absent patch set must not be presented as "this turn
   * changed nothing".
   */
  state: TaskRunState
}

/** Absence from the map IS the un-requested state; there is no `idle` member. */
export type DiffLoad =
  | { status: "loading" }
  | { status: "loaded"; text: string }
  /** The host answered with no body for a file it said had hunks. */
  | { status: "empty" }
  | { status: "error"; message: string }

export interface SessionChangesState {
  loading: boolean
  error?: string
  /** The host has no tracked workspace for this session — not an error. */
  untracked: boolean
  runs: SessionRunOption[]
  selectedRunId?: string
  selectRun: (runId: string) => void
  changes?: RunChangeSet
  diffs: Record<string, DiffLoad>
  loadDiff: (path: string) => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const RUN_REFRESH_MS = 1_500
const isUnsettled = (state: TaskRunState): boolean => state === "running" || state === "settling"

async function loadRunOptions(taskIds: readonly string[]): Promise<SessionRunOption[]> {
  const batches = await Promise.all(taskIds.map((taskId) => listTaskRuns(taskId)))
  return batches
    .flat()
    .map((run) => ({ runId: run.runId, createdAt: run.createdAt, state: run.state }))
    .sort((left, right) => right.createdAt - left.createdAt)
}

export function useSessionChanges(sessionId: string): SessionChangesState {
  const [runs, setRuns] = useState<SessionRunOption[]>([])
  const [taskIds, setTaskIds] = useState<string[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  const [changes, setChanges] = useState<RunChangeSet | undefined>(undefined)
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({})
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingPatch, setLoadingPatch] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [untracked, setUntracked] = useState(false)
  // Read inside `loadDiff` so the callback does not re-create per patch load
  // and drop the in-flight map it is closing over.
  const changesRef = useRef<RunChangeSet | undefined>(undefined)
  changesRef.current = changes
  // Paths already asked for. Kept apart from `diffs` because the guard has to
  // hold synchronously: two taps in one tick both read the same pre-update
  // state, so a check against `diffs` would let the second request through.
  const requested = useRef<Set<string>>(new Set())
  // Invalidates bodies requested for a previous session or run. Clearing the
  // visible map alone is insufficient because an older promise can still
  // resolve afterward and repopulate it.
  const diffGeneration = useRef(0)

  useEffect(() => {
    let cancelled = false
    diffGeneration.current += 1
    requested.current = new Set()
    setLoadingRuns(true)
    setError(undefined)
    setUntracked(false)
    setRuns([])
    setTaskIds([])
    setSelectedRunId(undefined)
    setChanges(undefined)
    setDiffs({})
    void (async () => {
      try {
        const workspaces = await listTaskWorkspaces(sessionId)
        // One session can own several task workspaces (a re-based turn opens a
        // new one), so every workspace's runs are folded into a single
        // newest-first list rather than picking one workspace arbitrarily.
        const workspaceTaskIds = workspaces.map((workspace) => workspace.taskId)
        const options = await loadRunOptions(workspaceTaskIds)
        if (cancelled) return
        setTaskIds(workspaceTaskIds)
        setRuns(options)
        setUntracked(options.length === 0)
        setSelectedRunId(options[0]?.runId)
      } catch (cause) {
        if (!cancelled) setError(message(cause))
      } finally {
        if (!cancelled) setLoadingRuns(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const hasUnsettledRuns = runs.some((run) => isUnsettled(run.state))

  useEffect(() => {
    if (!hasUnsettledRuns || taskIds.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      let continuePolling = true
      try {
        const options = await loadRunOptions(taskIds)
        if (cancelled) return
        continuePolling = options.some((run) => isUnsettled(run.state))
        setRuns(options)
        setUntracked(options.length === 0)
        setSelectedRunId((current) =>
          current && options.some((run) => run.runId === current) ? current : options[0]?.runId
        )
        setError(undefined)
      } catch (cause) {
        if (!cancelled) setError(message(cause))
      }
      if (!cancelled && continuePolling) timer = setTimeout(poll, RUN_REFRESH_MS)
    }

    timer = setTimeout(poll, RUN_REFRESH_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [hasUnsettledRuns, taskIds])

  const selectedRunState = runs.find((run) => run.runId === selectedRunId)?.state

  useEffect(() => {
    if (!selectedRunId) return
    let cancelled = false
    diffGeneration.current += 1
    setLoadingPatch(true)
    setError(undefined)
    setChanges(undefined)
    setDiffs({})
    requested.current = new Set()
    void (async () => {
      try {
        const patch = await getTaskPatchSet(selectedRunId)
        if (cancelled) return
        // A run that touched nothing settles without a patch set at all. That
        // is "no changes", which is a different answer from "not tracked".
        setChanges(patch ? projectPatchSetChanges(patch) : undefined)
      } catch (cause) {
        if (!cancelled) setError(message(cause))
      } finally {
        if (!cancelled) setLoadingPatch(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedRunId, selectedRunState])

  const loadDiff = useCallback(
    (path: string) => {
      const runId = selectedRunId
      const generation = diffGeneration.current
      const file = changesRef.current?.files.find((entry) => entry.path === path)
      // Never ask for a body this surface already decided it will not render:
      // a sensitive path must not be requested at all, and a file with no
      // stored hunks would answer with an empty string that reads as "clean".
      if (!runId || !file || file.availability !== "available") return
      if (requested.current.has(path)) return
      requested.current.add(path)
      setDiffs((prev) => ({ ...prev, [path]: { status: "loading" } }))
      void (async () => {
        try {
          // `allowSensitive` stays false unconditionally. The host would grant
          // it to a device holding `workspace.write`, but a phone screen is
          // not where a credential diff should land.
          const text = await readTaskResourceDiff(runId, path, false)
          if (diffGeneration.current !== generation) return
          setDiffs((prev) => ({
            ...prev,
            [path]: text.trim().length > 0 ? { status: "loaded", text } : { status: "empty" },
          }))
        } catch (cause) {
          // Dropped from the asked-for set so the surface can offer a retry;
          // a success stays recorded and is never re-fetched.
          if (diffGeneration.current !== generation) return
          requested.current.delete(path)
          setDiffs((prev) => ({ ...prev, [path]: { status: "error", message: message(cause) } }))
        }
      })()
    },
    [selectedRunId]
  )

  const selectRun = useCallback((runId: string) => setSelectedRunId(runId), [])

  return useMemo(
    () => ({
      loading: loadingRuns || loadingPatch,
      ...(error ? { error } : {}),
      untracked,
      runs,
      ...(selectedRunId ? { selectedRunId } : {}),
      selectRun,
      ...(changes ? { changes } : {}),
      diffs,
      loadDiff,
    }),
    [
      loadingRuns,
      loadingPatch,
      error,
      untracked,
      runs,
      selectedRunId,
      selectRun,
      changes,
      diffs,
      loadDiff,
    ]
  )
}
