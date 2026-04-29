import { useCallback, useEffect, useMemo, useState } from "react"

import {
  buildCrashLogExportBundle,
  buildCrashLogItems,
  isCrashRelevantLogEntry,
  summarizeCrashLogItems,
  type CrashDiagnosticsSnapshot,
  type CrashLogItem,
  type CrashLogLevelFilter,
  type CrashLogSourceFilter,
} from "@/lib/logger/crash-log"
import { getIndexedDBTransport } from "@/lib/logger"
import {
  clearRecentErrorLogs,
  getRecentErrorLogs,
  subscribeRecentErrorLogs,
} from "@/lib/logger/recent-errors"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import {
  getNativeLogDirectory,
  getNativeLoggingReadiness,
  getNativeLoggingReadinessSnapshot,
  openNativeLogDirectory as openNativeLogDirectoryImpl,
} from "@/lib/native/native-logging"
import { getWindowDiagnostics } from "@/lib/native/window-diagnostics"
import { useLogStream } from "./use-log-stream"

function matchesSearch(item: CrashLogItem, query: string): boolean {
  if (!query.trim()) {
    return true
  }

  const normalized = query.trim().toLowerCase()
  return [item.title, item.summary, item.module, item.traceId, item.logEntry?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized))
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function deriveRelatedLogs(items: CrashLogItem[], selectedItem: CrashLogItem | null) {
  if (!selectedItem?.traceId) {
    return []
  }

  return items
    .filter(
      (item) =>
        item.id !== selectedItem.id && item.logEntry && item.traceId === selectedItem.traceId
    )
    .map((item) => item.logEntry!)
    .slice(0, 10)
}

export interface UseCrashLogsResult {
  isLoading: boolean
  isRefreshing: boolean
  error: Error | null
  autoRefresh: boolean
  setAutoRefresh: (value: boolean) => void
  lastUpdatedAt: string | null
  filters: {
    source: CrashLogSourceFilter
    level: CrashLogLevelFilter
    search: string
  }
  setSourceFilter: (value: CrashLogSourceFilter) => void
  setLevelFilter: (value: CrashLogLevelFilter) => void
  setSearchQuery: (value: string) => void
  items: CrashLogItem[]
  selectedItem: CrashLogItem | null
  relatedLogs: NonNullable<CrashLogItem["logEntry"]>[]
  selectItem: (itemId: string) => void
  refresh: () => Promise<void>
  clearRecent: () => void
  clearPersisted: () => Promise<void>
  copySelected: () => Promise<boolean>
  exportBundle: (format?: "bundle" | "json" | "text") => void
  openNativeLogDirectory: () => Promise<boolean>
  summary: ReturnType<typeof summarizeCrashLogItems>
}

export function useCrashLogs(): UseCrashLogsResult {
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<CrashLogSourceFilter>("all")
  const [levelFilter, setLevelFilter] = useState<CrashLogLevelFilter>("all")
  const [search, setSearch] = useState("")
  const [recentErrors, setRecentErrors] = useState(getRecentErrorLogs())
  const [diagnostics, setDiagnostics] = useState<CrashDiagnosticsSnapshot | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diagnosticsError, setDiagnosticsError] = useState<Error | null>(null)

  const {
    logs: persistedLogs,
    isLoading: persistedLoading,
    error: persistedError,
    refresh: refreshPersisted,
    clearLogs,
  } = useLogStream({
    autoRefresh,
    refreshInterval: 3000,
    maxLogs: 400,
    level: "all",
  })

  useEffect(() => {
    return subscribeRecentErrorLogs(() => {
      setRecentErrors(getRecentErrorLogs())
    })
  }, [])

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true)
    try {
      await getNativeLoggingReadiness()
      const [windowDiagnostics, localRuntimeDiagnostics, logDirectoryResult] = await Promise.all([
        getWindowDiagnostics(),
        getLocalRuntimeDiagnostics().catch(() => null),
        getNativeLogDirectory().catch(() => null),
      ])
      setDiagnostics({
        capturedAt: new Date().toISOString(),
        nativeLogging: getNativeLoggingReadinessSnapshot(),
        windowDiagnostics,
        localRuntimeDiagnostics,
        logDirectoryPath: logDirectoryResult,
        diagnosticsError: null,
      })
      setLastUpdatedAt(new Date().toISOString())
      setDiagnosticsError(null)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      setDiagnostics({
        capturedAt: new Date().toISOString(),
        nativeLogging: getNativeLoggingReadinessSnapshot(),
        windowDiagnostics: null,
        localRuntimeDiagnostics: null,
        logDirectoryPath: null,
        diagnosticsError: err.message,
      })
      setLastUpdatedAt(new Date().toISOString())
      setDiagnosticsError(err)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refreshDiagnostics()
  }, [refreshDiagnostics])

  useEffect(() => {
    if (!autoRefresh) {
      return
    }

    const timer = window.setInterval(() => {
      void refreshDiagnostics()
    }, 3000)

    return () => window.clearInterval(timer)
  }, [autoRefresh, refreshDiagnostics])

  const allItems = useMemo(
    () =>
      buildCrashLogItems({
        recentErrors,
        persistedLogs: persistedLogs.filter((log) => isCrashRelevantLogEntry(log)),
        diagnostics,
      }),
    [diagnostics, persistedLogs, recentErrors]
  )

  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      const sourceMatches = sourceFilter === "all" || item.sources.includes(sourceFilter)
      const levelMatches = levelFilter === "all" || item.level === levelFilter
      return sourceMatches && levelMatches && matchesSearch(item, search)
    })
  }, [allItems, levelFilter, search, sourceFilter])

  const selectedItem = useMemo(() => {
    if (filteredItems.length === 0) {
      return null
    }

    const current = selectedId
      ? (filteredItems.find((item) => item.id === selectedId) ?? null)
      : null
    if (current) {
      return current
    }

    return filteredItems.find((item) => !item.sources.includes("diagnostic")) ?? filteredItems[0]
  }, [filteredItems, selectedId])

  const summary = useMemo(
    () => summarizeCrashLogItems(filteredItems, diagnostics),
    [diagnostics, filteredItems]
  )

  const relatedLogs = useMemo(
    () => deriveRelatedLogs(filteredItems, selectedItem),
    [filteredItems, selectedItem]
  )

  const refresh = useCallback(async () => {
    await Promise.all([refreshPersisted(), refreshDiagnostics()])
    setRecentErrors(getRecentErrorLogs())
    setLastUpdatedAt(new Date().toISOString())
  }, [refreshDiagnostics, refreshPersisted])

  const clearPersisted = useCallback(async () => {
    const persistedIds = allItems
      .filter((item) => item.sources.includes("persisted"))
      .map((item) => item.id)

    const transport = getIndexedDBTransport()
    if (transport && persistedIds.length > 0 && typeof transport.deleteEntries === "function") {
      await transport.deleteEntries(persistedIds)
      await refreshPersisted()
      return
    }

    await clearLogs()
  }, [allItems, clearLogs, refreshPersisted])

  const copySelected = useCallback(async () => {
    if (!selectedItem) {
      return false
    }

    const bundle = buildCrashLogExportBundle({
      items: [selectedItem],
      diagnostics: selectedItem.diagnostics ?? diagnostics,
      exportedAt: new Date().toISOString(),
      filters: {
        source: sourceFilter,
        level: levelFilter,
        search,
      },
    })
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2))
    return true
  }, [diagnostics, levelFilter, search, selectedItem, sourceFilter])

  const exportBundle = useCallback(
    (format: "bundle" | "json" | "text" = "bundle") => {
      const bundle = buildCrashLogExportBundle({
        items: filteredItems,
        diagnostics,
        exportedAt: new Date().toISOString(),
        filters: {
          source: sourceFilter,
          level: levelFilter,
          search,
        },
      })

      if (format === "json") {
        downloadTextFile(
          `cognia-crash-logs-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify(
            bundle.items.map((item) => item.logEntry ?? item),
            null,
            2
          ),
          "application/json"
        )
        return
      }

      if (format === "text") {
        downloadTextFile(
          `cognia-crash-logs-${new Date().toISOString().slice(0, 10)}.txt`,
          bundle.items
            .map(
              (item) =>
                `${item.timestamp} [${item.level.toUpperCase()}] ${item.module} ${item.title}`
            )
            .join("\n"),
          "text/plain"
        )
        return
      }

      downloadTextFile(
        `cognia-crash-bundle-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(bundle, null, 2),
        "application/json"
      )
    },
    [diagnostics, filteredItems, levelFilter, search, sourceFilter]
  )

  const openNativeLogDirectory = useCallback(async () => {
    return openNativeLogDirectoryImpl()
  }, [])

  return {
    isLoading: persistedLoading || (diagnosticsLoading && diagnostics === null),
    isRefreshing: !persistedLoading && diagnosticsLoading && diagnostics !== null,
    error: persistedError ?? diagnosticsError,
    autoRefresh,
    setAutoRefresh,
    lastUpdatedAt,
    filters: {
      source: sourceFilter,
      level: levelFilter,
      search,
    },
    setSourceFilter,
    setLevelFilter,
    setSearchQuery: setSearch,
    items: filteredItems,
    selectedItem,
    relatedLogs,
    selectItem: setSelectedId,
    refresh,
    clearRecent: clearRecentErrorLogs,
    clearPersisted,
    copySelected,
    exportBundle,
    openNativeLogDirectory,
    summary,
  }
}
