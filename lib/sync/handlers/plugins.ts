import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { PluginRow } from "@/lib/db/plugin-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull plugin registry upserts from the desktop. Powers the mobile
 * "Plugins" surface inside the Me settings + the per-plugin enable toggles.
 */
export function syncPlugins(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<PluginRow>(
    {
      table: "plugins",
      getTable: () => getDb().plugins,
    },
    transport,
    cursor
  )
}
