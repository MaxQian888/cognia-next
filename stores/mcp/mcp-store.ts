/**
 * Minimal MCP store stub.
 *
 * cognia-next persists MCP servers in `lib/db/mcp-servers.ts` (Dexie),
 * not in a Zustand store. The upstream Cognia agent UIs (custom-mode
 * editor's MCP tool picker, etc.) expect `useMcpStore` with an array
 * of servers, last-selection state, and a tool-selection config slice.
 *
 * We expose a contract-compatible shape returning empty data so the
 * editor renders an empty list rather than crashing. Wire to the real
 * MCP runtime when multi-server tool selection becomes a feature.
 */

import { create } from "zustand"
import type { McpToolSelectionConfig } from "@/types/mcp"
import { DEFAULT_TOOL_SELECTION_CONFIG } from "@/types/mcp"

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
