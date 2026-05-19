import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { TwinProfile } from "@/types/twin"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull twin-profile upserts from the desktop. Twin profiles drive the
 * mobile character switcher + the read-only twin profile panel under
 * `components/mobile/discover/twin-profile-panel.tsx`.
 */
export function syncTwinProfile(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<TwinProfile>(
    {
      table: "twinProfile",
      getTable: () => getDb().twinProfile,
    },
    transport,
    cursor
  )
}
