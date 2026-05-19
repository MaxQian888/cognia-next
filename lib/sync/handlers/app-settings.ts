import type { Table } from "dexie"

import type { AppSettings } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull the desktop `AppSettings` singleton.
 *
 * The settings table is keyed by literal `"singleton"`, so the server emits
 * at most one row per delta. The Dexie put is idempotent — repeated pulls
 * with the same `since` cursor are a no-op.
 *
 * Note that mobile reads only the fields it understands (theme, language,
 * fontScale, defaultModel, etc.). Per-platform-only fields stored on the
 * desktop are merged forward by `lib/db/settings.ts:getSettings()` when
 * the row is read.
 */
export function syncAppSettings(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AppSettings>(
    {
      table: "settings",
      // The settings table is declared as `Table<AppSettings, "singleton">`
      // (literal key type) but `runSyncHandler` expects `Table<TRow, string>`.
      // "singleton" is a string-literal subtype, so the value is compatible
      // at runtime; cast to widen the Dexie type so TypeScript accepts it.
      getTable: () => getDb().settings as unknown as Table<AppSettings, string>,
    },
    transport,
    cursor
  )
}
