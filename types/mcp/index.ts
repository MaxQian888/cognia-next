/**
 * Minimal MCP types — stub for migrated agent code.
 *
 * cognia-next stores MCP servers in `lib/db/mcp-servers.ts` (Dexie). The
 * Cognia-side agent UIs reference a more elaborate MCP type hierarchy;
 * here we expose only the symbols the migrated code names so the surface
 * compiles without pulling in the full Cognia MCP store.
 */

export type McpServerStatus = "stopped" | "starting" | "running" | "error" | "unknown"

export interface McpServerInfo {
  id: string
  name: string
  status: McpServerStatus
}

export interface McpToolSelectionConfig {
  enabled: boolean
  allowList: string[]
  denyList: string[]
  autoLoadAll?: boolean
  /** Hard cap on the number of tools loaded into a single mode. */
  maxTools: number
  /** Minimum number of tools that should be selected for a mode. */
  minSelectedTools: number
}

export const DEFAULT_TOOL_SELECTION_CONFIG: McpToolSelectionConfig = {
  enabled: true,
  allowList: [],
  denyList: [],
  autoLoadAll: true,
  maxTools: 64,
  minSelectedTools: 0,
}
