"use client"

// Reads the unified log store for a single MCP server's outbound-client logs
// (written by the MCP log bridge, tagged module `mcp:<server>`). Thin wrapper
// over `useLogStream` — reuses its IndexedDB query, incremental fetch, and live
// `onLogsUpdated` refresh — deriving the most-recent entry / error the server
// cards surface. See lib/mcp/log-bridge.ts for the write side.

import { useMemo } from "react"

import { useLogStream } from "@/hooks/logging/use-log-stream"
import type { StructuredLogEntry } from "@/lib/logging"

/** The unified-logger module a server's bridged logs are written under. */
export function mcpServerModule(server: string): string {
  return `mcp:${server}`
}

/**
 * Deep-link into the `/logs` page pre-filtered to one MCP server's logs. Both
 * params are hydrated by `useLogPanelUrlSync` (`src` → source filter, `module`
 * → module filter).
 */
export function mcpServerLogsHref(server: string): string {
  return `/logs?src=mcp&module=${encodeURIComponent(mcpServerModule(server))}`
}

export interface UseMcpServerLogsOptions {
  /** Max entries to hold (newest-first). Defaults to 50. */
  limit?: number
  /** Live-refresh on new logs. Defaults to true. */
  autoRefresh?: boolean
}

export interface McpServerLogsResult {
  logs: StructuredLogEntry[]
  /** Most recent entry of any level, or null. */
  lastEntry: StructuredLogEntry | null
  /** Most recent error/fatal entry within the held window, or null. */
  lastError: StructuredLogEntry | null
  /** Count of error/fatal entries within the held window. */
  errorCount: number
  isLoading: boolean
}

const EMPTY: McpServerLogsResult = {
  logs: [],
  lastEntry: null,
  lastError: null,
  errorCount: 0,
  isLoading: false,
}

export function useMcpServerLogs(
  server: string,
  options: UseMcpServerLogsOptions = {}
): McpServerLogsResult {
  const { limit = 50, autoRefresh = true } = options
  const hasServer = server.trim().length > 0

  const { logs, isLoading } = useLogStream({
    // When there is no server, filter to a module that matches nothing so the
    // hook stays cheap (never fetches the whole store).
    module: hasServer ? mcpServerModule(server) : "__mcp_none__",
    autoRefresh: autoRefresh && hasServer,
    maxLogs: limit,
  })

  return useMemo(() => {
    if (!hasServer) return EMPTY
    // useLogStream returns entries newest-first.
    const lastError = logs.find((l) => l.level === "error" || l.level === "fatal") ?? null
    const errorCount = logs.reduce(
      (n, l) => (l.level === "error" || l.level === "fatal" ? n + 1 : n),
      0
    )
    return {
      logs,
      lastEntry: logs[0] ?? null,
      lastError,
      errorCount,
      isLoading,
    }
  }, [hasServer, logs, isLoading])
}
