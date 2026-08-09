import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { McpServerSummary } from "@cognia/agent-config-types"

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
  return runSyncHandler<McpServerSummary>(
    {
      table: "mcpServers",
      // The RPC keeps its compatibility table name, but only redacted summaries
      // are accepted into the paired-mobile database.
      getTable: () => getDb().mcpServerSummaries,
      applyRows: async (rows) => {
        await getDb().mcpServerSummaries.bulkPut(
          rows.map((row) => {
            const legacy = row as McpServerSummary & {
              name?: string
              trust?: { state?: McpServerSummary["trustState"] }
            }
            return {
              id: row.id,
              displayName: row.displayName || legacy.name || row.id,
              transport: row.transport,
              enabled: Boolean(row.enabled),
              trustState: row.trustState ?? legacy.trust?.state ?? "legacy",
              updatedAt: Number(row.updatedAt ?? 0),
            }
          })
        )
      },
    },
    transport,
    cursor
  )
}
