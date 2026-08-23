"use client"

/**
 * The selected run's detail, live.
 *
 * Reads three things and hands them to the pure projection in
 * `lib/execution/run-detail-model.ts`: the run row (for its snapshot), the raw
 * journal, and the run's approvals.
 *
 * ## Private events, and why they are read here
 *
 * `resource.changed` is written `visibility: "private"` because it names
 * workspace paths and the snapshot is projected onto IM cards. That tier exists
 * to keep paths out of REMOTE projections, not out of the console running on
 * the machine that owns the workspace — so this hook passes `includePrivate`.
 *
 * ## Why `journalAvailable` exists
 *
 * `/agent-runs` is `companion: "remote"` (see `lib/runtime/surface-contract.ts`),
 * so it also renders on a paired phone. Mobile sync ships `executionRuns` and
 * nothing else — not `executionRunEvents`, not `executionRunInterrupts`. An
 * empty Changes list there would claim "this run touched no files", which is a
 * different and much worse statement than "the journal is not on this device".
 * A run whose revision has moved but whose journal came back empty is exactly
 * that case, and the panel says so instead of showing a confident zero.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import { getExecutionRun, listVisibleExecutionRunEvents } from "@/lib/db/execution-runs"
import { projectRunDetail, type RunDetailProjection } from "@/lib/execution/run-detail-model"
import type { ExecutionRun, ExecutionRunInterrupt, RunEvent } from "@/types/execution/run"

export interface ExecutionRunDetailState {
  run?: ExecutionRun
  detail: RunDetailProjection
  /** Newest first. Empty on a device the journal does not reach. */
  interrupts: ExecutionRunInterrupt[]
  /**
   * False when this device holds the run summary but not its journal — the
   * event-derived sections are unavailable, NOT empty.
   */
  journalAvailable: boolean
  isLoading: boolean
}

const EMPTY_DETAIL: RunDetailProjection = {
  activities: [],
  omittedActivityCount: 0,
  artifacts: [],
  verifications: [],
  changes: [],
}

interface RunDetailSources {
  run: ExecutionRun | undefined
  events: RunEvent[]
  interrupts: ExecutionRunInterrupt[]
}

export function useExecutionRunDetail(runId: string | undefined): ExecutionRunDetailState {
  const sources = useLiveQuery<RunDetailSources | null>(async () => {
    if (!runId) return null
    const run = await getExecutionRun(runId)
    if (!run) return { run: undefined, events: [], interrupts: [] }
    const [events, interrupts] = await Promise.all([
      listVisibleExecutionRunEvents(runId, true),
      getDb().executionRunInterrupts.where("runId").equals(runId).toArray(),
    ])
    return {
      run,
      events,
      interrupts: interrupts.sort((left, right) => right.createdAt - left.createdAt),
    }
  }, [runId])

  if (!runId) {
    return { detail: EMPTY_DETAIL, interrupts: [], journalAvailable: true, isLoading: false }
  }
  if (sources === undefined) {
    return { detail: EMPTY_DETAIL, interrupts: [], journalAvailable: true, isLoading: true }
  }

  const run = sources?.run
  const events = sources?.events ?? []
  // A run that has appended at least one event but whose journal reads empty is
  // a summary that travelled without its history.
  const journalAvailable = !run || run.currentRevision === 0 || events.length > 0

  return {
    ...(run ? { run } : {}),
    detail: projectRunDetail(run?.latestSnapshot, events),
    interrupts: sources?.interrupts ?? [],
    journalAvailable,
    isLoading: false,
  }
}
