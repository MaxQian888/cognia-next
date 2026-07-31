"use client"

/**
 * useAgentTraceAsLogs — surfaces persisted agent-trace spans as
 * `StructuredLogEntry[]` so the unified log panel can merge them next to
 * regular logs.
 *
 * Reads via `dexie-react-hooks` `useLiveQuery` so the panel re-renders the
 * moment the trace transport flushes a new batch. Each row is converted
 * through `spanToLogEntry`, which embeds the full span under
 * `data.span` — the log-detail panel pulls it back out via
 * `getAgentTraceLogData`.
 *
 * Sorting: newest-first, matching `useLogStream`. The panel runs a linear
 * two-pointer merge over the two streams.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type {
  StructuredLogEntry,
  UseAgentTraceLogsOptions,
  UseAgentTraceLogsReturn,
} from "@/types/logging"
import { queryRecent } from "@/lib/db/agent-traces"
import { spanToLogEntry } from "@cognia/agent-trace/span-to-log-entry"

export type { UseAgentTraceLogsOptions, UseAgentTraceLogsReturn } from "@/types/logging"

const EMPTY: StructuredLogEntry[] = []
const DEFAULT_MAX_LOGS = 500

export function useAgentTraceAsLogs(
  options: UseAgentTraceLogsOptions = {}
): UseAgentTraceLogsReturn {
  const enabled = options.enabled !== false
  const maxLogs = clampMaxLogs(options.maxLogs)

  const rows = useLiveQuery(
    async () => {
      if (!enabled) return []
      return queryRecent(maxLogs)
    },
    [enabled, maxLogs],
    undefined as Awaited<ReturnType<typeof queryRecent>> | undefined
  )

  const logs = useMemo<StructuredLogEntry[]>(() => {
    if (!rows || rows.length === 0) return EMPTY
    return rows.map(spanToLogEntry)
  }, [rows])

  return {
    logs,
    isLoading: enabled && rows === undefined,
    error: null,
  }
}

function clampMaxLogs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_LOGS
  }
  return Math.min(Math.floor(value), 5_000)
}

export default useAgentTraceAsLogs
