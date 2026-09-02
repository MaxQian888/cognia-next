/**
 * `platformIdentities` companion sync handler.
 *
 * The contact directory behind the Inbox profile drawer. Full-row mirror:
 * merge snapshots ride along so the drawer can list absorbed aliases. The host
 * cursors on `updatedAt` with `lastSeenAt` as the legacy fallback
 * (`readPlatformIdentitiesDelta`), and a merge tombstones the absorbed row, so
 * deletions arrive through `deleted_ids`. Merge and unmerge are host
 * operations. The client never writes back.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncPlatformIdentities(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<PlatformIdentityRow>(
    {
      table: "platformIdentities",
      getTable: () => getDb().platformIdentities,
    },
    transport,
    cursor
  )
}
