import { getDb } from "@/lib/db/schema"
import type { AgentTeamBoardRow } from "@/lib/db/agent-team-board"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull the Agent-Team board projection (`agentTeamBoard`, v104) from the
 * desktop so the mobile companion can render the task kanban offline.
 * One-way read mirror — the board is authored on the desktop (the
 * agent-team-store is the single write source); phone-side edits travel
 * back as Companion RPC commands (`team_task_move` et al.), never as
 * data-level writes. Tombstones carry task/team deletions.
 */
export function syncAgentTeamBoard(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AgentTeamBoardRow>(
    {
      table: "agentTeamBoard",
      getTable: () => getDb().agentTeamBoard,
    },
    transport,
    cursor
  )
}
