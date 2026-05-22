import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull per-conversation override upserts (pinned / archived / lastReadAt /
 * allowComputerUse / allowGoalDriving / mode / character / quietHours)
 * from the desktop (v49). Lets the mobile Inbox render correct buckets
 * for pinned/unread/archived even when the companion server is offline.
 */
export function syncConversationOverrides(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<ConversationOverrideRow>(
    {
      table: "conversationOverrides",
      getTable: () => getDb().conversationOverrides,
    },
    transport,
    cursor
  )
}
