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
 *
 * `live: false` freezes the output: the panel's "Live off" stopped polling the
 * log store, while this live query kept pushing spans into the same list. The
 * live query keeps running underneath (it is what a manual refresh reads),
 * but what the hook returns is a snapshot taken when following stopped, and
 * it is re-taken only when `refreshToken` changes.
 */

import { useMemo, useState } from "react"
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
  const live = options.live !== false
  const refreshToken = options.refreshToken ?? 0

  const rows = useLiveQuery(
    async () => {
      if (!enabled) return []
      return queryRecent(maxLogs)
    },
    [enabled, maxLogs],
    undefined as Awaited<ReturnType<typeof queryRecent>> | undefined
  )

  // Derived-state-from-props: the snapshot is re-taken during render when the
  // inputs that define it change, which React supports without an effect (and
  // without the extra frame an effect would show stale rows for). It changes
  // when following stops or resumes, when a refresh is asked for, and once
  // when a panel that mounted with Live off sees its first rows land.
  const [frozen, setFrozen] = useState<{
    live: boolean
    token: number
    rows: typeof rows
  }>(() => ({ live, token: refreshToken, rows: live ? undefined : rows }))
  if (
    frozen.live !== live ||
    frozen.token !== refreshToken ||
    (!live && frozen.rows === undefined && rows !== undefined)
  ) {
    setFrozen({ live, token: refreshToken, rows: live ? undefined : rows })
  }
  const visibleRows = live ? rows : frozen.rows

  const logs = useMemo<StructuredLogEntry[]>(() => {
    if (!visibleRows || visibleRows.length === 0) return EMPTY
    return visibleRows.map(spanToLogEntry)
  }, [visibleRows])

  return {
    logs,
    isLoading: enabled && visibleRows === undefined,
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
