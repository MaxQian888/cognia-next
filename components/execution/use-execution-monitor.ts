"use client"

/**
 * Live "what is running right now" hook backing the {@link ExecutionMonitorPanel}.
 *
 * Fans three live sources into one normalized row list (see
 * `lib/execution/monitor-model.ts`):
 *  - the in-memory {@link getExecutionBroker} legs (via `useSyncExternalStore`),
 *  - active `workflowRuns` (Dexie `useLiveQuery`),
 *  - recent scheduler `executions` (Dexie `useLiveQuery`).
 *
 * The two persisted sources share ONE `useLiveQuery` so the hook re-renders on a
 * single subscription and stays trivially mockable in tests.
 */

import { useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getDb } from "@/lib/db/schema"
import { listExecutionRuns } from "@/lib/db/execution-runs"
import { getExecutionBroker } from "@/lib/execution/broker"
import {
  buildExecutionMonitorModel,
  countRunningRows,
  type UnifiedExecutionRow,
} from "@/lib/execution/monitor-model"
import type { TaskExecution } from "@/types/scheduler"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { ExecutionRun } from "@/types/execution/run"

export interface ExecutionMonitorState {
  rows: UnifiedExecutionRow[]
  runningCount: number
  /** True until the persisted sources have resolved at least once. */
  isLoading: boolean
}

const EMPTY_LEGS: UnifiedExecutionRow[] = []

interface PersistedSources {
  executionRuns: ExecutionRun[]
  workflowRuns: WorkflowRunRow[]
  schedulerExecutions: TaskExecution[]
}

export function useExecutionMonitor(projectId?: string): ExecutionMonitorState {
  const broker = getExecutionBroker()
  const brokerLegs = useSyncExternalStore(
    broker.subscribe,
    broker.getSnapshot,
    // Static export / SSR: no live broker — render nothing.
    () => EMPTY_LEGS as never
  )

  const persisted = useLiveQuery<PersistedSources>(async () => {
    const [executionRuns, workflowRuns, schedulerExecutions] = await Promise.all([
      listExecutionRuns({
        statuses: ["queued", "running", "waiting", "paused", "recovery_required"],
        limit: 100,
      }),
      getDb().workflowRuns.orderBy("startedAt").reverse().limit(100).toArray(),
      schedulerDb.getRecentExecutions(100),
    ])
    return { executionRuns, workflowRuns, schedulerExecutions }
  }, [])

  const rows = useMemo(
    () =>
      buildExecutionMonitorModel({
        brokerLegs,
        executionRuns: persisted?.executionRuns ?? [],
        workflowRuns: persisted?.workflowRuns ?? [],
        schedulerExecutions: persisted?.schedulerExecutions ?? [],
        ...(projectId ? { projectId } : {}),
      }),
    [brokerLegs, persisted, projectId]
  )

  return { rows, runningCount: countRunningRows(rows), isLoading: persisted === undefined }
}
