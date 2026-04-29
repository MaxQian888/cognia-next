/**
 * useLogStream Hook
 *
 * Provides real-time log streaming from IndexedDB storage.
 * Supports filtering, grouping by trace ID, auto-refresh, and incremental loading.
 */

import { useState, useEffect, useRef, useMemo } from "react"
import {
  IndexedDBTransport,
  getRegisteredModules,
  type StructuredLogEntry,
  type LogLevel,
  type LogFilter,
} from "@/lib/logger"

export interface LogStreamOptions {
  /** Enable auto-refresh polling */
  autoRefresh?: boolean
  /** Refresh interval in milliseconds */
  refreshInterval?: number
  /** Maximum number of logs to keep in memory */
  maxLogs?: number
  /** Filter by log level */
  level?: LogLevel | "all"
  /** Filter by module name */
  module?: string
  /** Filter by trace ID */
  traceId?: string
  /** Search query for message content */
  searchQuery?: string
  /** Use regex for search query */
  useRegex?: boolean
  /** Filter by tags */
  tags?: string[]
  /** Group logs by trace ID */
  groupByTraceId?: boolean
}

export interface LogStreamResult {
  logs: StructuredLogEntry[]
  groupedLogs: Map<string, StructuredLogEntry[]>
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
  clearLogs: () => Promise<void>
  exportLogs: (format?: "json" | "text") => string
  stats: {
    total: number
    byLevel: Record<LogLevel, number>
    byModule: Record<string, number>
    oldestEntry?: Date
    newestEntry?: Date
  }
  logRate: number
}

const DEFAULT_OPTIONS: LogStreamOptions = {
  autoRefresh: false,
  refreshInterval: 2000,
  maxLogs: 1000,
  level: "all",
  useRegex: false,
  groupByTraceId: false,
}

function buildSearchText(log: StructuredLogEntry): string {
  let text = `${log.message}\n${log.module}`
  if (log.traceId) text += `\n${log.traceId}`
  if (log.data) {
    for (const [key, value] of Object.entries(log.data)) {
      if (typeof value === "string") {
        text += `\n${key}:${value}`
      } else if (typeof value === "number" || typeof value === "boolean") {
        text += `\n${key}:${String(value)}`
      }
    }
  }
  return text.toLowerCase()
}

export function useLogStream(options: LogStreamOptions = {}): LogStreamResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const [logs, setLogs] = useState<StructuredLogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const transportRef = useRef<IndexedDBTransport | null>(null)
  const initialFetchDone = useRef(false)
  const lastFetchedTimestamp = useRef<string | null>(null)
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const searchTextCache = useRef<Map<string, string>>(new Map())

  // Keep latest opts in a ref so the long-lived fetch function reads current values
  // without recreating itself (which would re-run all effects).
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  // Filter key drives incremental-state reset.
  const filterKey = `${opts.level}|${opts.module}|${opts.traceId}|${opts.searchQuery}|${opts.useRegex}|${opts.tags?.join(",")}`

  useEffect(() => {
    transportRef.current = sharedTransport
    return () => {
      transportRef.current = null
    }
  }, [])

  // Reset incremental cursors whenever the filter key changes.
  useEffect(() => {
    lastFetchedTimestamp.current = null
    initialFetchDone.current = false
  }, [filterKey])

  // Stable fetch function — deps are React-stable (setters + ref), so the identity
  // is constant for the lifetime of the hook. Implementation reads `optsRef.current`.
  const fetchLogs = useMemo(() => {
    return async () => {
      const currentOpts = optsRef.current
      if (!transportRef.current) return

      try {
        if (!initialFetchDone.current) {
          setIsLoading(true)
        }
        setError(null)

        const filter: LogFilter = {
          limit: currentOpts.maxLogs,
        }

        if (currentOpts.level && currentOpts.level !== "all") {
          filter.level = currentOpts.level
        }
        if (currentOpts.module) {
          filter.module = currentOpts.module
        }
        if (currentOpts.traceId) {
          filter.traceId = currentOpts.traceId
        }

        if (initialFetchDone.current && lastFetchedTimestamp.current) {
          filter.since = new Date(lastFetchedTimestamp.current)
        }

        let fetchedLogs = await transportRef.current.getLogs(filter)

        if (currentOpts.searchQuery) {
          if (currentOpts.useRegex) {
            try {
              const regex = new RegExp(currentOpts.searchQuery, "i")
              fetchedLogs = fetchedLogs.filter((log) => {
                let cached = searchTextCache.current.get(log.id)
                if (!cached) {
                  cached = buildSearchText(log)
                  searchTextCache.current.set(log.id, cached)
                }
                return regex.test(cached)
              })
            } catch {
              const query = currentOpts.searchQuery.toLowerCase()
              fetchedLogs = fetchedLogs.filter((log) => log.message.toLowerCase().includes(query))
            }
          } else {
            const query = currentOpts.searchQuery.toLowerCase()
            fetchedLogs = fetchedLogs.filter((log) => {
              let cached = searchTextCache.current.get(log.id)
              if (!cached) {
                cached = buildSearchText(log)
                searchTextCache.current.set(log.id, cached)
              }
              return cached.includes(query)
            })
          }
        }

        if (currentOpts.tags && currentOpts.tags.length > 0) {
          const tags = currentOpts.tags
          fetchedLogs = fetchedLogs.filter(
            (log) => log.tags && tags.some((tag) => log.tags!.includes(tag))
          )
        }

        if (fetchedLogs.length > 0) {
          const newest = fetchedLogs.reduce(
            (max, log) => (log.timestamp > max ? log.timestamp : max),
            fetchedLogs[0].timestamp
          )
          if (!lastFetchedTimestamp.current || newest > lastFetchedTimestamp.current) {
            lastFetchedTimestamp.current = newest
          }
        }

        if (initialFetchDone.current && filter.since) {
          setLogs((prev) => {
            if (fetchedLogs.length === 0) return prev
            const existingIds = new Set(prev.map((l) => l.id))
            const newLogs = fetchedLogs.filter((l) => !existingIds.has(l.id))
            if (newLogs.length === 0) return prev
            const merged = [...newLogs, ...prev]
              .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
              .slice(0, currentOpts.maxLogs)
            return merged
          })
        } else {
          setLogs(fetchedLogs)
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to fetch logs"))
      } finally {
        setIsLoading(false)
        initialFetchDone.current = true
      }
    }
  }, [])

  // Initial + filter-change fetch — runs whenever the resolved filter changes.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await fetchLogs()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [fetchLogs, filterKey])

  // Auto-refresh polling
  useEffect(() => {
    if (!opts.autoRefresh) return

    const interval = opts.refreshInterval
    pollingTimerRef.current = setInterval(() => {
      void fetchLogs()
    }, interval)

    const unsubscribe = IndexedDBTransport.onLogsUpdated(() => {
      void fetchLogs()
      // Reset polling timer to avoid double-fetch
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current)
      }
      pollingTimerRef.current = setInterval(() => {
        void fetchLogs()
      }, interval)
    })

    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current)
        pollingTimerRef.current = null
      }
      unsubscribe()
    }
  }, [opts.autoRefresh, opts.refreshInterval, fetchLogs])

  // Trim search text cache periodically
  useEffect(() => {
    const cache = searchTextCache.current
    if (cache.size > 5000) {
      const currentIds = new Set(logs.map((l) => l.id))
      for (const key of cache.keys()) {
        if (!currentIds.has(key)) cache.delete(key)
      }
    }
  }, [logs])

  const groupedLogs = useMemo(() => {
    if (!opts.groupByTraceId) return new Map<string, StructuredLogEntry[]>()
    const groups = new Map<string, StructuredLogEntry[]>()
    for (const log of logs) {
      const traceId = log.traceId || "no-trace"
      const existing = groups.get(traceId) || []
      existing.push(log)
      groups.set(traceId, existing)
    }
    return groups
  }, [logs, opts.groupByTraceId])

  // Stable clearLogs — relies on transport ref and React-stable setters.
  const clearLogs = useMemo(() => {
    return async () => {
      if (!transportRef.current) return
      try {
        await transportRef.current.clear()
        setLogs([])
        lastFetchedTimestamp.current = null
        searchTextCache.current.clear()
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to clear logs"))
      }
    }
  }, [])

  const exportLogs = (format: "json" | "text" = "json"): string => {
    if (format === "json") return JSON.stringify(logs, null, 2)
    return logs
      .map((log) => {
        const level = log.level.toUpperCase().padEnd(5)
        const moduleName = log.module.padEnd(15)
        const trace = log.traceId ? `[${log.traceId.slice(0, 8)}]` : ""
        return `${log.timestamp} ${level} ${moduleName} ${trace} ${log.message}`
      })
      .join("\n")
  }

  const stats = useMemo(() => {
    const byLevel: Record<string, number> = {}
    const byModule: Record<string, number> = {}
    let oldest: string | undefined
    let newest: string | undefined

    for (const log of logs) {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1
      byModule[log.module] = (byModule[log.module] || 0) + 1
      if (!oldest || log.timestamp < oldest) oldest = log.timestamp
      if (!newest || log.timestamp > newest) newest = log.timestamp
    }

    return {
      total: logs.length,
      byLevel: byLevel as Record<LogLevel, number>,
      byModule,
      oldestEntry: oldest ? new Date(oldest) : undefined,
      newestEntry: newest ? new Date(newest) : undefined,
    }
  }, [logs])

  // Pure log rate: derived only from log timestamps (no Date.now inside the memo).
  // Computes events-per-minute over the actual span between newest and oldest log.
  const logRate = useMemo(() => {
    if (logs.length < 2) return 0
    let oldestTs = Infinity
    let newestTs = -Infinity
    for (const log of logs) {
      const ts = new Date(log.timestamp).getTime()
      if (ts < oldestTs) oldestTs = ts
      if (ts > newestTs) newestTs = ts
    }
    const spanMinutes = Math.max((newestTs - oldestTs) / (1000 * 60), 1 / 60)
    return Math.round(logs.length / spanMinutes)
  }, [logs])

  return {
    logs,
    groupedLogs,
    isLoading,
    error,
    refresh: fetchLogs,
    clearLogs,
    exportLogs,
    stats,
    logRate,
  }
}

let sharedTransportInstance: IndexedDBTransport | null = null
function getSharedTransport(): IndexedDBTransport {
  if (!sharedTransportInstance) {
    sharedTransportInstance = new IndexedDBTransport()
  }
  return sharedTransportInstance
}
const sharedTransport =
  typeof window !== "undefined" ? getSharedTransport() : (null as unknown as IndexedDBTransport)

export function useLogModules(): string[] {
  const [modules, setModules] = useState<string[]>(() => getRegisteredModules())

  useEffect(() => {
    const transport = sharedTransport
    const runtimeModules = getRegisteredModules()

    if (!transport) return

    let cancelled = false
    void (async () => {
      try {
        const stats = await transport.getStats()
        if (cancelled) return
        const uniqueModules = Array.from(
          new Set([...runtimeModules, ...Object.keys(stats.byModule)])
        ).sort()
        setModules(uniqueModules)
      } catch {
        if (!cancelled) setModules(runtimeModules)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return modules
}

export default useLogStream
