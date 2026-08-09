/**
 * Read model for MCP capability-selection surfaces. Dexie remains the source
 * of truth; Zustand holds only the current Registry/capability/status snapshot.
 */

import { create } from "zustand"
import type { McpToolSelectionConfig } from "@/types/mcp"
import { DEFAULT_TOOL_SELECTION_CONFIG } from "@/types/mcp"
import { getDb } from "@/lib/db/schema"
import { defaultMcpRuntimeGateway } from "@/lib/mcp/runtime-gateway"

export interface McpToolStub {
  name: string
  description?: string
}

export type McpServerStatusKind = "connected" | "disconnected" | "error" | "starting" | "unknown"

export interface McpServerStatusObject {
  type: McpServerStatusKind
  message?: string
}

export interface McpServerStub {
  id: string
  name: string
  status: McpServerStatusObject
  tools?: McpToolStub[]
}

export interface McpToolSelectionResult {
  selectedToolNames: string[]
  totalAvailable: number
  wasLimited: boolean
  fallbackApplied: boolean
}

interface McpStoreState {
  servers: McpServerStub[]
  toolSelectionConfig: McpToolSelectionConfig
  lastToolSelection: McpToolSelectionResult | null
  setToolSelection: (modeId: string, result: McpToolSelectionResult) => void
}

export const useMcpStore = create<McpStoreState>((set) => ({
  servers: [],
  toolSelectionConfig: DEFAULT_TOOL_SELECTION_CONFIG,
  lastToolSelection: null,
  setToolSelection: (_modeId, result) => set({ lastToolSelection: result }),
}))

let runtimeUnsubscribe: (() => void) | null = null

function ensureRuntimeSubscription(): void {
  if (runtimeUnsubscribe) return
  runtimeUnsubscribe = defaultMcpRuntimeGateway.subscribe(() => {
    void refreshMcpStore()
  })
}

export async function refreshMcpStore(): Promise<void> {
  ensureRuntimeSubscription()
  const db = getDb()
  const [definitions, capabilities] = await Promise.all([
    db.mcpServers.toArray(),
    db.mcpCapabilityCache.toArray(),
  ])
  const now = Date.now()
  const latestCapabilities = new Map<string, (typeof capabilities)[number]>()
  for (const row of capabilities) {
    if (row.expiresAt <= now) continue
    const prior = latestCapabilities.get(row.serverId)
    if (!prior || prior.updatedAt < row.updatedAt) latestCapabilities.set(row.serverId, row)
  }
  const statuses = new Map(
    defaultMcpRuntimeGateway.getStatusSnapshot().map((status) => [status.serverId, status] as const)
  )
  useMcpStore.setState({
    servers: definitions.map((server) => {
      const runtime = statuses.get(server.id)
      const cached = latestCapabilities.get(server.id)
      const status: McpServerStatusObject = runtime
        ? runtime.state === "ready"
          ? { type: "connected" }
          : runtime.state === "connecting"
            ? { type: "starting" }
            : runtime.state === "failed" ||
                runtime.state === "blocked" ||
                runtime.state === "degraded"
              ? { type: "error", message: runtime.errorCode }
              : { type: "disconnected" }
        : cached && server.enabled
          ? { type: "connected" }
          : { type: "unknown" }
      return {
        id: server.id,
        name: server.displayName || server.name,
        status,
        tools: cached?.tools.map(({ name, description }) => ({
          name,
          description,
        })),
      }
    }),
  })
}

export function stopMcpStoreRuntimeSubscription(): void {
  runtimeUnsubscribe?.()
  runtimeUnsubscribe = null
}
