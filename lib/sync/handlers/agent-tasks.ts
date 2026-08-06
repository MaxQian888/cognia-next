import type { AgentTask, AgentTaskAttempt } from "@/types/agent/agent-task"
import type { Transport } from "@/lib/tauri/transport-types"
import { getDb } from "@/lib/db/schema"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncAgentTasks(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AgentTask>(
    { table: "agentTasks", getTable: () => getDb().agentTasks },
    transport,
    cursor
  )
}

export function syncAgentTaskAttempts(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<AgentTaskAttempt>(
    { table: "agentTaskAttempts", getTable: () => getDb().agentTaskAttempts },
    transport,
    cursor
  )
}
