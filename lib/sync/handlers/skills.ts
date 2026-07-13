import type { Skill } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncSkills(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Skill>(
    {
      table: "skills",
      getTable: () => getDb().skills,
    },
    transport,
    cursor
  )
}
