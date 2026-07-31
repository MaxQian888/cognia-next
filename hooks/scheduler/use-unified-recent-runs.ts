"use client"

import { useEffect, useState } from "react"
import {
  getSchedulerSourceRegistry,
  type SchedulerSourceRegistry,
} from "@/lib/scheduler/sources/registry"
import type { ScheduledItemKind } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface UseUnifiedRecentRunsOptions {
  limit?: number
  filterKind?: ScheduledItemKind
  filterItemId?: string
  registry?: SchedulerSourceRegistry
}

export interface UseUnifiedRecentRunsResult {
  runs: UnifiedExecutionRun[]
  isLoading: boolean
}

const DEFAULT_LIMIT = 20
export const RECENT_RUN_REFRESH_INTERVAL_MS = 5_000

export async function loadUnifiedRecentRuns(
  registry: SchedulerSourceRegistry,
  options: Omit<UseUnifiedRecentRunsOptions, "registry"> = {}
): Promise<UnifiedExecutionRun[]> {
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const sources = registry.listAllSources().filter((source) => source.listRuns)
  const settled = await Promise.allSettled(sources.map((source) => source.listRuns!(limit)))
  const batches = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))

  let runs = batches.flat().sort((a, b) => b.startedAt - a.startedAt)
  if (options.filterKind) runs = runs.filter((run) => run.kind === options.filterKind)
  if (options.filterItemId) {
    runs = runs.filter((run) => run.itemUnifiedId === options.filterItemId)
  }
  return runs.slice(0, limit)
}

export function useUnifiedRecentRuns(
  options: UseUnifiedRecentRunsOptions = {}
): UseUnifiedRecentRunsResult {
  const [result, setResult] = useState<UseUnifiedRecentRunsResult>({ runs: [], isLoading: true })
  const registry = options.registry ?? getSchedulerSourceRegistry()
  const limit = options.limit
  const filterKind = options.filterKind
  const filterItemId = options.filterItemId

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void loadUnifiedRecentRuns(registry, { limit, filterKind, filterItemId }).then((runs) => {
        if (!cancelled) setResult({ runs, isLoading: false })
      })
    }
    refresh()
    const timer = setInterval(refresh, RECENT_RUN_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [registry, limit, filterKind, filterItemId])

  return result
}

export {
  toUnifiedFromAudit,
  toUnifiedFromBackupHistory,
  toUnifiedFromTaskExecution,
  toUnifiedFromWorkflowRun,
} from "@/lib/scheduler/sources/run-mappers"
