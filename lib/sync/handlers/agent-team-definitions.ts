import { getDb } from "@/lib/db/schema"
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

export function syncAgentTeams(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return syncDefinitionTable<AgentTeamRow>(
    "agentTeams",
    () => getDb().agentTeams as never,
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
