import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull the host's cogsets (ADR-0209). Read-only on a paired client: it shows
 * them and queues a switch to the host (`plugin_cogset_activate`), and never
 * edits them.
 */
export function syncPluginCogsets(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<CogsetRow>(
    { table: "pluginCogsets", getTable: () => getDb().pluginCogsets },
    transport,
    cursor
  )
}

/** Pull the host's cogset state: which one runs, what is always on, a pending switch. */
export function syncPluginCogsetState(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<CogsetStateRow>(
    { table: "pluginCogsetState", getTable: () => getDb().pluginCogsetState },
    transport,
    cursor
  )
}
