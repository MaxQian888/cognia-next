"use client"

/**
 * The tool inventory for one configured MCP server, plus the action that
 * refreshes it.
 *
 * Reads the capability cache (`mcpCapabilityCache`) rather than talking to the
 * server on every render: discovery costs a process spawn or a network round
 * trip, and the settings panel wants to render a switch per tool immediately.
 * Expired rows are still shown — an expiry means "re-discover before
 * connecting", not "forget the tool names", and hiding them would silently
 * empty the tool list (and un-expand every glob deny rule) ten minutes after a
 * successful test.
 *
 * `discover()` runs the same sidecar path the per-server test uses and writes
 * the result back through `recordMcpCapabilities`, so one refresh feeds the
 * switches, the deny-rule expansion, and the paired-client mirror alike.
 */

import { useCallback, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { discoverMcpServerViaSidecar } from "@/lib/claude/feature-call"
import { recordMcpCapabilities } from "@/lib/mcp/runtime-gateway"
import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

export interface McpToolInfo {
  name: string
  description?: string
}

export interface UseMcpServerTools {
  tools: McpToolInfo[]
  resourceCount: number
  promptCount: number
  /** Epoch ms of the discovery these tools came from, or null if never run. */
  discoveredAt: number | null
  /** True while the capability cache query is still resolving. */
  loading: boolean
  discovering: boolean
  /** Last discovery failure, cleared on the next successful run. */
  error: string | null
  /** Re-run discovery through the sidecar. Desktop-only; no-ops elsewhere. */
  discover: () => Promise<void>
  /** Whether `discover` can do anything on this host. */
  canDiscover: boolean
}

const NO_TOOLS: McpToolInfo[] = []

function freshest(rows: McpCapabilityCacheRow[]): McpCapabilityCacheRow | null {
  if (rows.length === 0) return null
  return rows.reduce((best, row) => (row.updatedAt > best.updatedAt ? row : best))
}

export function useMcpServerTools(server: McpServer | undefined): UseMcpServerTools {
  const serverId = server?.id
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = useLiveQuery<McpCapabilityCacheRow[]>(
    () =>
      serverId
        ? getDb().mcpCapabilityCache.where("serverId").equals(serverId).toArray()
        : Promise.resolve([]),
    [serverId]
  )

  const row = useMemo(() => freshest(rows ?? []), [rows])

  const tools = useMemo(
    () =>
      row
        ? [...row.tools]
            .map((tool) => ({ name: tool.name, description: tool.description }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : NO_TOOLS,
    [row]
  )

  const discover = useCallback(async () => {
    if (!server || !isTauri()) return
    setDiscovering(true)
    try {
      const result = await discoverMcpServerViaSidecar(server)
      if (!result.ok) {
        setError(result.error ?? "discovery failed")
        return
      }
      setError(null)
      await recordMcpCapabilities(server, {
        tools: result.tools,
        resources: result.resources,
        prompts: result.prompts,
      })
      loggers.mcp.info("settings.toolsDiscovered", {
        id: server.id,
        count: result.tools.length,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      loggers.mcp.error("settings.toolsDiscoveryFailed", err, { id: server.id })
    } finally {
      setDiscovering(false)
    }
  }, [server])

  return {
    tools,
    resourceCount: row?.resources.length ?? 0,
    promptCount: row?.prompts.length ?? 0,
    discoveredAt: row?.updatedAt ?? null,
    loading: rows === undefined,
    discovering,
    error,
    discover,
    canDiscover: Boolean(server) && isTauri(),
  }
}
