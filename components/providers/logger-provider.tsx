"use client"

/**
 * LoggerProvider - React Context wrapper for the unified logging system.
 *
 * @deprecated For new code, prefer importing directly from @/lib/logger.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { AppLogLevel, LogEntry, LoggerConfig, LogTransport } from "@/lib/logger"
import { LEVEL_PRIORITY as LOG_LEVEL_PRIORITY } from "@/lib/logger"
import {
  addTransport as addUnifiedTransport,
  applyLoggingSettings,
  bootstrapLogger,
  getIndexedDBTransport,
  loggers,
  removeTransport as removeUnifiedTransport,
  type LogLevel as UnifiedLogLevel,
  type StructuredLogEntry,
} from "@/lib/logger"
import { cleanupTauriLogBridge, initTauriLogBridge } from "@/lib/native/tauri-log-bridge"
import { getNativeLoggingReadiness } from "@/lib/native/native-logging"
import { isTauri } from "@/lib/tauri"

// Re-export types for backward compatibility.
export type { AppLogLevel, LogEntry, LoggerConfig, LogTransport } from "@/lib/logger"
export type LogLevel = AppLogLevel

interface LoggerContextValue {
  debug: (message: string, data?: unknown, context?: Record<string, unknown>) => void
  info: (message: string, data?: unknown, context?: Record<string, unknown>) => void
  warn: (message: string, data?: unknown, context?: Record<string, unknown>) => void
  error: (message: string, error?: Error | unknown, context?: Record<string, unknown>) => void
  fatal: (message: string, error?: Error | unknown, context?: Record<string, unknown>) => void
  getLogs: (filter?: { level?: LogLevel; since?: Date; limit?: number }) => Promise<LogEntry[]>
  clearLogs: () => Promise<void>
  exportLogs: (format?: "json" | "text") => Promise<string>
  config: LoggerConfig
  updateConfig: (config: Partial<LoggerConfig>) => void
  addTransport: (transport: LogTransport) => void
  removeTransport: (name: string) => void
  getStats: () => { total: number; byLevel: Record<LogLevel, number> }
}

const LoggerContext = createContext<LoggerContextValue | undefined>(undefined)

const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: process.env.NODE_ENV === "production" ? "info" : "debug",
  enableConsole: true,
  enableStorage: true,
  enableRemote: false,
  maxStorageEntries: 1000,
  includeStackTrace: process.env.NODE_ENV === "development",
}

function convertToLegacyEntry(entry: StructuredLogEntry): LogEntry {
  return {
    id: entry.id,
    timestamp: new Date(entry.timestamp),
    level: entry.level as AppLogLevel,
    message: entry.message,
    data: entry.data,
    context: entry.data as Record<string, unknown> | undefined,
    stack: entry.stack,
    sessionId: entry.sessionId,
  }
}

interface LoggerProviderProps {
  children: ReactNode
  config?: Partial<LoggerConfig>
  transports?: LogTransport[]
  sessionId?: string
}

export function LoggerProvider({
  children,
  config: userConfig = {},
  transports: userTransports = [],
  sessionId: _sessionId,
}: LoggerProviderProps) {
  const [initialBootstrap] = useState(() => bootstrapLogger(userConfig))
  const [config, setConfig] = useState<LoggerConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...initialBootstrap.config,
    ...userConfig,
  }))
  const [stats, setStats] = useState({ total: 0, byLevel: {} as Record<LogLevel, number> })
  const attachedTransportNamesRef = useRef(new Set<string>())

  // Bridge Rust → frontend log records via the `log://log` event emitted by
  // tauri-plugin-log's webview target. Without this, native logs never reach
  // the in-app Log Panel. Also kicks off a one-shot readiness query so the
  // settings panel can surface platform-logging health on first paint.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void initTauriLogBridge().then(() => {
      if (cancelled) return
      void getNativeLoggingReadiness()
    })
    return () => {
      cancelled = true
      void cleanupTauriLogBridge()
    }
  }, [])

  useEffect(() => {
    if (userTransports.length === 0) {
      return
    }
    userTransports.forEach((transport) => {
      if (attachedTransportNamesRef.current.has(transport.name)) {
        return
      }
      attachedTransportNamesRef.current.add(transport.name)
      addUnifiedTransport({
        name: transport.name,
        log: (entry) => transport.log(convertToLegacyEntry(entry)),
      })
    })
  }, [userTransports])

  const log = useCallback(
    (level: LogLevel, message: string, data?: unknown, context?: Record<string, unknown>) => {
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[config.minLevel]) {
        return
      }

      const combinedData = {
        ...context,
        ...(typeof data === "object" && data !== null && !(data instanceof Error)
          ? (data as Record<string, unknown>)
          : data !== undefined && !(data instanceof Error)
            ? { value: data }
            : {}),
      }

      switch (level) {
        case "debug":
          loggers.app.debug(message, combinedData)
          break
        case "info":
          loggers.app.info(message, combinedData)
          break
        case "warn":
          loggers.app.warn(message, combinedData)
          break
        case "error":
          loggers.app.error(message, data instanceof Error ? data : undefined, combinedData)
          break
        case "fatal":
          loggers.app.fatal(message, data instanceof Error ? data : undefined, combinedData)
          break
      }

      setStats((prev) => ({
        total: prev.total + 1,
        byLevel: {
          ...prev.byLevel,
          [level]: (prev.byLevel[level] || 0) + 1,
        },
      }))
    },
    [config.minLevel]
  )

  const debug = useCallback(
    (message: string, data?: unknown, context?: Record<string, unknown>) => {
      log("debug", message, data, context)
    },
    [log]
  )

  const info = useCallback(
    (message: string, data?: unknown, context?: Record<string, unknown>) => {
      log("info", message, data, context)
    },
    [log]
  )

  const warn = useCallback(
    (message: string, data?: unknown, context?: Record<string, unknown>) => {
      log("warn", message, data, context)
    },
    [log]
  )

  const error = useCallback(
    (message: string, err?: Error | unknown, context?: Record<string, unknown>) => {
      log("error", message, err, context)
    },
    [log]
  )

  const fatal = useCallback(
    (message: string, err?: Error | unknown, context?: Record<string, unknown>) => {
      log("fatal", message, err, context)
    },
    [log]
  )

  const getLogs = useCallback(
    async (filter?: { level?: LogLevel; since?: Date; limit?: number }): Promise<LogEntry[]> => {
      const indexedDBTransport = getIndexedDBTransport()
      if (!indexedDBTransport) {
        return []
      }

      const structuredLogs = await indexedDBTransport.getLogs({
        level: filter?.level as UnifiedLogLevel,
        limit: filter?.limit,
      })

      let logs = structuredLogs.map(convertToLegacyEntry)
      if (filter?.since) {
        logs = logs.filter((entry) => entry.timestamp >= filter.since!)
      }
      return logs
    },
    []
  )

  const clearLogs = useCallback(async () => {
    const indexedDBTransport = getIndexedDBTransport()
    if (indexedDBTransport) {
      await indexedDBTransport.clear()
    }
    setStats({ total: 0, byLevel: {} as Record<LogLevel, number> })
  }, [])

  const exportLogs = useCallback(
    async (format: "json" | "text" = "json"): Promise<string> => {
      const logs = await getLogs()
      if (format === "json") {
        return JSON.stringify(logs, null, 2)
      }

      return logs
        .map(
          (entry) =>
            `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] ${entry.message}${
              entry.data ? ` ${JSON.stringify(entry.data)}` : ""
            }`
        )
        .join("\n")
    },
    [getLogs]
  )

  const updateConfig = useCallback((updates: Partial<LoggerConfig>) => {
    setConfig((prev) => {
      const merged = { ...prev, ...updates }
      applyLoggingSettings({
        config: {
          minLevel: merged.minLevel as UnifiedLogLevel,
          includeStackTrace: merged.includeStackTrace,
          enableConsole: merged.enableConsole,
          enableStorage: merged.enableStorage,
          enableRemote: merged.enableRemote,
          maxStorageEntries: merged.maxStorageEntries,
        },
        transports: {
          console: merged.enableConsole,
          indexedDB: merged.enableStorage,
          remote: merged.enableRemote,
        },
      })
      return merged
    })
  }, [])

  const addTransport = useCallback((transport: LogTransport) => {
    addUnifiedTransport({
      name: transport.name,
      log: (entry) => {
        transport.log(convertToLegacyEntry(entry))
      },
    })
  }, [])

  const removeTransport = useCallback((name: string) => {
    removeUnifiedTransport(name)
  }, [])

  const getStats = useCallback(() => stats, [stats])

  const value = useMemo(
    (): LoggerContextValue => ({
      debug,
      info,
      warn,
      error,
      fatal,
      getLogs,
      clearLogs,
      exportLogs,
      config,
      updateConfig,
      addTransport,
      removeTransport,
      getStats,
    }),
    [
      debug,
      info,
      warn,
      error,
      fatal,
      getLogs,
      clearLogs,
      exportLogs,
      config,
      updateConfig,
      addTransport,
      removeTransport,
      getStats,
    ]
  )

  return <LoggerContext.Provider value={value}>{children}</LoggerContext.Provider>
}

export function useLogger(): LoggerContextValue {
  const context = useContext(LoggerContext)
  if (!context) {
    throw new Error("useLogger must be used within LoggerProvider")
  }
  return context
}

export function useLog() {
  const { debug, info, warn, error, fatal } = useLogger()

  return {
    debug,
    info,
    warn,
    error,
    fatal,
    log: info,
  }
}

export default LoggerProvider
