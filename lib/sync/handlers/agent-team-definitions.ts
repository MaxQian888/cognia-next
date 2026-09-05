import { getDb } from "@/lib/db/schema"
import { stripLegacyRuntimeSelector } from "@/lib/agent-team/definition-contract"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  AgentTeamRow,
  AgentTeammateRow,
  AgentTeamTaskRow,
} from "@/lib/db/agent-team-definitions"
import type { SyncCursor, SyncOutcome, SyncableTable } from "../types"
import { runSyncHandler } from "./base"

/**
 * Squad definitions, roster and tasks.
 *
 * A paired device could already see a squad's RUNS (`agentTeamRuns` has synced
 * since v145) while the squad itself lived in a desktop-only localStorage blob,
 * so the phone listed run history for squads it could not name and had nothing
 * to start.
 */
function syncDefinitionTable<TRow extends { id: string }>(
  table: SyncableTable,
  getTable: () => never,
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<TRow>({ table, getTable: getTable as never }, transport, cursor)
}

/**
 * Inbound Squad rows lose any retired runtime selector at the boundary
 * (ADR-0169). A peer still on an older contract may sync a row that names
 * `runtimeVersion`. Writing it as-is would resurrect the legacy/durable choice
 * on this device, and the definition migration would flip it back on the next
 * hydration, so the two devices would ping-pong the row for good.
 */
export function sanitizeInboundAgentTeamRows(rows: AgentTeamRow[]): AgentTeamRow[] {
  return rows.map((row) => {
    if (!row.config || typeof row.config !== "object") return row
    const { config, stripped } = stripLegacyRuntimeSelector(row.config)
    return stripped ? { ...row, config } : row
  })
}

export function syncAgentTeams(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AgentTeamRow>(
    {
      table: "agentTeams",
      getTable: () => getDb().agentTeams as never,
      applyRows: async (rows) => {
        await getDb().agentTeams.bulkPut(sanitizeInboundAgentTeamRows(rows))
      },
    },
    transport,
    cursor
  )
}

export function syncAgentTeammates(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return syncDefinitionTable<AgentTeammateRow>(
    "agentTeammates",
    () => getDb().agentTeammates as never,
    transport,
    cursor
  )
}

export function syncAgentTeamTasks(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return syncDefinitionTable<AgentTeamTaskRow>(
    "agentTeamTasks",
    () => getDb().agentTeamTasks as never,
    transport,
    cursor
  )
}
