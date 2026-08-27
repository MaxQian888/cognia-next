import { useCallback, useEffect, useMemo, useState } from "react"

import {
  buildCrashLogExportBundle,
  buildCrashLogItems,
  isCrashRelevantLogEntry,
  serializeCrashLogBundle,
  summarizeCrashLogItems,
} from "@/lib/logging/crash-log"
import type {
  CrashDiagnosticsSnapshot,
  CrashLogItem,
  CrashLogLevelFilter,
  CrashLogSourceFilter,
  UseCrashLogsResult,
} from "@/types/logging"
import { downloadFile } from "@/lib/files/download"
import { getIndexedDBTransport } from "@/lib/logging"
import { clearRecentErrorLogs } from "@cognia/logging/recent-errors"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import {
  getNativeLogDirectory,
  getNativeLoggingReadiness,
  getNativeLoggingReadinessSnapshot,
  openNativeLogDirectory as openNativeLogDirectoryImpl,
} from "@/lib/native/native-logging"
import { getWindowDiagnostics } from "@/lib/native/window-diagnostics"
import { useLogStream } from "./use-log-stream"
import { useRecentErrorLogs } from "./use-recent-error-logs"

function matchesSearch(item: CrashLogItem, query: string): boolean {
  if (!query.trim()) {
    return true
  }

  const normalized = query.trim().toLowerCase()
  return [item.title, item.summary, item.module, item.traceId, item.logEntry?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized))
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

export type { UseCrashLogsResult } from "@/types/logging"

export function useCrashLogs(): UseCrashLogsResult {
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<CrashLogSourceFilter>("all")
  const [levelFilter, setLevelFilter] = useState<CrashLogLevelFilter>("all")
  const [search, setSearch] = useState("")
  // Render-safe read of the recent-error buffer — see `useRecentErrorLogs` for
  // why a plain subscription here is a render-phase update waiting to happen.
  const recentErrors = useRecentErrorLogs()
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
    // The recent-error buffer needs no re-read: it is subscribed to, not
    // polled, so it is already whatever the logging core last recorded.
    await Promise.all([refreshPersisted(), refreshDiagnostics()])
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
      const serialized = serializeCrashLogBundle(bundle, format)
      downloadFile(serialized.filename, serialized.content, serialized.mimeType)
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
