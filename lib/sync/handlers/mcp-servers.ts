import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { McpServer } from "@/lib/claude/types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull configured MCP server rows from the desktop (ADR-0056, Wave 4).
 *
 * Powers the mobile `/me/mcp` page, which is a paired-only read-only viewer:
 * the standalone webview engine runs no MCP and the phone has no
 * `mcp_set_enabled` push RPC, so the phone only mirrors the desktop's server
 * list (name / transport / enabled state) — it never writes back.
 */
export function syncMcpServers(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<McpServer>(
    {
      table: "mcpServers",
      // `mcpServers` is `Table<McpServer, string>`; the row carries `updatedAt`
      // (set by every create/update), so the desktop projector cursors on it.
      getTable: () => getDb().mcpServers,
    },
    transport,
    cursor
  )
}
