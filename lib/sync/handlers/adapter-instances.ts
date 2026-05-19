import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull connector adapter-instance upserts (Telegram / Discord / Slack /
 * Lark / OneBot configurations) from the desktop. Mobile uses these for
 * the connector policy sheet + the inbox channel grouping.
 */
export function syncAdapterInstances(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<AdapterInstanceRow>(
    {
      table: "adapterInstances",
      getTable: () => getDb().adapterInstances,
    },
    transport,
    cursor
  )
}
